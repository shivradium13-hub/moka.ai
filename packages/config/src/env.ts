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
   * Session-cookie `SameSite`, and why this has to be configurable.
   *
   * `lax` is the default and the safer value: the browser refuses to send the
   * cookie on cross-site subresource requests, which blocks CSRF outright.
   *
   * It also silently breaks a split-domain deployment. "Same site" means the
   * same registrable domain, so `app.example.com` and `api.example.com` are
   * same-site and work perfectly — but `myapp.vercel.app` and
   * `myapi.up.railway.app` are NOT, and under `lax` the browser will not send
   * the session cookie on a single `fetch()`. Login appears to succeed and
   * every request afterwards is a 401, with nothing in any log explaining why.
   *
   * `none` makes that arrangement work and requires `Secure`, which is why it
   * is refused outside production below. It gives up the SameSite half of the
   * CSRF defence; the Origin check on state-changing requests
   * (apps/api/src/main.ts) is what replaces it.
   *
   * PREFER A SHARED PARENT DOMAIN over setting this to `none`. Putting the API
   * on `api.yourdomain.com` and the app on `app.yourdomain.com` keeps `lax`
   * and needs no trade-off at all.
   */
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  /*
   * Optional cookie `Domain`.
   *
   * Set it to a shared parent (`.yourdomain.com`) when the app and API are
   * subdomains of one domain, so the cookie issued by the API is sent to it
   * from the app's origin under `SameSite=lax`.
   *
   * Left unset the cookie is host-only, which is the tighter default: it is
   * sent to exactly the host that set it and to no sibling subdomain.
   */
  COOKIE_DOMAIN: z.string().min(1).optional(),

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

  /*
   * Web search for the research pipeline — OPTIONAL and FREE.
   *
   * A SearXNG instance the operator runs themselves. There is deliberately no
   * bundled search provider: the good ones are paid, and scraping the free
   * ones violates their terms (master prompt §2). Unset, research still works
   * against URLs a user supplies, and the UI says so rather than pretending a
   * keyword search happened.
   *
   * It may point at a private address — a self-hosted instance usually does —
   * and that exception is derived from THIS value alone. See
   * `configuredInternalHosts` in @moka/net for why a config-supplied private
   * host is categorically different from a request-supplied one.
   */
  /*
   * Whether an operator takes payment OUTSIDE this system — an invoice, a
   * bank transfer, or a self-hosted deployment with no billing at all.
   *
   * With it set, an administrator can activate a paid plan and the audit log
   * records that a HUMAN asserted the payment. Without it, plan upgrades are
   * refused with an explanation, because no card processor is integrated and
   * §45 forbids faking a payment confirmation.
   *
   * Defaults to false: a deployment that has configured nothing must not
   * appear to accept payment.
   */
  BILLING_MANUAL_PAYMENTS: booleanish.default('false'),

  SEARXNG_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
      message: 'must be an http:// or https:// URL',
    })
    .optional(),
});

/**
 * Cross-field rules, checked in EVERY environment rather than only production.
 *
 * `findProductionViolations` below runs only when NODE_ENV is production. This
 * one has to run everywhere, because the mistake it catches is a development
 * mistake: `secure` is derived from NODE_ENV, and a `SameSite=None` cookie
 * without `Secure` is discarded by every current browser. The cookie is never
 * stored, every request after login is a 401, and nothing logs a reason —
 * which is precisely the failure `COOKIE_SAMESITE` exists to fix, arrived at
 * from the opposite direction.
 */
export const envSchemaChecked = envSchema.superRefine((env, ctx) => {
  if (env.COOKIE_SAMESITE === 'none' && env.NODE_ENV !== 'production') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SAMESITE'],
      message:
        'COOKIE_SAMESITE=none requires the Secure attribute, which is only set when ' +
        'NODE_ENV=production. Browsers discard a SameSite=None cookie without Secure, ' +
        'so every request after login would fail with no error explaining why. ' +
        'In development, leave it at "lax" — localhost to localhost is same-site.',
    });
  }
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

/**
 * Configuration that is survivable in development and dangerous in production.
 *
 * These are the settings where the failure is SILENT — nothing errors, nothing
 * looks wrong, and the cost is paid later by somebody who cannot see the
 * configuration. A misconfiguration that crashes needs no check here; it
 * announces itself.
 *
 * Every entry below names the consequence rather than the rule, because the
 * operator reading this message at 3am needs to decide whether to override it,
 * and "DATABASE_SSL must be true" does not help them decide anything.
 */
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

  /*
   * A plaintext origin means the session cookie is sent in the clear. The
   * cookie is `httpOnly` and `sameSite: lax`, neither of which helps against
   * somebody reading the wire.
   */
  const insecureOrigins = env.CORS_ORIGINS.filter((o) => o.startsWith('http://'));
  if (insecureOrigins.length > 0) {
    problems.push(
      `CORS_ORIGINS contains plaintext origins (${insecureOrigins.join(', ')}). ` +
        'Session cookies would travel unencrypted to those sites.',
    );
  }

  /*
   * The cheap, static half of the runtime check in @moka/db.
   *
   * `assertRuntimeRoleIsConstrained` asks the server whether the role can
   * bypass RLS, which is authoritative but requires a connection. This catches
   * the most common form of the same mistake before one is opened, and names
   * it as configuration rather than as a startup crash.
   */
  const dbUser = databaseUser(env.DATABASE_URL);
  if (dbUser === 'postgres') {
    problems.push(
      'DATABASE_URL connects as "postgres", the superuser. Row-level security ' +
        'does not apply to a superuser, so every tenant-isolation policy in the ' +
        'database would stop applying — silently, with no request failing. ' +
        'Use the unprivileged application role (moka_app).',
    );
  }
  if (env.DATABASE_MIGRATION_URL && env.DATABASE_MIGRATION_URL === env.DATABASE_URL) {
    problems.push(
      'DATABASE_URL and DATABASE_MIGRATION_URL are the same connection. The ' +
        'migration role owns the tables, and a table owner can run ALTER TABLE ' +
        '... DISABLE ROW LEVEL SECURITY. Serving requests as that role means an ' +
        'application bug can switch off tenant isolation. Keep the two roles separate.',
    );
  }

  /*
   * Instance-wide provider keys are a DEVELOPMENT convenience (see the schema
   * above). In production they mean every organization spends the operator's
   * key, so per-tenant cost attribution, per-tenant limits and per-tenant
   * revocation all quietly stop being true.
   */
  const shared = (
    [
      ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY],
      ['OPENAI_API_KEY', env.OPENAI_API_KEY],
      ['GEMINI_API_KEY', env.GEMINI_API_KEY],
    ] as const
  )
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name);
  if (shared.length > 0) {
    problems.push(
      `Instance-wide provider keys are set (${shared.join(', ')}). Every ` +
        "organization would spend the operator's key, and per-tenant cost " +
        'attribution, quotas and revocation would all be fictional. Production ' +
        'deployments use per-organization credentials (Moka Credentials).',
    );
  }

  /*
   * Debug logging is not a vulnerability by itself; it is how one is created.
   * At `debug` and below this codebase logs request context that can carry
   * user-supplied content, and logs are the place secrets end up when nobody
   * intended them to.
   */
  if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') {
    problems.push(
      `LOG_LEVEL is "${env.LOG_LEVEL}" in production. Verbose logs capture ` +
        'request context, and log storage is rarely protected as carefully as ' +
        'the database it describes.',
    );
  }

  /*
   * `SameSite=None` without `Secure` is rejected by every current browser, so
   * the cookie would simply never be stored — the same silent 401 loop the
   * setting exists to fix, arrived at from the other direction.
   *
   * `secure` is derived from NODE_ENV, so inside this branch it is already
   * true. The check below catches the remaining mistake: a cookie domain that
   * cannot possibly match the app it is meant to be sent from.
   */
  if (env.COOKIE_DOMAIN) {
    const bare = env.COOKIE_DOMAIN.replace(/^\./, '').toLowerCase();
    const matches = env.CORS_ORIGINS.some((origin) => {
      const host = hostOf(origin).toLowerCase();
      return host === bare || host.endsWith(`.${bare}`);
    });
    if (!matches) {
      problems.push(
        `COOKIE_DOMAIN is "${env.COOKIE_DOMAIN}" but no origin in CORS_ORIGINS is ` +
          'under it, so the browser would discard the session cookie and every ' +
          'authenticated request would fail with no error explaining why.',
      );
    }
  }

  /*
   * A SearXNG instance reached over plaintext on a PUBLIC address exposes every
   * research query to the path. Over a private address it is the normal
   * self-hosted arrangement and is not flagged.
   */
  if (env.SEARXNG_URL?.startsWith('http://') && !isPrivateHostname(hostOf(env.SEARXNG_URL))) {
    problems.push(
      'SEARXNG_URL is a plaintext http:// URL on a public address. Every ' +
        'research query would be readable in transit.',
    );
  }

  return problems;
}

/** Username from a postgres URL, or null if it carries none. */
function databaseUser(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.username ? decodeURIComponent(parsed.username) : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A deliberately conservative literal check.
 *
 * This is NOT the SSRF defence — that one resolves DNS and inspects the
 * address actually connected to, and lives in @moka/net. This only decides
 * whether to nag an operator about plaintext, so a hostname that merely looks
 * private is enough, and being wrong costs a spurious warning rather than a
 * security hole.
 */
function isPrivateHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || host === '::1') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}
