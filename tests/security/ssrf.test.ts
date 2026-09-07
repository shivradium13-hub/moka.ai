import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import {
  SsrfBlockedError,
  classifyIp,
  isBlockedHostname,
  parseRobotsTxt,
  isPathAllowed,
  robotsFetchFailurePolicy,
  safeFetch,
  CRAWLER_TOKEN,
} from '@moka/net';
import {
  CrawlFrontier,
  DEFAULT_CRAWL_POLICY,
  ResearchStatus,
  SourceOutcome,
  clampPolicy,
  normaliseUrl,
  runResearch,
  seedUrlProvider,
  type FetchedPage,
  type PageFetcher,
  type ResearchModel,
  type RobotsChecker,
} from '@moka/research';

/**
 * SECURITY SUITE 6 — SSRF.
 *
 * `packages/net` already tests `safeFetch` in isolation. This suite exists to
 * test something different and, historically, more likely to be wrong: that
 * the FEATURES which make outbound requests actually go through it, and that
 * the guard still holds when reached the way a real attacker would reach it —
 * through a crawl target, a research URL, or a redirect from a page we were
 * legitimately reading.
 *
 * A guard that is correct and bypassed is not a guard. Most SSRF incidents are
 * not a broken IP check; they are a second code path that forgot to call it.
 *
 * THE ATTACKER'S POSITION, stated plainly: they can put any URL into a
 * research request or a crawl seed, they control a web server that our crawler
 * will read, and they can make that server redirect anywhere and resolve DNS
 * to anything. Everything below assumes all of that.
 */

let server: Server;
let base: string;
let port: number;

/**
 * The local fixture server is on loopback, which the guard blocks by default.
 * `testOnlyAllowPrivateHosts` names ONE address so the transport can be
 * exercised; every other private address stays blocked, which is what keeps a
 * "redirect to the metadata service" test a real test.
 */
const LOCAL = ['127.0.0.1'];

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    switch (url.pathname) {
      case '/robots.txt':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('User-agent: *\nDisallow: /private\n');
        return;

      case '/page':
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          '<html><head><title>Public page</title></head><body><main>' +
            '<p>Ordinary content about pricing.</p>' +
            // The links an attacker would plant on a page they control.
            '<a href="http://169.254.169.254/latest/meta-data/">metadata</a>' +
            '<a href="http://127.0.0.1:5432/">database</a>' +
            '<a href="file:///etc/passwd">passwd</a>' +
            '<a href="http://[::1]/admin">loopback v6</a>' +
            '</main></body></html>',
        );
        return;

      // A page that redirects into the cloud metadata service.
      case '/redirect-to-metadata':
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        response.end();
        return;

      // A redirect to a different private address than the one allowlisted.
      case '/redirect-to-private':
        response.writeHead(302, { location: 'http://10.0.0.1/internal' });
        response.end();
        return;

      default:
        response.writeHead(404);
        response.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ========================================================================== */
/* 1. The blocked ranges, at the classifier                                   */
/* ========================================================================== */

describe('address classification', () => {
  const blocked = [
    ['127.0.0.1', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.0.0.1', 'RFC1918 private'],
    ['172.16.0.1', 'RFC1918 private'],
    ['192.168.1.1', 'RFC1918 private'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'CGNAT'],
    ['::1', 'IPv6 loopback'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ] as const;

  for (const [address, why] of blocked) {
    it(`refuses ${address} (${why})`, () => {
      expect(classifyIp(address).allowed).toBe(false);
    });
  }

  it('permits ordinary public addresses', () => {
    // The control. Without this the suite would pass with a classifier that
    // refuses everything, which is not the property being claimed.
    expect(classifyIp('93.184.216.34').allowed).toBe(true);
    expect(classifyIp('2606:2800:220:1:248:1893:25c8:1946').allowed).toBe(true);
  });

  it('refuses hostnames that name the local machine', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('LOCALHOST')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });
});

/* ========================================================================== */
/* 2. safeFetch, reached the way an attacker reaches it                       */
/* ========================================================================== */

describe('direct requests', () => {
  it('refuses the cloud metadata service', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('refuses loopback, including the port our own database is on', async () => {
    await expect(safeFetch('http://127.0.0.1:55432/')).rejects.toThrow(SsrfBlockedError);
    await expect(safeFetch('http://localhost:4000/v1/auth/me')).rejects.toThrow(SsrfBlockedError);
  });

  it('refuses non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x.test/', 'ftp://x.test/']) {
      await expect(safeFetch(url)).rejects.toThrow(SsrfBlockedError);
    }
  });

  it('refuses high-value internal ports even on a public host', async () => {
    await expect(safeFetch('http://example.com:6379/')).rejects.toThrow(SsrfBlockedError);
    await expect(safeFetch('http://example.com:2375/containers/json')).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('does not leak which internal host was refused', async () => {
    /*
     * The message is generic on purpose. A caller who can tell "blocked
     * because private" from "blocked because it does not resolve" has a
     * working internal port scanner.
     */
    await expect(safeFetch('http://10.1.2.3/secret')).rejects.toThrow(/not permitted/i);
    await expect(safeFetch('http://10.1.2.3/secret')).rejects.not.toThrow(/10\.1\.2\.3/);
  });
});

describe('redirects', () => {
  it('REFUSES a redirect into the metadata service', async () => {
    /*
     * The classic bypass: the first URL is public and passes, and the site
     * redirects to 169.254.169.254. safeFetch follows redirects manually and
     * re-validates every hop, which is why this fails.
     */
    await expect(
      safeFetch(`${base}/redirect-to-metadata`, { testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('REFUSES a redirect to a private address that was not allowlisted', async () => {
    // Proves the test hatch is an allowlist of one address rather than a
    // switch that turns the guard off for the request.
    await expect(
      safeFetch(`${base}/redirect-to-private`, { testOnlyAllowPrivateHosts: LOCAL }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

/* ========================================================================== */
/* 3. The CRAWLER's scope rules                                               */
/* ========================================================================== */

describe('crawl scope', () => {
  it('refuses to queue a link to an internal address found on a page', () => {
    /*
     * The realistic attack: a site we were legitimately asked to crawl links
     * to the metadata service. Two independent controls refuse it — host
     * scope here, and the SSRF guard if it ever reached a fetch.
     */
    const frontier = new CrawlFrontier(clampPolicy({}));
    frontier.seed(`${base}/page`);

    expect(
      frontier.offer('http://169.254.169.254/latest/meta-data/', `${base}/page`, 1),
    ).toBe(false);
    expect(frontier.offer('http://10.0.0.1/admin', `${base}/page`, 1)).toBe(false);
  });

  it('refuses non-http schemes at normalisation, before scope is consulted', () => {
    expect(normaliseUrl('file:///etc/passwd')).toBeNull();
    expect(normaliseUrl('javascript:fetch("http://169.254.169.254")')).toBeNull();
    expect(normaliseUrl('data:text/html,<script>')).toBeNull();
  });

  it('refuses a URL carrying credentials', () => {
    expect(normaliseUrl('http://user:pass@169.254.169.254/')).toBeNull();
  });

  it('cannot be widened past its ceilings by a request', () => {
    // The policy arrives from a request body. Clamping is what stops
    // `maxPages: 1e9` becoming a way to spend a tenant's month in one call.
    const clamped = clampPolicy({ maxPages: 1e9, maxDepth: 999, maxTotalBytes: 1e12 });
    expect(clamped.maxPages).toBeLessThanOrEqual(500);
    expect(clamped.maxDepth).toBeLessThanOrEqual(5);
  });

  it('defaults to the seed host only', () => {
    // "Index my site" almost never means "and everything my site links to",
    // and a single unscoped link is the difference.
    expect(DEFAULT_CRAWL_POLICY.sameHostOnly).toBe(true);
  });
});

/* ========================================================================== */
/* 4. The RESEARCH pipeline                                                   */
/* ========================================================================== */

describe('research egress', () => {
  const model: ResearchModel = {
    async synthesize() {
      throw new Error('the model must not be reached when nothing was collected');
    },
  };

  const allowAll: RobotsChecker = { async allowed() { return true; } };

  /** A fetcher that really calls safeFetch, so the guard is genuinely in path. */
  const realFetcher: PageFetcher = {
    async fetch(url: string): Promise<FetchedPage> {
      const response = await safeFetch(url, { timeoutMs: 5_000, maxBytes: 1024 * 1024 });
      return {
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers['content-type'] ?? null,
        body: response.text(),
        byteLength: response.body.byteLength,
        contentHash: createHash('sha256').update(response.body).digest('hex'),
      };
    },
  };

  it('refuses an internal address supplied as a research URL', async () => {
    /*
     * The most direct attack on this feature: a user asks it to "research"
     * the cloud metadata service. It must be refused by the guard, recorded,
     * and — because nothing was collected — must not reach the model.
     */
    const result = await runResearch(
      'what is in here',
      {
        search: seedUrlProvider([
          'http://169.254.169.254/latest/meta-data/',
          'http://127.0.0.1:55432/',
          'http://[::1]/admin',
        ]),
        fetcher: realFetcher,
        robots: allowAll,
        model,
      },
    );

    expect(result.status).toBe(ResearchStatus.NO_SOURCES);
    expect(result.citations).toEqual([]);
    expect(
      result.attempts.every(
        (a) => a.outcome === SourceOutcome.FETCH_FAILED || a.outcome === SourceOutcome.BLOCKED,
      ),
    ).toBe(true);
  });

  it('says nothing about WHY an internal address was refused', async () => {
    // The user-facing detail must not distinguish "private range" from "did
    // not resolve", or the feature becomes a port scanner with a nice UI.
    const result = await runResearch('probe', {
      search: seedUrlProvider(['http://10.1.2.3/secret']),
      fetcher: realFetcher,
      robots: allowAll,
      model,
    });

    const detail = result.attempts[0]!.detail ?? '';
    expect(detail).not.toContain('10.1.2.3');
    expect(detail).not.toMatch(/private|loopback|metadata|link-local/i);
  });

  it('refuses a non-http scheme before any request is made', async () => {
    const result = await runResearch('read this', {
      search: seedUrlProvider(['file:///etc/passwd']),
      fetcher: realFetcher,
      robots: allowAll,
      model,
    });
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.BLOCKED);
  });

  it('refuses a redirect from a permitted page into the metadata service', async () => {
    /*
     * End to end: a public page redirects to 169.254.169.254. The request
     * starts legitimately and the guard still refuses it, because every hop
     * is re-validated rather than only the first.
     */
    const result = await runResearch('anything', {
      search: seedUrlProvider([`${base}/redirect-to-metadata`]),
      fetcher: {
        async fetch(url: string): Promise<FetchedPage> {
          const response = await safeFetch(url, { testOnlyAllowPrivateHosts: LOCAL });
          return {
            status: response.status,
            finalUrl: response.url,
            contentType: null,
            body: response.text(),
            byteLength: response.body.byteLength,
            contentHash: 'x',
          };
        },
      },
      robots: allowAll,
      model,
    });

    expect(result.status).toBe(ResearchStatus.NO_SOURCES);
  });

  it('does not call the model when every candidate was blocked', async () => {
    /*
     * Belt and braces on the phase's other gate. A blocked fetch must not
     * degrade into "answer from memory and cite something plausible" — the
     * scripted model here throws if it is reached at all.
     */
    await expect(
      runResearch('q', {
        search: seedUrlProvider(['http://169.254.169.254/']),
        fetcher: realFetcher,
        robots: allowAll,
        model,
      }),
    ).resolves.toMatchObject({ status: ResearchStatus.NO_SOURCES });
  });
});

/* ========================================================================== */
/* 5. The publisher's terms                                                   */
/* ========================================================================== */

describe("robots.txt is consulted, and refusing it is the default", () => {
  it('blocks a disallowed path', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /private\n');
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/private/data')).toBe(false);
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/public')).toBe(true);
  });

  it('treats an unreadable robots.txt as a refusal, not as permission', () => {
    // A 403 on robots.txt is not an invitation to guess, and a 500 is not
    // permission to crawl blind.
    expect(robotsFetchFailurePolicy(403)).toBe('deny');
    expect(robotsFetchFailurePolicy(500)).toBe('deny');
    expect(robotsFetchFailurePolicy('network_error')).toBe('deny');
  });

  it('treats a genuinely absent robots.txt as permission', () => {
    expect(robotsFetchFailurePolicy(404)).toBe('allow');
  });

  it('is checked BEFORE the fetch, in the research pipeline', async () => {
    const fetched: string[] = [];
    const result = await runResearch('q', {
      search: seedUrlProvider(['https://example.com/private']),
      fetcher: {
        async fetch(url) {
          fetched.push(url);
          throw new Error('should never be reached');
        },
      },
      robots: { async allowed() { return false; } },
      model: { async synthesize() { throw new Error('unreachable'); } },
    });

    expect(fetched).toEqual([]);
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.ROBOTS_DISALLOWED);
  });
});

/* ========================================================================== */
/* 6. The one legitimate private-host exception                               */
/* ========================================================================== */

describe('configured internal hosts', () => {
  it('permits exactly the configured host and nothing else', async () => {
    /*
     * A self-hosted SearXNG is usually on a private address, so the exception
     * has to exist. What makes it safe is that it names ONE host taken from
     * boot configuration, and widens nothing else on the same request.
     */
    const response = await safeFetch(`${base}/robots.txt`, {
      configuredInternalHosts: ['127.0.0.1'],
    });
    expect(response.status).toBe(200);

    await expect(
      safeFetch('http://169.254.169.254/', { configuredInternalHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(SsrfBlockedError);
    await expect(
      safeFetch('http://10.0.0.1/', { configuredInternalHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('does not let a redirect escape into another private address', async () => {
    await expect(
      safeFetch(`${base}/redirect-to-private`, { configuredInternalHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});
