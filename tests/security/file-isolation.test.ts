import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  LocalStorageDriver,
  StorageError,
  assertValidKey,
  buildStorageKey,
  organizationOfKey,
} from '@moka/knowledge';
import {
  appClient,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE 9 — FILE ACCESS ISOLATION.
 *
 * Uploaded files are the one tenant asset that lives OUTSIDE PostgreSQL, so
 * row-level security — the control everything else leans on — does not protect
 * them. Whatever isolates one tenant's documents from another's has to be in
 * this code, and that makes it worth a suite of its own.
 *
 * THE DESIGN BEING TESTED
 *
 * No user-controlled string ever reaches the filesystem. A storage key is
 * built from server-generated UUIDs and an extension allowlisted to
 * `[a-z0-9]{1,8}`, so traversal, absolute paths, NUL bytes, Windows device
 * names and case-collision tricks are impossible BY CONSTRUCTION rather than
 * by filtering. Filtering is what you do when the dangerous value is still in
 * your hand; this suite checks that it never is.
 */

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const SOURCE = randomUUID();

let root: string;
let driver: LocalStorageDriver;
let migrator: pg.Client;
let app: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'moka-file-iso-'));
  driver = new LocalStorageDriver(root);

  migrator = await migratorClient();
  app = await appClient();
  tenantA = await createTenant(migrator, app, 'file-a');
  tenantB = await createTenant(migrator, app, 'file-b');
}, 60_000);

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  for (const tenant of [tenantA, tenantB]) {
    if (tenant) await cleanupTenant(migrator, tenant);
  }
  await app?.end();
  await migrator?.end();
});

/* ========================================================================== */
/* 1. The key is not attacker-influenceable                                   */
/* ========================================================================== */

describe('storage keys are built, not accepted', () => {
  it('embeds the organization, so a key names its owner', () => {
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'report.pdf',
      kind: 'raw',
    });
    expect(key.startsWith(`org/${ORG_A}/`)).toBe(true);
    expect(organizationOfKey(key)).toBe(ORG_A);
  });

  it('uses a server-generated name, never the uploaded filename', () => {
    /*
     * The property the whole design rests on. The user's filename contributes
     * an EXTENSION and nothing else, so there is no path through which a
     * user-chosen string reaches the filesystem.
     */
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'quarterly-results-FINAL-v3.pdf',
      kind: 'raw',
    });
    expect(key).not.toContain('quarterly');
    expect(key).not.toContain('FINAL');
    expect(key.endsWith('.pdf')).toBe(true);
  });

  it('neutralises every traversal attempt in the filename', () => {
    const hostile = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32\\config\\sam',
      '/etc/shadow',
      'C:\\Windows\\win.ini',
      'file\u0000.pdf',
      'CON',
      'nul.txt',
      '....//....//etc/passwd',
      '%2e%2e%2fetc%2fpasswd',
      'a'.repeat(5000),
    ];

    for (const filename of hostile) {
      const key = buildStorageKey({
        organizationId: ORG_A,
        sourceId: SOURCE,
        filename,
        kind: 'raw',
      });
      // Whatever went in, what comes out matches the generated shape exactly.
      expect(() => assertValidKey(key)).not.toThrow();
      expect(key).not.toContain('..');
      expect(key).not.toContain('\u0000');
      expect(key).not.toMatch(/[\\:]/);
      expect(key.startsWith(`org/${ORG_A}/source/${SOURCE}/raw/`)).toBe(true);
    }
  });

  it('drops an extension that is not a plain short token', () => {
    // `.php`, `.exe` and friends are not the risk here — nothing executes
    // stored files. A long or punctuated "extension" is a smuggling attempt.
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'x.this-is-not-an-extension',
      kind: 'raw',
    });
    expect(key).not.toContain('not-an-extension');
  });
});

/* ========================================================================== */
/* 2. Keys from anywhere else are refused                                     */
/* ========================================================================== */

describe('a key the system did not generate is refused', () => {
  const hostileKeys = [
    'org/../../../etc/passwd',
    `org/${ORG_A}/source/${SOURCE}/raw/../../../../etc/passwd`,
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    `org/${ORG_A}/source/${SOURCE}/raw/${randomUUID()}/../../../secret`,
    `org/${ORG_A}/source/${SOURCE}/exec/${randomUUID()}`,
    '',
    'org/not-a-uuid/source/x/raw/y',
  ];

  for (const key of hostileKeys) {
    it(`refuses ${JSON.stringify(key.slice(0, 48))}`, () => {
      expect(() => assertValidKey(key)).toThrow(StorageError);
    });
  }

  it('accepts a genuinely generated key', () => {
    // The control: a validator that refused everything would pass every test
    // above while breaking the product.
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'a.md',
      kind: 'text',
    });
    expect(() => assertValidKey(key)).not.toThrow();
  });
});

/* ========================================================================== */
/* 3. The driver stays inside its root                                        */
/* ========================================================================== */

describe('the local driver cannot be walked out of its root', () => {
  it('writes and reads back within the root directory', async () => {
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'note.txt',
      kind: 'raw',
    });
    const payload = new TextEncoder().encode('tenant A content');

    await driver.put(key, payload);
    const read = await driver.get(key);

    expect(new TextDecoder().decode(read)).toBe('tenant A content');
    // The file landed under the configured root and nowhere else.
    const onDisk = join(root, ...key.split('/'));
    expect(existsSync(onDisk)).toBe(true);
    expect(resolve(onDisk).startsWith(resolve(root) + sep)).toBe(true);
  });

  it('REFUSES a traversal key rather than escaping the root', async () => {
    /*
     * The escape that would matter: reading `/etc/passwd`, or writing into a
     * sibling directory. Refused at the key check, before any path is joined.
     */
    const escape = `org/${ORG_A}/source/${SOURCE}/raw/../../../../../../etc/passwd`;
    await expect(driver.get(escape)).rejects.toThrow(StorageError);
    await expect(driver.put(escape, new Uint8Array([1]))).rejects.toThrow(StorageError);
  });

  it('does not read a file planted outside the key structure', async () => {
    // A file that exists on disk but has no valid key is unreachable, so an
    // attacker who can write to the volume still cannot serve it through us.
    const secretDir = join(root, 'not-a-tenant');
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, 'secret.txt'), 'should never be served');

    await expect(driver.get('not-a-tenant/secret.txt')).rejects.toThrow(StorageError);
  });

  it('reports a missing object as missing, not as an empty one', async () => {
    // An empty buffer for a missing file would let a deleted document appear
    // as an empty one, which is a quieter and more confusing failure.
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'gone.txt',
      kind: 'raw',
    });
    await expect(driver.get(key)).rejects.toThrow();
  });
});

/* ========================================================================== */
/* 4. One tenant's key never addresses another's file                         */
/* ========================================================================== */

describe('keys are organization-scoped', () => {
  it('two organizations never collide, even with identical filenames', async () => {
    const keyA = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'invoice.pdf',
      kind: 'raw',
    });
    const keyB = buildStorageKey({
      organizationId: ORG_B,
      sourceId: SOURCE,
      filename: 'invoice.pdf',
      kind: 'raw',
    });

    await driver.put(keyA, new TextEncoder().encode('A secret'));
    await driver.put(keyB, new TextEncoder().encode('B secret'));

    expect(keyA).not.toBe(keyB);
    expect(new TextDecoder().decode(await driver.get(keyA))).toBe('A secret');
    expect(new TextDecoder().decode(await driver.get(keyB))).toBe('B secret');
  });

  it('a key carries its owner, so access can be re-checked before serving', () => {
    /*
     * The defence in depth that matters when a document id leaks. Possession
     * of a key is not authorisation: the organization is recoverable from the
     * key itself and can be compared against the caller's tenant context
     * without a database round trip.
     */
    const keyB = buildStorageKey({
      organizationId: ORG_B,
      sourceId: SOURCE,
      filename: 'x.pdf',
      kind: 'raw',
    });
    expect(organizationOfKey(keyB)).toBe(ORG_B);
    expect(organizationOfKey(keyB)).not.toBe(ORG_A);
  });

  it('returns null for a key with no recoverable owner', () => {
    expect(organizationOfKey('nonsense')).toBeNull();
  });
});

/* ========================================================================== */
/* 5. The database half: a document row is unreachable across tenants         */
/* ========================================================================== */

describe('the row that names a file is itself isolated', () => {
  it("tenant A cannot read tenant B's document row, so cannot learn its key", async () => {
    /*
     * Two independent controls have to fail for a cross-tenant file read: the
     * key would have to be guessed (three UUIDs), AND the row naming it would
     * have to be readable. This asserts the second, which is the one an
     * application bug is most likely to weaken.
     */
    const storageKey = buildStorageKey({
      organizationId: tenantB.organizationId,
      sourceId: SOURCE,
      filename: 'b.pdf',
      kind: 'raw',
    });

    const documentId = await asOrg(app, tenantB.organizationId, async () => {
      const source = await app.query<{ id: string }>(
        `INSERT INTO knowledge_sources (organization_id, type, name, status)
         VALUES ($1, 'UPLOAD', 'B files', 'READY') RETURNING id`,
        [tenantB.organizationId],
      );
      const document = await app.query<{ id: string }>(
        `INSERT INTO knowledge_documents
           (organization_id, source_id, title, status, mime_type, checksum, raw_storage_key)
         VALUES ($1, $2, 'B secret', 'READY', 'application/pdf', $3, $4) RETURNING id`,
        [tenantB.organizationId, source.rows[0]!.id, randomUUID(), storageKey],
      );
      return document.rows[0]!.id;
    });

    const seen = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT raw_storage_key FROM knowledge_documents WHERE id = $1', [documentId]),
    );
    expect(seen.rowCount).toBe(0);
  });

  it('a storage key is not guessable from anything a tenant can see', () => {
    // Three server-generated UUIDs. Enumerating them is not an attack, it is
    // a thought experiment.
    const key = buildStorageKey({
      organizationId: ORG_A,
      sourceId: SOURCE,
      filename: 'x.pdf',
      kind: 'raw',
    });
    const uuids = key.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(uuids.length).toBe(3);
  });
});
