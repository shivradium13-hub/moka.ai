import { Injectable } from '@nestjs/common';
import { RateLimitedError } from '@moka/core';

/**
 * Rate limiting (docs/security.md §9).
 *
 * Driver-based so the storage can change without touching call sites.
 *
 * The in-memory driver is genuinely functional, but ONLY within one process.
 * It is not a stand-in for the real thing: @moka/config refuses to boot in
 * production without REDIS_URL, precisely so this driver cannot silently
 * become the production limiter behind multiple instances.
 *
 * TODO(Phase 1.8): ValkeyRateLimiter, once Valkey is available on this host.
 * Not implemented rather than faked (§45).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
  }

  /** Evict expired buckets so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

/**
 * Enforce a limit, throwing the standard 429 when exceeded.
 * Login uses a deliberately tight limit to blunt credential stuffing.
 */
export async function enforceRateLimit(
  limiter: RateLimiter,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await limiter.consume(key, limit, windowSeconds);
  if (!result.allowed) {
    throw new RateLimitedError(result.retryAfterSeconds);
  }
}
