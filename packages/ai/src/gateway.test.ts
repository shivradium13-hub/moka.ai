import { describe, expect, it } from 'vitest';
import { MODELS, findModel, listModels, modelsWithCapabilities } from './registry.js';
import { estimateCost, estimateCostByModelId, formatMicroUsd } from './cost.js';
import { defaultModelFor, estimateRequestTokens, planRoute } from './router.js';
import { ProviderError, ProviderErrorCode, codeFromHttpStatus, parseRetryAfter } from './errors.js';
import { Capability, EMPTY_USAGE, type ChatRequest, type TokenUsage } from './types.js';

const ALL_PROVIDERS = ['anthropic', 'openai', 'google'];
const ANTHROPIC_ONLY = ['anthropic'];

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: null, messages: [{ role: 'user', content: 'hello' }], ...overrides };
}

describe('registry', () => {
  it('has unique model ids', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every model a sane context and output window', () => {
    for (const model of MODELS) {
      expect(model.contextWindow, model.id).toBeGreaterThan(0);
      expect(model.maxOutputTokens, model.id).toBeGreaterThan(0);
      expect(model.maxOutputTokens, model.id).toBeLessThanOrEqual(model.contextWindow);
      expect(model.capabilities.length, model.id).toBeGreaterThan(0);
    }
  });

  it('finds and filters models', () => {
    expect(findModel('claude-opus-5')?.providerId).toBe('anthropic');
    expect(findModel('no-such-model')).toBeNull();
    expect(listModels({ providerId: 'anthropic' }).every((m) => m.providerId === 'anthropic')).toBe(
      true,
    );
  });

  it('orders capability matches by routing priority', () => {
    const matches = modelsWithCapabilities([Capability.TEXT]);
    const priorities = matches.map((m) => m.routingPriority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it('returns only models having ALL requested capabilities', () => {
    for (const model of modelsWithCapabilities([Capability.VISION, Capability.REASONING])) {
      expect(model.capabilities).toContain(Capability.VISION);
      expect(model.capabilities).toContain(Capability.REASONING);
    }
  });

  /*
   * Pricing is money. Anthropic figures come from the bundled reference and
   * must carry a source and date; OpenAI/Google pricing could not be verified
   * in this build and is therefore null rather than guessed.
   */
  describe('pricing provenance', () => {
    it('cites a source and date wherever pricing exists', () => {
      for (const model of MODELS) {
        if (!model.pricing) continue;
        expect(model.pricing.source, model.id).toBeTruthy();
        expect(model.pricing.verifiedOn, model.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(model.pricing.inputPerMillion, model.id).toBeGreaterThan(0);
        expect(model.pricing.outputPerMillion, model.id).toBeGreaterThan(0);
      }
    });

    it('leaves unverified pricing null rather than estimating', () => {
      expect(findModel('gpt-4o')?.pricing).toBeNull();
      expect(findModel('gemini-2.0-flash')?.pricing).toBeNull();
    });

    it('prices output above input, as every provider does', () => {
      for (const model of MODELS) {
        if (!model.pricing) continue;
        expect(model.pricing.outputPerMillion, model.id).toBeGreaterThan(
          model.pricing.inputPerMillion,
        );
      }
    });
  });
});

describe('cost', () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };

  it('computes a known cost in integer micro-dollars', () => {
    const model = findModel('claude-opus-5')!;
    const result = estimateCost(model, usage);

    expect(result.known).toBe(true);
    // $5 input + $25 output = $30 = 30,000,000 micro-dollars
    expect(result.microUsd).toBe(30_000_000);
    expect(Number.isInteger(result.microUsd)).toBe(true);
  });

  it('reports UNKNOWN rather than guessing when pricing is absent', () => {
    const result = estimateCost(findModel('gpt-4o')!, usage);
    expect(result.known).toBe(false);
    expect(result.microUsd).toBeNull();
    expect(result.reason).toMatch(/not configured/i);
  });

  it('reports unknown for an unrecognised model', () => {
    const result = estimateCostByModelId('made-up', usage);
    expect(result.known).toBe(false);
    expect(result.microUsd).toBeNull();
  });

  it('is zero for zero usage', () => {
    expect(estimateCost(findModel('claude-opus-5')!, EMPTY_USAGE).microUsd).toBe(0);
  });

  it('bills cache reads at the input rate when no cache rate is given', () => {
    const model = findModel('claude-opus-5')!;
    const cached = estimateCost(model, {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    // Never silently free.
    expect(cached.microUsd).toBe(5_000_000);
  });

  it('scales linearly and stays integral for small requests', () => {
    const model = findModel('claude-sonnet-5')!;
    const result = estimateCost(model, {
      inputTokens: 1234,
      outputTokens: 567,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    // 1234 * 2 + 567 * 10 = 2468 + 5670 = 8138 micro-dollars
    expect(result.microUsd).toBe(8138);
  });

  it('carries the pricing provenance through to the result', () => {
    const result = estimateCost(findModel('claude-opus-5')!, usage);
    expect(result.pricingSource).toBeTruthy();
    expect(result.pricingVerifiedOn).toBe('2026-06-24');
  });

  describe('formatting', () => {
    it('shows sub-cent amounts with enough precision to be non-zero', () => {
      expect(formatMicroUsd(8138)).toBe('$0.008138');
    });

    it('formats larger amounts conventionally', () => {
      expect(formatMicroUsd(30_000_000)).toBe('$30.0000');
    });

    it('returns null for unknown cost, never "$0.00"', () => {
      expect(formatMicroUsd(null)).toBeNull();
    });
  });
});

describe('router', () => {
  it('honours an explicitly requested model', () => {
    const plan = planRoute(request({ model: 'claude-sonnet-5' }), {
      availableProviders: ALL_PROVIDERS,
    });
    expect(plan.primary.id).toBe('claude-sonnet-5');
  });

  /*
   * Substituting a different model for an explicit request would bill the
   * caller for something they did not ask for.
   */
  it('errors rather than substituting when the requested model is unusable', () => {
    expect(() =>
      planRoute(request({ model: 'gpt-4o' }), { availableProviders: ANTHROPIC_ONLY }),
    ).toThrow(ProviderError);

    try {
      planRoute(request({ model: 'gpt-4o' }), { availableProviders: ANTHROPIC_ONLY });
    } catch (error) {
      expect((error as ProviderError).code).toBe(ProviderErrorCode.NO_CREDENTIAL);
    }
  });

  it('errors on an unknown model id', () => {
    try {
      planRoute(request({ model: 'not-real' }), { availableProviders: ALL_PROVIDERS });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ProviderError).code).toBe(ProviderErrorCode.INVALID_REQUEST);
    }
  });

  it('picks the highest-priority usable model when none is requested', () => {
    const plan = planRoute(request(), { availableProviders: ALL_PROVIDERS });
    expect(plan.primary.providerId).toBe('anthropic');
    expect(plan.fallbacks.length).toBeGreaterThan(0);
  });

  it('never plans a model whose provider has no credential', () => {
    const plan = planRoute(request(), { availableProviders: ANTHROPIC_ONLY });
    for (const model of [plan.primary, ...plan.fallbacks]) {
      expect(model.providerId).toBe('anthropic');
    }
  });

  it('respects operator-disabled models', () => {
    const plan = planRoute(request(), {
      availableProviders: ALL_PROVIDERS,
      disabledModelIds: ['claude-fable-5-1', 'claude-opus-5'],
    });
    expect(plan.primary.id).not.toBe('claude-opus-5');
    expect(plan.primary.id).not.toBe('claude-fable-5-1');
  });

  it('requires vision when the request contains an image', () => {
    const plan = planRoute(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
        ],
      }),
      { availableProviders: ALL_PROVIDERS },
    );
    expect(plan.primary.capabilities).toContain(Capability.VISION);
  });

  it('requires reasoning at high effort', () => {
    const plan = planRoute(request({ effort: 'high' }), { availableProviders: ALL_PROVIDERS });
    expect(plan.primary.capabilities).toContain(Capability.REASONING);
  });

  it('excludes models whose context window is too small', () => {
    const huge = 'x'.repeat(900_000); // ~300k tokens by the estimator
    const plan = planRoute(request({ messages: [{ role: 'user', content: huge }] }), {
      availableProviders: ALL_PROVIDERS,
    });
    expect(plan.primary.contextWindow).toBeGreaterThan(250_000);
    for (const model of plan.fallbacks) {
      expect(model.contextWindow).toBeGreaterThan(250_000);
    }
  });

  it('distinguishes "no credentials" from "nothing fits"', () => {
    try {
      planRoute(request(), { availableProviders: [] });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ProviderError).code).toBe(ProviderErrorCode.NO_CREDENTIAL);
    }
  });

  it('never lists the primary among its own fallbacks', () => {
    const plan = planRoute(request(), { availableProviders: ALL_PROVIDERS });
    expect(plan.fallbacks.map((m) => m.id)).not.toContain(plan.primary.id);
  });

  it('estimates tokens from text and images', () => {
    expect(estimateRequestTokens(request({ messages: [{ role: 'user', content: 'abc' }] }))).toBe(1);
    const withImage = estimateRequestTokens(
      request({
        messages: [
          { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
        ],
      }),
    );
    // An image must not be counted as one character.
    expect(withImage).toBeGreaterThan(500);
  });

  it('falls back to any usable model when the default is unavailable', () => {
    expect(defaultModelFor({ availableProviders: ALL_PROVIDERS })?.id).toBe('claude-opus-5');
    expect(defaultModelFor({ availableProviders: ['openai'] })?.providerId).toBe('openai');
    expect(defaultModelFor({ availableProviders: [] })).toBeNull();
  });
});

describe('provider errors', () => {
  it('maps HTTP statuses consistently across providers', () => {
    expect(codeFromHttpStatus(401)).toBe(ProviderErrorCode.AUTHENTICATION);
    expect(codeFromHttpStatus(403)).toBe(ProviderErrorCode.AUTHENTICATION);
    expect(codeFromHttpStatus(429)).toBe(ProviderErrorCode.RATE_LIMITED);
    expect(codeFromHttpStatus(400)).toBe(ProviderErrorCode.INVALID_REQUEST);
    expect(codeFromHttpStatus(500)).toBe(ProviderErrorCode.UNAVAILABLE);
    expect(codeFromHttpStatus(503)).toBe(ProviderErrorCode.UNAVAILABLE);
  });

  it('marks only transient conditions retryable', () => {
    const retryable = [ProviderErrorCode.RATE_LIMITED, ProviderErrorCode.UNAVAILABLE];
    for (const code of Object.values(ProviderErrorCode)) {
      const error = new ProviderError({ code, providerId: 'test' });
      expect(error.retryable, code).toBe(retryable.includes(code as never));
    }
  });

  it('allows fallback for credential problems but not for a bad request', () => {
    expect(
      new ProviderError({ code: ProviderErrorCode.AUTHENTICATION, providerId: 'x' }).shouldFallback,
    ).toBe(true);
    expect(
      new ProviderError({ code: ProviderErrorCode.INVALID_REQUEST, providerId: 'x' }).shouldFallback,
    ).toBe(false);
    // A malformed request will fail identically on another provider.
    expect(
      new ProviderError({ code: ProviderErrorCode.CONTEXT_LENGTH, providerId: 'x' }).shouldFallback,
    ).toBe(false);
  });

  it('keeps upstream detail out of the public message', () => {
    const error = new ProviderError({
      code: ProviderErrorCode.INVALID_REQUEST,
      providerId: 'anthropic',
      internalMessage: 'prompt contained SECRET-VALUE at index 3',
    });
    expect(error.publicMessage).not.toContain('SECRET-VALUE');
    expect(error.message).toContain('SECRET-VALUE');
  });

  it('parses Retry-After as seconds or as a date', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('nonsense')).toBeNull();
    const future = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(future)).toBeGreaterThan(50_000);
  });
});
