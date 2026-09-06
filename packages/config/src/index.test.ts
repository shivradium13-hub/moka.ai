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

  it('applies none of these checks outside production', () => {
    expect(findProductionViolations(envSchema.parse(validEnv()))).toEqual([]);
  });
});
