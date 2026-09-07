import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SsrfBlockedError } from '@moka/net';
import {
  SearchUnavailableError,
  createSearxngProvider,
  describeSearchCapabilities,
  seedUrlProvider,
} from './search.js';

/**
 * Search providers.
 *
 * The SearXNG adapter has never spoken to a real instance — there is none on
 * this machine and running one needs Docker (roadmap §B2). So it is tested the
 * way the provider adapters were in Phase 3: against a local server that
 * speaks the documented wire format. That verifies everything except whether
 * SearXNG's own behaviour matches its documentation, which is not something a
 * test here could establish either way.
 */

let server: Server;
let base: string;
/** The local server is on loopback, which the SSRF guard blocks by default. */
let host: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (url.pathname === '/search') {
      const query = url.searchParams.get('q');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          query,
          number_of_results: 2,
          results: [
            {
              url: 'https://example.com/pricing',
              title: 'Pricing',
              content: 'Plans start at 40 dollars.',
              engine: 'duckduckgo',
            },
            {
              url: 'https://docs.example.com/limits',
              title: 'Rate limits',
              content: '600 requests per minute.',
              engine: 'wikipedia',
            },
            // Real instances return partial rows. Each of these must be
            // dropped rather than repaired into something plausible.
            { title: 'No URL at all', content: 'x' },
            { url: 42, title: 'URL is not a string' },
          ],
        }),
      );
      return;
    }

    if (url.pathname === '/badjson/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('<html>an error page served with a JSON content type</html>');
      return;
    }

    if (url.pathname === '/down/search') {
      response.writeHead(502);
      response.end('bad gateway from the upstream engine at 10.1.2.3');
      return;
    }

    if (url.pathname === '/away/search') {
      response.writeHead(302, { location: 'https://elsewhere.test/search' });
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  host = '127.0.0.1';
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('seed URLs', () => {
  it('returns exactly the URLs it was given', async () => {
    const provider = seedUrlProvider(['https://a.test/one', 'https://b.test/two']);
    const hits = await provider.search('anything', 10);
    expect(hits.map((h) => h.url)).toEqual(['https://a.test/one', 'https://b.test/two']);
  });

  it('needs no network, so research works with nothing configured', async () => {
    // Not a fallback. "Read these three pages and tell me what they say" is
    // the most common real request, and it needs no engine at all.
    expect(seedUrlProvider([]).requiresNetwork).toBe(false);
  });

  it('respects the limit', async () => {
    const provider = seedUrlProvider(['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);
    expect(await provider.search('q', 2)).toHaveLength(2);
  });

  it('invents no titles or snippets it does not have', async () => {
    const [hit] = await seedUrlProvider(['https://a.test/one']).search('q', 1);
    expect(hit!.title).toBeNull();
    expect(hit!.snippet).toBeNull();
  });
});

describe('the SearXNG adapter', () => {
  it('parses a well-formed response', async () => {
    const provider = createSearxngProvider({ baseUrl: base });
    const hits = await provider.search('pricing', 10);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: 'https://example.com/pricing',
      title: 'Pricing',
      engine: 'searxng:duckduckgo',
    });
  });

  it('DROPS malformed rows rather than repairing them', async () => {
    // Everything past this point is third-party data. A row with no URL is
    // not a result, and inventing one would put a fabricated source into a
    // citation ledger.
    const hits = await createSearxngProvider({ baseUrl: base }).search('pricing', 10);
    expect(hits.every((hit) => typeof hit.url === 'string' && hit.url.length > 0)).toBe(true);
    expect(hits.some((hit) => hit.title === 'No URL at all')).toBe(false);
  });

  it('respects the limit', async () => {
    expect(await createSearxngProvider({ baseUrl: base }).search('pricing', 1)).toHaveLength(1);
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    const provider = createSearxngProvider({ baseUrl: `${base}/` });
    expect(await provider.search('pricing', 5)).toHaveLength(2);
  });

  it('reports an upstream failure WITHOUT leaking its message', async () => {
    // The instance's own error text mentioned an internal address. That must
    // not reach a user who may be probing what our network looks like.
    const provider = createSearxngProvider({ baseUrl: `${base}/down` });
    await expect(provider.search('q', 5)).rejects.toThrow(SearchUnavailableError);
    await expect(provider.search('q', 5)).rejects.toThrow(/unavailable right now/i);
    await expect(provider.search('q', 5)).rejects.not.toThrow(/10\.1\.2\.3/);
  });

  it('reports a non-JSON body as unavailable rather than crashing', async () => {
    // A misconfigured instance in front of a proxy will happily serve an HTML
    // error page with a JSON content type. Trusting the header would throw a
    // SyntaxError out of a background job.
    const provider = createSearxngProvider({ baseUrl: `${base}/badjson` });
    await expect(provider.search('q', 5)).rejects.toThrow(SearchUnavailableError);
  });

  it('REFUSES to follow a redirect away from the configured instance', async () => {
    /*
     * A search endpoint that redirects is not the one the operator
     * configured. Following it would take the query — and the private-host
     * exception that comes with it — somewhere they did not choose.
     *
     * The refusal comes from safeFetch rather than from this adapter, and it
     * surfaces as SsrfBlockedError rather than being flattened into
     * "unavailable". That is deliberate: an egress refusal is a distinct,
     * security-relevant event, and collapsing it into a generic failure would
     * erase it from the logs. Its message is already generic, so nothing
     * about our network reaches the caller either way.
     */
    const provider = createSearxngProvider({ baseUrl: `${base}/away` });
    await expect(provider.search('q', 5)).rejects.toThrow(SsrfBlockedError);
    await expect(provider.search('q', 5)).rejects.toThrow(/not permitted/i);
  });

  it('permits the configured instance to be on a private address', async () => {
    /*
     * The whole reason `configuredInternalHosts` exists. This request goes to
     * 127.0.0.1, which the SSRF guard blocks for every request derived from
     * user input — and must not block for a host the operator named in
     * boot configuration.
     */
    expect(host).toBe('127.0.0.1');
    const hits = await createSearxngProvider({ baseUrl: base }).search('pricing', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does NOT widen the exception to any other private address', async () => {
    /*
     * The exception is one hostname, taken from one configured URL. A
     * different private address on the same request is still refused, so a
     * redirect or a crafted result cannot walk into the internal network.
     */
    const { safeFetch } = await import('@moka/net');
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      SsrfBlockedError,
    );
    await expect(
      safeFetch('http://10.0.0.1/', { configuredInternalHosts: ['127.0.0.1'] }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe('capability reporting', () => {
  it('says plainly when no engine is configured', () => {
    /*
     * A research feature that silently answers from model priors because
     * search was unavailable is the exact failure this phase is measured
     * against. The user is the last person who should have to infer it.
     */
    const capabilities = describeSearchCapabilities(undefined);
    const searxng = capabilities.providers.find((p) => p.id === 'searxng')!;

    expect(searxng.configured).toBe(false);
    expect(searxng.note).toMatch(/SEARXNG_URL/);
  });

  it('always reports explicit URLs as available', () => {
    const capabilities = describeSearchCapabilities(undefined);
    expect(capabilities.providers.find((p) => p.id === 'seed')!.configured).toBe(true);
  });

  it('reports SearXNG as configured once a URL is set', () => {
    const capabilities = describeSearchCapabilities('http://searxng.internal:8080');
    expect(capabilities.providers.find((p) => p.id === 'searxng')!.configured).toBe(true);
  });
});
