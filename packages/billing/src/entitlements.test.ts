import { describe, expect, it } from 'vitest';
import {
  ALL_FEATURES,
  DenialReason,
  Feature,
  FEATURE_LABELS,
  FEATURE_UNITS,
  SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS,
  SubscriptionStatus,
  checkAllowlist,
  checkQuota,
  describeSubscriptionState,
  resolveEntitlement,
  subscriptionPermitsConsumption,
  type EntitlementSources,
} from './entitlements.js';

/**
 * THE PHASE 9 GATE: entitlement enforcement, and no hard-coded limits.
 *
 * Two things are being pinned. The first is that every limit resolves from
 * data — override, then plan, then denial, with no code constant anywhere in
 * the chain. The second is the distinction the gate is easiest to misread
 * into breaking: safety ceilings are NOT entitlements and must never become
 * purchasable.
 */

function sources(overrides: Partial<EntitlementSources> = {}): EntitlementSources {
  return { overrides: [], plan: [], ...overrides };
}

/* ========================================================================== */
/* Resolution                                                                 */
/* ========================================================================== */

describe('resolution order', () => {
  it('takes the plan value when there is no override', () => {
    const entitlement = resolveEntitlement(
      Feature.AGENTS_MAX,
      sources({ plan: [{ featureKey: Feature.AGENTS_MAX, limitValue: 5 }] }),
    );
    expect(entitlement).toEqual({ kind: 'limited', limit: 5 });
  });

  it('lets an override beat the plan', () => {
    // The reason overrides exist: a negotiated contract without cloning a plan
    // per customer, which produces a plan table nobody can reason about.
    const entitlement = resolveEntitlement(
      Feature.AGENTS_MAX,
      sources({
        plan: [{ featureKey: Feature.AGENTS_MAX, limitValue: 5 }],
        overrides: [{ featureKey: Feature.AGENTS_MAX, limitValue: 500 }],
      }),
    );
    expect(entitlement).toEqual({ kind: 'limited', limit: 500 });
  });

  it('lets an override REDUCE a plan limit as well as raise it', () => {
    // Overrides are exceptions, not upgrades. An abusive tenant on a paid plan
    // is a real case, and an override that could only add would not cover it.
    const entitlement = resolveEntitlement(
      Feature.AGENTS_MAX,
      sources({
        plan: [{ featureKey: Feature.AGENTS_MAX, limitValue: 500 }],
        overrides: [{ featureKey: Feature.AGENTS_MAX, limitValue: 0 }],
      }),
    );
    expect(entitlement).toEqual({ kind: 'limited', limit: 0 });
  });

  it('treats an absent row as NOT INCLUDED, never as unlimited', () => {
    /*
     * The direction of this default is the whole design. Failing open would
     * mean a feature added to the code before it is added to any plan is free
     * and unlimited for everyone until somebody notices.
     */
    expect(resolveEntitlement(Feature.AGENTS_MAX, sources())).toEqual({ kind: 'not_included' });
  });

  it('has no third fallback to a code constant', () => {
    // If there were one, it would be the hard-coded limit this design exists
    // to remove, and it would take over silently whenever a plan was unseeded.
    for (const feature of ALL_FEATURES) {
      expect(resolveEntitlement(feature, sources()).kind).toBe('not_included');
    }
  });
});

describe('the three states of a limit', () => {
  it('null means UNLIMITED, not zero', () => {
    // `limit ?? 0` would break every paying customer on an unlimited plan.
    const entitlement = resolveEntitlement(
      Feature.AGENTS_MAX,
      sources({ plan: [{ featureKey: Feature.AGENTS_MAX, limitValue: null }] }),
    );
    expect(entitlement).toEqual({ kind: 'unlimited' });
  });

  it('zero means NONE, not unlimited', () => {
    const entitlement = resolveEntitlement(
      Feature.CHATBOTS_MAX,
      sources({ plan: [{ featureKey: Feature.CHATBOTS_MAX, limitValue: 0 }] }),
    );
    expect(entitlement).toEqual({ kind: 'limited', limit: 0 });
  });

  it('an absent row is a third state, distinct from both', () => {
    const absent = resolveEntitlement(Feature.CHATBOTS_MAX, sources());
    const zero = resolveEntitlement(
      Feature.CHATBOTS_MAX,
      sources({ plan: [{ featureKey: Feature.CHATBOTS_MAX, limitValue: 0 }] }),
    );
    const unlimited = resolveEntitlement(
      Feature.CHATBOTS_MAX,
      sources({ plan: [{ featureKey: Feature.CHATBOTS_MAX, limitValue: null }] }),
    );

    expect(new Set([absent.kind, zero.kind, unlimited.kind]).size).toBe(3);
  });
});

/* ========================================================================== */
/* Quota decisions                                                            */
/* ========================================================================== */

describe('checkQuota', () => {
  const limited = { kind: 'limited', limit: 3 } as const;

  it('permits below the limit and reports what is left', () => {
    expect(checkQuota(Feature.AGENTS_MAX, limited, 1)).toEqual({ allowed: true, remaining: 1 });
  });

  it('permits the call that reaches the limit exactly', () => {
    // Off-by-one in the permissive direction gives away one of everything; in
    // the restrictive direction it sells three and delivers two.
    expect(checkQuota(Feature.AGENTS_MAX, limited, 2)).toEqual({ allowed: true, remaining: 0 });
  });

  it('refuses the one after that', () => {
    const decision = checkQuota(Feature.AGENTS_MAX, limited, 3);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.reason).toBe(DenialReason.LIMIT_REACHED);
  });

  it('handles a bulk request rather than only one at a time', () => {
    expect(checkQuota(Feature.SEATS_MAX, limited, 1, 3).allowed).toBe(false);
    expect(checkQuota(Feature.SEATS_MAX, limited, 1, 2).allowed).toBe(true);
  });

  it('always permits an unlimited entitlement', () => {
    expect(checkQuota(Feature.AGENTS_MAX, { kind: 'unlimited' }, 1_000_000)).toEqual({
      allowed: true,
      remaining: null,
    });
  });

  it('refuses a feature the plan does not include', () => {
    const decision = checkQuota(Feature.AGENTS_MAX, { kind: 'not_included' }, 0);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.reason).toBe(DenialReason.NOT_INCLUDED);
  });

  it('names the limit and the usage, so the message is actionable', () => {
    const decision = checkQuota(Feature.AGENTS_MAX, limited, 3);
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.message).toContain('3');
    expect(decision.message).toContain(FEATURE_LABELS[Feature.AGENTS_MAX]);
    expect(decision.limit).toBe(3);
    expect(decision.current).toBe(3);
  });

  it('says "does not include" rather than "you have used 0 of 0"', () => {
    const decision = checkQuota(Feature.CHATBOTS_MAX, { kind: 'limited', limit: 0 }, 0);
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.message).toMatch(/does not include/i);
  });

  it('refuses to answer a quantity question about a list feature', () => {
    // A programming error, not a customer one. Guessing a number here would
    // silently enforce something nobody designed.
    const decision = checkQuota(Feature.AI_MODELS, { kind: 'allowlist', values: ['a'] }, 0);
    expect(decision.allowed).toBe(false);
  });
});

/* ========================================================================== */
/* Allowlists                                                                 */
/* ========================================================================== */

describe('checkAllowlist', () => {
  const restricted = { kind: 'allowlist', values: ['claude-haiku-4-5-20251001'] } as const;

  it('permits a listed value', () => {
    expect(checkAllowlist(Feature.AI_MODELS, restricted, 'claude-haiku-4-5-20251001').allowed).toBe(
      true,
    );
  });

  it('refuses an unlisted one', () => {
    const decision = checkAllowlist(Feature.AI_MODELS, restricted, 'claude-opus-5');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.reason).toBe(DenialReason.NOT_ON_ALLOWLIST);
  });

  it('does not enumerate the plan when refusing', () => {
    // Naming the value the caller already supplied leaks nothing. Listing what
    // the plan DOES include would be a small upsell and a real leak of other
    // tiers' configuration.
    const decision = checkAllowlist(Feature.AI_MODELS, restricted, 'claude-opus-5');
    if (decision.allowed) throw new Error('expected refusal');
    expect(decision.message).toContain('claude-opus-5');
    expect(decision.message).not.toContain('claude-haiku');
  });

  it('permits everything when the allowlist is unrestricted', () => {
    expect(checkAllowlist(Feature.AI_MODELS, { kind: 'unlimited' }, 'anything').allowed).toBe(true);
  });

  it('permits NOTHING when the list is empty', () => {
    // An empty list and an unrestricted one are opposites. A plan that lists
    // no models sells nothing; one that restricts none sells everything.
    expect(checkAllowlist(Feature.AI_MODELS, { kind: 'allowlist', values: [] }, 'x').allowed).toBe(
      false,
    );
  });

  it('distinguishes an unrestricted list from a missing row', () => {
    const unrestricted = resolveEntitlement(
      Feature.AI_MODELS,
      sources({ plan: [{ featureKey: Feature.AI_MODELS, limitValue: null }] }),
    );
    const restrictedRow = resolveEntitlement(
      Feature.AI_MODELS,
      sources({ plan: [{ featureKey: Feature.AI_MODELS, limitValue: 0, allowedValues: ['a'] }] }),
    );

    expect(unrestricted.kind).toBe('unlimited');
    expect(restrictedRow).toEqual({ kind: 'allowlist', values: ['a'] });
  });
});

/* ========================================================================== */
/* Subscription state                                                         */
/* ========================================================================== */

describe('subscription state', () => {
  it('permits consumption while trialing or active', () => {
    expect(subscriptionPermitsConsumption(SubscriptionStatus.TRIALING)).toBe(true);
    expect(subscriptionPermitsConsumption(SubscriptionStatus.ACTIVE)).toBe(true);
  });

  it('refuses consumption when past due, canceled or expired', () => {
    for (const status of [
      SubscriptionStatus.PAST_DUE,
      SubscriptionStatus.CANCELED,
      SubscriptionStatus.EXPIRED,
    ]) {
      expect(subscriptionPermitsConsumption(status)).toBe(false);
    }
  });

  it('reassures a past-due customer that their data is intact', () => {
    /*
     * Refusing to spend more of your own money on their behalf is reasonable.
     * Cutting off access to their data because a card expired turns a billing
     * problem into a data-loss complaint.
     */
    const decision = describeSubscriptionState(SubscriptionStatus.PAST_DUE);
    expect(decision?.message).toMatch(/data is unaffected/i);
  });

  it('returns null for a healthy subscription, so callers can early-exit', () => {
    expect(describeSubscriptionState(SubscriptionStatus.ACTIVE)).toBeNull();
  });

  it('treats an unknown status as not permitting consumption', () => {
    // Fails closed. A status this build does not recognise is not a licence.
    expect(subscriptionPermitsConsumption('something_new')).toBe(false);
  });
});

/* ========================================================================== */
/* The distinction the gate is easiest to misread                             */
/* ========================================================================== */

describe('safety ceilings are not entitlements', () => {
  it('no safety ceiling appears in the feature enum', () => {
    /*
     * Making one purchasable would mean selling a weaker security posture to
     * whoever pays most, and the enterprise tier would be the one whose public
     * chatbot can be driven into an unbounded loop by a stranger.
     */
    const featureValues = new Set<string>(ALL_FEATURES);
    for (const ceiling of SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS) {
      expect({ ceiling, isFeature: featureValues.has(ceiling) }).toEqual({
        ceiling,
        isFeature: false,
      });
    }
  });

  it('the list names the ceilings that actually exist in the codebase', () => {
    // A stale list is worse than none: it reads as a guarantee while covering
    // constants that were renamed away.
    for (const expected of [
      'chat.max_steps',
      'crawl.max_pages_ceiling',
      'net.blocked_ip_ranges',
      'upload.max_bytes',
    ]) {
      expect(SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS).toContain(expected);
    }
  });
});

describe('the feature catalogue is complete', () => {
  it('every feature has a unit and a label', () => {
    // A missing label renders a raw key like `agents.max` in an error message
    // shown to a customer.
    for (const feature of ALL_FEATURES) {
      expect(FEATURE_UNITS[feature]).toBeDefined();
      expect(FEATURE_LABELS[feature]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('feature keys are namespaced, so a collision is visible', () => {
    for (const feature of ALL_FEATURES) {
      expect(feature).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(ALL_FEATURES).size).toBe(ALL_FEATURES.length);
  });
});
