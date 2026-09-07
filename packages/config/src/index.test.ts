import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ConfigurationError } from '@moka/core';
import { loadConfig } from './index.js';
import { findLeakyPublicVars, findProductionViolations, envSchema } from './env.js';

const KEY_32 = randomBytes(32).toString('base64');

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://moka_app:pw@127.0.0.1:5432/moka_ai',
    ENCRYPTION_KEY: KEY_32,
    AUTH_SECRET: KEY_32,
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('accepts a valid environment', () => {
    const config = loadConfig({ source: validEnv() });
    expect(config.NODE_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('reports every problem at once rather than one at a time', () => {
    try {
      loadConfig({ source: { NODE_ENV: 'development' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const message = (error as ConfigurationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('ENCRYPTION_KEY');
      expect(message).toContain('AUTH_SECRET');
    }
  });

  it('rejects an ENCRYPTION_KEY that is not exactly 32 bytes', () => {
    expect(() =>
      loadConfig({ source: validEnv({ ENCRYPTION_KEY: randomBytes(16).toString('base64') }) }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ source: validEnv({ ENCRYPTION_KEY: randomBytes(64).toString('base64') }) }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() =>
      loadConfig({ source: validEnv({ DATABASE_URL: 'mysql://localhost/db' }) }),
    ).toThrow(ConfigurationError);
  });

  it('parses CORS_ORIGINS into a trimmed list', () => {
    const config = loadConfig({
      source: validEnv({ CORS_ORIGINS: 'http://a.test, http://b.test ,' }),
    });
    expect(config.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ source: validEnv({ API_PORT: '70000' }) })).toThrow(
      ConfigurationError,
    );
  });
});

/*
 * A secret placed in NEXT_PUBLIC_ is inlined into the browser bundle — it is
 * published, not configured. The loader refuses to boot rather than leak.
 */
describe('NEXT_PUBLIC_ leak guard', () => {
  it('flags secret-looking public variables', () => {
    expect(findLeakyPublicVars({ NEXT_PUBLIC_API_SECRET: 'x' })).toEqual(['NEXT_PUBLIC_API_SECRET']);
    expect(findLeakyPublicVars({ NEXT_PUBLIC_OPENAI_API_KEY: 'x' })).toHaveLength(1);
    expect(findLeakyPublicVars({ NEXT_PUBLIC_DATABASE_URL: 'x' })).toHaveLength(1);
    expect(findLeakyPublicVars({ NEXT_PUBLIC_AUTH_TOKEN: 'x' })).toHaveLength(1);
    expect(findLeakyPublicVars({ NEXT_PUBLIC_PRIVATE_KEY: 'x' })).toHaveLength(1);
  });

  it('permits genuinely public variables', () => {
    expect(
      findLeakyPublicVars({
        NEXT_PUBLIC_API_URL: 'http://localhost:4000',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      }),
    ).toEqual([]);
  });

  it('refuses to boot when a leak is present', () => {
    expect(() =>
      loadConfig({ source: validEnv({ NEXT_PUBLIC_STRIPE_SECRET: 'sk-live' }) }),
    ).toThrow(/NEXT_PUBLIC_/);
  });
});

describe('production hardening', () => {
  const prodBase = envSchema.parse(
    validEnv({
      NODE_ENV: 'production',
      REDIS_URL: 'redis://valkey:6379',
      DATABASE_SSL: 'true',
      API_HOST: '0.0.0.0',
      CORS_ORIGINS: 'https://app.example.com',
    }),
  );

  it('passes a correctly configured production environment', () => {
    expect(findProductionViolations(prodBase)).toEqual([]);
  });

  it('requires REDIS_URL in production', () => {
    const env = envSchema.parse(
      validEnv({ NODE_ENV: 'production', DATABASE_SSL: 'true', API_HOST: '0.0.0.0', CORS_ORIGINS: 'https://app.example.com' }),
    );
    expect(findProductionViolations(env).join(' ')).toContain('REDIS_URL');
  });

  it('requires TLS to the database in production', () => {
    const env = envSchema.parse(
      validEnv({ NODE_ENV: 'production', REDIS_URL: 'redis://v:6379', API_HOST: '0.0.0.0', CORS_ORIGINS: 'https://app.example.com' }),
    );
    expect(findProductionViolations(env).join(' ')).toContain('DATABASE_SSL');
  });

  it('rejects a localhost CORS origin in production', () => {
    const env = envSchema.parse(
      validEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://v:6379',
        DATABASE_SSL: 'true',
        API_HOST: '0.0.0.0',
        CORS_ORIGINS: 'https://app.example.com,http://localhost:3000',
      }),
    );
    expect(findProductionViolations(env).join(' ')).toContain('CORS_ORIGINS');
  });

  const prod = (overrides: Record<string, string | undefined>) =>
    envSchema.parse(
      validEnv({
        NODE_ENV: 'production',
        REDIS_URL: 'redis://v:6379',
        DATABASE_SSL: 'true',
        API_HOST: '0.0.0.0',
        CORS_ORIGINS: 'https://app.example.com',
        ...overrides,
      }),
    );

  it('rejects a plaintext CORS origin, even a non-localhost one', () => {
    // The localhost check above would miss `http://staging.example.com`, which
    // is the same mistake with a domain name on it.
    const message = findProductionViolations(
      prod({ CORS_ORIGINS: 'https://app.example.com,http://staging.example.com' }),
    ).join(' ');
    expect(message).toContain('staging.example.com');
    expect(message).toContain('unencrypted');
  });

  it('refuses to serve requests as the postgres superuser', () => {
    /*
     * The highest-consequence entry in this function. A superuser is not
     * subject to RLS, so every isolation policy stops applying at once and
     * nothing fails — which is precisely why a static check is worth having in
     * addition to the runtime one in @moka/db.
     */
    const message = findProductionViolations(
      prod({ DATABASE_URL: 'postgresql://postgres:pw@db.internal:5432/moka_ai' }),
    ).join(' ');
    expect(message).toContain('superuser');
    expect(message).toContain('moka_app');
  });

  it('accepts the unprivileged application role', () => {
    // The control. A check that flagged every DATABASE_URL would be removed.
    expect(
      findProductionViolations(prod({ DATABASE_URL: 'postgresql://moka_app:pw@db:5432/moka_ai' })),
    ).toEqual([]);
  });

  it('refuses to run the application as the migration role', () => {
    const url = 'postgresql://moka_migrator:pw@db:5432/moka_ai';
    const message = findProductionViolations(
      prod({ DATABASE_URL: url, DATABASE_MIGRATION_URL: url }),
    ).join(' ');
    expect(message).toContain('DISABLE ROW LEVEL SECURITY');
  });

  it('allows the two roles to differ, which is the intended arrangement', () => {
    expect(
      findProductionViolations(
        prod({
          DATABASE_URL: 'postgresql://moka_app:pw@db:5432/moka_ai',
          DATABASE_MIGRATION_URL: 'postgresql://moka_migrator:pw@db:5432/moka_ai',
        }),
      ),
    ).toEqual([]);
  });

  it('rejects instance-wide provider keys, which break per-tenant accounting', () => {
    const message = findProductionViolations(prod({ ANTHROPIC_API_KEY: 'sk-ant-xxx' })).join(' ');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('per-tenant cost');
    // And it must not echo the key itself into an error that will be logged.
    expect(message).not.toContain('sk-ant-xxx');
  });

  it('names every shared provider key that is set, not just the first', () => {
    const message = findProductionViolations(
      prod({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', GEMINI_API_KEY: 'c' }),
    ).join(' ');
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
      expect(message).toContain(name);
    }
  });

  it('rejects debug logging in production', () => {
    expect(findProductionViolations(prod({ LOG_LEVEL: 'debug' })).join(' ')).toContain('LOG_LEVEL');
    expect(findProductionViolations(prod({ LOG_LEVEL: 'trace' })).join(' ')).toContain('LOG_LEVEL');
    expect(findProductionViolations(prod({ LOG_LEVEL: 'info' }))).toEqual([]);
  });

  it('rejects a plaintext search URL on a public host', () => {
    expect(
      findProductionViolations(prod({ SEARXNG_URL: 'http://search.example.com' })).join(' '),
    ).toContain('SEARXNG_URL');
  });

  it('permits a plaintext search URL on a private host, which is the normal setup', () => {
    /*
     * A self-hosted SearXNG usually sits on the same private network and is
     * reached over http. Flagging that would push operators to disable the
     * check rather than to fix anything.
     */
    for (const url of ['http://10.0.0.5:8080', 'http://searx.internal', 'http://127.0.0.1:8888']) {
      expect({ url, problems: findProductionViolations(prod({ SEARXNG_URL: url })) }).toEqual({
        url,
        problems: [],
      });
    }
  });

  it('reports every problem at once, so one fix does not reveal the next', () => {
    const env = envSchema.parse(
      validEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://postgres:pw@db:5432/m' }),
    );
    const problems = findProductionViolations(env);
    // REDIS_URL, DATABASE_SSL, API_HOST, localhost CORS, plaintext CORS, superuser.
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });

  it('applies none of these checks outside production', () => {
    expect(findProductionViolations(envSchema.parse(validEnv()))).toEqual([]);
  });
});
