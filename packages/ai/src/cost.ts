import { findModel } from './registry.js';
import type { ModelDescriptor, TokenUsage } from './types.js';

/**
 * Cost accounting (docs/architecture.md §17, §35).
 *
 * Two rules, both about not lying with numbers:
 *
 *  1. If pricing for a model is not known, the result is `known: false` and
 *     `microUsd: null`. It never falls back to an average, a sibling model's
 *     rate, or zero. A wrong cost figure is worse than a missing one because
 *     people budget against it.
 *
 *  2. Money is integer MICRO-dollars, never a float. Floating-point drift is
 *     invisible per request and material across millions of them.
 */

export interface CostResult {
  readonly known: boolean;
  /** Integer millionths of a US dollar. Null when pricing is unknown. */
  readonly microUsd: number | null;
  /** Present when `known` is false, for display and diagnosis. */
  readonly reason?: string;
  readonly pricingSource?: string;
  readonly pricingVerifiedOn?: string;
}

const MICRO = 1_000_000;

/** Cost of `tokens` at `perMillion` USD/1M, in integer micro-dollars. */
function tokensToMicroUsd(tokens: number, perMillion: number): number {
  if (tokens <= 0 || perMillion <= 0) return 0;
  // (tokens / 1e6) * perMillion * 1e6  ==  tokens * perMillion
  return Math.round(tokens * perMillion);
}

export function estimateCost(model: ModelDescriptor, usage: TokenUsage): CostResult {
  if (!model.pricing) {
    return {
      known: false,
      microUsd: null,
      reason: `Pricing for ${model.id} is not configured in this build.`,
    };
  }

  const { pricing } = model;

  // Cached tokens are billed differently where a provider reports them. When
  // a specific cache rate is absent, cache reads are billed at the input rate
  // rather than silently treated as free.
  const cacheWriteRate = pricing.cacheWritePerMillion ?? pricing.inputPerMillion;
  const cacheReadRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion;

  const microUsd =
    tokensToMicroUsd(usage.inputTokens, pricing.inputPerMillion) +
    tokensToMicroUsd(usage.outputTokens, pricing.outputPerMillion) +
    tokensToMicroUsd(usage.cacheWriteTokens, cacheWriteRate) +
    tokensToMicroUsd(usage.cacheReadTokens, cacheReadRate);

  return {
    known: true,
    microUsd,
    pricingSource: pricing.source,
    pricingVerifiedOn: pricing.verifiedOn,
  };
}

export function estimateCostByModelId(modelId: string, usage: TokenUsage): CostResult {
  const model = findModel(modelId);
  if (!model) {
    return { known: false, microUsd: null, reason: `Unknown model ${modelId}.` };
  }
  return estimateCost(model, usage);
}

/** Format micro-dollars for display. Returns null when cost is unknown. */
export function formatMicroUsd(microUsd: number | null): string | null {
  if (microUsd === null) return null;
  const dollars = microUsd / MICRO;
  // Sub-cent amounts are the norm for a single request; show enough digits
  // that a real cost never renders as "$0.00".
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(6)}`;
  return `$${dollars.toFixed(4)}`;
}
