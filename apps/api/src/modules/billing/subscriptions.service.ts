import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Database, planEntitlements, plans, subscriptions } from '@moka/db';
import { NotFoundError, type TenantContext } from '@moka/core';
import {
  DEFAULT_PLAN_KEY,
  ManualPaymentGateway,
  UnavailablePaymentGateway,
  type PaymentGateway,
} from '@moka/billing';
import { loadConfig } from '@moka/config';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * Subscriptions and plan changes (§34).
 *
 * THE PAYMENT BOUNDARY.
 *
 * §45 forbids a fake payment confirmation, and the most damaging possible
 * instance of that would be right here: activating a paid plan without a
 * processor having taken money. The organization would get real credit, make
 * real provider calls, and the money would not exist.
 *
 * So a plan change routes through a `PaymentGateway`, and the default one
 * REFUSES. The response says so, in words, rather than queueing something that
 * never completes.
 *
 * The one exception is a downgrade to the default plan, which is permitted
 * without a gateway because it takes nothing and charges nothing. Refusing a
 * customer's cancellation because no processor is configured would be a
 * hostage-taking, not a safeguard.
 */
@Injectable()
export class SubscriptionsService {
  private readonly gateway: PaymentGateway;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {
    /*
     * `BILLING_MANUAL_PAYMENTS=true` says an operator takes payment outside
     * this system — an invoice, a bank transfer, a self-hosted deployment with
     * no billing at all. That is the realistic arrangement for most of this
     * product's likely customers, and it is honest because a HUMAN asserts the
     * payment rather than the code inventing it.
     */
    const manual = loadConfig().BILLING_MANUAL_PAYMENTS;
    this.gateway = manual ? new ManualPaymentGateway() : new UnavailablePaymentGateway();
  }

  /** The plan catalogue with its entitlements, for a pricing page. */
  async catalogue() {
    const rows = await this.db.global
      .select({
        key: plans.key,
        name: plans.name,
        description: plans.description,
        priceMonthlyCents: plans.priceMonthlyCents,
        currency: plans.currency,
        sortOrder: plans.sortOrder,
        planId: plans.id,
      })
      .from(plans)
      .where(eq(plans.status, 'active'))
      .orderBy(asc(plans.sortOrder));

    const entitlements = await this.db.global
      .select({
        planId: planEntitlements.planId,
        featureKey: planEntitlements.featureKey,
        limitValue: planEntitlements.limitValue,
        allowedValues: planEntitlements.allowedValues,
        unit: planEntitlements.unit,
      })
      .from(planEntitlements);

    const byPlan = new Map<string, typeof entitlements>();
    for (const row of entitlements) {
      byPlan.set(row.planId, [...(byPlan.get(row.planId) ?? []), row]);
    }

    return rows.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      priceMonthlyCents: plan.priceMonthlyCents,
      currency: plan.currency,
      entitlements: (byPlan.get(plan.planId) ?? []).map((row) => ({
        featureKey: row.featureKey,
        // Null means unlimited. Passed through as null rather than as a large
        // number, so a UI renders "Unlimited" instead of "9,999,999".
        limitValue: row.limitValue,
        allowedValues: row.allowedValues,
        unit: row.unit,
      })),
    }));
  }

  /**
   * Whether the deployment can take money at all, for the UI.
   *
   * Reported so a pricing page can say "contact us to upgrade" rather than
   * rendering a buy button that leads to a refusal.
   */
  paymentCapability(): { gateway: string; canChargeCards: boolean; canSelfServe: boolean } {
    return {
      gateway: this.gateway.id,
      canChargeCards: this.gateway.canChargeCards,
      canSelfServe: this.gateway.id !== 'unavailable',
    };
  }

  async changePlan(
    context: TenantContext,
    input: { planKey: string; externalReference: string | null; requestId?: string | undefined },
  ): Promise<{ changed: boolean; planKey: string; message: string }> {
    const target = await this.db.global
      .select({ id: plans.id, key: plans.key, price: plans.priceMonthlyCents })
      .from(plans)
      .where(eq(plans.key, input.planKey))
      .limit(1);

    const plan = target[0];
    if (!plan) throw new NotFoundError('Plan');

    const current = await this.db.withTenant(context, async (tx) =>
      tx
        .select({ id: subscriptions.id, planId: subscriptions.planId })
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, context.organizationId))
        .limit(1),
    );

    /*
     * A move to the default (free) plan is a cancellation. Always permitted:
     * refusing it because no processor is configured would hold a customer on
     * a plan they are trying to leave.
     */
    const isDowngradeToDefault = plan.key === DEFAULT_PLAN_KEY;

    if (!isDowngradeToDefault) {
      const checkout = await this.gateway.checkout({
        organizationId: context.organizationId,
        planKey: plan.key,
        actorUserId: context.userId,
        externalReference: input.externalReference,
      });

      if (!checkout.activate) {
        // Not an error: the request was well-formed and the answer is "not
        // here". Returning 200 with `changed: false` lets a UI show the real
        // reason instead of a generic failure.
        return { changed: false, planKey: input.planKey, message: checkout.message };
      }

      await this.applyPlan(context, plan.id, checkout.externalReference);

      await this.audit.record(context, {
        action: 'billing.plan.change',
        resourceType: 'subscription',
        resourceId: current[0]?.id ?? null,
        after: {
          planKey: plan.key,
          // Recorded because a manual activation is a HUMAN's assertion that
          // payment happened, and the person who made it must be findable.
          gateway: this.gateway.id,
          externalReference: checkout.externalReference,
        },
        requestId: input.requestId,
      });

      getLogger().info(
        {
          organizationId: context.organizationId,
          planKey: plan.key,
          gateway: this.gateway.id,
          actorUserId: context.userId,
        },
        'subscription activated without an online payment',
      );

      return { changed: true, planKey: plan.key, message: checkout.message };
    }

    await this.applyPlan(context, plan.id, null);

    await this.audit.record(context, {
      action: 'billing.plan.cancel',
      resourceType: 'subscription',
      resourceId: current[0]?.id ?? null,
      after: { planKey: plan.key },
      requestId: input.requestId,
    });

    return {
      changed: true,
      planKey: plan.key,
      message: 'Moved to the free plan. Nothing was charged, and your data is unaffected.',
    };
  }

  private async applyPlan(
    context: TenantContext,
    planId: string,
    externalRef: string | null,
  ): Promise<void> {
    const now = new Date();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(subscriptions)
        .set({
          planId,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          externalRef,
          updatedAt: now,
        })
        .where(eq(subscriptions.organizationId, context.organizationId));
    });
  }
}
