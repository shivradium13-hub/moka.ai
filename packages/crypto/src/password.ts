import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Password and token hashing (docs/security.md §7, §8).
 *
 * Argon2id via hash-wasm (pure WebAssembly). Chosen over the native bindings
 * deliberately: this machine has no MSVC build tools, so a native module with
 * no prebuilt binary would fail to install. WASM removes that failure mode
 * entirely at a modest CPU cost.
 */

/**
 * OWASP-recommended baseline: 19 MiB memory, 2 iterations, parallelism 1.
 * Memory cost is deliberately conservative — the target host has 7.3 GB RAM
 * and must survive concurrent logins without swapping.
 */
const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456, // KiB
  hashLength: 32,
} as const;

const SALT_BYTES = 16;

/** Hash a user password. Returns a self-describing encoded string. */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    ...ARGON2_PARAMS,
    outputType: 'encoded',
  });
}

/**
 * Verify a password against an encoded hash.
 * Returns false rather than throwing on a malformed stored hash, so a
 * corrupted row cannot become a 500 that distinguishes it from a bad password.
 */
export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Session / API tokens                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Session tokens are 256 bits of CSPRNG output. Because the input already has
 * full entropy, a plain SHA-256 is the correct storage transform — Argon2's
 * work factor exists to slow brute force against LOW-entropy secrets and buys
 * nothing here, while costing ~19 MiB per request.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time token hash comparison. */
export function verifyTokenHash(token: string, storedHash: string): boolean {
  const computed = Buffer.from(hashToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/** API key: a display prefix plus a high-entropy secret. */
export function generateApiKey(): { plaintext: string; prefix: string } {
  const secret = randomBytes(24).toString('base64url');
  const prefix = `moka_sk_${randomBytes(4).toString('hex')}`;
  return { plaintext: `${prefix}_${secret}`, prefix };
}
