import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Database, knowledgeSources, SourceStatus } from '@moka/db';
import { NotFoundError, ValidationError, type TenantContext } from '@moka/core';
import {
  CrawlFrontier,
  clampPolicy,
  extractPage,
  normaliseUrl,
  OutOfScope,
  type CrawlPolicy,
} from '@moka/research';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { IngestionService } from '../knowledge/ingestion.service.js';
import { RobotsService } from './robots.service.js';
import { PageFetcherService } from './page-fetcher.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * The website crawler (master prompt §7; deferred from Phase 2b).
 *
 * Turns a WEBSITE knowledge source into indexed documents:
 *
 *   seed → robots check → fetch → extract → ingest → follow links → repeat
 *
 * Scope and budget live in `@moka/research` as pure functions, so what a crawl
 * is permitted to do can be read and tested without a network. This service
 * supplies the network, the clock and the database.
 *
 * TWO THINGS THIS DOES THAT A NAIVE CRAWLER DOES NOT
 *
 *  1. IT ASKS FIRST. robots.txt is checked before every fetch, and a `noindex`
 *     on the page itself means the page is read but NOT stored. Both are the
 *     publisher's stated terms, and the brief forbids bypassing those.
 *
 *  2. IT REPORTS WHAT IT SKIPPED. An operator whose crawl indexed four pages
 *     needs to know whether the rest were off-host, disallowed or over budget.
 *     "Finished" tells them nothing and invites them to assume the site was
 *     small.
 *
 * SYNCHRONOUS, like the rest of ingestion. A queue needs Valkey, which needs
 * Docker (roadmap §B2). The page and byte budgets are what keep that bounded,
 * and the default of 50 pages is chosen so a crawl completes inside a request
 * rather than because 50 is the right number of pages.
 */

export interface CrawlSummary {
  readonly sourceId: string;
  readonly pagesIndexed: number;
  readonly pagesFetched: number;
  readonly bytesFetched: number;
  readonly stopReason: string;
  readonly skipped: ReadonlyArray<{ url: string; reason: string }>;
  readonly warnings: readonly string[];
}

/**
 * Politeness delay between requests to the same site, when robots.txt does not
 * state one. Not a tuning knob: a crawler with no delay is indistinguishable
 * from a small denial of service, and the sites being crawled did not ask for
 * this traffic.
 */
const DEFAULT_DELAY_MS = 250;

/** Never wait longer than this between pages, whatever robots.txt asks. */
const MAX_DELAY_MS = 5_000;

@Injectable()
export class CrawlerService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly robots: RobotsService,
    private readonly fetcher: PageFetcherService,
    private readonly ingestion: IngestionService,
    private readonly audit: AuditService,
  ) {}

  async crawl(
    context: TenantContext,
    input: {
      sourceId: string;
      seedUrls: readonly string[];
      policy?: Partial<CrawlPolicy>;
      requestId?: string | undefined;
    },
  ): Promise<CrawlSummary> {
    const source = await this.requireSource(context, input.sourceId);

    const policy = clampPolicy(input.policy ?? {});
    const frontier = new CrawlFrontier(policy);

    const seeds = input.seedUrls.map((url) => normaliseUrl(url)).filter((url): url is string => !!url);
    if (seeds.length === 0) {
      throw new ValidationError({ seedUrls: 'At least one valid http(s) URL is required.' });
    }
    for (const seed of seeds) frontier.seed(seed);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(knowledgeSources)
        .set({ status: SourceStatus.PROCESSING, errorMessage: null, updatedAt: new Date() })
        .where(eq(knowledgeSources.id, source.id));
    });

    const warnings: string[] = [];
    let pagesIndexed = 0;
    let lastFetchAt = 0;

    try {
      for (;;) {
        const item = frontier.next();
        if (!item) break;

        /*
         * The publisher's own rules, checked before the request.
         *
         * An SSRF refusal propagates out of the robots check rather than being
         * reported as a robots decision — saying "their robots.txt disallows
         * it" about an internal address would be a false statement about a
         * publisher. Caught here so one bad link ends that page, not the crawl.
         */
        try {
          if (!(await this.robots.allowed(item.url))) {
            frontier.recordRobotsRefusal(item.url);
            continue;
          }
        } catch (error) {
          warnings.push(`${item.url}: ${describeFailure(error)}`);
          continue;
        }

        await this.pause(item.url, lastFetchAt);
        lastFetchAt = Date.now();

        let page;
        try {
          page = await this.fetcher.fetch(item.url);
        } catch (error) {
          warnings.push(`${item.url}: ${describeFailure(error)}`);
          continue;
        }

        frontier.record(page.byteLength);

        if (page.status < 200 || page.status >= 300) {
          warnings.push(`${item.url}: the site returned ${page.status}.`);
          continue;
        }

        const contentType = (page.contentType ?? '').toLowerCase();
        const isHtml = contentType.includes('html') || contentType === '';
        if (!isHtml) {
          warnings.push(`${item.url}: not an HTML page.`);
          continue;
        }

        const extracted = extractPage(page.body, page.finalUrl);

        /*
         * `noindex` is honoured by not STORING the page — while still
         * following its links unless it also said nofollow. A publisher who
         * asked not to be indexed has said something specific, and reading the
         * page anyway while calling the result an index is exactly the kind of
         * technicality the brief rules out.
         */
        if (!extracted.noindex && extracted.text.trim().length > 0) {
          await this.ingestion.ingestText(context, {
            sourceId: source.id,
            title: extracted.title ?? page.finalUrl,
            text: extracted.text,
            url: page.finalUrl,
            requestId: input.requestId,
          });
          pagesIndexed += 1;
        } else if (extracted.noindex) {
          frontier.recordRobotsRefusal(item.url);
        }

        for (const link of extracted.links) {
          frontier.offer(link, page.finalUrl, item.depth + 1);
        }
      }
    } finally {
      const stats = frontier.stats;
      await this.db.withTenant(context, async (tx) => {
        await tx
          .update(knowledgeSources)
          .set({
            status: pagesIndexed > 0 ? SourceStatus.READY : SourceStatus.FAILED,
            errorMessage:
              pagesIndexed > 0
                ? null
                : 'No pages could be indexed. See the skipped list for the reason.',
            lastIndexedAt: new Date(),
            updatedAt: new Date(),
            // Kept on the source so the next crawl can repeat what worked, and
            // so an operator can see what the last one actually did.
            config: {
              ...(source.config as Record<string, unknown>),
              seedUrls: seeds,
              policy,
              lastCrawl: {
                at: new Date().toISOString(),
                pagesIndexed,
                pagesFetched: stats.pagesFetched,
                stopReason: frontier.stopReason(),
              },
            },
          })
          .where(eq(knowledgeSources.id, source.id));
      });
    }

    const stats = frontier.stats;

    await this.audit.record(context, {
      action: 'knowledge.crawl',
      resourceType: 'knowledge_source',
      resourceId: source.id,
      after: {
        seeds,
        pagesIndexed,
        pagesFetched: stats.pagesFetched,
        stopReason: frontier.stopReason(),
      },
      requestId: input.requestId,
    });

    getLogger().info(
      {
        organizationId: context.organizationId,
        sourceId: source.id,
        pagesIndexed,
        pagesFetched: stats.pagesFetched,
        skipped: stats.skipped.length,
      },
      'website crawl finished',
    );

    return {
      sourceId: source.id,
      pagesIndexed,
      pagesFetched: stats.pagesFetched,
      bytesFetched: stats.bytesFetched,
      stopReason: frontier.stopReason(),
      // Bounded: a crawl that rejects two thousand off-host links should not
      // return two thousand rows to a browser.
      skipped: summariseSkipped(stats.skipped),
      warnings: warnings.slice(0, 50),
    };
  }

  /**
   * Wait between requests to the same site.
   *
   * Honours `Crawl-delay` when the site states one, and applies a small
   * default when it does not. Capped, so a site asking for five minutes
   * between pages does not hold a request open — that crawl simply ends early
   * against its budget, which is the honest outcome.
   */
  private async pause(url: string, lastFetchAt: number): Promise<void> {
    const stated = await this.robots.crawlDelaySeconds(url);
    const wanted = Math.min(stated !== null ? stated * 1000 : DEFAULT_DELAY_MS, MAX_DELAY_MS);
    const elapsed = Date.now() - lastFetchAt;
    if (lastFetchAt > 0 && elapsed < wanted) {
      await new Promise((resolve) => setTimeout(resolve, wanted - elapsed));
    }
  }

  private async requireSource(context: TenantContext, sourceId: string) {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            eq(knowledgeSources.organizationId, context.organizationId),
          ),
        )
        .limit(1),
    );

    const source = rows[0];
    if (!source || source.deletedAt) throw new NotFoundError('Knowledge source');
    if (source.type !== 'WEBSITE') {
      throw new ValidationError({ sourceId: 'This source is not a website source.' });
    }
    return source;
  }
}

/**
 * Collapse the skip list to something a person can read.
 *
 * A crawl that stayed on one site will have rejected every outbound link on
 * every page. Listing them individually buries the two rejections an operator
 * could actually act on.
 */
function summariseSkipped(
  skipped: ReadonlyArray<{ url: string; reason: OutOfScope }>,
): Array<{ url: string; reason: string }> {
  const byReason = new Map<string, string[]>();
  for (const entry of skipped) {
    byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.url]);
  }

  const out: Array<{ url: string; reason: string }> = [];
  for (const [reason, urls] of byReason) {
    for (const url of urls.slice(0, 10)) out.push({ url, reason });
    if (urls.length > 10) {
      out.push({ url: `…and ${urls.length - 10} more`, reason });
    }
  }
  return out;
}

function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'SsrfBlockedError') return 'this address is not one we are permitted to fetch.';
  if (name === 'FetchTimeoutError') return 'the site did not respond in time.';
  if (name === 'ResponseTooLargeError') return 'the page was too large to read.';
  return 'the page could not be fetched.';
}
