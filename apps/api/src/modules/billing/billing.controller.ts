import { Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { formatCredit } from '@moka/billing';
import { EntitlementsService } from './entitlements.service.js';
import { CreditsService } from './credits.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { UsageService } from './usage.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

/**
 * Plan, entitlements, credits and usage (§34, §35).
 *
 * PERMISSIONS
 *
 *   Reading the plan and usage needs ORG_READ. Everyone in the organization is
 *     affected by the limits, so everyone can see them; hiding the reason a
 *     creation was refused helps nobody.
 *   Changing the plan needs ORG_UPDATE, because it is a commercial commitment.
 *
 * NOTE WHAT IS ABSENT: there is no endpoint that grants credit or writes an
 * entitlement override. Both would be a self-service way to raise your own
 * limits, and the database enforces it too — `moka_app` holds SELECT and
 * nothing else on `plan_entitlements` and `entitlement_overrides`.
 */

const planChangeSchema = z.object({
  planKey: z.string().min(1).max(60),
  /** An invoice or contract reference, when payment was arranged elsewhere. */
  externalReference: z.string().max(200).nullish(),
});

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly credits: CreditsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly usage: UsageService,
  ) {}

  /** The plan, every entitlement, and how much of each is used. */
  @RequirePermission(Permission.ORG_READ)
  @Get()
  async summary(@CurrentTenant() tenant: TenantContext) {
    const [summary, balance, unpriced] = await Promise.all([
      this.entitlements.summary(tenant),
      this.credits.balance(tenant),
      this.credits.unpricedCount(tenant),
    ]);

    return {
      plan: summary.plan
        ? {
            key: summary.plan.planKey,
            name: summary.plan.planName,
            status: summary.plan.status,
            priceMonthlyCents: summary.plan.priceMonthlyCents,
            currentPeriodEnd: summary.plan.currentPeriodEnd,
          }
        : null,
      features: summary.features,
      credit: {
        balanceMicroUsd: balance,
        display: formatCredit(balance),
        /*
         * Reported prominently rather than buried. An organization seeing
         * "12 calls could not be priced" knows its usage figure is
         * understated and can ask why; the alternative is that nobody ever
         * discovers our model registry is missing a row.
         */
        unpricedCallsThisPeriod: unpriced,
      },
    };
  }

  /** The plan catalogue, so a UI can render an upgrade path. */
  @RequirePermission(Permission.ORG_READ)
  @Get('plans')
  async plans() {
    return { plans: await this.subscriptions.catalogue() };
  }

  /** Usage over the current period, grouped for a chart. */
  @RequirePermission(Permission.ORG_READ)
  @Get('usage')
  async usageSummary(@CurrentTenant() tenant: TenantContext) {
    return this.usage.summary(tenant);
  }

  /** The credit ledger. The authoritative record, not the cached balance. */
  @RequirePermission(Permission.ORG_READ)
  @Get('credit-transactions')
  async transactions(@CurrentTenant() tenant: TenantContext) {
    return { transactions: await this.credits.recentTransactions(tenant) };
  }

  /**
   * Change plan.
   *
   * Routed through the payment gateway, which by default REFUSES because no
   * processor is integrated (§45). A downgrade to the free plan is permitted
   * without one, because it takes nothing and charges nothing.
   *
   * The response says plainly whether money moved. It never did in this
   * build, and saying "payment successful" would be a claim about a
   * transaction this system did not observe.
   */
  @RequirePermission(Permission.ORG_UPDATE)
  @Post('plan')
  async changePlan(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(planChangeSchema, body);
    return this.subscriptions.changePlan(tenant, {
      planKey: input.planKey,
      externalReference: input.externalReference ?? null,
      requestId,
    });
  }

  /**
   * Issue this period's credit allowance.
   *
   * ON DEMAND, and idempotent per period. There is no scheduler: the job queue
   * needs Valkey, which needs Docker (roadmap §B2). Shipping a timer that
   * dies with the process, while an operator believes allowances are being
   * issued monthly, would be worse than an honest button.
   *
   * ORG_UPDATE rather than ORG_READ — it changes a balance, even though the
   * amount comes from the plan and cannot be chosen by the caller.
   */
  @RequirePermission(Permission.ORG_UPDATE)
  @Post('credit/period-allowance')
  async grantAllowance(@CurrentTenant() tenant: TenantContext) {
    const result = await this.credits.grantPeriodAllowance(tenant);
    return {
      ...result,
      message: result.granted
        ? `Granted ${formatCredit(result.amount)} for this period.`
        : 'This period’s allowance has already been issued, or this plan does not meter AI spend.',
    };
  }
}
