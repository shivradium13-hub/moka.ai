import { Injectable } from '@nestjs/common';
import {
  CRAWLER_TOKEN,
  CRAWLER_USER_AGENT,
  crawlDelayFor,
  isPathAllowed,
  parseRobotsTxt,
  robotsFetchFailurePolicy,
  safeFetch,
  type RobotsTxt,
} from '@moka/net';
import { getLogger } from '../../common/logger.js';

/**
 * Fetching and caching robots.txt (master prompt §2, §14).
 *
 * A publisher's robots.txt is the machine-readable form of their terms for
 * automated clients, and the brief forbids bypassing a provider's terms. So
 * this is consulted before every outbound page fetch on both the crawl and the
 * research paths — not as a courtesy, but because fetching a path a publisher
 * has said in writing not to fetch is the thing we agreed not to do.
 *
 * CACHED PER ORIGIN, and the cache is the polite part as much as the fast
 * part: without it, a fifty-page crawl means fifty-one requests to the same
 * robots.txt, which is itself the behaviour a site owner would complain about.
 *
 * The cache is IN-MEMORY and per-process, like the rate limiter. That is a
 * genuine limitation behind multiple instances — each would fetch its own
 * copy — but not a correctness problem: every instance reaches the same
 * decision from the same file. A shared cache belongs with Valkey (§B2).
 */

interface CacheEntry {
  readonly robots: RobotsTxt | null;
  /** Applied when `robots` is null: the file could not be read. */
  readonly fallback: 'allow' | 'deny';
  readonly expiresAt: number;
}

/** How long a robots.txt is trusted. Long enough to matter, short enough to fix. */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** A robots.txt larger than this is not a robots.txt. */
const MAX_ROBOTS_BYTES = 512 * 1024;

@Injectable()
export class RobotsService {
  private readonly cache = new Map<string, CacheEntry>();

  /** Whether this URL may be fetched, per the site's own rules. */
  async allowed(rawUrl: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }

    const entry = await this.load(url.origin);
    if (!entry.robots) return entry.fallback === 'allow';

    return isPathAllowed(entry.robots, CRAWLER_TOKEN, `${url.pathname}${url.search}`);
  }

  /** The site's requested delay between requests, if it stated one. */
  async crawlDelaySeconds(rawUrl: string): Promise<number | null> {
    try {
      const entry = await this.load(new URL(rawUrl).origin);
      return entry.robots ? crawlDelayFor(entry.robots, CRAWLER_TOKEN) : null;
    } catch {
      return null;
    }
  }

  private async load(origin: string): Promise<CacheEntry> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const entry = await this.fetchRobots(origin);
    this.cache.set(origin, entry);
    this.sweep();
    return entry;
  }

  private async fetchRobots(origin: string): Promise<CacheEntry> {
    const expiresAt = Date.now() + CACHE_TTL_MS;

    try {
      const response = await safeFetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': CRAWLER_USER_AGENT, accept: 'text/plain' },
        timeoutMs: 10_000,
        maxBytes: MAX_ROBOTS_BYTES,
        /*
         * Redirects are followed, but only two hops. `example.com/robots.txt`
         * redirecting to `www.example.com/robots.txt` is entirely normal;
         * a longer chain is a site doing something we should not be guessing
         * the intent of. safeFetch re-validates each hop against the SSRF
         * rules regardless.
         */
        maxRedirects: 2,
      });

      const policy = robotsFetchFailurePolicy(response.status);
      if (response.status < 200 || response.status >= 300) {
        return { robots: null, fallback: policy, expiresAt };
      }

      return { robots: parseRobotsTxt(response.text()), fallback: 'allow', expiresAt };
    } catch (error) {
      /*
       * An SSRF refusal is NOT a robots decision, and must not be reported as
       * one. "This site's robots.txt disallows it" for 169.254.169.254 is a
       * false statement about a publisher, and it hides the real reason from
       * the operator reading the result. Rethrown so the caller can attribute
       * it correctly.
       */
      if (error instanceof Error && error.name === 'SsrfBlockedError') throw error;

      /*
       * Any other failure means we could not read the rules, so we do not
       * crawl the site. RFC 9309 §2.3.1 suggests using a previously cached
       * result; on a first visit there is none, and the cautious reading is
       * the one that cannot embarrass a tenant by hammering a site that had
       * asked us not to.
       */
      getLogger().info(
        { origin, error: error instanceof Error ? error.name : 'unknown' },
        'robots.txt unavailable; treating the site as disallowed',
      );
      return { robots: null, fallback: 'deny', expiresAt };
    }
  }

  /** Keep the map from growing without bound across many crawled hosts. */
  private sweep(): void {
    if (this.cache.size < 500) return;
    const now = Date.now();
    for (const [origin, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(origin);
    }
  }
}
