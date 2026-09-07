import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { CRAWL_CEILINGS } from '@moka/research';
import { ResearchService } from './research.service.js';
import { CrawlerService } from './crawler.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

/**
 * Web research and website crawling (§7, §8, §9).
 *
 * PERMISSIONS ARE NOT THE OBVIOUS ONES, and both choices are deliberate:
 *
 *   RESEARCH_RUN, not PROJECT_READ, for research. It is not a read of our
 *     data. Every run spends provider tokens and sends requests from our
 *     address range to whoever is being researched. A viewer should be able to
 *     read this workspace without being able to cause either.
 *
 *   PROJECT_CREATE for crawling, matching the rest of ingestion. A crawl
 *     creates knowledge documents, which is what that permission governs.
 *
 * Reading a past run needs only PROJECT_READ: the outbound traffic already
 * happened, and the record of it is ordinary workspace data.
 */

const idSchema = z.string().uuid();

const runSchema = z.object({
  question: z.string().min(3).max(500),
  /*
   * Explicit URLs to read. When present these are used INSTEAD of a search:
   * a person who names three pages has been more specific than a keyword
   * query could be, and searching anyway would answer a different question.
   */
  urls: z.array(z.string().url()).max(10).default([]),
  projectId: z.string().uuid().nullish(),
});

const crawlSchema = z.object({
  sourceId: z.string().uuid(),
  seedUrls: z.array(z.string().url()).min(1).max(10),
  /*
   * Bounded at the edge as well as clamped in the service. Two checks because
   * they answer different questions: this one rejects a nonsensical request
   * with a message naming the field, and `clampPolicy` guarantees the
   * invariant regardless of which caller arrives.
   */
  maxPages: z.number().int().min(1).max(CRAWL_CEILINGS.maxPages).optional(),
  maxDepth: z.number().int().min(0).max(CRAWL_CEILINGS.maxDepth).optional(),
  sameHostOnly: z.boolean().optional(),
  additionalHosts: z.array(z.string().max(253)).max(10).optional(),
  pathPrefixes: z.array(z.string().max(200)).max(10).optional(),
});

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/research')
export class ResearchController {
  constructor(
    private readonly research: ResearchService,
    private readonly crawler: CrawlerService,
  ) {}

  /**
   * What search is actually available.
   *
   * Read by the UI so it can say "no search engine is configured; supply URLs"
   * rather than offering a keyword box that silently returns nothing. A
   * research feature that appears to search and does not is the failure this
   * phase is measured against.
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('capabilities')
  capabilities() {
    return this.research.capabilities();
  }

  @RequirePermission(Permission.RESEARCH_RUN)
  @Post()
  async run(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(runSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    const result = await this.research.run(tenant, {
      question: input.question,
      urls: input.urls,
      projectId: input.projectId ?? null,
      requestId,
    });

    return {
      runId: result.runId,
      status: result.status,
      answer: result.answer,
      citations: result.citations,
      // Returned so a user can see WHY an answer is thin. Two sources out of
      // nine is a different answer from two out of two.
      attempts: result.attempts,
      verification: result.verification,
      searchProvider: result.searchProvider,
    };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return { runs: await this.research.list(tenant) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get(':id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.research.get(tenant, parse(idSchema, id));
  }
}

@Controller('v1/knowledge')
export class CrawlController {
  constructor(private readonly crawler: CrawlerService) {}

  /**
   * Crawl a website into a knowledge source.
   *
   * Synchronous, like the rest of ingestion: the job queue needs Valkey, which
   * needs Docker (roadmap §B2). The page and byte budgets are what keep a
   * request bounded, and the default of 50 pages is chosen so a crawl finishes
   * inside one — not because 50 is the right number of pages.
   */
  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('crawl')
  async crawl(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(crawlSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));

    return this.crawler.crawl(tenant, {
      sourceId: input.sourceId,
      seedUrls: input.seedUrls,
      policy: {
        ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.sameHostOnly !== undefined ? { sameHostOnly: input.sameHostOnly } : {}),
        ...(input.additionalHosts ? { additionalHosts: input.additionalHosts } : {}),
        ...(input.pathPrefixes ? { pathPrefixes: input.pathPrefixes } : {}),
      },
      requestId,
    });
  }
}
