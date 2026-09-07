import { describe, expect, it } from 'vitest';
import {
  CRAWL_CEILINGS,
  CrawlFrontier,
  DEFAULT_CRAWL_POLICY,
  OutOfScope,
  clampPolicy,
  hostOf,
  inScope,
  looksFetchable,
  normaliseUrl,
} from './crawl.js';

/**
 * Crawl scope and budget.
 *
 * The interesting failures are all "we fetched more than we were asked to":
 * a link off-host, a calendar generating infinite URLs, the same page under a
 * dozen campaign tags. Each one costs a tenant's money and a publisher's
 * bandwidth, and the last one costs it silently.
 */

describe('URL normalisation', () => {
  it('drops the fragment', () => {
    // `#section` is a position inside a document we would fetch identically.
    // Keeping it lets a page with a table of contents eat the whole budget.
    expect(normaliseUrl('https://example.com/docs#install')).toBe('https://example.com/docs');
  });

  it('drops the default port but keeps a real one', () => {
    expect(normaliseUrl('https://example.com:443/x')).toBe('https://example.com/x');
    expect(normaliseUrl('http://example.com:80/x')).toBe('http://example.com/x');
    expect(normaliseUrl('https://example.com:8443/x')).toContain(':8443');
  });

  it('strips tracking parameters so one page is not fetched a dozen times', () => {
    expect(normaliseUrl('https://example.com/p?utm_source=x&utm_campaign=y')).toBe(
      'https://example.com/p',
    );
    expect(normaliseUrl('https://example.com/p?fbclid=abc')).toBe('https://example.com/p');
  });

  it('KEEPS parameters that might select content', () => {
    // Dropping `id` or `page` would silently merge two different pages.
    expect(normaliseUrl('https://example.com/p?id=7')).toContain('id=7');
    expect(normaliseUrl('https://example.com/p?page=2')).toContain('page=2');
    expect(normaliseUrl('https://example.com/search?q=refunds')).toContain('q=refunds');
  });

  it('sorts parameters so argument order is not a second identity', () => {
    expect(normaliseUrl('https://example.com/p?b=2&a=1')).toBe(
      normaliseUrl('https://example.com/p?a=1&b=2'),
    );
  });

  it('lowercases the host but not the path', () => {
    // Hosts are case-insensitive; paths are not, and folding them would merge
    // two genuinely different documents on a case-sensitive server.
    const normalised = normaliseUrl('https://EXAMPLE.com/Docs/Install');
    expect(normalised).toContain('example.com');
    expect(normalised).toContain('/Docs/Install');
  });

  it('resolves a relative link against its page', () => {
    expect(normaliseUrl('../guide', 'https://example.com/docs/intro/')).toBe(
      'https://example.com/docs/guide',
    );
    expect(normaliseUrl('/top', 'https://example.com/docs/intro')).toBe('https://example.com/top');
  });

  it('REFUSES non-web schemes', () => {
    // Abundant in real pages, and must never reach the fetcher.
    expect(normaliseUrl('mailto:someone@example.com')).toBeNull();
    expect(normaliseUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseUrl('tel:+441234')).toBeNull();
    expect(normaliseUrl('file:///etc/passwd')).toBeNull();
    expect(normaliseUrl('data:text/html,<script>')).toBeNull();
  });

  it('REFUSES credentials embedded in the URL', () => {
    // Either a mistake or an attempt to make us authenticate somewhere.
    expect(normaliseUrl('https://user:pass@example.com/x')).toBeNull();
  });

  it('refuses malformed input rather than guessing', () => {
    expect(normaliseUrl('not a url')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });
});

describe('fetchability', () => {
  it('skips archives, media and assets that yield no text', () => {
    expect(looksFetchable('https://example.com/a.zip')).toBe(false);
    expect(looksFetchable('https://example.com/v.mp4')).toBe(false);
    expect(looksFetchable('https://example.com/logo.png')).toBe(false);
    expect(looksFetchable('https://example.com/app.js')).toBe(false);
  });

  it('KEEPS documents the parser can actually read', () => {
    // Often the most useful thing on a documentation site.
    expect(looksFetchable('https://example.com/manual.pdf')).toBe(true);
    expect(looksFetchable('https://example.com/report.docx')).toBe(true);
  });

  it('keeps ordinary pages, with or without an extension', () => {
    expect(looksFetchable('https://example.com/docs/install')).toBe(true);
    expect(looksFetchable('https://example.com/page.html')).toBe(true);
    expect(looksFetchable('https://example.com/')).toBe(true);
  });

  it('is not fooled by a dot in a directory name', () => {
    expect(looksFetchable('https://example.com/v1.2/guide')).toBe(true);
  });
});

describe('scope', () => {
  const policy = { ...DEFAULT_CRAWL_POLICY };

  it('permits the seed host', () => {
    expect(inScope('https://example.com/docs', policy, ['example.com'])).toEqual({ ok: true });
  });

  it('refuses another host', () => {
    // "Index my site" almost never means "and everything my site links to".
    expect(inScope('https://other.test/x', policy, ['example.com'])).toEqual({
      ok: false,
      reason: OutOfScope.WRONG_HOST,
    });
  });

  it('refuses a subdomain under sameHostOnly', () => {
    expect(inScope('https://blog.example.com/x', policy, ['example.com']).ok).toBe(false);
  });

  it('permits an explicitly listed additional host', () => {
    expect(
      inScope('https://docs.example.com/x', { ...policy, additionalHosts: ['docs.example.com'] }, [
        'example.com',
      ]),
    ).toEqual({ ok: true });
  });

  it('THE SUFFIX TRAP: a subdomain rule does not match a lookalike domain', () => {
    /*
     * `evil-example.com` ends with the string `example.com`. The dot must be
     * inside the compared string. Same trap as the chatbot origin allowlist,
     * and worth pinning in both places.
     */
    const wide = { ...policy, sameHostOnly: false, additionalHosts: ['example.com'] };
    expect(inScope('https://sub.example.com/x', wide, ['example.com']).ok).toBe(true);
    expect(inScope('https://evil-example.com/x', wide, ['example.com']).ok).toBe(false);
    expect(inScope('https://example.com.evil.net/x', wide, ['example.com']).ok).toBe(false);
  });

  it('honours a path prefix', () => {
    const scoped = { ...policy, pathPrefixes: ['/docs'] };
    expect(inScope('https://example.com/docs/install', scoped, ['example.com']).ok).toBe(true);
    expect(inScope('https://example.com/careers', scoped, ['example.com'])).toEqual({
      ok: false,
      reason: OutOfScope.WRONG_PATH,
    });
  });
});

describe('policy clamping', () => {
  it('applies defaults for anything unset', () => {
    expect(clampPolicy({})).toEqual(DEFAULT_CRAWL_POLICY);
  });

  it('refuses to exceed the ceilings', () => {
    // An operator may lower these; nothing may raise them, including a value
    // that arrived from a request body.
    const clamped = clampPolicy({ maxPages: 1_000_000, maxDepth: 99, maxTotalBytes: 1e12 });
    expect(clamped.maxPages).toBe(CRAWL_CEILINGS.maxPages);
    expect(clamped.maxDepth).toBe(CRAWL_CEILINGS.maxDepth);
    expect(clamped.maxTotalBytes).toBe(CRAWL_CEILINGS.maxTotalBytes);
  });

  it('refuses nonsense values', () => {
    expect(clampPolicy({ maxPages: -5 }).maxPages).toBe(1);
    expect(clampPolicy({ maxPages: Number.NaN }).maxPages).toBe(1);
    expect(clampPolicy({ maxDepth: -1 }).maxDepth).toBe(0);
  });

  it('allows a deliberately narrow crawl', () => {
    expect(clampPolicy({ maxPages: 1, maxDepth: 0 })).toMatchObject({ maxPages: 1, maxDepth: 0 });
  });
});

describe('the frontier', () => {
  function frontier(overrides: Partial<typeof DEFAULT_CRAWL_POLICY> = {}) {
    return new CrawlFrontier(clampPolicy(overrides));
  }

  it('serves the seed first', () => {
    const f = frontier();
    expect(f.seed('https://example.com/')).toBe(true);
    expect(f.next()).toEqual({ url: 'https://example.com/', depth: 0 });
  });

  it('is breadth-first', () => {
    /*
     * Depth-first spends the whole budget in whichever branch it enters first.
     * A documentation site's useful pages are one or two links from the entry.
     */
    const f = frontier();
    f.seed('https://example.com/');
    f.next();
    f.offer('/a', 'https://example.com/', 1);
    f.offer('/b', 'https://example.com/', 1);
    f.offer('/a/deep', 'https://example.com/a', 2);

    expect(f.next()!.url).toBe('https://example.com/a');
    expect(f.next()!.url).toBe('https://example.com/b');
    expect(f.next()!.url).toBe('https://example.com/a/deep');
  });

  it('never queues the same page twice', () => {
    const f = frontier();
    f.seed('https://example.com/');
    f.next();
    expect(f.offer('/x', 'https://example.com/', 1)).toBe(true);
    expect(f.offer('/x#top', 'https://example.com/', 1)).toBe(false);
    expect(f.offer('/x?utm_source=news', 'https://example.com/', 1)).toBe(false);
    expect(f.stats.queued).toBe(1);
  });

  it('refuses links past the depth limit', () => {
    const f = frontier({ maxDepth: 1 });
    f.seed('https://example.com/');
    expect(f.offer('/a', 'https://example.com/', 1)).toBe(true);
    expect(f.offer('/b', 'https://example.com/a', 2)).toBe(false);
    expect(f.stats.skipped.some((s) => s.reason === OutOfScope.TOO_DEEP)).toBe(true);
  });

  it('refuses off-host links and says why', () => {
    const f = frontier();
    f.seed('https://example.com/');
    expect(f.offer('https://other.test/x', 'https://example.com/', 1)).toBe(false);
    expect(f.stats.skipped.some((s) => s.reason === OutOfScope.WRONG_HOST)).toBe(true);
  });

  it('silently ignores mailto and anchor links rather than logging noise', () => {
    // Every page has dozens. Reporting them would bury the rejections that
    // an operator can actually act on.
    const f = frontier();
    f.seed('https://example.com/');
    expect(f.offer('mailto:a@example.com', 'https://example.com/', 1)).toBe(false);
    expect(f.offer('javascript:void(0)', 'https://example.com/', 1)).toBe(false);
    expect(f.stats.skipped).toHaveLength(0);
  });

  it('stops at the page budget', () => {
    const f = frontier({ maxPages: 2 });
    f.seed('https://example.com/');
    f.next();
    f.record(100);
    f.offer('/a', 'https://example.com/', 1);
    f.next();
    f.record(100);
    f.offer('/b', 'https://example.com/', 1);

    expect(f.exhausted()).toBe(true);
    expect(f.next()).toBeNull();
    expect(f.stopReason()).toBe('page_budget');
  });

  it('stops at the byte budget', () => {
    const f = frontier({ maxTotalBytes: 2048 });
    f.seed('https://example.com/');
    f.next();
    f.record(3000);
    expect(f.exhausted()).toBe(true);
    expect(f.stopReason()).toBe('byte_budget');
  });

  it('reports a clean finish when nothing was hit', () => {
    const f = frontier();
    f.seed('https://example.com/');
    f.next();
    f.record(10);
    expect(f.stopReason()).toBe('complete');
    expect(f.next()).toBeNull();
  });

  it('records a robots refusal so the operator can see it happened', () => {
    // "The crawl returned four pages" is useless without knowing whether the
    // rest were off-host, disallowed, or over budget.
    const f = frontier();
    f.recordRobotsRefusal('https://example.com/private');
    expect(f.stats.skipped).toEqual([
      { url: 'https://example.com/private', reason: OutOfScope.ROBOTS },
    ]);
  });

  it('survives an infinite link space without exceeding its budget', () => {
    /*
     * The calendar problem: a page that generates a new URL forever. Only the
     * budget stops it, so the budget has to be checked on every turn.
     */
    const f = frontier({ maxPages: 5, maxDepth: 5 });
    f.seed('https://example.com/calendar');

    let fetched = 0;
    let day = 0;
    for (;;) {
      const item = f.next();
      if (!item) break;
      fetched += 1;
      f.record(1000);
      day += 1;
      f.offer(`/calendar?day=${day}`, item.url, item.depth + 1);
    }

    expect(fetched).toBe(5);
    expect(f.stopReason()).toBe('page_budget');
  });

  it('takes host scope from the seeds, not from configuration', () => {
    const f = frontier();
    f.seed('https://a.test/');
    f.seed('https://b.test/');
    expect(f.offer('https://b.test/x', 'https://a.test/', 1)).toBe(true);
    expect(f.offer('https://c.test/x', 'https://a.test/', 1)).toBe(false);
  });

  it('reports a malformed seed instead of failing silently', () => {
    const f = frontier();
    expect(f.seed('not a url')).toBe(false);
    expect(f.stats.skipped[0]!.reason).toBe(OutOfScope.MALFORMED);
  });
});

describe('hostOf', () => {
  it('lowercases and returns null for nonsense', () => {
    expect(hostOf('https://EXAMPLE.com/x')).toBe('example.com');
    expect(hostOf('nonsense')).toBeNull();
  });
});
