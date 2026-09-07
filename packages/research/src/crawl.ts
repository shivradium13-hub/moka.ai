/**
 * Crawl policy and frontier (master prompt §7, §14).
 *
 * Everything here is pure — no network, no clock, no database — so the rules
 * that decide what a crawler is permitted to fetch can be read in one file and
 * tested exhaustively. The fetching itself lives in the API service, and goes
 * through `safeFetch` like all other egress.
 *
 * THREE KINDS OF LIMIT, AND THEY ARE NOT INTERCHANGEABLE
 *
 *   SCOPE  — which URLs belong to this crawl at all. A tenant asked us to
 *            index their documentation site, not the whole web, and a single
 *            unscoped link is the difference.
 *   BUDGET — how much we will do before stopping. A crawler without one is a
 *            way to spend a tenant's money and a publisher's bandwidth
 *            without limit, and faceted search pages make that space infinite.
 *   MANNERS — robots.txt and crawl delay, handled in @moka/net. Not politeness:
 *            the brief forbids bypassing a publisher's stated terms, and
 *            robots.txt is the machine-readable form of them.
 *
 * The frontier below enforces scope and budget. It takes robots decisions as
 * an input rather than fetching them, so this file stays pure.
 */

export interface CrawlPolicy {
  /** Absolute limit on pages fetched. Reached, the crawl stops cleanly. */
  readonly maxPages: number;
  /** Link depth from the seed. 0 fetches only the seeds themselves. */
  readonly maxDepth: number;
  /** Total bytes across every page, so many small pages are bounded too. */
  readonly maxTotalBytes: number;
  /**
   * When true, only URLs on the seed's exact host are followed.
   * The default, because "index my site" almost never means "and everything
   * my site links to".
   */
  readonly sameHostOnly: boolean;
  /** Extra hosts permitted beyond the seed's, e.g. `docs.example.com`. */
  readonly additionalHosts: readonly string[];
  /**
   * When set, a URL's path must start with one of these. Lets an operator
   * index `/docs` without dragging in a blog and a careers section.
   */
  readonly pathPrefixes: readonly string[];
}

export const DEFAULT_CRAWL_POLICY: CrawlPolicy = {
  maxPages: 50,
  maxDepth: 2,
  maxTotalBytes: 20 * 1024 * 1024,
  sameHostOnly: true,
  additionalHosts: [],
  pathPrefixes: [],
};

/** Hard ceilings. An operator may lower these; nothing may raise them. */
export const CRAWL_CEILINGS = {
  maxPages: 500,
  maxDepth: 5,
  maxTotalBytes: 100 * 1024 * 1024,
} as const;

export function clampPolicy(policy: Partial<CrawlPolicy>): CrawlPolicy {
  const merged = { ...DEFAULT_CRAWL_POLICY, ...policy };
  return {
    ...merged,
    maxPages: clamp(merged.maxPages, 1, CRAWL_CEILINGS.maxPages),
    maxDepth: clamp(merged.maxDepth, 0, CRAWL_CEILINGS.maxDepth),
    maxTotalBytes: clamp(merged.maxTotalBytes, 1024, CRAWL_CEILINGS.maxTotalBytes),
  };
}

/* -------------------------------------------------------------------------- */
/* URL normalisation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Query parameters dropped before comparing URLs.
 *
 * Analytics tags are the single largest source of duplicate crawling: the same
 * page arrives a dozen times under a dozen campaign ids, each looking distinct
 * to a naive `Set`, each costing a fetch and a chunk of the page budget.
 *
 * Only parameters that are unambiguously tracking are listed. Anything that
 * could select content — `id`, `page`, `q` — is left alone, because dropping
 * one would silently merge two different pages into one.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  '_ga',
  'igshid',
]);

/**
 * Canonical form of a URL, for deduplication and scope checks.
 *
 * Returns null for anything that is not a fetchable web page: other schemes,
 * malformed input, credentials in the URL. `mailto:` and `javascript:` links
 * are abundant in real pages and must never reach the fetcher.
 *
 * The fragment is always dropped — `#section` is a position within a document
 * we would fetch identically, and keeping it is how a page with a table of
 * contents consumes an entire crawl budget on itself.
 */
export function normaliseUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentials in a crawl target are either a mistake or an attempt to make
  // us authenticate somewhere. Neither is something to follow.
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;

  url.hash = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  // Stable parameter order, so `?a=1&b=2` and `?b=2&a=1` are one page.
  url.searchParams.sort();

  // A trailing slash on the root only. Elsewhere `/docs` and `/docs/` are
  // frequently distinct pages and merging them would lose one.
  if (url.pathname === '') url.pathname = '/';

  return url.toString();
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

export const OutOfScope = {
  MALFORMED: 'malformed',
  WRONG_HOST: 'wrong_host',
  WRONG_PATH: 'wrong_path',
  TOO_DEEP: 'too_deep',
  ALREADY_SEEN: 'already_seen',
  BUDGET_PAGES: 'budget_pages',
  BUDGET_BYTES: 'budget_bytes',
  ROBOTS: 'robots',
  NOT_A_PAGE: 'not_a_page',
} as const;

export type OutOfScope = (typeof OutOfScope)[keyof typeof OutOfScope];

/**
 * File extensions never worth fetching in a crawl.
 *
 * Not a security control — `safeFetch` caps size and the parser refuses what
 * it cannot read. It is a budget control: an archive or a video will consume
 * the byte allowance and yield no text. PDFs and Office documents are
 * deliberately absent, because the parser handles them and they are often the
 * most useful thing on a documentation site.
 */
const UNFETCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.zip', '.gz', '.tar', '.rar', '.7z',
  '.exe', '.dmg', '.msi', '.iso', '.apk',
  '.mp4', '.mp3', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ogg', '.wav',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot',
  '.css', '.js', '.map',
]);

export function looksFetchable(url: string): boolean {
  const path = pathOf(url).toLowerCase();
  const dot = path.lastIndexOf('.');
  if (dot === -1) return true;
  const extension = path.slice(dot);
  // A dot in a directory name is not an extension.
  if (extension.includes('/')) return true;
  return !UNFETCHABLE_EXTENSIONS.has(extension);
}

export function inScope(
  url: string,
  policy: CrawlPolicy,
  seedHosts: readonly string[],
): { ok: true } | { ok: false; reason: OutOfScope } {
  const host = hostOf(url);
  if (!host) return { ok: false, reason: OutOfScope.MALFORMED };

  const permitted = [...seedHosts, ...policy.additionalHosts].map((h) => h.toLowerCase());

  if (policy.sameHostOnly) {
    if (!permitted.includes(host)) return { ok: false, reason: OutOfScope.WRONG_HOST };
  } else if (permitted.length > 0) {
    /*
     * The suffix check needs the dot INSIDE the compared string, or
     * `evil-example.com` passes as a subdomain of `example.com`. Same trap as
     * the chatbot origin allowlist, and it is worth writing out twice.
     */
    const ok = permitted.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    if (!ok) return { ok: false, reason: OutOfScope.WRONG_HOST };
  }

  if (policy.pathPrefixes.length > 0) {
    const path = pathOf(url);
    if (!policy.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
      return { ok: false, reason: OutOfScope.WRONG_PATH };
    }
  }

  if (!looksFetchable(url)) return { ok: false, reason: OutOfScope.NOT_A_PAGE };

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Frontier                                                                    */
/* -------------------------------------------------------------------------- */

export interface QueuedUrl {
  readonly url: string;
  readonly depth: number;
}

export interface SkippedUrl {
  readonly url: string;
  readonly reason: OutOfScope;
}

/**
 * The work queue for one crawl.
 *
 * Breadth-first, which matters: a documentation site's most useful pages are
 * usually one or two links from the entry point, and a depth-first crawl
 * spends its entire budget in the first branch it happens to enter.
 *
 * Every rejection is recorded with a reason. An operator whose crawl returned
 * four pages needs to know whether the rest were off-host, robots-disallowed
 * or simply over budget, and "it finished" tells them nothing.
 */
export class CrawlFrontier {
  private readonly queue: QueuedUrl[] = [];
  private readonly seen = new Set<string>();
  private readonly skipped: SkippedUrl[] = [];
  private readonly seedHosts: string[] = [];
  private pagesFetched = 0;
  private bytesFetched = 0;

  constructor(private readonly policy: CrawlPolicy) {}

  /** Add a starting point. Seeds define the host scope. */
  seed(rawUrl: string): boolean {
    const url = normaliseUrl(rawUrl);
    if (!url) {
      this.skipped.push({ url: rawUrl, reason: OutOfScope.MALFORMED });
      return false;
    }
    const host = hostOf(url);
    if (host && !this.seedHosts.includes(host)) this.seedHosts.push(host);

    if (this.seen.has(url)) return false;
    this.seen.add(url);
    this.queue.push({ url, depth: 0 });
    return true;
  }

  /**
   * Offer a discovered link.
   *
   * Returns whether it was accepted, and records why not when it was not.
   * Depth is checked BEFORE scope so a link that is both too deep and
   * off-host reports the reason an operator can act on.
   */
  offer(rawUrl: string, fromUrl: string, depth: number): boolean {
    const url = normaliseUrl(rawUrl, fromUrl);
    if (!url) return false; // Anchors, mailto:, javascript: — not worth reporting.

    if (this.seen.has(url)) {
      this.skipped.push({ url, reason: OutOfScope.ALREADY_SEEN });
      return false;
    }
    if (depth > this.policy.maxDepth) {
      this.seen.add(url);
      this.skipped.push({ url, reason: OutOfScope.TOO_DEEP });
      return false;
    }

    const scope = inScope(url, this.policy, this.seedHosts);
    if (!scope.ok) {
      this.seen.add(url);
      this.skipped.push({ url, reason: scope.reason });
      return false;
    }

    this.seen.add(url);
    this.queue.push({ url, depth });
    return true;
  }

  /** The next URL to fetch, or null when the crawl is finished. */
  next(): QueuedUrl | null {
    if (this.exhausted()) return null;
    return this.queue.shift() ?? null;
  }

  /**
   * Record a completed fetch against the budget.
   *
   * Byte accounting happens here rather than in `next()` because the size is
   * only known afterwards. The consequence is that the byte budget can be
   * exceeded by at most one page, which is bounded by `safeFetch`'s own
   * per-response cap.
   */
  record(bytes: number): void {
    this.pagesFetched += 1;
    this.bytesFetched += bytes;
  }

  /** Note a URL refused by robots.txt, so the operator can see it happened. */
  recordRobotsRefusal(url: string): void {
    this.skipped.push({ url, reason: OutOfScope.ROBOTS });
  }

  exhausted(): boolean {
    return (
      this.pagesFetched >= this.policy.maxPages ||
      this.bytesFetched >= this.policy.maxTotalBytes
    );
  }

  /** Why the crawl stopped, for the operator-facing summary. */
  stopReason(): 'complete' | 'page_budget' | 'byte_budget' {
    if (this.pagesFetched >= this.policy.maxPages) return 'page_budget';
    if (this.bytesFetched >= this.policy.maxTotalBytes) return 'byte_budget';
    return 'complete';
  }

  get stats(): {
    pagesFetched: number;
    bytesFetched: number;
    queued: number;
    skipped: readonly SkippedUrl[];
  } {
    return {
      pagesFetched: this.pagesFetched,
      bytesFetched: this.bytesFetched,
      queued: this.queue.length,
      skipped: this.skipped,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
