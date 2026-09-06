import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigurationError, DecryptionFailedError } from '@moka/core';

/**
 * Envelope encryption (docs/security.md §3.1).
 *
 *   ENCRYPTION_KEY (root KEK)
 *      └─ wraps ─▶ per-organization DEK
 *                     └─ encrypts ─▶ credential ciphertexts
 *
 * Every ciphertext is bound by AES-GCM Additional Authenticated Data to the
 * identifiers it belongs to. Moving a ciphertext row to another organization
 * or another credential id makes it undecryptable, so database tampering
 * fails closed rather than yielding another tenant's secret.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

export interface SealedBox {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}

/** Identifiers bound into the AAD of a credential ciphertext. */
export interface CredentialAad {
  readonly organizationId: string;
  readonly credentialId: string;
  readonly providerId: string;
}

function assertKey(key: Buffer, label: string): void {
  if (key.length !== KEY_BYTES) {
    throw new ConfigurationError(`${label} must be exactly ${KEY_BYTES} bytes, got ${key.length}.`);
  }
}

/** Decode and validate the root KEK from configuration. */
export function loadRootKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new ConfigurationError('ENCRYPTION_KEY is not valid base64.');
  }
  assertKey(key, 'ENCRYPTION_KEY');
  return key;
}

/** Generate a fresh 256-bit data encryption key. */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): SealedBox {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function open(key: Buffer, box: SealedBox, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, box.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(box.authTag);
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  } catch (cause) {
    // Never surface the underlying reason: distinguishing "wrong key" from
    // "tampered ciphertext" from "wrong AAD" is an oracle.
    throw new DecryptionFailedError(
      cause instanceof Error ? `AES-GCM open failed: ${cause.message}` : 'AES-GCM open failed',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* DEK wrapping — AAD binds the DEK to its organization                        */
/* -------------------------------------------------------------------------- */

function dekAad(organizationId: string): Buffer {
  return Buffer.from(`moka:dek:v1:${organizationId}`, 'utf8');
}

/**
 * Wrap an organization DEK under the root key. Returns a single opaque buffer
 * laid out as `iv || authTag || ciphertext`, suitable for a bytea column.
 */
export function wrapDek(rootKey: Buffer, dek: Buffer, organizationId: string): Buffer {
  assertKey(rootKey, 'root key');
  assertKey(dek, 'DEK');
  const box = seal(rootKey, dek, dekAad(organizationId));
  return Buffer.concat([box.iv, box.authTag, box.ciphertext]);
}

export function unwrapDek(rootKey: Buffer, wrapped: Buffer, organizationId: string): Buffer {
  assertKey(rootKey, 'root key');
  if (wrapped.length < IV_BYTES + TAG_BYTES) {
    throw new DecryptionFailedError('Wrapped DEK is truncated.');
  }
  const box: SealedBox = {
    iv: wrapped.subarray(0, IV_BYTES),
    authTag: wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    ciphertext: wrapped.subarray(IV_BYTES + TAG_BYTES),
  };
  const dek = open(rootKey, box, dekAad(organizationId));
  assertKey(dek, 'unwrapped DEK');
  return dek;
}

/* -------------------------------------------------------------------------- */
/* Credential secrets — AAD binds to (org, credential, provider)               */
/* -------------------------------------------------------------------------- */

function credentialAad(aad: CredentialAad): Buffer {
  // Length-prefixed so that ("a","bc") and ("ab","c") cannot collide.
  const parts = [aad.organizationId, aad.credentialId, aad.providerId];
  return Buffer.from(`moka:cred:v1:${parts.map((p) => `${p.length}:${p}`).join('|')}`, 'utf8');
}

export function encryptCredential(dek: Buffer, plaintext: string, aad: CredentialAad): SealedBox {
  assertKey(dek, 'DEK');
  return seal(dek, Buffer.from(plaintext, 'utf8'), credentialAad(aad));
}

export function decryptCredential(dek: Buffer, box: SealedBox, aad: CredentialAad): string {
  assertKey(dek, 'DEK');
  return open(dek, box, credentialAad(aad)).toString('utf8');
}

/* -------------------------------------------------------------------------- */
/* Display-safe derivatives                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Non-reversible fingerprint, for de-duplication and "is this the same key?"
 * checks in the UI. Truncated to 128 bits — enough to avoid collisions, not
 * enough to assist brute force.
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 32);
}

/** Last four characters, for display only. Never the leading characters, which carry provider prefixes. */
export function lastFour(secret: string): string {
  return secret.length <= 4 ? '' : secret.slice(-4);
}

/** Constant-time comparison for tokens and fingerprints. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
