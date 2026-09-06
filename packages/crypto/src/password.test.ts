import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyTokenHash,
} from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!');
    await expect(verifyPassword('CorrectHorseBattery1!', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!');
    await expect(verifyPassword('CorrectHorseBattery1', hash)).resolves.toBe(false);
  });

  it('produces an argon2id hash, salted uniquely per call', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toBe(b);
  });

  it('never embeds the plaintext in the hash', async () => {
    const hash = await hashPassword('MyPlaintextSecret123');
    expect(hash).not.toContain('MyPlaintextSecret123');
  });

  // A corrupted stored hash must read as "wrong password", not as a 500 —
  // otherwise the error itself distinguishes account states.
  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });
});

describe('session tokens', () => {
  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);
    // 32 bytes base64url ≈ 43 chars
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(43);
  });

  it('hashes deterministically and verifies', () => {
    const token = generateSessionToken();
    const stored = hashToken(token);
    expect(hashToken(token)).toBe(stored);
    expect(verifyTokenHash(token, stored)).toBe(true);
  });

  it('rejects a different token', () => {
    const stored = hashToken(generateSessionToken());
    expect(verifyTokenHash(generateSessionToken(), stored)).toBe(false);
  });

  it('does not leak the token in its hash', () => {
    const token = generateSessionToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('api keys', () => {
  it('returns a plaintext that begins with its stored prefix', () => {
    const { plaintext, prefix } = generateApiKey();
    expect(plaintext.startsWith(prefix)).toBe(true);
    expect(prefix.startsWith('moka_sk_')).toBe(true);
  });

  it('generates unique keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(100);
  });
});
