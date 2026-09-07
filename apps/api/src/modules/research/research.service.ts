import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Database, researchRuns, researchSources } from '@moka/db';
import { ConflictError, NotFoundError, type TenantContext } from '@moka/core';
import { loadConfig } from '@moka/config';
import {
  DEFAULT_RESEARCH_OPTIONS,
  ResearchStatus,
  SourceOutcome,
  createSearxngProvider,
  describeSearchCapabilities,
  runResearch,
  seedUrlProvider,
  type ResearchModel,
  type ResearchResult,
  type SearchProvider,
} from '@moka/research';
import { Feature } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { GatewayService } from '../ai/gateway.service.js';
import { RobotsService } from './robots.service.js';
import { PageFetcherService } from './page-fetcher.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * Web research (architecture §5 Path C).
 *
 * Wires the pure pipeline in `@moka/research` to the network, the AI gateway
 * and the database. The pipeline itself has no I/O, which is what let every
 * failure path — robots refusal, blocked address, nothing collected — be
 * tested without the internet needing to be a particular way.
 *
 * THIS SERVICE'S OWN JOB IS THE RECORD.
 *
 * Every run is persisted with the sources it fetched AND the candidates it
 * skipped, including the excerpt the model was shown. "No fabricated
 * citations" is a claim about a system; storing the evidence is what lets
 * somebody check it six months later without taking our word for it.
 */

/** Bound on how many URLs a caller may hand to one run. */
const MAX_SEED_URLS = 10;

export interface ResearchRunSummary {
  id: string;
  question: string;
  status: string;
  answer: string | null;
  searchProvider: string;
  citationCount: number;
  startedAt: Date;
}

@Injectable()
export class ResearchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly robots: RobotsService,
    private readonly fetcher: PageFetcherService,
    private readonly gateway: GatewayService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** What the UI is told about search, so it never implies a capability. */
  capabilities() {
    return describeSearchCapabilities(loadConfig().SEARXNG_URL);
  }

  /**
   * Choose a search provider.
   *
   * Explicit URLs win when the caller supplied any. That is not a fallback
   * ordering: a person who names three pages has been more specific than a
   * keyword search could be, and quietly searching instead would answer a
   * different question from the one they asked.
   */
  private providerFor(urls: readonly string[]): SearchProvider {
    if (urls.length > 0) return seedUrlProvider(urls.slice(0, MAX_SEED_URLS));

    const configured = loadConfig().SEARXNG_URL;
    if (configured) return createSearxngProvider({ baseUrl: configured });

    /*
     * Nothing configured and no URLs given. Returns an EMPTY provider rather
     * than throwing, so the pipeline reaches its own NO_RESULTS path and the
     * caller gets the same shaped answer with an honest explanation — instead
     * of a 500 that says nothing about what to do next.
     */
    return seedUrlProvider([]);
  }

  async run(
    context: TenantContext,
    input: {
      question: string;
      urls: readonly string[];
      projectId?: string | null;
      requestId?: string | undefined;
    },
  ): Promise<ResearchResult & { runId: string }> {
    /*
     * The monthly run limit, checked BEFORE any outbound request. A research
     * run costs a provider call and several requests to whoever is being
     * researched; refusing after the fetching would waste both.
     */
    await this.entitlements.requireQuota(context, Feature.RESEARCH_RUNS_PER_MONTH);

    const provider = this.providerFor(input.urls);
    const runId = await this.startRun(context, input, provider.id);

    let result: ResearchResult;
    try {
      result = await runResearch(
        input.question,
        {
          search: provider,
          fetcher: this.fetcher,
          robots: this.robots,
          model: this.modelFor(context, input.requestId),
        },
        DEFAULT_RESEARCH_OPTIONS,
      );
    } catch (error) {
      await this.failRun(context, runId, error);
      throw error;
    }

    await this.persist(context, runId, result);

    await this.audit.record(context, {
      action: 'research.run',
      resourceType: 'research_run',
      resourceId: runId,
      after: {
        status: result.status,
        provider: result.searchProvider,
        citations: result.citations.length,
        // Recorded because a pattern of fabrication across runs is worth being
        // able to find, and one instance is not.
        invalidMarkers: result.verification?.invalidMarkers.length ?? 0,
        inventedUrls: result.verification?.inventedUrls.length ?? 0,
      },
      outcome: result.status === ResearchStatus.ANSWERED ? 'success' : 'failure',
      requestId: input.requestId,
    });

    if ((result.verification?.inventedUrls.length ?? 0) > 0) {
      // Worth a log line of its own: the verifier caught something the prompt
      // asked the model not to do, and the rate of that is a health signal.
      getLogger().warn(
        {
          organizationId: context.organizationId,
          runId,
          inventedUrls: result.verification?.inventedUrls.length,
          invalidMarkers: result.verification?.invalidMarkers.length,
        },
        'research answer contained fabricated references; they were removed',
      );
    }

    return { ...result, runId };
  }

  /**
   * A model backed by the AI gateway.
   *
   * NOT VERIFIED against a live provider: no API key exists in this
   * environment (docs/roadmap.md §B). The pipeline around it is exercised
   * against a scripted model, which is what made the fabrication tests
   * possible at all.
   */
  private modelFor(context: TenantContext, requestId: string | undefined): ResearchModel {
    const gateway = this.gateway;
    return {
      async synthesize(request) {
        const response = await gateway.chat(
          context,
          {
            model: null,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          },
          { requestId },
        );
        return {
          text: response.text,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
      },
    };
  }

  private async startRun(
    context: TenantContext,
    input: { question: string; projectId?: string | null; requestId?: string | undefined },
    provider: string,
  ): Promise<string> {
    const [row] = await this.db.withTenant(context, async (tx) =>
      tx
        .insert(researchRuns)
        .values({
          organizationId: context.organizationId,
          projectId: input.projectId ?? null,
          question: input.question,
          searchProvider: provider,
          createdBy: context.userId,
          requestId: input.requestId ?? null,
        })
        .returning({ id: researchRuns.id }),
    );
    if (!row) throw new ConflictError('The research run could not be started.');
    return row.id;
  }

  /**
   * Persist the run and its ledger.
   *
   * Both the verified answer and the RAW one are stored. If the system
   * silently corrected an answer, the person relying on it should be able to
   * see what was corrected — keeping only our tidied version would hide our
   * own edits from the only people who would want to review them.
   */
  private async persist(
    context: TenantContext,
    runId: string,
    result: ResearchResult,
  ): Promise<void> {
    /*
     * Keyed on the REQUESTED url, which is what `attempts` records, so a
     * redirect does not break the join. `collected` is the ledger in fetch
     * order — the citation list is not, since it is ordered by first mention
     * in the answer and omits sources the model chose not to cite.
     */
    const ledger = new Map(result.collected.map((entry) => [entry.requestedUrl, entry]));

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(researchRuns)
        .set({
          status: result.status,
          answer: result.answer,
          rawAnswer: result.rawAnswer,
          verification: (result.verification ?? {}) as never,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          finishedAt: new Date(),
        })
        .where(
          and(eq(researchRuns.id, runId), eq(researchRuns.organizationId, context.organizationId)),
        );

      if (result.attempts.length === 0) return;

      /*
       * `ordinal` is the citation number, unique within a run, so a candidate
       * that was skipped gets NULL rather than a number. A hole in the
       * numbering would be a citation that resolves to nothing while looking
       * valid, which is the failure this whole feature exists to prevent.
       */
      await tx.insert(researchSources).values(
        result.attempts.map((attempt) => {
          const entry = ledger.get(attempt.url);
          const collected = attempt.outcome === SourceOutcome.COLLECTED && entry !== undefined;

          return {
            organizationId: context.organizationId,
            runId,
            ordinal: collected ? entry.id : null,
            requestedUrl: attempt.url,
            finalUrl: collected ? entry.url : null,
            title: collected ? entry.title : null,
            contentHash: collected ? entry.contentHash : null,
            // The evidence itself: exactly the text the model was shown.
            excerpt: collected ? entry.excerpt : null,
            outcome: attempt.outcome,
            detail: attempt.detail,
            fetchedAt: collected ? entry.fetchedAt : null,
          };
        }),
      );
    });
  }

  private async failRun(context: TenantContext, runId: string, error: unknown): Promise<void> {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'INTERNAL';

    await this.db
      .withTenant(context, async (tx) => {
        await tx
          .update(researchRuns)
          .set({ status: 'failed', errorCode: code, finishedAt: new Date() })
          .where(
            and(
              eq(researchRuns.id, runId),
              eq(researchRuns.organizationId, context.organizationId),
            ),
          );
      })
      .catch(() => undefined);
  }

  async list(context: TenantContext, limit = 30): Promise<ResearchRunSummary[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({
          id: researchRuns.id,
          question: researchRuns.question,
          status: researchRuns.status,
          answer: researchRuns.answer,
          searchProvider: researchRuns.searchProvider,
          startedAt: researchRuns.startedAt,
        })
        .from(researchRuns)
        .where(eq(researchRuns.organizationId, context.organizationId))
        .orderBy(desc(researchRuns.startedAt))
        .limit(Math.min(limit, 100));

      const sources = await tx
        .select({ runId: researchSources.runId, ordinal: researchSources.ordinal })
        .from(researchSources)
        .where(eq(researchSources.organizationId, context.organizationId));

      const counts = new Map<string, number>();
      for (const source of sources) {
        if (source.ordinal === null) continue;
        counts.set(source.runId, (counts.get(source.runId) ?? 0) + 1);
      }

      return rows.map((row) => ({ ...row, citationCount: counts.get(row.id) ?? 0 }));
    });
  }

  async get(context: TenantContext, runId: string) {
    return this.db.withTenant(context, async (tx) => {
      const runs = await tx
        .select()
        .from(researchRuns)
        .where(
          and(eq(researchRuns.id, runId), eq(researchRuns.organizationId, context.organizationId)),
        )
        .limit(1);

      const run = runs[0];
      if (!run) throw new NotFoundError('Research run');

      const sources = await tx
        .select({
          ordinal: researchSources.ordinal,
          requestedUrl: researchSources.requestedUrl,
          finalUrl: researchSources.finalUrl,
          title: researchSources.title,
          contentHash: researchSources.contentHash,
          outcome: researchSources.outcome,
          detail: researchSources.detail,
          fetchedAt: researchSources.fetchedAt,
        })
        .from(researchSources)
        .where(eq(researchSources.runId, runId))
        .orderBy(researchSources.createdAt);

      return {
        run: {
          id: run.id,
          question: run.question,
          status: run.status,
          answer: run.answer,
          searchProvider: run.searchProvider,
          verification: run.verification,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        },
        // Both halves. An answer that used two sources out of nine is a
        // different answer from one that had two candidates.
        sources,
      };
    });
  }
}
