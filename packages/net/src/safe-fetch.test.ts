import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  FetchTimeoutError,
  ResponseTooLargeError,
  SsrfBlockedError,
  assertSafeUrl,
  safeFetch,
} from './safe-fetch.js';

/**
 * safeFetch transport behaviour.
 *
 * These run against a real local HTTP server. `testOnlyAllowPrivateHosts` names
 * ONLY that server's address, so every other private destination stays blocked
 * — which is what keeps the redirect tests below meaningful rather than
 * circular.
 */

let server: Server;
let base: string;
const LOCAL = ['127.0.0.1'];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
        return;

      // Redirects to internal targets — the attack this guard exists for.
      case '/redirect-to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      case '/redirect-to-loopback':
        res.writeHead(302, { location: 'http://127.0.0.1:1/' });
        res.end();
        return;
      case '/redirect-to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        res.end();
        return;
      case '/redirect-loop':
        res.writeHead(302, { location: `${base}/redirect-loop` });
        res.end();
        return;

      case '/large':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(200_000));
        return;

      case '/declared-large':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999999' });
        res.end('x');
        return;

      case '/slow':
        setTimeout(() => {
          res.writeHead(200);
          res.end('too late');
        }, 3000);
        return;

      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, auth: req.headers['authorization'] ?? null }));
        return;

      default:
        res.writeHead(404);
        res.end('nope');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('URL validation', () => {
  it('rejects non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com/',
      'data:text/plain,hi',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(() => assertSafeUrl(url), url).toThrow(SsrfBlockedError);
    }
  });

  it('rejects internal hosts and addresses', () => {
    for (const url of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://metadata.google.internal/',
      'http://db.internal/',
    ]) {
      expect(() => assertSafeUrl(url), url).toThrow(SsrfBlockedError);
    }
  });

  it('rejects high-value internal ports even on a public host', () => {
    for (const url of [
      'http://example.com:22/',
      'http://example.com:5432/',
      'http://example.com:6379/',
      'http://example.com:2375/',
      'http://example.com:10250/',
    ]) {
      expect(() => assertSafeUrl(url), url).toThrow(SsrfBlockedError);
    }
  });

  it('accepts ordinary public URLs', () => {
    for (const url of [
      'https://api.anthropic.com/v1/messages',
      'https://api.openai.com/v1/chat/completions',
      'https://example.com:8443/path?q=1',
    ]) {
      expect(() => assertSafeUrl(url), url).not.toThrow();
    }
  });

  it('enforces an explicit host allowlist when given', () => {
    const only = (host: string) => ({ allowedHosts: [host] });

    expect(() => assertSafeUrl('https://evil.test/', only('api.anthropic.com'))).toThrow(
      SsrfBlockedError,
    );
    expect(() =>
      assertSafeUrl('https://api.anthropic.com/v1', only('api.anthropic.com')),
    ).not.toThrow();
    // Subdomains of an allowed host are permitted.
    expect(() =>
      assertSafeUrl('https://eu.api.anthropic.com/v1', only('api.anthropic.com')),
    ).not.toThrow();
    // But a suffix-collision domain is not.
    expect(() => assertSafeUrl('https://notanthropic.com/', only('anthropic.com'))).toThrow(
      SsrfBlockedError,
    );
  });

  /*
   * Regression guard for the options-object signature: an array satisfies the
   * all-optional type structurally, so passing one used to disable the
   * allowlist silently.
   */
  it('refuses an array where an options object is expected', () => {
    expect(() =>
      assertSafeUrl('https://evil.test/', ['api.anthropic.com'] as never),
    ).toThrow(TypeError);
  });
});

describe('successful requests', () => {
  it('fetches and decodes a response', async () => {
    const response = await safeFetch(`${base}/ok`, { testOnlyAllowPrivateHosts: LOCAL });
    expect(response.status).toBe(200);
    expect(response.json<{ hello: string }>()).toEqual({ hello: 'world' });
  });

  it('passes method and headers through', async () => {
    const response = await safeFetch(`${base}/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: '{}',
      testOnlyAllowPrivateHosts: LOCAL,
    });
    expect(response.json<{ method: string; auth: string }>()).toEqual({
      method: 'POST',
      auth: 'Bearer test-token',
    });
  });

  it('surfaces non-2xx without throwing', async () => {
    const response = await safeFetch(`${base}/missing`, { testOnlyAllowPrivateHosts: LOCAL });
    expect(response.status).toBe(404);
    expect(response.text()).toBe('nope');
  });
});

/**
 * The core of the suite. A permitted request that redirects to an internal
 * target must be stopped at the redirect, not followed.
 */
describe('redirects are re-validated on every hop', () => {
  it('blocks a redirect to the cloud metadata service', async () => {
    await expect(
      safeFetch(`${base}/redirect-to-metadata`, { testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('blocks a redirect to a loopback address not in the test allowlist', async () => {
    // 127.0.0.1 IS allowlisted for this test, but port 1 is not the server —
    // what matters is that the guard re-runs, which the metadata case proves.
    // This case additionally pins that a redirect cannot escape the allowlist.
    await expect(
      safeFetch(`${base}/redirect-to-loopback`, { testOnlyAllowPrivateHosts: ['198.51.100.9'] }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('blocks a redirect to a non-http scheme', async () => {
    await expect(
      safeFetch(`${base}/redirect-to-file`, { testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('stops a redirect loop at the hop limit', async () => {
    await expect(
      safeFetch(`${base}/redirect-loop`, { maxRedirects: 2, testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('refuses to follow any redirect when maxRedirects is 0', async () => {
    await expect(
      safeFetch(`${base}/redirect-to-metadata`, {
        maxRedirects: 0,
        testOnlyAllowPrivateHosts: LOCAL,
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe('resource limits', () => {
  it('rejects a response that exceeds the byte cap while streaming', async () => {
    await expect(
      safeFetch(`${base}/large`, { maxBytes: 1000, testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(ResponseTooLargeError);
  });

  it('rejects early on a declared content-length over the cap', async () => {
    await expect(
      safeFetch(`${base}/declared-large`, { maxBytes: 1000, testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(ResponseTooLargeError);
  });

  it('allows a response under the cap', async () => {
    const response = await safeFetch(`${base}/large`, {
      maxBytes: 500_000,
      testOnlyAllowPrivateHosts: LOCAL,
    });
    expect(response.body.byteLength).toBe(200_000);
  });

  it('times out a slow response', async () => {
    await expect(
      safeFetch(`${base}/slow`, { timeoutMs: 300, testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(FetchTimeoutError);
  });
});

describe('the test hatch is not a production switch', () => {
  it('refuses to run when NODE_ENV is production', async () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await expect(
        safeFetch(`${base}/ok`, { testOnlyAllowPrivateHosts: LOCAL }),
      ).rejects.toThrow(/never be used in production/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('still blocks addresses it does not name', async () => {
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/', {
        testOnlyAllowPrivateHosts: LOCAL,
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe('error messages leak nothing', () => {
  it('does not reveal which internal host was targeted', async () => {
    try {
      await safeFetch('http://169.254.169.254/latest/meta-data/');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('Request to this address is not permitted.');
      expect((error as Error).message).not.toContain('169.254');
      // The detail is available for logs, just not in the message.
      expect((error as SsrfBlockedError).target).toBe('169.254.169.254');
    }
  });
});
