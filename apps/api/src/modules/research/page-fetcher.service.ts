import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CRAWLER_USER_AGENT, safeFetch } from '@moka/net';
import type { FetchedPage, PageFetcher } from '@moka/research';

/**
 * The one place a web page is fetched (docs/security.md §5).
 *
 * Both web-facing features — the website crawler and the research pipeline —
 * go through here, and here goes through `safeFetch`. That is the single
 * SSRF-guarded egress point, enforced by a lint rule that forbids raw `fetch`
 * outside `packages/net`, so this service cannot quietly acquire a second
 * route to the network.
 *
 * WHAT THIS ADDS ON TOP OF safeFetch
 *
 *  - A HONEST USER AGENT. It names the software and offers a contact URL, so
 *    a site owner can block us specifically rather than blocking every unknown
 *    client. Impersonating a browser would be a small deception with no upside
 *    and would also defeat the robots.txt token we ask sites to match on.
 *
 *  - A CONTENT HASH, computed over the bytes as received. It is what makes a
 *    citation checkable later and what lets the pipeline notice that two URLs
 *    are the same document.
 *
 *  - TIGHTER LIMITS than the defaults. A web page is not a file download: 5 MB
 *    and 20 seconds is generous for a document and mean for an attempt to make
 *    us hold a connection open.
 */

/** Per-page byte cap. Generous for a document, mean for a tarpit. */
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Per-page deadline, including redirects. */
const PAGE_TIMEOUT_MS = 20_000;

@Injectable()
export class PageFetcherService implements PageFetcher {
  async fetch(url: string): Promise<FetchedPage> {
    const response = await safeFetch(url, {
      headers: {
        'user-agent': CRAWLER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'en',
      },
      timeoutMs: PAGE_TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
      /*
       * Three hops. Every one is re-validated by safeFetch against the same
       * SSRF rules, so a redirect cannot be used to reach an address the first
       * URL would have been refused for.
       */
      maxRedirects: 3,
    });

    const contentType = response.headers['content-type'] ?? null;

    return {
      status: response.status,
      // AFTER redirects. This is what gets cited, and it is the only URL that
      // reliably names what was actually read.
      finalUrl: response.url,
      contentType,
      body: decode(response.body, contentType),
      byteLength: response.body.byteLength,
      contentHash: createHash('sha256').update(response.body).digest('hex'),
    };
  }
}

/**
 * Decode a page body to text.
 *
 * `fatal: false` on purpose. A page declaring UTF-8 and serving something else
 * is common, and refusing to read it would drop real documents; the
 * replacement characters that result are visible in the extract and are a
 * better outcome than an exception in the middle of a crawl.
 *
 * Only the charset from the header is honoured. A `<meta charset>` inside the
 * body would have to be read from bytes we have not decoded yet, and getting
 * that wrong is a way to mis-decode a page rather than a way to secure one.
 */
function decode(bytes: Uint8Array, contentType: string | null): string {
  const declared = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]?.toLowerCase();
  const encoding = declared && declared !== 'utf8' ? declared : 'utf-8';

  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    // An encoding label Node does not know. UTF-8 with replacement is a better
    // guess than failing the fetch outright.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
