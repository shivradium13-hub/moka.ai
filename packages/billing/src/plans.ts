import { Feature, type EntitlementRow } from './entitlements.js';

/**
 * The default plan catalogue (master prompt §34).
 *
 * THIS IS SEED DATA, NOT A HARD-CODED LIMIT, and the difference is the gate.
 *
 * These become rows in `plans` and `plan_entitlements` the first time the seed
 * runs. After that the database is authoritative: an operator changes what a
 * plan includes with an UPDATE, and nothing here is consulted again. No
 * enforcement path imports this file.
 *
 * A test asserts that — the only importers are the seed script and the tests
 * themselves. If an enforcement call site ever reaches for `FREE_PLAN.limits`
 * to answer a question, the limit has silently become hard-coded again and the
 * whole three-layer design is decoration.
 *
 * ON THE NUMBERS THEMSELVES: they are a plausible starting shape, not a
 * pricing decision. Nobody has done the unit economics, no market research
 * informs them, and the free tier's credit allowance in particular is a guess
 * at "enough to evaluate the product". Presenting them as considered would be
 * the kind of false precision this codebase avoids elsewhere.
 */

export interface PlanDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Integer cents per month. 0 for free. Null means "contact us". */
  readonly priceMonthlyCents: number | null;
  readonly currency: string;
  readonly sortOrder: number;
  readonly entitlements: readonly EntitlementRow[];
}

const MICRO = 1_000_000;
const GB = 1024 * 1024 * 1024;

/** Models a plan may call. Ids match `packages/ai` registry entries. */
const CHEAP_MODELS = ['claude-haiku-4-5-20251001', 'gpt-4o-mini'];

export const DEFAULT_PLANS: readonly PlanDefinition[] = [
  {
    key: 'free',
    name: 'Free',
    description: 'Enough to evaluate the product on real data.',
    priceMonthlyCents: 0,
    currency: 'USD',
    sortOrder: 0,
    entitlements: [
      // $2 of AI usage. A guess at "enough to try it", not a costed figure.
      { featureKey: Feature.AI_CREDITS_MICRO_USD, limitValue: 2 * MICRO },
      { featureKey: Feature.AI_MODELS, limitValue: 0, allowedValues: CHEAP_MODELS },
      { featureKey: Feature.AGENTS_MAX, limitValue: 2 },
      { featureKey: Feature.AGENT_RUNS_PER_MONTH, limitValue: 50 },
      { featureKey: Feature.CHATBOTS_MAX, limitValue: 1 },
      { featureKey: Feature.CHATBOT_DEPLOYMENTS_MAX, limitValue: 1 },
      { featureKey: Feature.CHATBOT_MESSAGES_PER_MONTH, limitValue: 200 },
      { featureKey: Feature.KNOWLEDGE_SOURCES_MAX, limitValue: 3 },
      { featureKey: Feature.KNOWLEDGE_STORAGE_BYTES, limitValue: 100 * 1024 * 1024 },
      { featureKey: Feature.RESEARCH_RUNS_PER_MONTH, limitValue: 20 },
      { featureKey: Feature.PROJECTS_MAX, limitValue: 3 },
      { featureKey: Feature.SEATS_MAX, limitValue: 2 },
      { featureKey: Feature.API_REQUESTS_PER_MONTH, limitValue: 1_000 },
    ],
  },
  {
    key: 'team',
    name: 'Team',
    description: 'For a working team, with room to run agents in earnest.',
    priceMonthlyCents: 4900,
    currency: 'USD',
    sortOrder: 1,
    entitlements: [
      { featureKey: Feature.AI_CREDITS_MICRO_USD, limitValue: 50 * MICRO },
      // No allowedValues and a null limit: every model in the registry.
      { featureKey: Feature.AI_MODELS, limitValue: null },
      { featureKey: Feature.AGENTS_MAX, limitValue: 25 },
      { featureKey: Feature.AGENT_RUNS_PER_MONTH, limitValue: 2_000 },
      { featureKey: Feature.CHATBOTS_MAX, limitValue: 10 },
      { featureKey: Feature.CHATBOT_DEPLOYMENTS_MAX, limitValue: 25 },
      { featureKey: Feature.CHATBOT_MESSAGES_PER_MONTH, limitValue: 20_000 },
      { featureKey: Feature.KNOWLEDGE_SOURCES_MAX, limitValue: 50 },
      { featureKey: Feature.KNOWLEDGE_STORAGE_BYTES, limitValue: 10 * GB },
      { featureKey: Feature.RESEARCH_RUNS_PER_MONTH, limitValue: 1_000 },
      { featureKey: Feature.PROJECTS_MAX, limitValue: 50 },
      { featureKey: Feature.SEATS_MAX, limitValue: 20 },
      { featureKey: Feature.API_REQUESTS_PER_MONTH, limitValue: 250_000 },
    ],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Negotiated limits. Everything unlimited unless overridden.',
    // Null rather than a number: this tier is negotiated, and inventing a
    // price would be a claim about a commercial arrangement nobody has made.
    priceMonthlyCents: null,
    currency: 'USD',
    sortOrder: 2,
    entitlements: [
      /*
       * `null` here means UNLIMITED, and `entitlement_overrides` is how an
       * individual contract is expressed — which is the reason overrides exist
       * at all. Cloning a plan per customer produces a plan table nobody can
       * reason about and a pricing page that cannot be generated from it.
       */
      { featureKey: Feature.AI_CREDITS_MICRO_USD, limitValue: null },
      { featureKey: Feature.AI_MODELS, limitValue: null },
      { featureKey: Feature.AGENTS_MAX, limitValue: null },
      { featureKey: Feature.AGENT_RUNS_PER_MONTH, limitValue: null },
      { featureKey: Feature.CHATBOTS_MAX, limitValue: null },
      { featureKey: Feature.CHATBOT_DEPLOYMENTS_MAX, limitValue: null },
      { featureKey: Feature.CHATBOT_MESSAGES_PER_MONTH, limitValue: null },
      { featureKey: Feature.KNOWLEDGE_SOURCES_MAX, limitValue: null },
      { featureKey: Feature.KNOWLEDGE_STORAGE_BYTES, limitValue: null },
      { featureKey: Feature.RESEARCH_RUNS_PER_MONTH, limitValue: null },
      { featureKey: Feature.PROJECTS_MAX, limitValue: null },
      { featureKey: Feature.SEATS_MAX, limitValue: null },
      { featureKey: Feature.API_REQUESTS_PER_MONTH, limitValue: null },
    ],
  },
];

/**
 * The plan a brand-new organization is put on.
 *
 * A NAME rather than a set of limits. The organization gets a real
 * subscription row pointing at whatever `free` currently contains, so an
 * operator who edits the free plan changes what new signups receive without
 * touching code.
 */
export const DEFAULT_PLAN_KEY = 'free';

export function findPlanDefinition(key: string): PlanDefinition | undefined {
  return DEFAULT_PLANS.find((plan) => plan.key === key);
}
