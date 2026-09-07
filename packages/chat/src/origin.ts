/**
 * Origin handling for embedded chatbots (master prompt §22, docs/security.md §11).
 *
 * WHAT AN ORIGIN ALLOWLIST IS AND IS NOT
 *
 * A deployment names the sites it may appear on. That list does two jobs, and
 * they have very different strengths — conflating them is the mistake this
 * comment exists to prevent.
 *
 *  1. STRONG. It becomes the `frame-ancestors` directive on the chat frame.
 *     That is enforced by the visitor's own browser and cannot be forged by a
 *     third-party site, because the attacker is not the one holding the
 *     browser. This is a real clickjacking and unauthorised-embedding control.
 *
 *  2. WEAK. It is also checked against the `Origin` header on API calls. The
 *     Origin header is set by browsers and simply absent from `curl`. Anyone
 *     who reads the customer's page source can replay the requests from a
 *     script with any Origin they like. So this check stops casual reuse of a
 *     deployment on an unrelated site; it stops a determined attacker from
 *     nothing at all.
 *
 * Which is why the deployment key grants NO authority (see keys.ts) and why a
 * visitor holds no role (see CustomerContext in @moka/core). The security of
 * the public surface rests on those two facts, not on this file. This file
 * raises the cost of misuse and keeps honest embeds honest.
 */

/** Parsed, normalised origin: scheme + host + explicit non-default port. */
export interface NormalisedOrigin {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  /** Null when the port is the scheme default, so comparison is canonical. */
  readonly port: string | null;
  /** Canonical serialisation, e.g. `https://shop.example.com`. */
  readonly value: string;
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/**
 * Parse an `Origin` header or a configured allowlist entry.
 *
 * Returns null for anything that is not exactly an origin. Deliberately strict:
 * a value carrying a path, query, fragment or userinfo is not an origin, and
 * accepting one would mean comparing strings that mean different things. The
 * literal `null` origin — sent by sandboxed iframes, `file://` documents and
 * some redirects — is refused rather than mapped to a default, because an
 * unattributable caller is exactly the case an allowlist exists to exclude.
 */
export function parseOrigin(raw: string | null | undefined): NormalisedOrigin | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  // A wildcard host would mean "any site", which must be a separate, named
  // decision rather than something reachable by typing a character.
  if (trimmed.includes('*')) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  // `new URL('https://a.com')` yields pathname '/', which is the only path an
  // origin may have. Anything longer carries a path and is not an origin.
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.hostname === '') return null;

  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  // URL lowercases and punycodes the hostname for us, so two spellings of the
  // same internationalised domain compare equal.
  const host = url.hostname;
  const port = url.port === '' || url.port === DEFAULT_PORTS[url.protocol] ? null : url.port;

  return { scheme, host, port, value: port ? `${scheme}://${host}:${port}` : `${scheme}://${host}` };
}

/**
 * An allowlist entry, which may be an exact origin or a subdomain wildcard.
 *
 * A wildcard entry is written `https://*.example.com`. It matches any
 * subdomain of `example.com` over https, and deliberately NOT the apex:
 * an operator who wants both writes both, so that "did I publish on the
 * marketing site as well?" is answerable by reading the list.
 */
export interface AllowedOriginPattern {
  readonly raw: string;
  readonly scheme: 'http' | 'https';
  /** Host for an exact entry, or the suffix (without the `*.`) for a wildcard. */
  readonly host: string;
  readonly port: string | null;
  readonly wildcard: boolean;
}

const WILDCARD_PREFIX = '://*.';

export function parseAllowedOrigin(raw: string): AllowedOriginPattern | null {
  const trimmed = raw.trim();
  const wildcardAt = trimmed.indexOf(WILDCARD_PREFIX);

  if (wildcardAt === -1) {
    const origin = parseOrigin(trimmed);
    if (!origin) return null;
    return {
      raw: origin.value,
      scheme: origin.scheme,
      host: origin.host,
      port: origin.port,
      wildcard: false,
    };
  }

  // Rebuild without the `*.` so the remainder can be validated as a real
  // origin. This also rejects `https://*` (no suffix) and `https://*.` .
  const rebuilt = trimmed.slice(0, wildcardAt + 3) + trimmed.slice(wildcardAt + WILDCARD_PREFIX.length);
  const origin = parseOrigin(rebuilt);
  if (!origin) return null;

  /*
   * A wildcard must cover a registrable-looking suffix, not a public one.
   * `*.com` would hand the deployment to the entire top-level domain. This is
   * a label count, not a public-suffix lookup: doing it properly needs the
   * Mozilla PSL, which is a data file we would have to ship and keep current.
   * Requiring at least two labels blocks the catastrophic case; the residual
   * gap (`*.co.uk`) is recorded in docs/security.md rather than pretended away.
   */
  if (origin.host.split('.').length < 2) return null;

  return {
    raw: `${origin.scheme}://*.${origin.host}${origin.port ? `:${origin.port}` : ''}`,
    scheme: origin.scheme,
    host: origin.host,
    port: origin.port,
    wildcard: true,
  };
}

/** Parse a stored allowlist, silently dropping entries that are not origins. */
export function parseAllowedOrigins(raw: readonly string[]): AllowedOriginPattern[] {
  return raw
    .map(parseAllowedOrigin)
    .filter((pattern): pattern is AllowedOriginPattern => pattern !== null);
}

/**
 * Whether a request's Origin is covered by the allowlist.
 *
 * Scheme and port must match exactly. Downgrading https to http is a different
 * origin and is treated as one: a chatbot published on a secure page must not
 * answer the same page served over plaintext, where the transcript is readable
 * by the network.
 */
export function originAllowed(
  origin: NormalisedOrigin | null,
  patterns: readonly AllowedOriginPattern[],
): boolean {
  if (!origin) return false;

  return patterns.some((pattern) => {
    if (pattern.scheme !== origin.scheme) return false;
    if (pattern.port !== origin.port) return false;

    if (!pattern.wildcard) return pattern.host === origin.host;

    /*
     * The suffix test that has to be right.
     *
     * `endsWith('.' + host)` — with the dot INSIDE the compared string — is
     * what separates `shop.example.com` from `evil-example.com`, which shares
     * the suffix `example.com` but is a different registration entirely. The
     * apex is excluded because the length check requires at least one label
     * before the dot.
     */
    return origin.host.endsWith(`.${pattern.host}`) && origin.host.length > pattern.host.length + 1;
  });
}

/**
 * The `frame-ancestors` directive for a deployment's chat frame.
 *
 * Returns `'none'` for an empty allowlist. That is the correct failing
 * behaviour: a deployment that has named no sites is embeddable nowhere, not
 * everywhere. The widget then shows nothing and the operator sees why.
 *
 * Wildcards translate directly — CSP understands `https://*.example.com` and,
 * unlike our own matcher, its wildcard also matches nothing at the apex.
 */
export function frameAncestorsDirective(patterns: readonly AllowedOriginPattern[]): string {
  if (patterns.length === 0) return "frame-ancestors 'none'";
  const sources = patterns.map((pattern) =>
    pattern.wildcard
      ? `${pattern.scheme}://*.${pattern.host}${pattern.port ? `:${pattern.port}` : ''}`
      : `${pattern.scheme}://${pattern.host}${pattern.port ? `:${pattern.port}` : ''}`,
  );
  return `frame-ancestors ${sources.join(' ')}`;
}
