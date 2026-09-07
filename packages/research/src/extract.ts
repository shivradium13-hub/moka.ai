import * as cheerio from 'cheerio';
import { htmlToSections } from '@moka/knowledge';
import { normaliseUrl } from './crawl.js';

/**
 * Turning a fetched page into text, links and a citable record.
 *
 * TWO CONSUMERS, ONE EXTRACTOR. The website crawler stores the text as
 * knowledge; the research pipeline puts it in front of a model. Sharing this
 * matters because the second use is the dangerous one: whatever comes out of
 * here is third-party text that will sit in a prompt, and it should have been
 * treated identically on both paths rather than carefully on one.
 *
 * Boilerplate stripping is inherited from `htmlToSections` in @moka/knowledge,
 * which removes script, style, nav, header, footer, aside and form. That is a
 * retrieval-quality decision and a safety one: `<script>` contents are
 * attacker-authored text that must never reach a prompt looking like prose.
 */

export interface ExtractedPage {
  readonly title: string | null;
  /** Clean text, sections joined. This is what a model or an index sees. */
  readonly text: string;
  /** Absolute, normalised, deduplicated links found in the document. */
  readonly links: readonly string[];
  /** `<link rel="canonical">`, when the page declares one. */
  readonly canonicalUrl: string | null;
  /** True when the page asked robots not to index it. */
  readonly noindex: boolean;
  /** True when the page asked robots not to follow its links. */
  readonly nofollow: boolean;
  readonly warnings: readonly string[];
}

/** Longest text kept from one page. Beyond this a page is a corpus, not a source. */
export const MAX_PAGE_CHARS = 200_000;

/** Links harvested from one page. A sitemap-style index can list thousands. */
export const MAX_LINKS_PER_PAGE = 300;

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const warnings: string[] = [];

  const parsed = htmlToSections(html);
  const joined = parsed.sections.map((section) => section.text).join('\n\n');

  const text = joined.length > MAX_PAGE_CHARS ? joined.slice(0, MAX_PAGE_CHARS) : joined;
  if (joined.length > MAX_PAGE_CHARS) warnings.push('Page was truncated.');
  if (text.trim().length === 0) warnings.push('No readable text found on this page.');

  const $ = cheerio.load(html);

  /*
   * Robots META directives.
   *
   * robots.txt says which URLs may be FETCHED; these say what may be done with
   * a page once fetched, and only the page itself can carry them. `noindex` is
   * honoured by not storing the page as knowledge — a publisher asking not to
   * be indexed has said something specific, and reading it anyway while
   * calling the result an index is exactly the kind of technicality the brief
   * rules out.
   */
  const robotsMeta = [
    $('meta[name="robots"]').attr('content') ?? '',
    // Addressed to us specifically. Site owners use this to permit or refuse
    // one crawler without changing their policy for everyone.
    $('meta[name="mokaai-crawler"]').attr('content') ?? '',
  ]
    .join(',')
    .toLowerCase();

  const noindex = /\bnoindex\b|\bnone\b/.test(robotsMeta);
  const nofollow = /\bnofollow\b|\bnone\b/.test(robotsMeta);

  const canonicalRaw = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonicalRaw ? normaliseUrl(canonicalRaw, pageUrl) : null;

  const links = nofollow ? [] : collectLinks($, pageUrl);

  return {
    title: parsed.title,
    text,
    links,
    canonicalUrl,
    noindex,
    nofollow,
    warnings,
  };
}

function collectLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const seen = new Set<string>();

  $('a[href]').each((_index, element) => {
    if (seen.size >= MAX_LINKS_PER_PAGE) return;

    const href = $(element).attr('href');
    if (!href) return;

    /*
     * A per-link `rel="nofollow"` is honoured too. It is most often on
     * user-submitted content — comments, forum posts — which is precisely the
     * material a site owner does not want a crawler treating as their own.
     */
    const rel = ($(element).attr('rel') ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('nofollow')) return;

    // `normaliseUrl` refuses mailto:, javascript:, credentials and malformed
    // input, so nothing unfetchable escapes this loop.
    const absolute = normaliseUrl(href, pageUrl);
    if (absolute) seen.add(absolute);
  });

  return [...seen];
}

/**
 * Take an excerpt for a citation.
 *
 * Prefers the region of the page that actually mentions the query, because a
 * research answer cites a passage rather than a document, and the first 2 KB
 * of a page is usually navigation and a masthead.
 *
 * A plain keyword window rather than anything cleverer: with no dense
 * retriever available (pgvector, roadmap §B1) there is no embedding to score
 * relevance with, and a similarity number computed from nothing would be worse
 * than an honest heuristic.
 */
export function excerptFor(text: string, query: string, maxChars = 2_000): string {
  if (text.length <= maxChars) return text;

  const haystack = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 3);

  let best = -1;
  for (const term of terms) {
    const at = haystack.indexOf(term);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }

  if (best === -1) return text.slice(0, maxChars);

  const start = Math.max(0, best - Math.floor(maxChars / 3));
  const slice = text.slice(start, start + maxChars);
  return start > 0 ? `…${slice}` : slice;
}
