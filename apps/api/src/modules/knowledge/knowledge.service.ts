import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  Database,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  type KnowledgeSourceType,
} from '@moka/db';
import { ConflictError, NotFoundError, type TenantContext } from '@moka/core';
import { assertBelongsToTenant } from '@moka/tenancy';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';

export interface SourceDto {
  id: string;
  type: string;
  name: string;
  status: string;
  projectId: string | null;
  documentCount: number;
  chunkCount: number;
  errorMessage: string | null;
  lastIndexedAt: Date | null;
  createdAt: Date;
}

export interface DocumentDto {
  id: string;
  sourceId: string;
  title: string;
  mimeType: string;
  byteSize: number;
  pageCount: number | null;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
  warnings: string[];
  createdAt: Date;
}

/** Knowledge source and document management (§13). */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async listSources(context: TenantContext): Promise<SourceDto[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({
          id: knowledgeSources.id,
          type: knowledgeSources.type,
          name: knowledgeSources.name,
          status: knowledgeSources.status,
          projectId: knowledgeSources.projectId,
          errorMessage: knowledgeSources.errorMessage,
          lastIndexedAt: knowledgeSources.lastIndexedAt,
          createdAt: knowledgeSources.createdAt,
          documentCount: sql<number>`(
            SELECT count(*)::int FROM knowledge_documents d
             WHERE d.source_id = ${knowledgeSources.id} AND d.deleted_at IS NULL
          )`,
          chunkCount: sql<number>`(
            SELECT count(*)::int FROM knowledge_chunks k
             WHERE k.source_id = ${knowledgeSources.id}
          )`,
        })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.organizationId, context.organizationId),
            isNull(knowledgeSources.deletedAt),
          ),
        )
        .orderBy(desc(knowledgeSources.createdAt));

      return rows;
    });
  }

  async createSource(
    context: TenantContext,
    input: {
      type: KnowledgeSourceType;
      name: string;
      projectId?: string | null;
      config?: Record<string, unknown>;
    },
    meta: { requestId?: string | undefined },
  ): Promise<SourceDto> {
    const created = await this.db.withTenant(context, async (tx) => {
      const [row] = await tx
        .insert(knowledgeSources)
        .values({
          // organizationId comes from the CONTEXT, never the payload.
          organizationId: context.organizationId,
          projectId: input.projectId ?? null,
          type: input.type,
          name: input.name,
          config: input.config ?? {},
          createdBy: context.userId,
        })
        .returning();
      if (!row) throw new ConflictError('Knowledge source could not be created.');
      return row;
    });

    await this.audit.record(context, {
      action: 'knowledge.source.create',
      resourceType: 'knowledge_source',
      resourceId: created.id,
      after: { type: created.type, name: created.name },
      requestId: meta.requestId,
    });

    return {
      id: created.id,
      type: created.type,
      name: created.name,
      status: created.status,
      projectId: created.projectId,
      documentCount: 0,
      chunkCount: 0,
      errorMessage: created.errorMessage,
      lastIndexedAt: created.lastIndexedAt,
      createdAt: created.createdAt,
    };
  }

  async getSource(context: TenantContext, sourceId: string): Promise<SourceDto> {
    const sources = await this.listSources(context);
    const source = sources.find((s) => s.id === sourceId);
    if (!source) throw new NotFoundError('Knowledge source');
    return source;
  }

  async deleteSource(
    context: TenantContext,
    sourceId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const source = await this.getSource(context, sourceId);

    // Hard delete: documents and chunks cascade. A soft-deleted source whose
    // chunks remained searchable would be a quiet knowledge leak within the
    // organization.
    await this.db.withTenant(context, async (tx) => {
      await tx
        .delete(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            eq(knowledgeSources.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'knowledge.source.delete',
      resourceType: 'knowledge_source',
      resourceId: sourceId,
      before: { name: source.name, type: source.type, documents: source.documentCount },
      requestId: meta.requestId,
    });
  }

  async listDocuments(context: TenantContext, sourceId?: string): Promise<DocumentDto[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({
          id: knowledgeDocuments.id,
          sourceId: knowledgeDocuments.sourceId,
          title: knowledgeDocuments.title,
          mimeType: knowledgeDocuments.mimeType,
          byteSize: knowledgeDocuments.byteSize,
          pageCount: knowledgeDocuments.pageCount,
          status: knowledgeDocuments.status,
          errorMessage: knowledgeDocuments.errorMessage,
          metadata: knowledgeDocuments.metadata,
          createdAt: knowledgeDocuments.createdAt,
          chunkCount: sql<number>`(
            SELECT count(*)::int FROM knowledge_chunks k
             WHERE k.document_id = ${knowledgeDocuments.id}
          )`,
        })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.organizationId, context.organizationId),
            isNull(knowledgeDocuments.deletedAt),
            ...(sourceId ? [eq(knowledgeDocuments.sourceId, sourceId)] : []),
          ),
        )
        .orderBy(desc(knowledgeDocuments.createdAt));

      return rows.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        title: row.title,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        pageCount: row.pageCount,
        status: row.status,
        errorMessage: row.errorMessage,
        chunkCount: row.chunkCount,
        warnings: extractWarnings(row.metadata),
        createdAt: row.createdAt,
      }));
    });
  }

  /** Chunk inspector (§13) — shows exactly what retrieval will see. */
  async listChunks(
    context: TenantContext,
    documentId: string,
    limit = 100,
  ): Promise<
    Array<{
      id: string;
      chunkIndex: number;
      content: string;
      tokenCount: number;
      page: number | null;
      section: string | null;
      headingPath: string[];
    }>
  > {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: knowledgeChunks.id,
          organizationId: knowledgeChunks.organizationId,
          chunkIndex: knowledgeChunks.chunkIndex,
          content: knowledgeChunks.content,
          tokenCount: knowledgeChunks.tokenCount,
          page: knowledgeChunks.page,
          section: knowledgeChunks.section,
          headingPath: knowledgeChunks.headingPath,
        })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.documentId, documentId),
            eq(knowledgeChunks.organizationId, context.organizationId),
          ),
        )
        .orderBy(knowledgeChunks.chunkIndex)
        .limit(Math.min(limit, 500)),
    );

    // Should be unreachable under RLS; fires loudly if a policy is missing.
    for (const row of rows) assertBelongsToTenant(row, context, 'knowledge chunk');

    return rows.map(({ organizationId: _organizationId, ...chunk }) => chunk);
  }
}

/** Parser warnings are stored in metadata; surface them without trusting the shape. */
function extractWarnings(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const warnings = (metadata as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((w): w is string => typeof w === 'string').slice(0, 10);
}
