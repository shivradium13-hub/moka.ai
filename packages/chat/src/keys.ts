import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Identifiers for the public chat surface (master prompt §22).
 *
 * There are two values here and they are opposites. Getting them confused is
 * the classic way a widget ends up shipping a credential, so they are kept in
 * one file with the distinction stated at the top.
 *
 *   DEPLOYMENT KEY — PUBLIC. It is pasted into the customer's HTML, visible in
 *     view-source to every visitor. It NAMES a deployment and grants nothing.
 *     Knowing it lets you do exactly what any visitor to that page can do:
 *     open a conversation with a chatbot that was published on purpose.
 *     Therefore it is stored in plaintext and may be shown in the UI, logged,
 *     and put in a URL. Treating it as a secret would be theatre.
 *
 *   VISITOR TOKEN — SECRET, but only to one conversation. It is issued to a
 *     browser, identifies one `chat_conversations` row, and lets that browser
 *     continue and read that conversation. It is stored HASHED, exactly like a
 *     session token, and is never logged or returned twice.
 *
 * The asymmetry is the design: possession of the public key gets you a fresh,
 * empty conversation and nothing else. It cannot read anyone else's.
 */

export const DEPLOYMENT_KEY_PREFIX = 'moka_cb_';

/** 24 bytes of randomness. Not a secret — long enough to be unguessable. */
export function generateDeploymentKey(): string {
  return `${DEPLOYMENT_KEY_PREFIX}${randomBytes(18).toString('base64url')}`;
}

/**
 * Shape check only. It exists so a malformed key is rejected before it reaches
 * the database, not to authenticate anything — a well-formed key that names no
 * deployment is refused in exactly the same way as a malformed one.
 */
export function isDeploymentKeyFormat(value: string): boolean {
  if (!value.startsWith(DEPLOYMENT_KEY_PREFIX)) return false;
  const body = value.slice(DEPLOYMENT_KEY_PREFIX.length);
  return body.length >= 20 && body.length <= 64 && /^[A-Za-z0-9_-]+$/.test(body);
}

/** 32 bytes. This one IS a secret, for the length of one conversation. */
export function generateVisitorToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Stored form of a visitor token. Same construction as session tokens. */
export function hashVisitorToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyVisitorToken(token: string, storedHash: string): boolean {
  const computed = Buffer.from(hashVisitorToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/**
 * A per-conversation pseudonym shown to staff in the inbox.
 *
 * Deliberately derived from the conversation id and nothing else — not the IP,
 * not a browser fingerprint. Staff need to tell two concurrent conversations
 * apart; they do not need, and should not be handed, a stable identifier that
 * follows a person between visits.
 */
export function visitorLabel(conversationId: string): string {
  const digest = createHash('sha256').update(conversationId, 'utf8').digest('hex');
  return `visitor-${digest.slice(0, 6)}`;
}
