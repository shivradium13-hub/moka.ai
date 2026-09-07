import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  Database,
  agentRuns,
  agents,
  chatMessages,
  chatbotDeployments,
  chatbots,
  entitlementOverrides,
  knowledgeDocuments,
  knowledgeSources,
  organizationMembers,
  planEntitlements,
  plans,
  projects,
  researchRuns,
  subscriptions,
} from '@moka/db';
import { QuotaExceededError, type OrganizationScoped, type TenantContext } from '@moka/core';
import {
  ALL_FEATURES,
  DEFAULT_PLAN_KEY,
  FEATURE_LABELS,
  FEATURE_UNITS,
  Feature,
  checkAllowlist,
  checkQuota,
  describeSubscriptionState,
  periodStart,
  resolveEntitlement,
  type Entitlement,
  type EntitlementDecision,
  type EntitlementRow,
} from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { getLogger } from '../../common/logger.js';

/**
 * Entitlement enforcement (master prompt §34).
 *
 * THE GATE: no hard-coded limits. Every number this service compares against
 * comes from `plan_entitlements` or `entitlement_overrides`. There is no
 * constant in this file that a limit could fall back to, deliberately — a
 * fallback would take over silently the moment a plan was unseeded, and it
 * would be the hard-coded limit the whole design exists to remove.
 *
 * COUNTING HAPPENS AT THE MOMENT OF THE CHECK.
 *
 * `currentUsage` runs a real `SELECT count(*)` every time rather than reading
 * a cached figure. That is the difference between an enforced limit and a
 * decorative one: with a cache, a customer at their limit can create one more
 * of everything on every instance holding a stale count, and the error only
 * shows up as a support ticket about "the number is wrong".
 *
 * It costs a query per creation. Creations are rare — this is not on the
 * per-token path — and being right matters more than being fast on an
 * operation a user performs a few times a day.
 */

export interface ResolvedPlan {
  readonly planKey: string;
  readonly planName: string;
  readonly status: string;
  readonly priceMonthlyCents: number | null;
  readonly currentPeriodEnd: Date;
  readonly entitlements: readonly EntitlementRow[];
  readonly overrides: readonly EntitlementRow[];
}

@Injectable()
export class EntitlementsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The organization's plan and every entitlement row that applies to it.
   *
   * Returns null when there is no subscription at all. Callers treat that as
   * "nothing is permitted" rather than "everything is" — see `requireQuota`.
   */
  async resolvePlan(scope: OrganizationScoped): Promise<ResolvedPlan | null> {
    return this.db.withScope(scope, async (tx) => {
      const rows = await tx
        .select({
          planId: subscriptions.planId,
          status: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          planKey: plans.key,
          planName: plans.name,
          priceMonthlyCents: plans.priceMonthlyCents,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.organizationId, scope.organizationId))
        .limit(1);

      const subscription = rows[0];
      if (!subscription) return null;

      const entitlements = await tx
        .select({
          featureKey: planEntitlements.featureKey,
          limitValue: planEntitlements.limitValue,
          allowedValues: planEntitlements.allowedValues,
        })
        .from(planEntitlements)
        .where(eq(planEntitlements.planId, subscription.planId));

      const overrideRows = await tx
        .select({
          featureKey: entitlementOverrides.featureKey,
          limitValue: entitlementOverrides.limitValue,
          allowedValues: entitlementOverrides.allowedValues,
          expiresAt: entitlementOverrides.expiresAt,
        })
        .from(entitlementOverrides)
        .where(eq(entitlementOverrides.organizationId, scope.organizationId));

      const now = Date.now();

      return {
        planKey: subscription.planKey,
        planName: subscription.planName,
        status: subscription.status,
        priceMonthlyCents: subscription.priceMonthlyCents,
        currentPeriodEnd: subscription.currentPeriodEnd,
        entitlements: entitlements.map((row) => ({
          featureKey: row.featureKey,
          limitValue: row.limitValue,
          ...(row.allowedValues ? { allowedValues: row.allowedValues } : {}),
        })),
        // An expired override is simply not applied. Deleting it would lose
        // the record of a commercial arrangement that once existed.
        overrides: overrideRows
          .filter((row) => !row.expiresAt || row.expiresAt.getTime() > now)
          .map((row) => ({
            featureKey: row.featureKey,
            limitValue: row.limitValue,
            ...(row.allowedValues ? { allowedValues: row.allowedValues } : {}),
          })),
      };
    });
  }

  async entitlementFor(scope: OrganizationScoped, feature: Feature): Promise<Entitlement> {
    const plan = await this.resolvePlan(scope);
    if (!plan) return { kind: 'not_included' };
    return resolveEntitlement(feature, { overrides: plan.overrides, plan: plan.entitlements });
  }

  /**
   * How much of a feature this organization is currently using.
   *
   * One `SELECT count(*)` per feature, run now. Periodic features count from
   * the start of the current UTC month; the rest count everything live.
   */
  async currentUsage(scope: OrganizationScoped, feature: Feature): Promise<number> {
    const org = scope.organizationId;
    const since = periodStart(new Date());

    return this.db.withScope(scope, async (tx) => {
      const one = async (rows: Promise<Array<{ value: number }>>): Promise<number> =>
        (await rows)[0]?.value ?? 0;

      switch (feature) {
        case Feature.AGENTS_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(agents)
              .where(and(eq(agents.organizationId, org), isNull(agents.deletedAt))),
          );

        case Feature.AGENT_RUNS_PER_MONTH:
          return one(
            tx
              .select({ value: count() })
              .from(agentRuns)
              .where(and(eq(agentRuns.organizationId, org), gte(agentRuns.startedAt, since))),
          );

        case Feature.CHATBOTS_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(chatbots)
              .where(and(eq(chatbots.organizationId, org), isNull(chatbots.deletedAt))),
          );

        case Feature.CHATBOT_DEPLOYMENTS_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(chatbotDeployments)
              .where(
                and(
                  eq(chatbotDeployments.organizationId, org),
                  eq(chatbotDeployments.status, 'active'),
                ),
              ),
          );

        case Feature.CHATBOT_MESSAGES_PER_MONTH:
          return one(
            tx
              .select({ value: count() })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.organizationId, org),
                  eq(chatMessages.role, 'visitor'),
                  gte(chatMessages.createdAt, since),
                ),
              ),
          );

        case Feature.KNOWLEDGE_SOURCES_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(knowledgeSources)
              .where(
                and(eq(knowledgeSources.organizationId, org), isNull(knowledgeSources.deletedAt)),
              ),
          );

        case Feature.KNOWLEDGE_STORAGE_BYTES:
          return one(
            tx
              .select({ value: sql<number>`coalesce(sum(${knowledgeDocuments.byteSize}), 0)::bigint` })
              .from(knowledgeDocuments)
              .where(
                and(
                  eq(knowledgeDocuments.organizationId, org),
                  isNull(knowledgeDocuments.deletedAt),
                ),
              ),
          );

        case Feature.RESEARCH_RUNS_PER_MONTH:
          return one(
            tx
              .select({ value: count() })
              .from(researchRuns)
              .where(and(eq(researchRuns.organizationId, org), gte(researchRuns.startedAt, since))),
          );

        case Feature.PROJECTS_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(projects)
              .where(and(eq(projects.organizationId, org), isNull(projects.deletedAt))),
          );

        case Feature.SEATS_MAX:
          return one(
            tx
              .select({ value: count() })
              .from(organizationMembers)
              .where(
                and(
                  eq(organizationMembers.organizationId, org),
                  eq(organizationMembers.status, 'active'),
                ),
              ),
          );

        /*
         * Not counted here. AI credit is metered by the ledger rather than by
         * a row count (see CreditsService), models are an allowlist rather
         * than a quantity, and API requests are counted by the rate limiter
         * rather than persisted — recording every request to bill it would
         * cost more than the feature is worth.
         */
        case Feature.AI_CREDITS_MICRO_USD:
        case Feature.AI_MODELS:
        case Feature.API_REQUESTS_PER_MONTH:
          return 0;
      }
    });
  }

  /**
   * The whole decision for one feature: subscription state, then the limit.
   *
   * Subscription state comes FIRST. An organization with no active
   * subscription has no entitlements to check, and reporting "you have used
   * 3 of 3 agents" to somebody whose subscription lapsed answers a question
   * they did not ask.
   */
  async check(
    scope: OrganizationScoped,
    feature: Feature,
    requested = 1,
  ): Promise<EntitlementDecision> {
    const plan = await this.resolvePlan(scope);

    if (!plan) {
      return {
        allowed: false,
        reason: 'no_subscription',
        message: 'This organization does not have a subscription.',
        limit: 0,
        current: 0,
      };
    }

    const stateDenial = describeSubscriptionState(plan.status);
    if (stateDenial) return stateDenial;

    const entitlement = resolveEntitlement(feature, {
      overrides: plan.overrides,
      plan: plan.entitlements,
    });

    // Unlimited needs no count, and skipping it saves a query on the plans
    // where creations are most frequent.
    if (entitlement.kind === 'unlimited') return { allowed: true, remaining: null };

    // Counted now, not read from a cache. Per-month features scope themselves
    // to the current UTC period inside `currentUsage`.
    const current = await this.currentUsage(scope, feature);
    return checkQuota(feature, entitlement, current, requested);
  }

  /** Throw unless the organization may do one more of this. */
  async requireQuota(
    scope: OrganizationScoped,
    feature: Feature,
    requested = 1,
  ): Promise<void> {
    const decision = await this.check(scope, feature, requested);
    if (decision.allowed) return;

    getLogger().info(
      {
        organizationId: scope.organizationId,
        feature,
        limit: decision.limit,
        current: decision.current,
        reason: decision.reason,
      },
      'entitlement refused',
    );

    throw new QuotaExceededError({
      feature,
      publicMessage: decision.message,
      limit: decision.limit,
      current: decision.current,
      internalMessage: `Entitlement ${feature} refused: ${decision.reason}.`,
    });
  }

  /** Throw unless a specific value — a model id — is on the plan's allowlist. */
  async requireAllowed(
    scope: OrganizationScoped,
    feature: Feature,
    value: string,
  ): Promise<void> {
    const entitlement = await this.entitlementFor(scope, feature);
    const decision = checkAllowlist(feature, entitlement, value);
    if (decision.allowed) return;

    throw new QuotaExceededError({
      feature,
      publicMessage: decision.message,
      limit: decision.limit,
      current: decision.current,
      internalMessage: `Value "${value}" is not permitted for ${feature}.`,
    });
  }

  /**
   * Every feature with its limit and current usage, for the dashboard.
   *
   * Counts each one, which is a handful of queries on a page a user opens
   * occasionally. Showing a stale number on the page whose entire purpose is
   * to say how much of the plan is left would be worse than the cost.
   */
  async summary(scope: OrganizationScoped): Promise<{
    plan: ResolvedPlan | null;
    features: Array<{
      feature: string;
      label: string;
      unit: string;
      limit: number | null;
      current: number;
      included: boolean;
      allowedValues: readonly string[] | null;
    }>;
  }> {
    const plan = await this.resolvePlan(scope);
    if (!plan) return { plan: null, features: [] };

    const features = [];

    for (const feature of ALL_FEATURES) {
      const entitlement = resolveEntitlement(feature, {
        overrides: plan.overrides,
        plan: plan.entitlements,
      });

      features.push({
        feature,
        label: FEATURE_LABELS[feature],
        unit: FEATURE_UNITS[feature],
        limit: entitlement.kind === 'limited' ? entitlement.limit : null,
        current: await this.currentUsage(scope, feature),
        included: entitlement.kind !== 'not_included',
        allowedValues: entitlement.kind === 'allowlist' ? entitlement.values : null,
      });
    }

    return { plan, features };
  }

  /**
   * Give a brand-new organization a subscription to the default plan.
   *
   * Named after the plan KEY rather than a set of limits, so an operator who
   * edits the free plan changes what new signups receive without a deployment.
   */
  async ensureSubscription(context: TenantContext): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const existing = await tx
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.organizationId, context.organizationId))
        .limit(1);
      if (existing.length > 0) return;

      const planRows = await tx
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.key, DEFAULT_PLAN_KEY))
        .limit(1);

      const plan = planRows[0];
      if (!plan) {
        /*
         * The catalogue has not been seeded. Logged loudly and NOT papered
         * over with an invented default: an organization silently created
         * with no subscription is refused everything, which is a confusing
         * but safe failure, whereas one given an imaginary unlimited plan is
         * a quiet one that costs money.
         */
        getLogger().error(
          { organizationId: context.organizationId, planKey: DEFAULT_PLAN_KEY },
          'no default plan exists; organization created without a subscription',
        );
        return;
      }

      const now = new Date();
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      await tx.insert(subscriptions).values({
        organizationId: context.organizationId,
        planId: plan.id,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      });
    });
  }
}
