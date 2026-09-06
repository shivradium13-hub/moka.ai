import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Database } from '@moka/db';
import { DATABASE } from '../../database/database.module.js';
import type { TenantContext } from '@moka/core';
import {
  RetrievalMode,
  parseQuery,
  reciprocalRankFusion,
  trigramNeedle,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievedChunk,
} from '@moka/knowledge';

interface RawRow {
  // Index signature required by drizzle's execute<T extends Record<string, unknown>>.
  [key: string]: unknown;
  chunk_id: string;
  document_id: string;
  source_id: string;
  content: string;
  page: number | null;
  section: string | null;
  heading_path: string[] | null;
  document_title: string;
  document_url: string | null;
  rank: number;
}

/**
 * Retrieval (docs/architecture.md §5).
 *
 * CURRENT STATE: sparse only. pgvector is not installed (docs/roadmap.md §B1),
 * so there is no dense retriever to fuse with. `denseAvailable: false` is
 * returned on every result so callers and the UI can see that results are
 * lexical rather than semantic — the system never claims to have searched
 * vectors it does not have (§45).
 *
 * Two lexical retrievers are already fused with RRF:
 *   - `ts_rank_cd` over the generated tsvector (stemmed, stopworded)
 *   - trigram similarity (typo and substring tolerance)
 *
 * That makes the fusion path real and exercised now; adding the dense list
 * later is one more entry in the same `reciprocalRankFusion` call.
 */
@Injectable()
export class RetrievalService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Whether dense retrieval is possible in this deployment. */
  async denseAvailable(): Promise<boolean> {
    const rows = await this.db.global.execute<{ present: boolean }>(
      sql`select exists (select 1 from pg_extension where extname = 'vector') as present`,
    );
    const first = (rows as unknown as { rows?: Array<{ present: boolean }> }).rows?.[0];
    return first?.present ?? false;
  }

  async search(context: TenantContext, query: RetrievalQuery): Promise<RetrievalResult> {
    const started = Date.now();
    const parsed = parseQuery(query.text);
    const limit = Math.min(Math.max(query.limit, 1), 50);
    const poolSize = Math.min(limit * 4, 200);

    const dense = await this.denseAvailable();

    if (!parsed.tsquery && parsed.terms.length === 0) {
      return {
        chunks: [],
        mode: RetrievalMode.SPARSE_ONLY,
        denseAvailable: dense,
        tookMs: Date.now() - started,
      };
    }

    const [lexical, fuzzy] = await Promise.all([
      this.fullTextSearch(context, parsed.tsquery, query, poolSize),
      this.trigramSearch(context, trigramNeedle(query.text), query, poolSize),
    ]);

    const fused = reciprocalRankFusion(
      [
        { name: 'fulltext', items: lexical },
        { name: 'trigram', items: fuzzy },
      ],
      (row) => row.chunk_id,
    ).slice(0, limit);

    const chunks: RetrievedChunk[] = fused.map(({ item, score, signals }) => ({
      chunkId: item.chunk_id,
      documentId: item.document_id,
      sourceId: item.source_id,
      content: item.content,
      page: item.page,
      section: item.section,
      headingPath: item.heading_path ?? [],
      documentTitle: item.document_title,
      documentUrl: item.document_url,
      score,
      signals,
    }));

    return {
      chunks,
      mode: RetrievalMode.SPARSE_ONLY,
      denseAvailable: dense,
      tookMs: Date.now() - started,
    };
  }

  /**
   * Full-text branch.
   *
   * The `organization_id` predicate is present for the QUERY PLANNER, not for
   * security — RLS already confines this to the bound organization. Removing
   * it would be a performance bug, not a leak, and the knowledge-isolation
   * suite proves that.
   */
  private async fullTextSearch(
    context: TenantContext,
    tsquery: string | null,
    query: RetrievalQuery,
    limit: number,
  ): Promise<RawRow[]> {
    if (!tsquery) return [];

    return this.db.withTenant(context, async (tx) => {
      const result = await tx.execute<RawRow>(sql`
        SELECT
          c.id            AS chunk_id,
          c.document_id   AS document_id,
          c.source_id     AS source_id,
          c.content       AS content,
          c.page          AS page,
          c.section       AS section,
          c.heading_path  AS heading_path,
          d.title         AS document_title,
          d.url           AS document_url,
          ts_rank_cd(c.content_tsv, query) AS rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        , to_tsquery('english', ${tsquery}) AS query
        WHERE c.organization_id = ${context.organizationId}
          AND d.deleted_at IS NULL
          AND c.content_tsv @@ query
          ${this.sourceFilter(query)}
        ORDER BY rank DESC
        LIMIT ${limit}
      `);
      return this.rowsOf(result);
    });
  }

  /** Trigram branch: tolerates typos and matches substrings FTS would miss. */
  private async trigramSearch(
    context: TenantContext,
    needle: string,
    query: RetrievalQuery,
    limit: number,
  ): Promise<RawRow[]> {
    if (needle.length < 3) return [];

    return this.db.withTenant(context, async (tx) => {
      const result = await tx.execute<RawRow>(sql`
        SELECT
          c.id            AS chunk_id,
          c.document_id   AS document_id,
          c.source_id     AS source_id,
          c.content       AS content,
          c.page          AS page,
          c.section       AS section,
          c.heading_path  AS heading_path,
          d.title         AS document_title,
          d.url           AS document_url,
          similarity(c.content, ${needle}) AS rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        WHERE c.organization_id = ${context.organizationId}
          AND d.deleted_at IS NULL
          AND c.content %> ${needle}
          ${this.sourceFilter(query)}
        ORDER BY rank DESC
        LIMIT ${limit}
      `);
      return this.rowsOf(result);
    });
  }

  /** Optional source restriction, parameterised. */
  private sourceFilter(query: RetrievalQuery) {
    if (!query.sourceIds || query.sourceIds.length === 0) return sql``;
    return sql` AND c.source_id IN (${sql.join(
      query.sourceIds.map((id) => sql`${id}`),
      sql`, `,
    )})`;
  }

  /** node-postgres returns { rows }, but drizzle's type here is loose. */
  private rowsOf(result: unknown): RawRow[] {
    const rows = (result as { rows?: RawRow[] }).rows;
    return Array.isArray(rows) ? rows : (result as RawRow[]);
  }
}
