import { DEFAULT_MODEL_ID, findModel, modelsWithCapabilities } from './registry.js';
import { ProviderError, ProviderErrorCode } from './errors.js';
import { Capability, type ChatRequest, type ModelDescriptor } from './types.js';

/**
 * Model router (docs/architecture.md §17).
 *
 * Produces an ordered plan — a primary model plus fallbacks — rather than a
 * single choice, so a provider outage is handled by walking the plan instead
 * of failing the request.
 *
 * Routing is constrained by what the ORGANIZATION can actually use. A model
 * with no usable credential is never planned, because "route to the best
 * model" that then fails on a missing key is worse than routing to a model
 * that works.
 */

export interface RoutingContext {
  /** Providers the organization has a working credential for. */
  readonly availableProviders: readonly string[];
  /** Models an operator has disabled for this organization, if any. */
  readonly disabledModelIds?: readonly string[];
}

export interface RoutingPlan {
  readonly primary: ModelDescriptor;
  readonly fallbacks: readonly ModelDescriptor[];
  readonly reason: string;
}

function isUsable(model: ModelDescriptor, context: RoutingContext): boolean {
  if (!context.availableProviders.includes(model.providerId)) return false;
  if (context.disabledModelIds?.includes(model.id)) return false;
  return model.status === 'available';
}

/**
 * Rough token estimate for context-window fit.
 *
 * Deliberately approximate and deliberately generous: it exists to avoid
 * routing a clearly-oversized conversation to a small-context model, not to
 * predict billing. Under-estimating here would send a request that fails at
 * the provider, so the estimate rounds up.
 */
export function estimateRequestTokens(request: ChatRequest): number {
  let characters = request.system?.length ?? 0;
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      characters += message.content.length;
    } else {
      for (const part of message.content) {
        // A base64 image costs far more than its character count suggests;
        // this is a coarse floor, not an accurate count.
        characters += part.type === 'text' ? part.text.length : 2000;
      }
    }
  }
  return Math.ceil(characters / 3);
}

function inferCapabilities(request: ChatRequest): Capability[] {
  const capabilities = new Set<Capability>(request.requiredCapabilities ?? []);
  capabilities.add(Capability.TEXT);

  const hasImage = request.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((part) => part.type === 'image'),
  );
  if (hasImage) capabilities.add(Capability.VISION);

  if (request.effort === 'high') capabilities.add(Capability.REASONING);

  // Only add LONG_CONTEXT when the request genuinely needs it: requiring it
  // unnecessarily would exclude otherwise-suitable models.
  if (estimateRequestTokens(request) > 150_000) capabilities.add(Capability.LONG_CONTEXT);

  return [...capabilities];
}

export function planRoute(request: ChatRequest, context: RoutingContext): RoutingPlan {
  const estimatedTokens = estimateRequestTokens(request);

  /*
   * An explicitly requested model is honoured, not second-guessed. If the
   * caller named a model they cannot use, that is an error they need to see —
   * silently substituting another model would mean a user asking for one
   * model gets billed for a different one.
   */
  if (request.model) {
    const model = findModel(request.model);
    if (!model) {
      throw new ProviderError({
        code: ProviderErrorCode.INVALID_REQUEST,
        providerId: 'router',
        modelId: request.model,
        internalMessage: `Unknown model ${request.model}.`,
      });
    }
    if (!isUsable(model, context)) {
      throw new ProviderError({
        code: ProviderErrorCode.NO_CREDENTIAL,
        providerId: model.providerId,
        modelId: model.id,
        internalMessage: `No usable credential for provider ${model.providerId}.`,
      });
    }

    // Fallbacks stay within the same capability class so a failover does not
    // quietly downgrade what the caller asked for.
    const fallbacks = modelsWithCapabilities(model.capabilities)
      .filter((candidate) => candidate.id !== model.id && isUsable(candidate, context))
      .filter((candidate) => candidate.contextWindow >= estimatedTokens)
      .slice(0, 2);

    return { primary: model, fallbacks, reason: 'explicit model requested' };
  }

  const required = inferCapabilities(request);
  const candidates = modelsWithCapabilities(required)
    .filter((model) => isUsable(model, context))
    .filter((model) => model.contextWindow >= estimatedTokens);

  const primary = candidates[0];
  if (!primary) {
    // Distinguish "nothing is configured" from "nothing fits", because the
    // fixes are completely different.
    const anyUsable = modelsWithCapabilities([Capability.TEXT]).some((model) =>
      isUsable(model, context),
    );
    throw new ProviderError({
      code: anyUsable ? ProviderErrorCode.INVALID_REQUEST : ProviderErrorCode.NO_CREDENTIAL,
      providerId: 'router',
      internalMessage: anyUsable
        ? `No available model satisfies capabilities [${required.join(', ')}] with a ${estimatedTokens}-token context.`
        : 'No AI provider credential is configured for this organization.',
    });
  }

  return {
    primary,
    fallbacks: candidates.slice(1, 3),
    reason: `capabilities [${required.join(', ')}]`,
  };
}

/** The model used when a caller expresses no preference and it is usable. */
export function defaultModelFor(context: RoutingContext): ModelDescriptor | null {
  const preferred = findModel(DEFAULT_MODEL_ID);
  if (preferred && isUsable(preferred, context)) return preferred;
  return modelsWithCapabilities([Capability.TEXT]).find((model) => isUsable(model, context)) ?? null;
}
