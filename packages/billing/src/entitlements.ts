/**
 * Entitlements (master prompt §34).
 *
 * THE GATE THIS PHASE IS MEASURED ON: no hard-coded limits.
 *
 * Every commercial limit is a row, resolved at call time:
 *
 *     entitlement_overrides   per-organization exception
 *              ↓ falls back to
 *     plan_entitlements       what the plan includes
 *              ↓ falls back to
 *     DENY                    an unlisted feature is not included
 *
 * Application code asks `resolveEntitlement(...)` and never writes a number.
 * Changing what a plan includes is an UPDATE, not a deployment.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DISTINCTION THAT MATTERS MOST, AND THE ONE "no hard-coded limits" IS
 * EASIEST TO MISREAD INTO BREAKING
 *
 * There are two kinds of limit in this codebase and they must never be
 * conflated:
 *
 *   ENTITLEMENTS — commercial. How many agents, how many chatbots, how much
 *     AI credit, how many seats. These are the plan. They belong in the
 *     database, an operator changes them freely, and selling more of them is
 *     the entire business model.
 *
 *   SAFETY CEILINGS — abuse and cost-blowup controls. A public chatbot's
 *     4-step budget, the crawler's page and depth maxima, the SSRF blocked
 *     ranges, the upload size cap. These are CONSTANTS and stay constants.
 *
 * Making a safety ceiling purchasable would mean selling a weaker security
 * posture to whoever pays most, and the enterprise tier would be the one
 * whose chatbot can be driven into an unbounded loop by a stranger. So
 * `SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS` below is a real list, and a test
 * asserts nothing on it ever becomes a feature key.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Every commercial limit in the product.
 *
 * A closed enum rather than free-form strings, so a typo in an enforcement
 * call is a compile error rather than a silent grant — `limitFor(org,
 * 'agents.maxx')` resolving to "not included" would deny everything, and
 * resolving to "unlimited" would grant everything. Neither is a failure mode
 * worth having available.
 */
export const Feature = {
  /** AI spend per period, in micro-dollars. The main meter. */
  AI_CREDITS_MICRO_USD: 'ai.credits_micro_usd',
  /** Models this plan may call. A list entitlement, not a numeric one. */
  AI_MODELS: 'ai.models',

  AGENTS_MAX: 'agents.max',
  AGENT_RUNS_PER_MONTH: 'agents.runs_per_month',

  CHATBOTS_MAX: 'chatbots.max',
  CHATBOT_DEPLOYMENTS_MAX: 'chatbots.deployments_max',
  CHATBOT_MESSAGES_PER_MONTH: 'chatbots.messages_per_month',

  KNOWLEDGE_SOURCES_MAX: 'knowledge.sources_max',
  KNOWLEDGE_STORAGE_BYTES: 'knowledge.storage_bytes',

  RESEARCH_RUNS_PER_MONTH: 'research.runs_per_month',

  PROJECTS_MAX: 'projects.max',
  SEATS_MAX: 'seats.max',

  API_REQUESTS_PER_MONTH: 'api.requests_per_month',
} as const;

export type Feature = (typeof Feature)[keyof typeof Feature];

export const ALL_FEATURES: readonly Feature[] = Object.values(Feature);

/**
 * Limits that are NOT entitlements and must never become purchasable.
 *
 * Listed by name so the intent survives a refactor, and asserted by a test
 * that none of them appears in `Feature`. If a future plan wants "longer
 * chatbot conversations", the answer is that the 4-step budget is not for
 * sale — it exists because a stranger on the internet triggers it.
 */
export const SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS: readonly string[] = [
  'chat.max_steps',
  'chat.max_messages_per_conversation',
  'chat.max_history_messages',
  'crawl.max_pages_ceiling',
  'crawl.max_depth_ceiling',
  'crawl.max_total_bytes_ceiling',
  'net.blocked_ip_ranges',
  'net.max_response_bytes',
  'upload.max_bytes',
  'approval.ttl_minutes',
];

/** What a feature's number means. */
export const Unit = {
  COUNT: 'count',
  BYTES: 'bytes',
  MICRO_USD: 'micro_usd',
  /** A list of permitted values rather than a quantity. */
  ALLOWLIST: 'allowlist',
} as const;

export type Unit = (typeof Unit)[keyof typeof Unit];

export const FEATURE_UNITS: Readonly<Record<Feature, Unit>> = {
  [Feature.AI_CREDITS_MICRO_USD]: Unit.MICRO_USD,
  [Feature.AI_MODELS]: Unit.ALLOWLIST,
  [Feature.AGENTS_MAX]: Unit.COUNT,
  [Feature.AGENT_RUNS_PER_MONTH]: Unit.COUNT,
  [Feature.CHATBOTS_MAX]: Unit.COUNT,
  [Feature.CHATBOT_DEPLOYMENTS_MAX]: Unit.COUNT,
  [Feature.CHATBOT_MESSAGES_PER_MONTH]: Unit.COUNT,
  [Feature.KNOWLEDGE_SOURCES_MAX]: Unit.COUNT,
  [Feature.KNOWLEDGE_STORAGE_BYTES]: Unit.BYTES,
  [Feature.RESEARCH_RUNS_PER_MONTH]: Unit.COUNT,
  [Feature.PROJECTS_MAX]: Unit.COUNT,
  [Feature.SEATS_MAX]: Unit.COUNT,
  [Feature.API_REQUESTS_PER_MONTH]: Unit.COUNT,
};

/** Human wording, so an error names the plan limit rather than a key. */
export const FEATURE_LABELS: Readonly<Record<Feature, string>> = {
  [Feature.AI_CREDITS_MICRO_USD]: 'AI credit',
  [Feature.AI_MODELS]: 'available models',
  [Feature.AGENTS_MAX]: 'agents',
  [Feature.AGENT_RUNS_PER_MONTH]: 'agent runs this month',
  [Feature.CHATBOTS_MAX]: 'chatbots',
  [Feature.CHATBOT_DEPLOYMENTS_MAX]: 'chatbot deployments',
  [Feature.CHATBOT_MESSAGES_PER_MONTH]: 'chatbot messages this month',
  [Feature.KNOWLEDGE_SOURCES_MAX]: 'knowledge sources',
  [Feature.KNOWLEDGE_STORAGE_BYTES]: 'knowledge storage',
  [Feature.RESEARCH_RUNS_PER_MONTH]: 'research runs this month',
  [Feature.PROJECTS_MAX]: 'projects',
  [Feature.SEATS_MAX]: 'seats',
  [Feature.API_REQUESTS_PER_MONTH]: 'API requests this month',
};

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One entitlement row, from a plan or from an override.
 *
 * `limitValue` has THREE meaningful states and conflating any two of them is
 * a real bug:
 *
 *   a number   — that many, and no more.
 *   null       — UNLIMITED. Not "zero", not "unset".
 *   absent     — NOT INCLUDED. The plan does not offer this feature at all.
 *
 * The temptation is `limit ?? 0`, which turns unlimited into none, or
 * `limit ?? Infinity`, which turns a missing row into unlimited. The first
 * breaks paying customers; the second gives the product away. `Entitlement`
 * models the distinction so neither is expressible.
 */
export interface EntitlementRow {
  readonly featureKey: string;
  /** Null means unlimited. */
  readonly limitValue: number | null;
  /** For ALLOWLIST features. Empty array means "none permitted". */
  readonly allowedValues?: readonly string[];
}

export type Entitlement =
  | { readonly kind: 'limited'; readonly limit: number }
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'allowlist'; readonly values: readonly string[] }
  /** Explicitly not part of this plan. */
  | { readonly kind: 'not_included' };

export interface EntitlementSources {
  /** Per-organization exceptions. Highest precedence. */
  readonly overrides: readonly EntitlementRow[];
  /** What the subscribed plan includes. */
  readonly plan: readonly EntitlementRow[];
}

/**
 * Resolve one feature for one organization.
 *
 * Override beats plan; an absent row means not included. There is deliberately
 * no third fallback to a code constant — that constant would be the
 * hard-coded limit this whole design exists to remove, and it would silently
 * take over the moment somebody forgot to seed a plan.
 */
export function resolveEntitlement(
  feature: Feature,
  sources: EntitlementSources,
): Entitlement {
  const row =
    sources.overrides.find((r) => r.featureKey === feature) ??
    sources.plan.find((r) => r.featureKey === feature);

  if (!row) return { kind: 'not_included' };

  if (FEATURE_UNITS[feature] === Unit.ALLOWLIST) {
    /*
     * An allowlist feature with a null limit means "no restriction", which is
     * different from an empty list meaning "nothing permitted". A plan that
     * lists no models sells nothing; a plan that restricts none sells
     * everything.
     */
    if (row.limitValue === null && row.allowedValues === undefined) return { kind: 'unlimited' };
    return { kind: 'allowlist', values: row.allowedValues ?? [] };
  }

  if (row.limitValue === null) return { kind: 'unlimited' };
  return { kind: 'limited', limit: row.limitValue };
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

export const DenialReason = {
  NOT_INCLUDED: 'not_included',
  LIMIT_REACHED: 'limit_reached',
  NOT_ON_ALLOWLIST: 'not_on_allowlist',
  NO_SUBSCRIPTION: 'no_subscription',
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
} as const;

export type DenialReason = (typeof DenialReason)[keyof typeof DenialReason];

export type EntitlementDecision =
  | { readonly allowed: true; readonly remaining: number | null }
  | {
      readonly allowed: false;
      readonly reason: DenialReason;
      readonly message: string;
      /** What the plan permits, for the upgrade prompt. Null when unlimited. */
      readonly limit: number | null;
      readonly current: number;
    };

/**
 * Whether one more of something is permitted.
 *
 * `current` is the count the caller measured — an actual `SELECT count(*)`,
 * not a cached number. Counting at the moment of the check is the difference
 * between an enforced limit and a decorative one: a stale count means a
 * customer at their limit can create one more of everything on every
 * deployment of a stale cache.
 */
export function checkQuota(
  feature: Feature,
  entitlement: Entitlement,
  current: number,
  requested = 1,
): EntitlementDecision {
  const label = FEATURE_LABELS[feature];

  switch (entitlement.kind) {
    case 'unlimited':
      return { allowed: true, remaining: null };

    case 'not_included':
      return {
        allowed: false,
        reason: DenialReason.NOT_INCLUDED,
        message: `Your plan does not include ${label}.`,
        limit: 0,
        current,
      };

    case 'allowlist':
      // A quantity question asked of a list feature is a programming error,
      // not a customer-facing one. Refuse rather than guess a number.
      return {
        allowed: false,
        reason: DenialReason.NOT_INCLUDED,
        message: `${label} is not a quantity on this plan.`,
        limit: 0,
        current,
      };

    case 'limited': {
      if (current + requested > entitlement.limit) {
        return {
          allowed: false,
          reason: DenialReason.LIMIT_REACHED,
          message:
            entitlement.limit === 0
              ? `Your plan does not include ${label}.`
              : `Your plan includes ${entitlement.limit} ${label}. You are using ${current}.`,
          limit: entitlement.limit,
          current,
        };
      }
      return { allowed: true, remaining: entitlement.limit - current - requested };
    }
  }
}

/** Whether a specific value — a model id, say — is permitted. */
export function checkAllowlist(
  feature: Feature,
  entitlement: Entitlement,
  value: string,
): EntitlementDecision {
  const label = FEATURE_LABELS[feature];

  if (entitlement.kind === 'unlimited') return { allowed: true, remaining: null };

  if (entitlement.kind === 'allowlist') {
    if (entitlement.values.includes(value)) return { allowed: true, remaining: null };
    return {
      allowed: false,
      reason: DenialReason.NOT_ON_ALLOWLIST,
      /*
       * Names the value the caller already supplied, and nothing else. Listing
       * what the plan DOES include here would be a small upsell and a large
       * information leak about other tiers' configuration.
       */
      message: `Your plan does not include ${value} in its ${label}.`,
      limit: null,
      current: 0,
    };
  }

  return {
    allowed: false,
    reason: DenialReason.NOT_INCLUDED,
    message: `Your plan does not include ${label}.`,
    limit: 0,
    current: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Subscription state                                                          */
/* -------------------------------------------------------------------------- */

export const SubscriptionStatus = {
  TRIALING: 'trialing',
  ACTIVE: 'active',
  /** Payment failed. Still readable, but nothing new may be created. */
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  EXPIRED: 'expired',
} as const;

export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/**
 * Whether a subscription state permits CONSUMING entitlements.
 *
 * `past_due` deliberately still permits reads elsewhere in the application
 * while blocking new consumption. Cutting off access to a customer's own data
 * because a card expired is how you turn a billing problem into a data-loss
 * complaint; refusing to spend more of your money on their behalf is
 * reasonable in the same situation.
 */
export function subscriptionPermitsConsumption(status: string): boolean {
  return status === SubscriptionStatus.TRIALING || status === SubscriptionStatus.ACTIVE;
}

export function describeSubscriptionState(status: string): EntitlementDecision | null {
  if (subscriptionPermitsConsumption(status)) return null;

  return {
    allowed: false,
    reason:
      status === SubscriptionStatus.PAST_DUE
        ? DenialReason.SUBSCRIPTION_INACTIVE
        : DenialReason.NO_SUBSCRIPTION,
    message:
      status === SubscriptionStatus.PAST_DUE
        ? 'This organization has an unpaid invoice. Your existing data is unaffected.'
        : 'This organization does not have an active subscription.',
    limit: 0,
    current: 0,
  };
}
