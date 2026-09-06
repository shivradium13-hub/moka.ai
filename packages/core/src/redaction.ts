/**
 * Secret redaction (docs/security.md §3.4).
 *
 * Applied at the LOGGER and ERROR-SERIALISER level, never at call sites, so a
 * call site cannot opt out. This module is pure so it can be unit-tested
 * exhaustively and reused by pino, the exception filter, and audit writes.
 */

/** Object keys whose values are always replaced, regardless of content. */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)?/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /\bkey\b/i,
  /credential/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /ciphertext/i,
  /dek|kek/i,
  /auth[-_]?tag/i,
  /\biv\b/i,
  /signature/i,
  /private/i,
];

/** Value shapes that are redacted even under an innocuous key name. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic-style
  /\bAIza[0-9A-Za-z_-]{28,}\b/g, // Google API key
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // bearer tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi, // connection strings
  /\bredis:\/\/[^\s"']+/gi,
  /\bmoka_sk_[A-Za-z0-9]{16,}\b/g, // our own API keys
];

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/** Redact secret-shaped substrings inside a free-text string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    // Patterns are global; reset lastIndex to keep the function pure.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Deep-redact an arbitrary value.
 *
 * - Values under a sensitive key are replaced wholesale.
 * - All other strings are scanned for secret-shaped content.
 * - Buffers/typed arrays are never serialised (they may hold key material).
 * - Cycles and excessive depth are handled rather than throwing, because
 *   this runs inside the logger and must never itself raise.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
      };
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
    }
    return out;
  }

  return REDACTED;
}

/** Convenience wrapper for object payloads. */
export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(input) as Record<string, unknown>;
}
