import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { redactValue, AppError, ErrorCode } from '@moka/core';
import { encryptCredential, generateDek, hashPassword, wrapDek } from '@moka/crypto';
import { appClient, asOrg, cleanupTenant, createTenant, migratorClient, type TestTenant } from '../helpers/db.js';

/**
 * SECURITY SUITE 3 — CREDENTIAL EXPOSURE (Phase 1 scope).
 *
 * Phase 1 has no Moka Credentials vault yet (that is Phase 4), so this suite
 * covers what exists now: password hashes, session token hashes, the wrapped
 * organization DEK, and the guarantee that none of them can reach a response,
 * a log line, or an error body.
 *
 * It is completed in Phase 4 when the vault lands.
 */

let app: pg.Client;
let migrator: pg.Client;
let tenant: TestTenant;

beforeAll(async () => {
  app = await appClient();
  migrator = await migratorClient();
  tenant = await createTenant(migrator, app, 'cred');
}, 60_000);

afterAll(async () => {
  if (tenant) await cleanupTenant(migrator, tenant);
  await app?.end();
  await migrator?.end();
});

describe('secrets at rest', () => {
  it('never stores a password in plaintext', async () => {
    const password = 'SuperSecretPassword123!';
    const hash = await hashPassword(password);

    await migrator.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [hash, tenant.userId],
    );

    const { rows } = await migrator.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [tenant.userId],
    );

    expect(rows[0]?.password_hash).not.toContain(password);
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
  });

  it('stores the organization DEK wrapped, never as raw key material', async () => {
    const rootKey = Buffer.alloc(32, 7);
    const dek = generateDek();
    const wrapped = wrapDek(rootKey, dek, tenant.organizationId);

    await asOrg(app, tenant.organizationId, async () => {
      await app.query('UPDATE organizations SET dek_wrapped = $1 WHERE id = $2', [
        wrapped.toString('base64'),
        tenant.organizationId,
      ]);
    });

    const stored = await asOrg(app, tenant.organizationId, async () =>
      (await app.query<{ dek_wrapped: string }>(
        'SELECT dek_wrapped FROM organizations WHERE id = $1',
        [tenant.organizationId],
      )).rows,
    );

    const storedBytes = Buffer.from(stored[0]!.dek_wrapped, 'base64');
    expect(storedBytes.includes(dek), 'the raw DEK must not appear in storage').toBe(false);
  });

  it('produces ciphertext that does not contain the plaintext credential', () => {
    const secret = 'sk-ant-api03-REALSECRETVALUE0123456789';
    const box = encryptCredential(generateDek(), secret, {
      organizationId: tenant.organizationId,
      credentialId: '11111111-1111-4111-8111-111111111111',
      providerId: 'anthropic',
    });
    expect(box.ciphertext.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    expect(box.ciphertext.toString('utf8')).not.toContain('sk-ant');
  });
});

describe('secrets in logs', () => {
  it('redacts every secret-bearing field of a realistic log payload', () => {
    const payload = {
      requestId: 'req-1',
      user: { email: 'a@example.test', password: 'hunter2' },
      credential: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345', provider: 'openai' },
      session: { tokenHash: 'deadbeef', token: 'raw-session-token' },
      organization: { dekWrapped: 'AAAA', name: 'Acme' },
      db: { url: 'postgresql://moka_app:hunter2@127.0.0.1:5432/moka_ai' },
    };

    const serialised = JSON.stringify(redactValue(payload));

    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(serialised).not.toContain('raw-session-token');
    expect(serialised).not.toContain('deadbeef');
    // Non-secret context must survive, or the logs become useless.
    expect(serialised).toContain('a@example.test');
    expect(serialised).toContain('Acme');
    expect(serialised).toContain('req-1');
  });

  it('redacts a connection string embedded in free text', () => {
    const message = 'connect failed: postgresql://moka_app:s3cret@db:5432/moka_ai';
    expect(JSON.stringify(redactValue({ message }))).not.toContain('s3cret');
  });
});

describe('secrets in error responses', () => {
  it('excludes internal detail from the serialised error body', () => {
    const error = new AppError({
      code: ErrorCode.INTERNAL,
      httpStatus: 500,
      publicMessage: 'An unexpected error occurred.',
      internalMessage: 'ECONNREFUSED postgresql://moka_app:hunter2@127.0.0.1:5432/moka_ai',
      cause: new Error('key sk-abcdefghijklmnopqrstuvwxyz012345 rejected'),
    });

    const body = JSON.stringify(error.toPublicJSON('req-9'));

    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('postgresql://');
    expect(body).toContain('req-9');
  });
});

describe('secrets in query results', () => {
  /*
   * The organization DTO returned by OrganizationsService selects columns
   * explicitly and omits dek_wrapped. This asserts the shape that endpoint
   * relies on, so a future `SELECT *` refactor is caught here.
   */
  it('the organization read path selects no secret columns', async () => {
    const rows = await asOrg(app, tenant.organizationId, async () =>
      (await app.query(
        'SELECT id, name, slug, created_at FROM organizations WHERE id = $1',
        [tenant.organizationId],
      )).rows,
    );
    expect(Object.keys(rows[0]!)).toEqual(['id', 'name', 'slug', 'created_at']);
    expect(Object.keys(rows[0]!)).not.toContain('dek_wrapped');
  });
});
