import { safeFetch } from '@moka/net';

/**
 * Web search providers (master prompt §2, §8, §45).
 *
 * THE HONEST PROBLEM WITH THIS STEP
 *
 * Path C is "question → search → collect → extract → verify → synthesize →
 * cite". Every stage of that is buildable with no paid dependency except the
 * first one, and there is no way to pretend otherwise:
 *
 *   PAID APIs (Brave, Serper, Tavily, Exa, Bing). Good, cheap, and paid. The
 *     brief permits paid services only where technically unavoidable, and this
 *     one is avoidable — so none is bundled. An adapter can be added later as
 *     an explicitly OPTIONAL/PAID integration.
 *
 *   SCRAPING Google or Bing. Ruled out flatly. The brief says never bypass a
 *     provider's terms, and their terms prohibit it. It would also break
 *     without warning and take a tenant's crawl down with it.
 *
 *   SEARXNG, self-hosted. FREE and open source (AGPL — run as a service, never
 *     linked into our code, so the licence obligation stays with the operator's
 *     own deployment). Supported here, and the recommended configuration.
 *     Requires the operator to run an instance.
 *
 *   SEED URLs. No search engine at all: the operator or agent supplies the
 *     pages to read. Always available, needs nothing, and for the most common
 *     real request — "read these three competitor pages and tell me what they
 *     say" — it is not a fallback but the correct tool.
 *
 * So the default provider is seed URLs, SearXNG is configured if the operator
 * has one, and research WORKS OUT OF THE BOX with explicit sources rather than
 * appearing to work by inventing them.
 */

export interface SearchHit {
  readonly url: string;
  readonly title: string | null;
  /** The engine's own summary. Never used as evidence — only to rank. */
  readonly snippet: string | null;
  /** Which engine produced this, for the run record. */
  readonly engine: string;
}

export interface SearchProvider {
  readonly id: string;
  /** Shown in the UI so an operator knows what is configured and what is not. */
  readonly label: string;
  readonly requiresNetwork: boolean;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/* -------------------------------------------------------------------------- */
/* Seed URLs — always available                                                */
/* -------------------------------------------------------------------------- */

/**
 * A provider that returns exactly the URLs it was given.
 *
 * Deliberately not a stub. The engine step exists to turn a question into
 * candidate documents; when a person already knows which documents, skipping
 * it is not a degraded mode. It is also the only provider that can be fully
 * tested here, so the pipeline downstream of it is genuinely exercised.
 */
export function seedUrlProvider(urls: readonly string[]): SearchProvider {
  return {
    id: 'seed',
    label: 'Explicit URLs',
    requiresNetwork: false,
    async search(_query: string, limit: number): Promise<SearchHit[]> {
      return urls.slice(0, limit).map((url) => ({
        url,
        title: null,
        snippet: null,
        engine: 'seed',
      }));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* SearXNG                                                                     */
/* -------------------------------------------------------------------------- */

interface SearxngResponse {
  results?: Array<{ url?: unknown; title?: unknown; content?: unknown; engine?: unknown }>;
}

/**
 * SearXNG's documented JSON API.
 *
 * NOT VERIFIED AGAINST A REAL INSTANCE. There is none on this machine, and
 * running one needs Docker (roadmap §B2). It follows the documented request
 * and response shape and is tested against a local server that speaks that
 * shape — the same approach taken for the provider adapters in Phase 3, and
 * for the same reason: the wire format can be exercised honestly even when the
 * upstream cannot.
 *
 * `baseUrl` comes from validated boot configuration, so it is a legitimate
 * target for a private address — an operator running SearXNG on their own
 * network is the expected deployment. The exception is derived from that one
 * configured host and nothing else; see the block comment on the constant
 * below, and `configuredInternalHosts` in @moka/net.
 */
export function createSearxngProvider(options: {
  baseUrl: string;
  /** Categories to search. `general` unless the operator narrows it. */
  categories?: readonly string[];
  timeoutMs?: number;
}): SearchProvider {
  const base = options.baseUrl.replace(/\/+$/, '');

  /*
   * The instance host is permitted to be a private address, because a
   * self-hosted SearXNG usually is. Derived HERE from the configured base URL
   * and from nothing else — no request, no model, no crawl target can widen
   * it — which is the whole reason the exception is safe. See
   * `configuredInternalHosts` in @moka/net.
   */
  const internalHost = hostnameOf(base);
  const configuredInternalHosts = internalHost ? [internalHost] : [];

  return {
    id: 'searxng',
    label: 'SearXNG (self-hosted)',
    requiresNetwork: true,
    async search(query: string, limit: number): Promise<SearchHit[]> {
      const url = new URL(`${base}/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('categories', (options.categories ?? ['general']).join(','));

      const response = await safeFetch(url.toString(), {
        headers: { accept: 'application/json' },
        timeoutMs: options.timeoutMs ?? 15_000,
        // A search index is metadata, not a document. Anything larger than
        // this is a misconfigured instance, not a big result set.
        maxBytes: 2 * 1024 * 1024,
        // No redirects: a search endpoint that redirects is not one we
        // configured, and following it would leave the operator's instance.
        maxRedirects: 0,
        configuredInternalHosts,
      });

      if (response.status < 200 || response.status >= 300) {
        throw new SearchUnavailableError('searxng', response.status);
      }

      let payload: SearxngResponse;
      try {
        payload = response.json<SearxngResponse>();
      } catch {
        throw new SearchUnavailableError('searxng', response.status);
      }

      const results = Array.isArray(payload.results) ? payload.results : [];

      return results
        .map((row) => ({
          url: typeof row.url === 'string' ? row.url : '',
          title: typeof row.title === 'string' ? row.title : null,
          snippet: typeof row.content === 'string' ? row.content : null,
          engine: typeof row.engine === 'string' ? `searxng:${row.engine}` : 'searxng',
        }))
        // Everything from here is third-party data. A result whose URL is not
        // a string, or is empty, is dropped rather than repaired.
        .filter((hit) => hit.url.length > 0)
        .slice(0, limit);
    },
  };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export class SearchUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    // Generic on purpose: this message can reach a user, and the provider's
    // own error text may name internal hosts.
    super('Web search is unavailable right now.');
    this.name = 'SearchUnavailableError';
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export interface SearchCapabilities {
  /** Providers an operator could use, with whether each is configured. */
  readonly providers: ReadonlyArray<{
    id: string;
    label: string;
    configured: boolean;
    /** Plain-language reason when it is not configured. */
    note: string | null;
  }>;
}

/**
 * What the UI is told about search.
 *
 * Reports honestly that no engine is configured rather than degrading quietly.
 * A research feature that silently answers from model priors because search
 * was unavailable is the exact failure this phase is measured against, and the
 * user is the last person who should have to infer it.
 */
export function describeSearchCapabilities(searxngUrl: string | undefined): SearchCapabilities {
  return {
    providers: [
      {
        id: 'seed',
        label: 'Explicit URLs',
        configured: true,
        note: null,
      },
      {
        id: 'searxng',
        label: 'SearXNG (self-hosted)',
        configured: Boolean(searxngUrl),
        note: searxngUrl
          ? null
          : 'Set SEARXNG_URL to a SearXNG instance to search the web by keyword. ' +
            'Without it, research runs against URLs you supply.',
      },
    ],
  };
}
