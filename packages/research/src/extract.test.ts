import { describe, expect, it } from 'vitest';
import { MAX_LINKS_PER_PAGE, excerptFor, extractPage } from './extract.js';

/**
 * Page extraction.
 *
 * Whatever comes out of here goes two places: a knowledge index, and a model's
 * prompt. The second is the one that makes this a security file — a `<script>`
 * body reaching a prompt as if it were prose is the cheapest injection there
 * is, and the removal happens upstream in `htmlToSections`. These tests pin
 * that it is still happening.
 */

const PAGE = `
<!doctype html>
<html>
<head>
  <title>Refund policy</title>
  <link rel="canonical" href="/policies/refunds">
</head>
<body>
  <nav><a href="/home">Home</a></nav>
  <main>
    <h1>Refunds</h1>
    <p>Refunds are available within 30 days.</p>
    <p>See our <a href="/policies/shipping">shipping policy</a> too.</p>
    <a href="https://partner.test/deal" rel="nofollow sponsored">Partner</a>
    <a href="mailto:help@example.com">Email us</a>
    <a href="#top">Back to top</a>
  </main>
  <footer><a href="/careers">Careers</a></footer>
  <script>window.secret = "do not index me";</script>
</body>
</html>
`;

describe('text extraction', () => {
  const page = extractPage(PAGE, 'https://example.com/refunds');

  it('reads the title', () => {
    expect(page.title).toBe('Refund policy');
  });

  it('keeps the body prose', () => {
    expect(page.text).toContain('Refunds are available within 30 days.');
  });

  it('REMOVES script contents, which are not prose', () => {
    /*
     * The cheapest injection there is: put instructions in a script tag and
     * wait for a crawler to feed them to a model as document text.
     */
    expect(page.text).not.toContain('do not index me');
    expect(page.text).not.toContain('window.secret');
  });

  it('removes navigation and footer boilerplate', () => {
    expect(page.text).not.toContain('Careers');
  });

  it('warns when a page has no readable text', () => {
    const empty = extractPage('<html><body><script>1</script></body></html>', 'https://x.test/');
    expect(empty.warnings).toContain('No readable text found on this page.');
  });

  it('truncates a page that is a corpus rather than a source', () => {
    const huge = `<html><body><main><p>${'x'.repeat(300_000)}</p></main></body></html>`;
    const parsed = extractPage(huge, 'https://x.test/');
    expect(parsed.warnings).toContain('Page was truncated.');
    expect(parsed.text.length).toBeLessThanOrEqual(200_000);
  });
});

describe('link collection', () => {
  const page = extractPage(PAGE, 'https://example.com/refunds');

  it('resolves relative links against the page', () => {
    expect(page.links).toContain('https://example.com/policies/shipping');
  });

  it('drops mailto and fragment-only links', () => {
    expect(page.links.some((link) => link.startsWith('mailto:'))).toBe(false);
    // `#top` resolves to the page itself, which is already fetched.
    expect(page.links.filter((link) => link === 'https://example.com/refunds')).toHaveLength(1);
  });

  it('honours a per-link rel="nofollow"', () => {
    /*
     * Most often on user-submitted content — comments, forum posts — which is
     * exactly the material a site owner does not want treated as their own.
     */
    expect(page.links).not.toContain('https://partner.test/deal');
  });

  it('deduplicates', () => {
    const duplicated = extractPage(
      '<main><a href="/a">1</a><a href="/a?utm_source=x">2</a></main>',
      'https://example.com/',
    );
    expect(duplicated.links).toEqual(['https://example.com/a']);
  });

  it('caps how many links one page can contribute', () => {
    const many = Array.from({ length: 500 }, (_v, i) => `<a href="/p${i}">x</a>`).join('');
    const parsed = extractPage(`<main>${many}</main>`, 'https://example.com/');
    expect(parsed.links.length).toBeLessThanOrEqual(MAX_LINKS_PER_PAGE);
  });
});

describe('robots meta directives', () => {
  it('detects noindex', () => {
    // robots.txt says what may be FETCHED; this says what may be done with a
    // page once fetched, and only the page can carry it.
    const page = extractPage(
      '<head><meta name="robots" content="noindex"></head><body><main><p>hi</p></main></body>',
      'https://x.test/',
    );
    expect(page.noindex).toBe(true);
  });

  it('detects nofollow, and then harvests no links at all', () => {
    const page = extractPage(
      '<head><meta name="robots" content="nofollow"></head><body><main><a href="/a">a</a></main></body>',
      'https://x.test/',
    );
    expect(page.nofollow).toBe(true);
    expect(page.links).toEqual([]);
  });

  it('treats `none` as both', () => {
    const page = extractPage(
      '<head><meta name="robots" content="none"></head><body><main><a href="/a">a</a></main></body>',
      'https://x.test/',
    );
    expect(page.noindex).toBe(true);
    expect(page.nofollow).toBe(true);
  });

  it('honours a directive addressed to this crawler by name', () => {
    // How a site owner permits or refuses us specifically without changing
    // their policy for everyone else.
    const page = extractPage(
      '<head><meta name="mokaai-crawler" content="noindex"></head><body><main><p>hi</p></main></body>',
      'https://x.test/',
    );
    expect(page.noindex).toBe(true);
  });

  it('leaves an ordinary page indexable', () => {
    const page = extractPage('<body><main><p>hi</p></main></body>', 'https://x.test/');
    expect(page.noindex).toBe(false);
    expect(page.nofollow).toBe(false);
  });
});

describe('canonical URL', () => {
  it('is resolved to an absolute URL', () => {
    const page = extractPage(PAGE, 'https://example.com/refunds');
    expect(page.canonicalUrl).toBe('https://example.com/policies/refunds');
  });

  it('is null when the page declares none', () => {
    expect(extractPage('<body><p>x</p></body>', 'https://x.test/').canonicalUrl).toBeNull();
  });
});

describe('excerpting for a citation', () => {
  const text = `${'preamble '.repeat(200)}The refund window is thirty days.${' filler'.repeat(500)}`;

  it('returns short text unchanged', () => {
    expect(excerptFor('short', 'refund')).toBe('short');
  });

  it('centres on the part of the page that mentions the query', () => {
    // The first 2 KB of a page is usually a masthead. A citation should point
    // at the passage, not the navigation above it.
    const excerpt = excerptFor(text, 'refund window', 400);
    expect(excerpt).toContain('refund window is thirty days');
  });

  it('falls back to the start when nothing matches', () => {
    const excerpt = excerptFor(text, 'unrelatedterm', 200);
    expect(excerpt.startsWith('preamble')).toBe(true);
  });

  it('marks a mid-document excerpt as truncated at the front', () => {
    expect(excerptFor(text, 'refund window', 400).startsWith('…')).toBe(true);
  });

  it('respects the character budget', () => {
    expect(excerptFor(text, 'refund', 300).length).toBeLessThanOrEqual(301);
  });
});
