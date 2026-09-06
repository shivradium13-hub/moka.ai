import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  decryptCredential,
  encryptCredential,
  fingerprint,
  generateDek,
  lastFour,
  loadRootKey,
  unwrapDek,
  wrapDek,
} from '@moka/crypto';
import { CREDENTIAL_SECRET_COLUMNS } from '@moka/db';
import { DecryptionFailedError, redactValue } from '@moka/core';
import {
  appClient,
  asNoOrg,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE — MOKA CREDENTIALS VAULT.
 *
 * The gate on Phase 4.
 *
 * A leaked provider key is not a data-exposure incident, it is a billing and
 * impersonation incident: whoever holds it can spend the customer's money and
 * act as them against the provider. So this suite tests the property from
 * every direction — at rest, in transit between tenants, in logs, and after
 * revocation.
 */

let app: pg.Client;
let migrator: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

const ROOT_KEY = randomBytes(32);
const SECRET_A = 'sk-ant-api03-TENANT-A-REAL-SECRET-VALUE-0123456789';
const SECRET_B = 'sk-proj-TENANT-B-REAL-SECRET-VALUE-9876543210';

interface StoredCredential {
  id: string;
  providerId: string;
  plaintext: string;
}

/** Store a credential exactly as VaultService does, including AAD binding. */
async function storeCredential(
  tenant: TestTenant,
  providerId: string,
  plaintext: string,
  dek: Buffer,
): Promise<StoredCredential> {
  // The id must exist before encryption: it is part of the AAD.
  const id = randomUUID();
  const sealed = encryptCredential(dek, plaintext, {
    organizationId: tenant.organizationId,
    credentialId: id,
    providerId,
  });

  await asOrg(app, tenant.organizationId, async () => {
    await app.query(
      `INSERT INTO credentials
         (id, organization_id, provider_id, name, ciphertext, iv, auth_tag,
          fingerprint, last_four, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
      [
        id,
        tenant.organizationId,
        providerId,
        `${providerId} key`,
        sealed.ciphertext.toString('base64'),
        sealed.iv.toString('base64'),
        sealed.authTag.toString('base64'),
        fingerprint(plaintext),
        lastFour(plaintext),
      ],
    );
  });

  return { id, providerId, plaintext };
}

/** Load an organization's DEK the way VaultService does. */
async function dekFor(tenant: TestTenant): Promise<Buffer> {
  const rows = await asOrg(app, tenant.organizationId, async () =>
    (
      await app.query<{ dek_wrapped: string }>(
        'SELECT dek_wrapped FROM organizations WHERE id = $1',
        [tenant.organizationId],
      )
    ).rows,
  );
  return unwrapDek(ROOT_KEY, Buffer.from(rows[0]!.dek_wrapped, 'base64'), tenant.organizationId);
}

let credentialA: StoredCredential;
let credentialB: StoredCredential;

beforeAll(async () => {
  app = await appClient();
  migrator = await migratorClient();
  tenantA = await createTenant(migrator, app, 'va');
  tenantB = await createTenant(migrator, app, 'vb');

  // createTenant writes a placeholder DEK; replace both with real wrapped DEKs
  // so unwrap/decrypt exercise the genuine path.
  for (const tenant of [tenantA, tenantB]) {
    const wrapped = wrapDek(ROOT_KEY, generateDek(), tenant.organizationId);
    await asOrg(app, tenant.organizationId, async () => {
      await app.query('UPDATE organizations SET dek_wrapped = $1 WHERE id = $2', [
        wrapped.toString('base64'),
        tenant.organizationId,
      ]);
    });
  }

  credentialA = await storeCredential(tenantA, 'anthropic', SECRET_A, await dekFor(tenantA));
  credentialB = await storeCredential(tenantB, 'openai', SECRET_B, await dekFor(tenantB));
}, 60_000);

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    if (!tenant) continue;
    await asOrg(app, tenant.organizationId, async () => {
      await app.query('DELETE FROM credentials WHERE organization_id = $1', [
        tenant.organizationId,
      ]);
    }).catch(() => undefined);
    await cleanupTenant(migrator, tenant);
  }
  await app?.end();
  await migrator?.end();
});

describe('secrets at rest', () => {
  it('never stores the plaintext key in any column', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM credentials WHERE id = $1', [credentialA.id])).rows,
    );

    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toContain(SECRET_A);
    expect(serialised).not.toContain('sk-ant-api03-TENANT-A');
  });

  it('does not leak the key through the whole-table dump either', async () => {
    const dump = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM credentials')).rows,
    );
    expect(JSON.stringify(dump)).not.toContain(SECRET_A);
  });

  it('stores only an irreversible fingerprint and the trailing characters', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query<{ fingerprint: string; last_four: string }>(
          'SELECT fingerprint, last_four FROM credentials WHERE id = $1',
          [credentialA.id],
        )
      ).rows,
    );

    expect(rows[0]?.fingerprint).toHaveLength(32);
    expect(SECRET_A).not.toContain(rows[0]!.fingerprint);
    // Trailing characters only: the leading ones carry the provider prefix.
    expect(rows[0]?.last_four).toBe(SECRET_A.slice(-4));
    expect(SECRET_A.startsWith(rows[0]!.last_four)).toBe(false);
  });

  it('round-trips correctly for its rightful owner', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query<{ ciphertext: string; iv: string; auth_tag: string }>(
          'SELECT ciphertext, iv, auth_tag FROM credentials WHERE id = $1',
          [credentialA.id],
        )
      ).rows,
    );

    const plaintext = decryptCredential(
      await dekFor(tenantA),
      {
        ciphertext: Buffer.from(rows[0]!.ciphertext, 'base64'),
        iv: Buffer.from(rows[0]!.iv, 'base64'),
        authTag: Buffer.from(rows[0]!.auth_tag, 'base64'),
      },
      {
        organizationId: tenantA.organizationId,
        credentialId: credentialA.id,
        providerId: 'anthropic',
      },
    );
    expect(plaintext).toBe(SECRET_A);
  });
});

/**
 * The property AAD exists for. An attacker with WRITE access to the database
 * still cannot read another tenant's key by moving rows around.
 */
describe('ciphertext is cryptographically bound to its row', () => {
  async function ciphertextOf(tenant: TestTenant, id: string) {
    const rows = await asOrg(app, tenant.organizationId, async () =>
      (
        await app.query<{ ciphertext: string; iv: string; auth_tag: string }>(
          'SELECT ciphertext, iv, auth_tag FROM credentials WHERE id = $1',
          [id],
        )
      ).rows,
    );
    return {
      ciphertext: Buffer.from(rows[0]!.ciphertext, 'base64'),
      iv: Buffer.from(rows[0]!.iv, 'base64'),
      authTag: Buffer.from(rows[0]!.auth_tag, 'base64'),
    };
  }

  it("refuses to decrypt Tenant A's ciphertext under Tenant B's organization", async () => {
    const box = await ciphertextOf(tenantA, credentialA.id);
    const dek = await dekFor(tenantA);
    expect(() =>
      decryptCredential(dek, box, {
        organizationId: tenantB.organizationId,
        credentialId: credentialA.id,
        providerId: 'anthropic',
      }),
    ).toThrow(DecryptionFailedError);
  });

  it("refuses to decrypt with the other organization's DEK", async () => {
    const box = await ciphertextOf(tenantA, credentialA.id);
    const dekB = await dekFor(tenantB);
    expect(() =>
      decryptCredential(dekB, box, {
        organizationId: tenantA.organizationId,
        credentialId: credentialA.id,
        providerId: 'anthropic',
      }),
    ).toThrow(DecryptionFailedError);
  });

  it('refuses to decrypt after the row is relabelled to another provider', async () => {
    const box = await ciphertextOf(tenantA, credentialA.id);
    const dek = await dekFor(tenantA);
    expect(() =>
      decryptCredential(dek, box, {
        organizationId: tenantA.organizationId,
        credentialId: credentialA.id,
        providerId: 'openai',
      }),
    ).toThrow(DecryptionFailedError);
  });

  it('refuses to decrypt after the ciphertext is copied to a new credential id', async () => {
    const box = await ciphertextOf(tenantA, credentialA.id);
    const dek = await dekFor(tenantA);
    expect(() =>
      decryptCredential(dek, box, {
        organizationId: tenantA.organizationId,
        credentialId: randomUUID(),
        providerId: 'anthropic',
      }),
    ).toThrow(DecryptionFailedError);
  });

  it('detects a single flipped bit in the stored ciphertext', async () => {
    const box = await ciphertextOf(tenantA, credentialA.id);
    const dek = await dekFor(tenantA);
    const tampered = Buffer.from(box.ciphertext);
    tampered[0] ^= 0x01;

    expect(() =>
      decryptCredential(
        dek,
        { ...box, ciphertext: tampered },
        {
          organizationId: tenantA.organizationId,
          credentialId: credentialA.id,
          providerId: 'anthropic',
        },
      ),
    ).toThrow(DecryptionFailedError);
  });

  /**
   * The full attack, end to end: physically copy Tenant A's encrypted bytes
   * into a row Tenant B owns, then try to read them as Tenant B.
   */
  it('a physically copied row is useless to the receiving tenant', async () => {
    const stolen = await ciphertextOf(tenantA, credentialA.id);
    const plantedId = randomUUID();

    await asOrg(app, tenantB.organizationId, async () => {
      await app.query(
        `INSERT INTO credentials
           (id, organization_id, provider_id, name, ciphertext, iv, auth_tag,
            fingerprint, last_four)
         VALUES ($1, $2, 'anthropic', 'stolen', $3, $4, $5, 'deadbeef', 'xxxx')`,
        [
          plantedId,
          tenantB.organizationId,
          stolen.ciphertext.toString('base64'),
          stolen.iv.toString('base64'),
          stolen.authTag.toString('base64'),
        ],
      );
    });

    const dekB = await dekFor(tenantB);
    expect(() =>
      decryptCredential(dekB, stolen, {
        organizationId: tenantB.organizationId,
        credentialId: plantedId,
        providerId: 'anthropic',
      }),
    ).toThrow(DecryptionFailedError);

    await asOrg(app, tenantB.organizationId, async () => {
      await app.query('DELETE FROM credentials WHERE id = $1', [plantedId]);
    });
  });
});

describe('tenant isolation', () => {
  it('has RLS enabled and forced', async () => {
    const { rows } = await app.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = 'credentials' AND relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("Tenant A cannot see Tenant B's credential rows at all", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT id, organization_id FROM credentials')).rows,
    );
    expect(rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(credentialB.id);
  });

  it("returns nothing when Tenant A asks for Tenant B's credential by id", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM credentials WHERE id = $1', [credentialB.id])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('shows nothing with no organization bound', async () => {
    const rows = await asNoOrg(app, async () =>
      (await app.query('SELECT * FROM credentials')).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot insert a credential into another organization", async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query(
          `INSERT INTO credentials
             (id, organization_id, provider_id, name, ciphertext, iv, auth_tag, fingerprint, last_four)
           VALUES ($1, $2, 'anthropic', 'injected', 'x', 'y', 'z', 'f', 'abcd')`,
          [randomUUID(), tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update another organization's credential", async () => {
    const result = await asOrg(app, tenantA.organizationId, async () =>
      app.query('UPDATE credentials SET name = $1 WHERE id = $2', ['hijacked', credentialB.id]),
    );
    expect(result.rowCount).toBe(0);
  });
});

describe('revocation actually revokes', () => {
  it('makes a revoked credential unresolvable, and is one-way', async () => {
    const temporary = await storeCredential(
      tenantA,
      'openai',
      'sk-temp-REVOCATION-TEST-VALUE-000000',
      await dekFor(tenantA),
    );

    const activeBefore = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query(
          `SELECT id FROM credentials WHERE id = $1 AND status = 'active'`,
          [temporary.id],
        )
      ).rows,
    );
    expect(activeBefore).toHaveLength(1);

    await asOrg(app, tenantA.organizationId, async () => {
      await app.query(
        `UPDATE credentials SET status = 'revoked', revoked_at = now(), is_default = false
          WHERE id = $1`,
        [temporary.id],
      );
    });

    // The resolve path selects only status='active', so this is the query that
    // decides whether a revoked key can still be used.
    const activeAfter = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query(
          `SELECT id FROM credentials WHERE id = $1 AND status = 'active'`,
          [temporary.id],
        )
      ).rows,
    );
    expect(activeAfter).toHaveLength(0);

    await asOrg(app, tenantA.organizationId, async () => {
      await app.query('DELETE FROM credentials WHERE id = $1', [temporary.id]);
    });
  });

  it('refuses a revoked row without a revocation timestamp', async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query(`UPDATE credentials SET status = 'revoked' WHERE id = $1`, [credentialA.id]),
      ),
    ).rejects.toThrow(/credentials_revoked_consistent/);
  });
});

describe('secrets in logs and errors', () => {
  /*
   * A field NAMED "credential" is redacted whole, without inspecting it. That
   * is the conservative branch: anything under such a key is assumed secret.
   */
  it('redacts an entire object stored under a credential-shaped key', () => {
    const serialised = JSON.stringify(
      redactValue({
        credential: { apiKey: SECRET_A, providerId: 'anthropic' },
      }),
    );
    expect(serialised).not.toContain(SECRET_A);
    expect(serialised).toContain('[REDACTED]');
  });

  /*
   * The harder case: an innocuously-named object that happens to carry secret
   * fields. Here per-field redaction must fire while ordinary context survives,
   * or the logs become useless and people stop logging.
   */
  it('redacts secret fields but keeps non-secret context', () => {
    const serialised = JSON.stringify(
      redactValue({
        event: 'provider.call',
        providerId: 'anthropic',
        modelId: 'claude-opus-5',
        apiKey: SECRET_A,
        ciphertext: 'AAAA',
        iv: 'BBBB',
        authTag: 'CCCC',
      }),
    );

    expect(serialised).not.toContain(SECRET_A);
    expect(serialised).not.toContain('sk-ant-api03');
    expect(serialised).not.toContain('AAAA');
    // Diagnostic context is preserved.
    expect(serialised).toContain('anthropic');
    expect(serialised).toContain('claude-opus-5');
  });

  it('redacts a bare key appearing in free text', () => {
    const message = `provider rejected key ${SECRET_A}`;
    expect(JSON.stringify(redactValue({ message }))).not.toContain(SECRET_A);
  });

  it('names the columns that must never reach a DTO', () => {
    expect(CREDENTIAL_SECRET_COLUMNS).toEqual(['ciphertext', 'iv', 'auth_tag']);
  });
});

describe('root key handling', () => {
  it('cannot unwrap an organization DEK with the wrong root key', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query<{ dek_wrapped: string }>(
          'SELECT dek_wrapped FROM organizations WHERE id = $1',
          [tenantA.organizationId],
        )
      ).rows,
    );

    expect(() =>
      unwrapDek(randomBytes(32), Buffer.from(rows[0]!.dek_wrapped, 'base64'), tenantA.organizationId),
    ).toThrow(DecryptionFailedError);
  });

  it("cannot unwrap one organization's DEK under another's identity", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query<{ dek_wrapped: string }>(
          'SELECT dek_wrapped FROM organizations WHERE id = $1',
          [tenantA.organizationId],
        )
      ).rows,
    );

    expect(() =>
      unwrapDek(ROOT_KEY, Buffer.from(rows[0]!.dek_wrapped, 'base64'), tenantB.organizationId),
    ).toThrow(DecryptionFailedError);
  });

  it('rejects a malformed root key rather than deriving one', () => {
    expect(() => loadRootKey(randomBytes(16).toString('base64'))).toThrow();
    expect(() => loadRootKey('')).toThrow();
  });
});
