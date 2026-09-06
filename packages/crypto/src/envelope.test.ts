import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { DecryptionFailedError, ConfigurationError } from '@moka/core';
import {
  decryptCredential,
  encryptCredential,
  fingerprint,
  generateDek,
  lastFour,
  loadRootKey,
  safeEquals,
  unwrapDek,
  wrapDek,
  type CredentialAad,
} from './envelope.js';

const rootKey = randomBytes(32);
const rootKeyB64 = rootKey.toString('base64');

function aad(overrides: Partial<CredentialAad> = {}): CredentialAad {
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    credentialId: '22222222-2222-4222-8222-222222222222',
    providerId: 'openai',
    ...overrides,
  };
}

describe('loadRootKey', () => {
  it('accepts exactly 32 bytes', () => {
    expect(loadRootKey(rootKeyB64)).toHaveLength(32);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => loadRootKey(randomBytes(16).toString('base64'))).toThrow(ConfigurationError);
    expect(() => loadRootKey(randomBytes(64).toString('base64'))).toThrow(ConfigurationError);
  });
});

describe('DEK wrapping', () => {
  it('round-trips a DEK for its own organization', () => {
    const orgId = randomUUID();
    const dek = generateDek();
    const wrapped = wrapDek(rootKey, dek, orgId);
    expect(unwrapDek(rootKey, wrapped, orgId).equals(dek)).toBe(true);
  });

  it('does not expose the DEK in the wrapped bytes', () => {
    const orgId = randomUUID();
    const dek = generateDek();
    const wrapped = wrapDek(rootKey, dek, orgId);
    expect(wrapped.includes(dek)).toBe(false);
  });

  // The security property: a wrapped DEK is bound to its organization.
  it('refuses to unwrap a DEK under a different organization', () => {
    const dek = generateDek();
    const wrapped = wrapDek(rootKey, dek, randomUUID());
    expect(() => unwrapDek(rootKey, wrapped, randomUUID())).toThrow(DecryptionFailedError);
  });

  it('refuses to unwrap under a different root key', () => {
    const orgId = randomUUID();
    const wrapped = wrapDek(rootKey, generateDek(), orgId);
    expect(() => unwrapDek(randomBytes(32), wrapped, orgId)).toThrow(DecryptionFailedError);
  });

  it('detects tampering with the ciphertext', () => {
    const orgId = randomUUID();
    const wrapped = wrapDek(rootKey, generateDek(), orgId);
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => unwrapDek(rootKey, tampered, orgId)).toThrow(DecryptionFailedError);
  });

  it('rejects a truncated wrapped DEK', () => {
    expect(() => unwrapDek(rootKey, Buffer.alloc(4), randomUUID())).toThrow(DecryptionFailedError);
  });
});

describe('credential encryption', () => {
  const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789';

  it('round-trips a credential', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, aad());
    expect(decryptCredential(dek, box, aad())).toBe(secret);
  });

  it('never stores the plaintext in the ciphertext', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, aad());
    expect(box.ciphertext.toString('utf8')).not.toContain('sk-test');
    expect(box.ciphertext.includes(Buffer.from(secret, 'utf8'))).toBe(false);
  });

  it('produces a distinct ciphertext each time (unique IV)', () => {
    const dek = generateDek();
    const a = encryptCredential(dek, secret, aad());
    const b = encryptCredential(dek, secret, aad());
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  /*
   * These three are the reason AAD exists. An attacker with write access to the
   * database must not be able to relocate a ciphertext into a row they control
   * and have it decrypt.
   */
  it('refuses to decrypt a ciphertext moved to another ORGANIZATION', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, aad());
    expect(() =>
      decryptCredential(dek, box, aad({ organizationId: '99999999-9999-4999-8999-999999999999' })),
    ).toThrow(DecryptionFailedError);
  });

  it('refuses to decrypt a ciphertext moved to another CREDENTIAL row', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, aad());
    expect(() =>
      decryptCredential(dek, box, aad({ credentialId: '88888888-8888-4888-8888-888888888888' })),
    ).toThrow(DecryptionFailedError);
  });

  it('refuses to decrypt a ciphertext relabelled to another PROVIDER', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, aad());
    expect(() => decryptCredential(dek, box, aad({ providerId: 'anthropic' }))).toThrow(
      DecryptionFailedError,
    );
  });

  it('refuses to decrypt with another organization DEK', () => {
    const box = encryptCredential(generateDek(), secret, aad());
    expect(() => decryptCredential(generateDek(), box, aad())).toThrow(DecryptionFailedError);
  });

  // Length-prefixing in the AAD prevents field-boundary collisions.
  it('is not confusable across AAD field boundaries', () => {
    const dek = generateDek();
    const box = encryptCredential(dek, secret, {
      organizationId: 'ab',
      credentialId: 'cd',
      providerId: 'ef',
    });
    expect(() =>
      decryptCredential(dek, box, { organizationId: 'a', credentialId: 'bcd', providerId: 'ef' }),
    ).toThrow(DecryptionFailedError);
  });
});

describe('display derivatives', () => {
  it('fingerprints deterministically without revealing the secret', () => {
    const secret = 'sk-ant-supersecretvalue';
    const fp = fingerprint(secret);
    expect(fp).toBe(fingerprint(secret));
    expect(fp).toHaveLength(32);
    expect(fp).not.toContain('secret');
  });

  it('produces different fingerprints for different secrets', () => {
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });

  it('exposes only trailing characters', () => {
    expect(lastFour('sk-abcdefgh1234')).toBe('1234');
    expect(lastFour('abc')).toBe('');
  });
});

describe('safeEquals', () => {
  it('matches identical strings', () => {
    expect(safeEquals('token-value', 'token-value')).toBe(true);
  });

  it('rejects different strings and differing lengths', () => {
    expect(safeEquals('token-value', 'token-valuf')).toBe(false);
    expect(safeEquals('short', 'much-longer-value')).toBe(false);
  });
});
