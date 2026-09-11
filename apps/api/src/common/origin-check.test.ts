import { describe, expect, it } from 'vitest';
import { OriginVerdict, checkOrigin } from './origin-check.js';

const ALLOWED = ['https://app.example.com', 'https://admin.example.com'];

function check(overrides: Partial<Parameters<typeof checkOrigin>[0]> = {}) {
  return checkOrigin({
    method: 'POST',
    url: '/v1/projects',
    origin: 'https://app.example.com',
    allowedOrigins: ALLOWED,
    ...overrides,
  });
}

/**
 * CSRF protection for deployments that cannot use `SameSite=lax`.
 *
 * This is the control that makes `COOKIE_SAMESITE=none` defensible, so it is
 * worth testing as adversarially as the thing it replaces.
 */

describe('a mutating request must come from an allowed origin', () => {
  it('allows an exactly-matching origin', () => {
    expect(check()).toBe(OriginVerdict.ALLOWED);
    expect(check({ origin: 'https://admin.example.com' })).toBe(OriginVerdict.ALLOWED);
  });

  it('refuses an origin that is not on the list', () => {
    expect(check({ origin: 'https://evil.com' })).toBe(OriginVerdict.REFUSED);
  });

  it('refuses lookalikes that a sloppy comparison would accept', () => {
    /*
     * Each of these is designed to pass one of the comparisons somebody
     * reaches for instead of equality: startsWith, endsWith, includes, or a
     * regex without anchors.
     */
    const lookalikes = [
      'https://app.example.com.evil.com', // startsWith
      'https://evil-app.example.com', //     endsWith on the bare domain
      'https://evilapp.example.com', //      endsWith without a dot boundary
      'https://app.example.com:8443', //     a different origin: port is part of it
      'http://app.example.com', //           a different origin: scheme is part of it
      'https://app.example.com/', //         trailing slash is not an origin
      'https://APP.example.com', //          case differs; Origin is sent lowercased
      ' https://app.example.com', //         leading space
      'null', //                             what a sandboxed iframe sends
    ];

    for (const origin of lookalikes) {
      expect({ origin, verdict: check({ origin }) }).toEqual({
        origin,
        verdict: OriginVerdict.REFUSED,
      });
    }
  });

  it('refuses every mutating method, not just POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) {
      expect({ method, verdict: check({ method, origin: 'https://evil.com' }) }).toEqual({
        method,
        verdict: OriginVerdict.REFUSED,
      });
    }
  });

  it('refuses an empty allowlist rather than falling open', () => {
    // A misconfigured CORS_ORIGINS must not become "allow everything".
    expect(check({ allowedOrigins: [] })).toBe(OriginVerdict.REFUSED);
  });
});

describe('what the check deliberately does not touch', () => {
  it('ignores safe methods, which change nothing', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect({ method, verdict: check({ method, origin: 'https://evil.com' }) }).toEqual({
        method,
        verdict: OriginVerdict.SAFE_METHOD,
      });
    }
  });

  it('ignores OPTIONS, so CORS preflight is never blocked by this hook', () => {
    /*
     * Worth its own test. Refusing the preflight would break every legitimate
     * cross-origin request in a way that looks like a CORS misconfiguration,
     * and the person debugging it would go and widen CORS_ORIGINS.
     */
    expect(check({ method: 'OPTIONS', origin: 'https://evil.com' })).toBe(
      OriginVerdict.SAFE_METHOD,
    );
  });

  it('exempts the public chatbot surface', () => {
    /*
     * Called from customer sites we cannot enumerate, and carrying no ambient
     * authority — the visitor token is a header, not a cookie. CSRF attacks
     * ambient authority; there is none here to attack.
     */
    expect(check({ url: '/public/chat/message', origin: 'https://a-customer-site.com' })).toBe(
      OriginVerdict.PUBLIC_SURFACE,
    );
  });

  it('does not let a non-public path smuggle itself in via /public/', () => {
    // The exemption is a prefix on the path, so these must NOT match.
    for (const url of ['/v1/public/projects', '/x/public/', '/publicx/thing', '/v1/projects']) {
      expect({ url, verdict: check({ url, origin: 'https://evil.com' }) }).toEqual({
        url,
        verdict: OriginVerdict.REFUSED,
      });
    }
  });

  it('allows a request with no Origin at all', () => {
    /*
     * curl, a mobile client, a server-to-server call. None of them carries the
     * user's cookie jar, so none is the CSRF threat. This is the deliberate
     * limit of the control: it defends browser sessions, which is exactly what
     * SameSite was defending.
     */
    for (const origin of [undefined, '']) {
      expect({ origin, verdict: check({ origin }) }).toEqual({
        origin,
        verdict: OriginVerdict.NO_ORIGIN,
      });
    }
  });
});
