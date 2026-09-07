import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  Database,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  DocumentStatus,
  SourceStatus,
} from '@moka/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type TenantContext,
} from '@moka/core';
import {
  DEFAULT_CHUNK_OPTIONS,
  LocalStorageDriver,
  ParseError,
  buildStorageKey,
  chunkDocument,
  parseDocument,
  sha256,
  type StorageDriver,
} from '@moka/knowledge';
import { loadConfig } from '@moka/config';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { getLogger } from '../../common/logger.js';

export interface IngestResult {
  documentId: string;
  status: string;
  chunkCount: number;
  warnings: string[];
  /** True when identical bytes were already ingested into this source. */
  deduplicated: boolean;
}

/**
 * Document ingestion (docs/architecture.md §5 Path A, §12).
 *
 *   Upload → Validate → Store → Parse → Chunk → Index → READY
 *
 * ON ASYNCHRONY (§12 requires large files to be processed asynchronously):
 * the intended design is a BullMQ queue on Valkey. Valkey needs Docker, which
 * is not available here (docs/roadmap.md §B2), so ingestion currently runs
 * INLINE within the request. That is a genuine limitation, not a stub:
 * a 25 MB PDF will hold the request open. The size cap keeps that bounded, the
 * status column already models the async lifecycle, and this method is written
 * to be moved behind a queue without changing its shape.
 *
 * ON EMBEDDINGS: chunks are stored WITHOUT vectors. pgvector is unavailable
 * (§B1), so retrieval is full-text only until 0004_embeddings.sql is applied.
 * Nothing here pretends otherwise.
 */
@Injectable()
export class IngestionService {
  private readonly storage: StorageDriver;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {
    const config = loadConfig();
    // TODO(Phase 2b): select an S3-compatible driver when STORAGE_DRIVER='s3'.
    // Only the local driver exists today; see docs/architecture.md §2 for the
    // MinIO/AGPL note behind that choice being deferred.
    this.storage = new LocalStorageDriver(config.STORAGE_LOCAL_PATH);
  }

  async ingestUpload(
    context: TenantContext,
    params: {
      sourceId: string;
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
      /** Origin URL, when the bytes came from the web. Null for an upload. */
      url?: string | null;
      requestId?: string | undefined;
    },
  ): Promise<IngestResult> {
    const source = await this.requireSource(context, params.sourceId);
    const checksum = sha256(params.bytes);

    // Idempotency: identical bytes in the same source are not re-ingested.
    // Re-uploading a file after an edit elsewhere is common, and duplicating
    // every chunk would quietly degrade retrieval.
    const existing = await this.db.withTenant(context, async (tx) =>
      tx
        .select({ id: knowledgeDocuments.id, status: knowledgeDocuments.status })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.organizationId, context.organizationId),
            eq(knowledgeDocuments.sourceId, params.sourceId),
            eq(knowledgeDocuments.checksum, checksum),
          ),
        )
        .limit(1),
    );

    if (existing[0]) {
      return {
        documentId: existing[0].id,
        status: existing[0].status,
        chunkCount: 0,
        warnings: ['This file has already been ingested into this source.'],
        deduplicated: true,
      };
    }

    // Parse BEFORE creating the document row, so an unreadable file produces a
    // clean 400 rather than a FAILED row the user has to clean up.
    let parsed;
    try {
      parsed = await parseDocument({
        bytes: params.bytes,
        filename: params.filename,
        mimeType: params.mimeType,
      });
    } catch (error) {
      if (error instanceof ParseError) {
        throw new ValidationError({ file: error.message });
      }
      throw error;
    }

    const chunks = chunkDocument(parsed, DEFAULT_CHUNK_OPTIONS);
    if (chunks.length === 0) {
      throw new ValidationError({
        file: 'No readable text was found in this file. If it is a scanned document, OCR is required (not yet implemented).',
      });
    }

    // Store raw bytes only after we know the file is usable.
    const storageKey = buildStorageKey({
      organizationId: context.organizationId,
      sourceId: params.sourceId,
      filename: params.filename,
      kind: 'raw',
    });
    await this.storage.put(storageKey, params.bytes);

    const documentId = await this.db.withTenant(context, async (tx) => {
      const [document] = await tx
        .insert(knowledgeDocuments)
        .values({
          organizationId: context.organizationId,
          sourceId: params.sourceId,
          title: parsed.title ?? params.filename,
          mimeType: params.mimeType,
          byteSize: params.bytes.byteLength,
          checksum,
          pageCount: parsed.pageCount,
          rawStorageKey: storageKey,
          url: params.url ?? null,
          status: DocumentStatus.PROCESSING,
          metadata: { warnings: parsed.warnings, parser: parsed.metadata },
        })
        .returning({ id: knowledgeDocuments.id });

      if (!document) throw new ConflictError('Document could not be created.');

      await tx.insert(knowledgeChunks).values(
        chunks.map((chunk) => ({
          organizationId: context.organizationId,
          documentId: document.id,
          sourceId: params.sourceId,
          chunkIndex: chunk.index,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          page: chunk.page,
          section: chunk.section,
          headingPath: [...chunk.headingPath],
        })),
      );

      await tx
        .update(knowledgeDocuments)
        .set({ status: DocumentStatus.READY, updatedAt: new Date() })
        .where(eq(knowledgeDocuments.id, document.id));

      await tx
        .update(knowledgeSources)
        .set({ status: SourceStatus.READY, lastIndexedAt: new Date(), updatedAt: new Date() })
        .where(eq(knowledgeSources.id, params.sourceId));

      return document.id;
    });

    await this.audit.record(context, {
      action: 'knowledge.document.ingest',
      resourceType: 'knowledge_document',
      resourceId: documentId,
      after: {
        sourceId: params.sourceId,
        // The filename is user-controlled; the audit writer redacts values, and
        // the byte content itself is never recorded.
        filename: params.filename,
        chunks: chunks.length,
        bytes: params.bytes.byteLength,
      },
      requestId: params.requestId,
    });

    getLogger().info(
      {
        organizationId: context.organizationId,
        documentId,
        sourceId: source.id,
        chunks: chunks.length,
      },
      'document ingested',
    );

    return {
      documentId,
      status: DocumentStatus.READY,
      chunkCount: chunks.length,
      warnings: [...parsed.warnings],
      deduplicated: false,
    };
  }

  /** Ingest raw text pasted into the UI, bypassing file handling entirely. */
  async ingestText(
    context: TenantContext,
    params: {
      sourceId: string;
      title: string;
      text: string;
      /**
       * Where the text came from, when it came from somewhere. Set by the
       * website crawler so a retrieved chunk can be traced to the page it was
       * read from — which is what makes a citation checkable rather than
       * merely plausible.
       */
      url?: string | null;
      requestId?: string | undefined;
    },
  ): Promise<IngestResult> {
    const bytes = new TextEncoder().encode(params.text);
    return this.ingestUpload(context, {
      sourceId: params.sourceId,
      filename: `${params.title}.md`,
      mimeType: 'text/markdown',
      bytes,
      url: params.url ?? null,
      requestId: params.requestId,
    });
  }

  async deleteDocument(
    context: TenantContext,
    documentId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const document = await this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({
          id: knowledgeDocuments.id,
          title: knowledgeDocuments.title,
          rawStorageKey: knowledgeDocuments.rawStorageKey,
        })
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.organizationId, context.organizationId),
          ),
        )
        .limit(1);
      return rows[0];
    });

    if (!document) throw new NotFoundError('Document');

    // Chunks cascade via the foreign key.
    await this.db.withTenant(context, async (tx) => {
      await tx
        .delete(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.organizationId, context.organizationId),
          ),
        );
    });

    if (document.rawStorageKey) {
      // Best effort: an orphaned blob is recoverable, a failed delete that
      // rolls back the row is not.
      try {
        await this.storage.delete(document.rawStorageKey);
      } catch (error) {
        getLogger().warn(
          { documentId, error: error instanceof Error ? error.message : String(error) },
          'stored object could not be deleted; row removed',
        );
      }
    }

    await this.audit.record(context, {
      action: 'knowledge.document.delete',
      resourceType: 'knowledge_document',
      resourceId: documentId,
      before: { title: document.title },
      requestId: meta.requestId,
    });
  }

  private async requireSource(
    context: TenantContext,
    sourceId: string,
  ): Promise<{ id: string; type: string }> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({ id: knowledgeSources.id, type: knowledgeSources.type })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.id, sourceId),
            eq(knowledgeSources.organizationId, context.organizationId),
            sql`${knowledgeSources.deletedAt} is null`,
          ),
        )
        .limit(1),
    );

    const source = rows[0];
    if (!source) throw new NotFoundError('Knowledge source');
    return source;
  }
}
