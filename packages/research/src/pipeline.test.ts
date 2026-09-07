import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_RESEARCH_OPTIONS,
  NO_SOURCES_MESSAGE,
  ResearchStatus,
  SourceOutcome,
  runResearch,
  type FetchedPage,
  type PageFetcher,
  type ResearchModel,
  type RobotsChecker,
} from './pipeline.js';
import { SearchUnavailableError, seedUrlProvider, type SearchProvider } from './search.js';
import { SsrfBlockedError } from '@moka/net';

/**
 * The research pipeline, driven with no network and no provider.
 *
 * Every collaborator is injected, which is the point: the interesting
 * behaviour is what happens when a step FAILS — robots refuses, a fetch is
 * blocked, nothing is collected — and those paths never get exercised by a
 * test that needs the internet to be a particular way.
 */

function page(html: string, overrides: Partial<FetchedPage> = {}): FetchedPage {
  const body = overrides.body ?? html;
  return {
    status: 200,
    finalUrl: 'https://example.com/pricing',
    contentType: 'text/html; charset=utf-8',
    body,
    byteLength: body.length,
    contentHash: createHash('sha256').update(body).digest('hex'),
    ...overrides,
  };
}

const PRICING_HTML = `
<html><head><title>Pricing</title></head>
<body><main><h1>Pricing</h1><p>The Pro plan costs 40 dollars per seat per month.</p></main></body>
</html>`;

const LIMITS_HTML = `
<html><head><title>Rate limits</title></head>
<body><main><p>API requests are limited to 600 per minute on the Pro plan.</p></main></body>
</html>`;

/** Collaborators that all succeed, so a test can vary exactly one thing. */
function deps(overrides: {
  search?: SearchProvider;
  pages?: Record<string, FetchedPage>;
  fetchError?: (url: string) => Error | null;
  robotsAllows?: (url: string) => boolean;
  robotsThrows?: boolean;
  /** A specific error from the robots check, e.g. an egress refusal. */
  robotsError?: (url: string) => Error | null;
  answer?: string;
} = {}) {
  const fetched: string[] = [];
  const robotsChecked: string[] = [];
  let synthesisCalls = 0;
  let lastUserPrompt = '';

  const fetcher: PageFetcher = {
    async fetch(url: string): Promise<FetchedPage> {
      fetched.push(url);
      const error = overrides.fetchError?.(url);
      if (error) throw error;
      const found = overrides.pages?.[url];
      if (!found) throw new Error('no fixture for this url');
      return found;
    },
  };

  const robots: RobotsChecker = {
    async allowed(url: string): Promise<boolean> {
      robotsChecked.push(url);
      const specific = overrides.robotsError?.(url);
      if (specific) throw specific;
      if (overrides.robotsThrows) throw new Error('robots.txt unreachable');
      return overrides.robotsAllows ? overrides.robotsAllows(url) : true;
    },
  };

  const model: ResearchModel = {
    async synthesize(request) {
      synthesisCalls += 1;
      lastUserPrompt = request.user;
      return {
        text: overrides.answer ?? 'The Pro plan costs 40 dollars per seat [1].',
        inputTokens: 100,
        outputTokens: 50,
      };
    },
  };

  return {
    search: overrides.search ?? seedUrlProvider(['https://example.com/pricing']),
    fetcher,
    robots,
    model,
    // Inspection handles for assertions.
    log: {
      fetched,
      robotsChecked,
      get synthesisCalls() {
        return synthesisCalls;
      },
      get lastUserPrompt() {
        return lastUserPrompt;
      },
    },
  };
}

describe('the happy path', () => {
  it('searches, fetches, synthesises and cites', async () => {
    const d = deps({ pages: { 'https://example.com/pricing': page(PRICING_HTML) } });
    const result = await runResearch('What does the Pro plan cost?', d);

    expect(result.status).toBe(ResearchStatus.ANSWERED);
    expect(result.answer).toContain('40 dollars');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.url).toBe('https://example.com/pricing');
  });

  it('checks robots.txt BEFORE fetching, not after', async () => {
    const d = deps({ pages: { 'https://example.com/pricing': page(PRICING_HTML) } });
    await runResearch('cost?', d);
    expect(d.log.robotsChecked).toEqual(['https://example.com/pricing']);
    expect(d.log.fetched).toEqual(['https://example.com/pricing']);
  });

  it('cites the FINAL url after a redirect, not the one requested', async () => {
    /*
     * A citation that points at a redirector tells a reader nothing about
     * what was actually read, and may not resolve the same way twice.
     */
    const d = deps({
      search: seedUrlProvider(['https://example.com/go']),
      pages: {
        'https://example.com/go': page(PRICING_HTML, {
          finalUrl: 'https://example.com/pricing-2026',
        }),
      },
    });
    const result = await runResearch('cost?', d);
    expect(result.citations[0]!.url).toBe('https://example.com/pricing-2026');
  });

  it('records a content hash, so a source can be shown to be unchanged', async () => {
    const d = deps({ pages: { 'https://example.com/pricing': page(PRICING_HTML) } });
    const result = await runResearch('cost?', d);
    expect(result.citations[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never puts a URL in the prompt', async () => {
    // Putting the exact string we are trying to stop the model producing into
    // its context makes copying it the path of least resistance.
    const d = deps({ pages: { 'https://example.com/pricing': page(PRICING_HTML) } });
    await runResearch('cost?', d);
    expect(d.log.lastUserPrompt).not.toContain('https://');
    expect(d.log.lastUserPrompt).toContain('[1] Pricing — example.com');
  });

  it('reports which search provider was used', async () => {
    const d = deps({ pages: { 'https://example.com/pricing': page(PRICING_HTML) } });
    expect((await runResearch('q', d)).searchProvider).toBe('seed');
  });
});

describe('when nothing can be collected', () => {
  it('DOES NOT CALL THE MODEL', async () => {
    /*
     * The refusal that matters most. A question, an instruction to cite
     * everything, and nothing to cite is the single most reliable recipe for
     * a fabricated bibliography. Refusing costs one provider call and saves
     * an invented source.
     */
    const d = deps({
      pages: {},
      fetchError: () => new SsrfBlockedError('example.com', 'hostname'),
    });
    const result = await runResearch('What does the Pro plan cost?', d);

    expect(result.status).toBe(ResearchStatus.NO_SOURCES);
    expect(d.log.synthesisCalls).toBe(0);
    expect(result.citations).toEqual([]);
    expect(result.answer).toBe(NO_SOURCES_MESSAGE);
  });

  it('spends no tokens on a question it cannot answer', async () => {
    const d = deps({ pages: {}, fetchError: () => new Error('down') });
    const result = await runResearch('q', d);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('promises nothing in the refusal text', async () => {
    const d = deps({ pages: {}, fetchError: () => new Error('down') });
    const result = await runResearch('q', d);
    expect(result.answer).toMatch(/nothing to base an answer on/i);
    expect(result.answer).not.toMatch(/probably|likely|generally|typically/i);
  });

  it('lists every candidate and why it was skipped', async () => {
    // "It found nothing" is useless. Off-host, robots-refused and timed out
    // are three different problems with three different fixes.
    const d = deps({
      search: seedUrlProvider(['https://a.test/x', 'https://b.test/y']),
      pages: {},
      fetchError: (url) =>
        url.includes('a.test') ? new SsrfBlockedError(url, 'hostname') : new Error('boom'),
    });
    const result = await runResearch('q', d);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.every((a) => a.outcome === SourceOutcome.FETCH_FAILED)).toBe(true);
    expect(result.attempts[0]!.detail).toMatch(/permitted to fetch/i);
  });

  it('reports NO_RESULTS when search itself returned nothing', async () => {
    const d = deps({ search: seedUrlProvider([]) });
    const result = await runResearch('q', d);
    expect(result.status).toBe(ResearchStatus.NO_RESULTS);
    expect(d.log.synthesisCalls).toBe(0);
  });

  it('does NOT answer from priors when search fails', async () => {
    /*
     * The tempting fallback, and the whole reason this pipeline exists. An
     * answer produced with no search is an answer from training data wearing
     * a research feature's clothes.
     */
    const failing: SearchProvider = {
      id: 'searxng',
      label: 'x',
      requiresNetwork: true,
      async search() {
        throw new SearchUnavailableError('searxng', 502);
      },
    };
    const d = deps({ search: failing });
    const result = await runResearch('q', d);

    expect(result.status).toBe(ResearchStatus.NO_RESULTS);
    expect(d.log.synthesisCalls).toBe(0);
  });
});

describe("the publisher's terms", () => {
  it('skips a page robots.txt disallows, and never fetches it', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      robotsAllows: () => false,
    });
    const result = await runResearch('q', d);

    expect(d.log.fetched).toEqual([]);
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.ROBOTS_DISALLOWED);
    expect(result.status).toBe(ResearchStatus.NO_SOURCES);
  });

  it('treats an unreachable robots.txt as a refusal', async () => {
    // Crawling blind because we could not read the rules is the cautious
    // reading in reverse.
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      robotsThrows: true,
    });
    const result = await runResearch('q', d);
    expect(d.log.fetched).toEqual([]);
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.ROBOTS_DISALLOWED);
  });

  it('explains the refusal in terms a person understands', async () => {
    const d = deps({ pages: {}, robotsAllows: () => false });
    const result = await runResearch('q', d);
    expect(result.attempts[0]!.detail).toMatch(/robots\.txt/i);
  });

  it('does NOT blame robots.txt when the ADDRESS was refused', async () => {
    /*
     * The robots check fetches robots.txt, so an internal address fails there
     * first. Reporting that as "their robots.txt disallows it" would be a
     * false statement about a publisher — 169.254.169.254 has no publisher —
     * and would hide the real reason from whoever reads the result.
     */
    const blocked = new SsrfBlockedError('169.254.169.254', 'metadata');
    const d = deps({
      search: seedUrlProvider(['http://169.254.169.254/latest/meta-data/']),
      pages: {},
      robotsError: () => blocked,
    });
    const result = await runResearch('q', d);

    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.BLOCKED);
    expect(result.attempts[0]!.detail).toMatch(/permitted to fetch/i);
    expect(result.attempts[0]!.detail).not.toMatch(/robots/i);
  });
});

describe('collection rules', () => {
  it('deduplicates on CONTENT, not just URL', async () => {
    /*
     * Mirrors and print views are the same document. Quoting one page three
     * times would make a single claim look corroborated by three sources,
     * which is worse than citing it once.
     */
    const same = page(PRICING_HTML);
    const d = deps({
      search: seedUrlProvider([
        'https://example.com/pricing',
        'https://example.com/pricing?print=1',
      ]),
      pages: {
        'https://example.com/pricing': same,
        'https://example.com/pricing?print=1': { ...same, finalUrl: 'https://example.com/print' },
      },
    });
    const result = await runResearch('q', d);

    expect(result.attempts.filter((a) => a.outcome === SourceOutcome.COLLECTED)).toHaveLength(1);
    expect(result.attempts.some((a) => a.outcome === SourceOutcome.DUPLICATE)).toBe(true);
  });

  it('skips a non-2xx response', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML, { status: 404 }) },
    });
    const result = await runResearch('q', d);
    expect(result.attempts[0]!.detail).toContain('404');
    expect(result.status).toBe(ResearchStatus.NO_SOURCES);
  });

  it('skips a response that is not a readable document', async () => {
    const d = deps({
      pages: {
        'https://example.com/pricing': page('', { contentType: 'image/png', body: 'binary' }),
      },
    });
    const result = await runResearch('q', d);
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.NOT_HTML);
  });

  it('skips a page with no readable text', async () => {
    const d = deps({
      pages: {
        'https://example.com/pricing': page('<html><body><script>1</script></body></html>'),
      },
    });
    const result = await runResearch('q', d);
    expect(result.attempts[0]!.outcome).toBe(SourceOutcome.EMPTY);
  });

  it('stops at the source budget, which is the cost driver', async () => {
    const urls = Array.from({ length: 10 }, (_v, i) => `https://example.com/p${i}`);
    const pages = Object.fromEntries(
      urls.map((url, i) => [
        url,
        page(`<main><p>Distinct page number ${i} about pricing.</p></main>`, { finalUrl: url }),
      ]),
    );
    const d = deps({ search: seedUrlProvider(urls), pages });

    const result = await runResearch('pricing', d, { ...DEFAULT_RESEARCH_OPTIONS, maxSources: 3 });
    expect(d.log.fetched).toHaveLength(3);
    expect(result.attempts.filter((a) => a.outcome === SourceOutcome.COLLECTED)).toHaveLength(3);
  });

  it('rejects a search result that is not a web address', async () => {
    const d = deps({ search: seedUrlProvider(['javascript:alert(1)', 'not a url']) });
    const result = await runResearch('q', d);
    expect(d.log.fetched).toEqual([]);
    expect(result.attempts.every((a) => a.outcome === SourceOutcome.BLOCKED)).toBe(true);
  });

  it('fetches sequentially rather than hammering one site at once', async () => {
    // Five simultaneous requests from one IP to whoever is being researched
    // looks like exactly what it is.
    const urls = ['https://example.com/a', 'https://example.com/b'];
    const pages = Object.fromEntries(
      urls.map((url, i) => [url, page(`<main><p>Page ${i} pricing detail.</p></main>`, { finalUrl: url })]),
    );
    const d = deps({ search: seedUrlProvider(urls), pages });
    await runResearch('pricing', d);
    expect(d.log.fetched).toEqual(urls);
  });
});

describe('verification of what the model said', () => {
  it('strips a citation to a source that does not exist', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      answer: 'It costs 40 dollars [1] and integrates with Salesforce [4].',
    });
    const result = await runResearch('q', d);

    expect(result.answer).not.toContain('[4]');
    expect(result.verification!.invalidMarkers).toEqual([4]);
    expect(result.citations.map((c) => c.id)).toEqual([1]);
  });

  it('strips a URL the model invented', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      answer: 'See https://example.com/terms for the full terms [1].',
    });
    const result = await runResearch('q', d);

    expect(result.answer).not.toContain('example.com/terms');
    expect(result.verification!.inventedUrls).toEqual(['https://example.com/terms']);
  });

  it('flags an answer that cited nothing at all', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      answer: 'I think it is around forty dollars.',
    });
    const result = await runResearch('q', d);
    expect(result.verification!.unsupported).toBe(true);
    expect(result.citations).toEqual([]);
  });

  it('reports clean verification for a well-behaved answer', async () => {
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      answer: 'The Pro plan costs 40 dollars per seat per month [1].',
    });
    const result = await runResearch('q', d);

    expect(result.verification).toEqual({
      invalidMarkers: [],
      inventedUrls: [],
      unverifiedQuotes: [],
      unsupported: false,
    });
  });

  it('records token spend even when the answer was heavily corrected', async () => {
    // The provider was called and charged regardless of what we kept.
    const d = deps({
      pages: { 'https://example.com/pricing': page(PRICING_HTML) },
      answer: 'Nonsense [9] with https://invented.test/x.',
    });
    const result = await runResearch('q', d);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });
});

describe('multi-source research', () => {
  it('numbers sources in fetch order and cites them independently', async () => {
    const d = deps({
      search: seedUrlProvider(['https://example.com/pricing', 'https://docs.example.com/limits']),
      pages: {
        'https://example.com/pricing': page(PRICING_HTML),
        'https://docs.example.com/limits': page(LIMITS_HTML, {
          finalUrl: 'https://docs.example.com/limits',
        }),
      },
      answer: 'It costs 40 dollars [1] and allows 600 requests a minute [2].',
    });
    const result = await runResearch('pricing and limits', d);

    expect(result.citations.map((c) => c.id)).toEqual([1, 2]);
    expect(result.citations.map((c) => c.url)).toEqual([
      'https://example.com/pricing',
      'https://docs.example.com/limits',
    ]);
  });

  it('renumbers around a source that failed, leaving no gap to invent into', async () => {
    /*
     * If the second of three candidates fails, the third becomes [2]. A
     * ledger with a hole would let `[2]` mean nothing while looking valid.
     */
    const d = deps({
      search: seedUrlProvider([
        'https://a.test/one',
        'https://b.test/broken',
        'https://c.test/three',
      ]),
      pages: {
        'https://a.test/one': page('<main><p>First source about pricing.</p></main>', {
          finalUrl: 'https://a.test/one',
        }),
        'https://c.test/three': page('<main><p>Third source about pricing.</p></main>', {
          finalUrl: 'https://c.test/three',
        }),
      },
      fetchError: (url) => (url.includes('b.test') ? new Error('down') : null),
      answer: 'Both agree [1][2].',
    });
    const result = await runResearch('pricing', d);

    expect(result.citations.map((c) => c.url)).toEqual([
      'https://a.test/one',
      'https://c.test/three',
    ]);
    expect(result.verification!.invalidMarkers).toEqual([]);
  });
});
