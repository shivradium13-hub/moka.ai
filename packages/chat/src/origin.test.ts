import { describe, expect, it } from 'vitest';
import {
  frameAncestorsDirective,
  originAllowed,
  parseAllowedOrigin,
  parseAllowedOrigins,
  parseOrigin,
} from './origin.js';

/**
 * SECURITY SUITE 8 (part 2) — origin matching.
 *
 * Origin comparison is string handling that decides an access question, which
 * is the combination that produces confident, wrong code. The cases below are
 * the ones that have historically broken real allowlists: suffix confusion,
 * scheme downgrade, port elision, and the `null` origin.
 *
 * Worth remembering while reading: on the API path this check is advisory
 * (see origin.ts). The same parsing also produces `frame-ancestors`, where it
 * is enforced by the browser — so a bug here is a real hole in the half that
 * matters.
 */

describe('parseOrigin', () => {
  it('accepts a bare origin and canonicalises it', () => {
    expect(parseOrigin('https://example.com')?.value).toBe('https://example.com');
    expect(parseOrigin('HTTPS://Example.COM')?.value).toBe('https://example.com');
  });

  it('elides the default port so both spellings compare equal', () => {
    expect(parseOrigin('https://example.com:443')?.value).toBe('https://example.com');
    expect(parseOrigin('http://example.com:80')?.value).toBe('http://example.com');
  });

  it('keeps a non-default port, which is part of the origin', () => {
    expect(parseOrigin('http://localhost:3000')?.value).toBe('http://localhost:3000');
    expect(parseOrigin('https://example.com:8443')?.port).toBe('8443');
  });

  it('rejects the literal null origin', () => {
    // Sent by sandboxed iframes and file:// documents. Unattributable, which
    // is exactly what an allowlist exists to exclude.
    expect(parseOrigin('null')).toBeNull();
    expect(parseOrigin('NULL')).toBeNull();
  });

  it('rejects an empty or missing header', () => {
    expect(parseOrigin('')).toBeNull();
    expect(parseOrigin(null)).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
  });

  it('rejects anything carrying a path, query or fragment', () => {
    expect(parseOrigin('https://example.com/app')).toBeNull();
    expect(parseOrigin('https://example.com?a=1')).toBeNull();
    expect(parseOrigin('https://example.com#x')).toBeNull();
  });

  it('rejects embedded credentials', () => {
    // `https://evil.com@example.com` reads as example.com to a careless parser
    // and as evil.com to a careless human. Refused rather than resolved.
    expect(parseOrigin('https://evil.com@example.com')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(parseOrigin('file:///tmp/x')).toBeNull();
    expect(parseOrigin('javascript:alert(1)')).toBeNull();
    expect(parseOrigin('chrome-extension://abcdef')).toBeNull();
    expect(parseOrigin('ws://example.com')).toBeNull();
  });

  it('rejects a wildcard where an exact origin is expected', () => {
    expect(parseOrigin('https://*.example.com')).toBeNull();
  });

  it('normalises an internationalised domain to punycode', () => {
    const parsed = parseOrigin('https://münchen.example');
    expect(parsed?.host).toBe('xn--mnchen-3ya.example');
  });
});

describe('parseAllowedOrigin', () => {
  it('accepts an exact origin', () => {
    expect(parseAllowedOrigin('https://shop.example.com')).toMatchObject({
      wildcard: false,
      host: 'shop.example.com',
    });
  });

  it('accepts a subdomain wildcard', () => {
    expect(parseAllowedOrigin('https://*.example.com')).toMatchObject({
      wildcard: true,
      host: 'example.com',
    });
  });

  it('refuses a wildcard over a single label', () => {
    // `*.com` would publish the deployment to an entire top-level domain.
    expect(parseAllowedOrigin('https://*.com')).toBeNull();
    expect(parseAllowedOrigin('https://*')).toBeNull();
    expect(parseAllowedOrigin('https://*.')).toBeNull();
  });

  it('drops unparseable entries instead of failing the whole list', () => {
    const parsed = parseAllowedOrigins(['https://a.example.com', 'nonsense', 'https://*.com']);
    expect(parsed.map((p) => p.raw)).toEqual(['https://a.example.com']);
  });
});

describe('originAllowed', () => {
  const exact = parseAllowedOrigins(['https://shop.example.com']);
  const wildcard = parseAllowedOrigins(['https://*.example.com']);

  it('matches an exact entry', () => {
    expect(originAllowed(parseOrigin('https://shop.example.com'), exact)).toBe(true);
  });

  it('refuses a different host', () => {
    expect(originAllowed(parseOrigin('https://other.example.com'), exact)).toBe(false);
  });

  it('refuses a scheme downgrade', () => {
    // A chatbot published on a secure page must not answer the plaintext
    // version of it, where the transcript is readable on the wire.
    expect(originAllowed(parseOrigin('http://shop.example.com'), exact)).toBe(false);
  });

  it('refuses a different port', () => {
    expect(originAllowed(parseOrigin('https://shop.example.com:8443'), exact)).toBe(false);
  });

  it('matches a subdomain under a wildcard', () => {
    expect(originAllowed(parseOrigin('https://shop.example.com'), wildcard)).toBe(true);
    expect(originAllowed(parseOrigin('https://a.b.example.com'), wildcard)).toBe(true);
  });

  it('does not let a wildcard match the apex', () => {
    // An operator who wants both writes both, so the list stays readable.
    expect(originAllowed(parseOrigin('https://example.com'), wildcard)).toBe(false);
  });

  it('THE SUFFIX TRAP: does not match a host that merely ends with the domain', () => {
    /*
     * `evil-example.com` ends with the string `example.com`. A naive
     * `endsWith(host)` accepts it, and the attacker registers it for $9.
     * The dot must be inside the compared string.
     */
    expect(originAllowed(parseOrigin('https://evil-example.com'), wildcard)).toBe(false);
    expect(originAllowed(parseOrigin('https://notexample.com'), wildcard)).toBe(false);
  });

  it('THE SUFFIX TRAP, other end: does not match a host that merely starts with it', () => {
    expect(originAllowed(parseOrigin('https://example.com.evil.net'), wildcard)).toBe(false);
  });

  it('refuses everything when the origin is absent or null', () => {
    expect(originAllowed(null, wildcard)).toBe(false);
    expect(originAllowed(parseOrigin('null'), wildcard)).toBe(false);
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(originAllowed(parseOrigin('https://shop.example.com'), [])).toBe(false);
  });
});

describe('frameAncestorsDirective', () => {
  it("denies embedding entirely when nothing is allowed", () => {
    // The correct failure: a deployment that has named no sites is embeddable
    // nowhere, not everywhere.
    expect(frameAncestorsDirective([])).toBe("frame-ancestors 'none'");
  });

  it('emits each allowed origin, wildcards included', () => {
    const patterns = parseAllowedOrigins(['https://shop.example.com', 'https://*.example.org']);
    expect(frameAncestorsDirective(patterns)).toBe(
      'frame-ancestors https://shop.example.com https://*.example.org',
    );
  });

  it('never emits a bare wildcard source', () => {
    const patterns = parseAllowedOrigins(['https://*.example.com', '*', 'https://*']);
    const directive = frameAncestorsDirective(patterns);
    expect(directive).not.toMatch(/\s\*(\s|$)/);
  });

  it('cannot be broken out of by a crafted allowlist entry', () => {
    /*
     * Entries reach this from a database column an admin can write. If one
     * could contain a semicolon it would terminate the directive and start a
     * new one, letting a stored value rewrite the whole policy. Parsing
     * rejects such entries before they get here, so nothing survives.
     */
    const patterns = parseAllowedOrigins([
      "https://ok.example.com",
      "https://x.com; script-src 'unsafe-inline'",
    ]);
    const directive = frameAncestorsDirective(patterns);
    expect(directive).toBe('frame-ancestors https://ok.example.com');
    expect(directive).not.toContain(';');
  });
});
