import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '@moka/core';
import { InMemoryRateLimiter, enforceRateLimit } from './rate-limit.js';

describe('InMemoryRateLimiter', () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new InMemoryRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await limiter.consume('key', 5, 60);
      expect(result.allowed, `request ${i + 1} should be allowed`).toBe(true);
    }
  });

  it('blocks the request after the limit', async () => {
    for (let i = 0; i < 5; i += 1) await limiter.consume('key', 5, 60);
    const blocked = await limiter.consume('key', 5, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports the remaining allowance', async () => {
    expect((await limiter.consume('key', 3, 60)).remaining).toBe(2);
    expect((await limiter.consume('key', 3, 60)).remaining).toBe(1);
    expect((await limiter.consume('key', 3, 60)).remaining).toBe(0);
  });

  it('keys are independent', async () => {
    for (let i = 0; i < 5; i += 1) await limiter.consume('a', 5, 60);
    expect((await limiter.consume('a', 5, 60)).allowed).toBe(false);
    expect((await limiter.consume('b', 5, 60)).allowed).toBe(true);
  });

  it('resets once the window elapses', async () => {
    for (let i = 0; i < 5; i += 1) await limiter.consume('key', 5, 60);
    expect((await limiter.consume('key', 5, 60)).allowed).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect((await limiter.consume('key', 5, 60)).allowed).toBe(true);
  });

  it('does not reset early', async () => {
    for (let i = 0; i < 5; i += 1) await limiter.consume('key', 5, 60);
    vi.advanceTimersByTime(30_000);
    expect((await limiter.consume('key', 5, 60)).allowed).toBe(false);
  });

  // An unbounded map keyed by IP is a memory-exhaustion vector.
  it('evicts expired buckets so the map cannot grow without bound', async () => {
    for (let i = 0; i < 500; i += 1) await limiter.consume(`key-${i}`, 5, 1);

    vi.advanceTimersByTime(60_000);
    await limiter.consume('trigger-sweep', 5, 60);

    const size = (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
    expect(size).toBeLessThan(500);
  });
});

describe('enforceRateLimit', () => {
  it('passes through while under the limit', async () => {
    const limiter = new InMemoryRateLimiter();
    await expect(enforceRateLimit(limiter, 'k', 2, 60)).resolves.toBeUndefined();
  });

  it('throws RateLimitedError with a retry hint once exceeded', async () => {
    const limiter = new InMemoryRateLimiter();
    await enforceRateLimit(limiter, 'k', 1, 60);

    await expect(enforceRateLimit(limiter, 'k', 1, 60)).rejects.toThrow(RateLimitedError);

    try {
      await enforceRateLimit(limiter, 'k', 1, 60);
    } catch (error) {
      const body = (error as RateLimitedError).toPublicJSON();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.details?.['retryAfterSeconds']).toBeGreaterThan(0);
      // The message must not reveal the limit or the key.
      expect(body.error.message).not.toContain('k');
    }
  });
});
