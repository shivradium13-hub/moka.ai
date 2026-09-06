import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LocalStorageDriver,
  StorageError,
  assertValidKey,
  buildStorageKey,
  organizationOfKey,
  sha256,
} from './driver.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';

describe('buildStorageKey', () => {
  it('produces a tenant-prefixed key', () => {
    const key = buildStorageKey({
      organizationId: ORG,
      sourceId: SOURCE,
      filename: 'report.pdf',
      kind: 'raw',
    });
    expect(key.startsWith(`org/${ORG}/source/${SOURCE}/raw/`)).toBe(true);
    expect(key.endsWith('.pdf')).toBe(true);
    assertValidKey(key);
  });

  it('never reuses a key', () => {
    const make = (): string =>
      buildStorageKey({ organizationId: ORG, sourceId: SOURCE, filename: 'a.txt', kind: 'raw' });
    expect(new Set(Array.from({ length: 100 }, make)).size).toBe(100);
  });

  /*
   * SECURITY: the user's filename contributes only an allowlisted extension.
   * The path body is a server-generated UUID, so traversal, absolute paths,
   * NUL bytes and Windows device names are impossible by construction rather
   * than by filtering.
   */
  describe('hostile filenames', () => {
    const hostile = [
      '../../../../etc/passwd',
      '..\\..\\windows\\system32\\config\\sam',
      '/etc/shadow',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'file\u0000.txt',
      'CON',
      'a'.repeat(500) + '.txt',
      '....//....//secret.txt',
      'file.tar.gz;rm -rf /',
      '.env',
      'x.<script>',
    ];

    for (const filename of hostile) {
      it(`neutralises ${JSON.stringify(filename.slice(0, 40))}`, () => {
        const key = buildStorageKey({
          organizationId: ORG,
          sourceId: SOURCE,
          filename,
          kind: 'raw',
        });
        expect(key).not.toContain('..');
        expect(key).not.toContain('\\');
        expect(key).not.toContain('\u0000');
        expect(key.startsWith(`org/${ORG}/`)).toBe(true);
        // Must still be a key the driver will accept.
        assertValidKey(key);
      });
    }
  });

  it('drops an extension that is not simple alphanumerics', () => {
    const key = buildStorageKey({
      organizationId: ORG,
      sourceId: SOURCE,
      filename: 'evil.<script>',
      kind: 'raw',
    });
    expect(key).not.toContain('script');
  });
});

describe('assertValidKey', () => {
  it('accepts a generated key', () => {
    expect(() =>
      assertValidKey(
        buildStorageKey({ organizationId: ORG, sourceId: SOURCE, filename: 'a.txt', kind: 'text' }),
      ),
    ).not.toThrow();
  });

  it('rejects anything not produced by buildStorageKey', () => {
    for (const key of [
      '../escape',
      'org/../../etc/passwd',
      `org/${ORG}/source/${SOURCE}/raw/../../../x`,
      'arbitrary/path.txt',
      '',
      '/absolute/path',
      `org/${ORG}/source/${SOURCE}/other/${randomUUID()}`,
    ]) {
      expect(() => assertValidKey(key), key).toThrow(StorageError);
    }
  });
});

describe('organizationOfKey', () => {
  it('recovers the owning organization', () => {
    const key = buildStorageKey({
      organizationId: ORG,
      sourceId: SOURCE,
      filename: 'a.txt',
      kind: 'raw',
    });
    expect(organizationOfKey(key)).toBe(ORG);
  });

  it('returns null for a malformed key', () => {
    expect(organizationOfKey('nonsense')).toBeNull();
  });
});

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moka-storage-'));
    driver = new LocalStorageDriver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const key = (): string =>
    buildStorageKey({ organizationId: ORG, sourceId: SOURCE, filename: 'a.txt', kind: 'raw' });

  it('round-trips content', async () => {
    const k = key();
    const bytes = new TextEncoder().encode('hello knowledge');
    const stored = await driver.put(k, bytes);

    expect(stored.size).toBe(bytes.byteLength);
    expect(stored.checksum).toBe(sha256(bytes));
    expect(new TextDecoder().decode(await driver.get(k))).toBe('hello knowledge');
  });

  it('reports existence', async () => {
    const k = key();
    expect(await driver.exists(k)).toBe(false);
    await driver.put(k, new Uint8Array([1, 2, 3]));
    expect(await driver.exists(k)).toBe(true);
  });

  it('deletes, and deleting twice is not an error', async () => {
    const k = key();
    await driver.put(k, new Uint8Array([1]));
    await driver.delete(k);
    expect(await driver.exists(k)).toBe(false);
    await expect(driver.delete(k)).resolves.toBeUndefined();
  });

  it('reports a missing object without leaking the path', async () => {
    await expect(driver.get(key())).rejects.toThrow(StorageError);
    await expect(driver.get(key())).rejects.not.toThrow(new RegExp(root.replace(/\\/g, '\\\\')));
  });

  it('refuses to read or write outside the root', async () => {
    for (const bad of ['../outside.txt', `org/${ORG}/source/${SOURCE}/raw/../../../../x`]) {
      await expect(driver.get(bad)).rejects.toThrow(StorageError);
      await expect(driver.put(bad, new Uint8Array([1]))).rejects.toThrow(StorageError);
    }
  });

  /*
   * Even given a file that genuinely exists outside the root, an invalid key
   * must not reach it.
   */
  it('cannot reach a real file outside the root', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'moka-outside-'));
    try {
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, 'secret.txt'), 'TOP SECRET');
      await expect(driver.get(join('..', 'secret.txt'))).rejects.toThrow(StorageError);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('keeps different organizations in separate paths', async () => {
    const otherOrg = '99999999-9999-4999-8999-999999999999';
    const a = buildStorageKey({ organizationId: ORG, sourceId: SOURCE, filename: 'x.txt', kind: 'raw' });
    const b = buildStorageKey({ organizationId: otherOrg, sourceId: SOURCE, filename: 'x.txt', kind: 'raw' });

    await driver.put(a, new TextEncoder().encode('tenant a'));
    await driver.put(b, new TextEncoder().encode('tenant b'));

    expect(new TextDecoder().decode(await driver.get(a))).toBe('tenant a');
    expect(organizationOfKey(a)).not.toBe(organizationOfKey(b));
  });
});
