import { z } from 'zod';

/**
 * Environment schema (docs/roadmap.md §1.2).
 *
 * Loaded once at boot. Any failure aborts the process with a readable message
 * naming the offending variable — the system must never start half-configured.
 */

/** 32 raw bytes, base64-encoded. Enforced, not assumed. */
const base64Key32 = z
  .string()
  .min(1, 'must be set')
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    {
      message:
        'must be exactly 32 bytes, base64-encoded. Generate with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    },
  );

const base64Secret = z
  .string()
  .min(1, 'must be set')
  .refine((v) => Buffer.from(v, 'base64').length >= 32, {
    message: 'must be at least 32 bytes, base64-encoded.',
  });

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
    message: 'must be a postgres:// or postgresql:// connection string',
  });

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  DATABASE_URL: postgresUrl,
  DATABASE_MIGRATION_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: booleanish.default('false'),

  REDIS_URL: z.string().optional(),

  ENCRYPTION_KEY: base64Key32,
  AUTH_SECRET: base64Secret,
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(2592000),

  /*
   * Provider keys — DEVELOPMENT ONLY.
   *
   * These are instance-wide, so every organization shares them. Phase 4
   * replaces this with per-organization encrypted credentials; until then a
   * multi-tenant deployment must not rely on them.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./local/storage'),
});

export type Env = z.infer<typeof envSchema>;

/* -------------------------------------------------------------------------- */
/* NEXT_PUBLIC_ guard                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Anything prefixed NEXT_PUBLIC_ is inlined into the browser bundle. A secret
 * placed there is published, not configured. We refuse to boot rather than
 * leak (docs/security.md §3.2).
 */
const FORBIDDEN_PUBLIC_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /password/i,
  /token/i,
  /api[-_]?key/i,
  /private/i,
  /credential/i,
  /encryption/i,
  /database[-_]?url/i,
  /_dsn$/i,
];

export function findLeakyPublicVars(source: Record<string, string | undefined>): string[] {
  return Object.keys(source)
    .filter((k) => k.startsWith('NEXT_PUBLIC_'))
    .filter((k) => FORBIDDEN_PUBLIC_PATTERNS.some((p) => p.test(k)));
}

/* -------------------------------------------------------------------------- */
/* Production hardening                                                        */
/* -------------------------------------------------------------------------- */

export function findProductionViolations(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  if (!env.REDIS_URL) {
    problems.push(
      'REDIS_URL is required in production. The in-memory rate limiter is ' +
        'single-process only and provides no real protection behind multiple instances.',
    );
  }
  if (!env.DATABASE_SSL) {
    problems.push('DATABASE_SSL must be true in production.');
  }
  if (env.API_HOST === '127.0.0.1') {
    problems.push('API_HOST is loopback-only; the service would be unreachable in production.');
  }
  if (env.CORS_ORIGINS.some((o) => o.includes('localhost'))) {
    problems.push('CORS_ORIGINS contains a localhost origin in production.');
  }
  return problems;
}
