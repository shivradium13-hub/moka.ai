import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Database, creditTransactions, credits } from '@moka/db';
import { QuotaExceededError, type OrganizationScoped } from '@moka/core';
import {
  CreditVerdict,
  Feature,
  TransactionKind,
  checkCredit,
  periodKey,
  planDebit,
  resolveEntitlement,
  signIsValid,
} from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { EntitlementsService } from './entitlements.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * The credit ledger (master prompt §35).
 *
 * `credit_transactions` is authoritative; `credits.balance_micro_usd` is a
 * cache of its sum, because a pre-flight check on every provider call cannot
 * afford to sum a million rows. A security test reconciles the two.
 *
 * ON CONCURRENCY, HONESTLY
 *
 * The cost of a provider call is not known until it returns — it depends on
 * how many tokens the model chooses to emit — so there is no way to
 * pre-authorise an exact amount. The pre-check is therefore a BALANCE check,
 * and a burst of concurrent requests can each pass it before any of them
 * debits.
 *
 * The bound on that is one call's cost per concurrent request, and the
 * consequences are handled rather than hidden:
 *
 *   - the debit itself is a single atomic UPDATE, so no two debits can lose
 *     each other regardless of interleaving;
 *   - the balance is allowed to go NEGATIVE, because clamping at zero would
 *     conceal exactly the overspend this trade-off produces;
 *   - the next pre-check refuses at or below zero, so the overshoot is
 *     bounded by one burst rather than compounding.
 *
 * The alternative — reserving a pessimistic maximum before every call — would
 * make a customer's usable credit a fraction of what they bought, and would
 * still be wrong whenever the reservation and the actual cost diverged.
 */
@Injectable()
export class CreditsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** The cached balance, or null when this organization has no credit row. */
  async balance(scope: OrganizationScoped): Promise<number | null> {
    const rows = await this.db.withScope(scope, async (tx) =>
      tx
        .select({ balance: credits.balanceMicroUsd })
        .from(credits)
        .where(eq(credits.organizationId, scope.organizationId))
        .limit(1),
    );
    return rows[0]?.balance ?? null;
  }

  /**
   * Whether this organization's plan meters AI spend at all.
   *
   * `unlimited` on the credit entitlement means genuinely unmetered — an
   * enterprise contract, say — and is different from a large allowance. It
   * skips the ledger entirely rather than debiting against an infinite
   * balance, so a usage dashboard can say "not metered" rather than showing a
   * meaningless number.
   */
  private async isMetered(scope: OrganizationScoped): Promise<boolean> {
    const plan = await this.entitlements.resolvePlan(scope);
    if (!plan) return true; // No subscription: metered, and the balance is zero.

    const entitlement = resolveEntitlement(Feature.AI_CREDITS_MICRO_USD, {
      overrides: plan.overrides,
      plan: plan.entitlements,
    });
    return entitlement.kind !== 'unlimited';
  }

  /**
   * The pre-flight check, run before a provider call.
   *
   * Throws rather than returning a decision, because every call site wants the
   * same behaviour and a returned boolean is a boolean somebody forgets to
   * read.
   */
  async requireCredit(scope: OrganizationScoped): Promise<void> {
    const metered = await this.isMetered(scope);
    const check = checkCredit({ balanceMicroUsd: await this.balance(scope), metered });

    if (check.verdict !== CreditVerdict.EXHAUSTED) return;

    throw new QuotaExceededError({
      feature: Feature.AI_CREDITS_MICRO_USD,
      publicMessage:
        'This organization has no AI credit remaining for this period. ' +
        'Existing data is unaffected.',
      limit: null,
      current: check.balanceMicroUsd ?? 0,
      internalMessage: `Credit exhausted: balance ${check.balanceMicroUsd}.`,
    });
  }

  /**
   * Charge for a completed provider call.
   *
   * Called AFTER the call, with the estimated cost. `costMicroUsd` is null
   * when the model's pricing is not configured — see `planDebit`, which
   * charges nothing and flags the gap rather than inventing a figure or
   * silently making an unpriced model free and unlimited.
   *
   * Never throws. A billing failure must not turn a successful provider call
   * into an error for the user: they got their answer, and losing the debit is
   * our problem to reconcile, not theirs to see as a 500.
   */
  async charge(
    scope: OrganizationScoped,
    params: {
      costMicroUsd: number | null;
      usageRecordId?: string | null;
      requestId?: string | undefined;
      reason?: string;
    },
  ): Promise<void> {
    try {
      if (!(await this.isMetered(scope))) return;

      const debit = planDebit(params.costMicroUsd);
      const period = periodKey(new Date());

      if (debit.unpriced) {
        /*
         * A call happened that we could not price. Recorded as a zero-amount
         * ledger entry rather than skipped, so the dashboard can say "N calls
         * this period could not be priced" and the gap is visible as the
         * registry bug it is — not absorbed as revenue, and not given away.
         */
        await this.append(scope, {
          kind: TransactionKind.DEBIT,
          amountMicroUsd: 0,
          unpriced: true,
          reason: debit.reason ?? null,
          usageRecordId: params.usageRecordId ?? null,
          requestId: params.requestId ?? null,
          period,
        });
        return;
      }

      if (debit.amountMicroUsd <= 0) return;

      await this.db.withScope(scope, async (tx) => {
        /*
         * ONE atomic statement. Read-then-write would lose a debit whenever
         * two calls finished together, and losing a debit is free usage.
         */
        await tx
          .update(credits)
          .set({
            balanceMicroUsd: sql`${credits.balanceMicroUsd} - ${debit.amountMicroUsd}`,
            updatedAt: new Date(),
          })
          .where(eq(credits.organizationId, scope.organizationId));

        await tx.insert(creditTransactions).values({
          organizationId: scope.organizationId,
          kind: TransactionKind.DEBIT,
          // Negative. The database CHECKs the sign against the kind, because a
          // debit that added credit would reconcile perfectly against a
          // wrong balance.
          amountMicroUsd: -debit.amountMicroUsd,
          reason: params.reason ?? null,
          periodKey: period,
          usageRecordId: params.usageRecordId ?? null,
          unpriced: false,
          requestId: params.requestId ?? null,
        });
      });
    } catch (error) {
      getLogger().error(
        {
          organizationId: scope.organizationId,
          costMicroUsd: params.costMicroUsd,
          requestId: params.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to record a credit debit; the provider call succeeded',
      );
    }
  }

  /**
   * Add credit.
   *
   * The only path that increases a balance, and it is not reachable from a
   * request — the service is called by the period grant below and by an
   * operator script. There is deliberately no self-service "add credit"
   * endpoint, because that would be a self-service way to spend somebody
   * else's provider quota.
   */
  async grant(
    scope: OrganizationScoped,
    params: { amountMicroUsd: number; reason: string; kind?: TransactionKind },
  ): Promise<void> {
    const kind = params.kind ?? TransactionKind.GRANT;
    if (!signIsValid(kind, params.amountMicroUsd)) {
      throw new Error(`Refusing a ${kind} of ${params.amountMicroUsd}: wrong sign for its kind.`);
    }

    const period = periodKey(new Date());

    await this.db.withScope(scope, async (tx) => {
      await tx
        .insert(credits)
        .values({
          organizationId: scope.organizationId,
          balanceMicroUsd: params.amountMicroUsd,
          periodKey: period,
        })
        .onConflictDoUpdate({
          target: credits.organizationId,
          set: {
            balanceMicroUsd: sql`${credits.balanceMicroUsd} + ${params.amountMicroUsd}`,
            periodKey: period,
            updatedAt: new Date(),
          },
        });

      await tx.insert(creditTransactions).values({
        organizationId: scope.organizationId,
        kind,
        amountMicroUsd: params.amountMicroUsd,
        reason: params.reason,
        periodKey: period,
        unpriced: false,
      });
    });
  }

  /**
   * Give an organization its plan's allowance for the current period.
   *
   * Idempotent per period: if a grant already exists for this `period_key`,
   * nothing happens. Without that, a scheduler retry — or two instances
   * starting at once — would hand out two months of credit.
   *
   * ON DEMAND ONLY. There is no scheduler here, for the same reason retention
   * has none: the job queue needs Valkey, which needs Docker (roadmap §B2).
   * Shipping a timer that dies with the process, while an operator believes
   * allowances are being issued, would be worse than an honest endpoint (§45).
   */
  async grantPeriodAllowance(scope: OrganizationScoped): Promise<{ granted: boolean; amount: number }> {
    const plan = await this.entitlements.resolvePlan(scope);
    if (!plan) return { granted: false, amount: 0 };

    const entitlement = resolveEntitlement(Feature.AI_CREDITS_MICRO_USD, {
      overrides: plan.overrides,
      plan: plan.entitlements,
    });

    // Unmetered plans have no allowance to issue.
    if (entitlement.kind !== 'limited') return { granted: false, amount: 0 };

    const period = periodKey(new Date());

    const already = await this.db.withScope(scope, async (tx) =>
      tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.organizationId, scope.organizationId),
            eq(creditTransactions.periodKey, period),
            eq(creditTransactions.kind, TransactionKind.GRANT),
          ),
        )
        .limit(1),
    );

    if (already.length > 0) return { granted: false, amount: 0 };

    await this.grant(scope, {
      amountMicroUsd: entitlement.limit,
      reason: `Plan allowance for ${period} (${plan.planKey}).`,
    });

    return { granted: true, amount: entitlement.limit };
  }

  /** Recent ledger entries, for the usage page. */
  async recentTransactions(scope: OrganizationScoped, limit = 50) {
    return this.db.withScope(scope, async (tx) =>
      tx
        .select({
          kind: creditTransactions.kind,
          amountMicroUsd: creditTransactions.amountMicroUsd,
          reason: creditTransactions.reason,
          unpriced: creditTransactions.unpriced,
          periodKey: creditTransactions.periodKey,
          createdAt: creditTransactions.createdAt,
        })
        .from(creditTransactions)
        .where(eq(creditTransactions.organizationId, scope.organizationId))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(Math.min(limit, 200)),
    );
  }

  /**
   * How many calls this period could not be priced.
   *
   * Surfaced on the dashboard. An organization seeing "12 calls could not be
   * priced" knows its bill is understated and can ask; the alternative is that
   * nobody ever finds out our model registry is missing a row.
   */
  async unpricedCount(scope: OrganizationScoped): Promise<number> {
    const period = periodKey(new Date());
    const rows = await this.db.withScope(scope, async (tx) =>
      tx
        .select({ value: sql<number>`count(*)::int` })
        .from(creditTransactions)
        .where(
          and(
            eq(creditTransactions.organizationId, scope.organizationId),
            eq(creditTransactions.periodKey, period),
            eq(creditTransactions.unpriced, true),
          ),
        ),
    );
    return rows[0]?.value ?? 0;
  }

  private async append(
    scope: OrganizationScoped,
    entry: {
      kind: TransactionKind;
      amountMicroUsd: number;
      unpriced: boolean;
      reason: string | null;
      usageRecordId: string | null;
      requestId: string | null;
      period: string;
    },
  ): Promise<void> {
    await this.db.withScope(scope, async (tx) => {
      await tx.insert(creditTransactions).values({
        organizationId: scope.organizationId,
        kind: entry.kind,
        amountMicroUsd: entry.amountMicroUsd,
        reason: entry.reason,
        periodKey: entry.period,
        usageRecordId: entry.usageRecordId,
        unpriced: entry.unpriced,
        requestId: entry.requestId,
      });
    });
  }
}
