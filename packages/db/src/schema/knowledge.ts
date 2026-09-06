import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

/**
 * Knowledge Engine schema (docs/architecture.md §5, docs/database.md §6).
 *
 * Note the absence of any vector column: embeddings live in their own table,
 * added by 0004_embeddings.sql, so that the embedding model is not baked into
 * the schema. See packages/db/drizzle/_blocked/README.md.
 */

/** Source types. Extending this requires a matching ALTER on the check constraint. */
export const KnowledgeSourceType = {
  UPLOAD: 'UPLOAD',
  WEBSITE: 'WEBSITE',
  TEXT: 'TEXT',
  URL: 'URL',
  BUSINESS_DATA: 'BUSINESS_DATA',
  FAQ: 'FAQ',
  PRODUCT_DATA: 'PRODUCT_DATA',
  POLICY: 'POLICY',
} as const;

export type KnowledgeSourceType =
  (typeof KnowledgeSourceType)[keyof typeof KnowledgeSourceType];

export const ALL_SOURCE_TYPES = Object.values(KnowledgeSourceType);

export const SourceStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;

export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

/** Document lifecycle, surfaced verbatim in the UI (§12). */
export const DocumentStatus = {
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;

export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull().default({}),
    status: text('status').notNull().default(SourceStatus.PENDING),
    errorMessage: text('error_message'),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('knowledge_sources_org_created_idx').on(t.organizationId, t.createdAt),
    index('knowledge_sources_org_type_idx').on(t.organizationId, t.type),
    index('knowledge_sources_project_idx').on(t.organizationId, t.projectId),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    title: text('title').notNull(),
    url: text('url'),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
    /** SHA-256 of the raw bytes; makes re-ingestion idempotent. */
    checksum: text('checksum').notNull(),
    pageCount: integer('page_count'),
    rawStorageKey: text('raw_storage_key'),
    extractedTextKey: text('extracted_text_key'),
    status: text('status').notNull().default(DocumentStatus.UPLOADED),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('knowledge_documents_org_created_idx').on(t.organizationId, t.createdAt),
    index('knowledge_documents_source_idx').on(t.organizationId, t.sourceId),
    index('knowledge_documents_status_idx').on(t.organizationId, t.status),
    uniqueIndex('knowledge_documents_source_checksum_unique').on(t.sourceId, t.checksum),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    page: integer('page'),
    section: text('section'),
    headingPath: text('heading_path').array().notNull().default(sql`'{}'`),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // content_tsv is GENERATED ALWAYS in SQL and deliberately not modelled
    // here: it must never be writable from application code.
  },
  (t) => [
    uniqueIndex('knowledge_chunks_document_index_unique').on(t.documentId, t.chunkIndex),
    index('knowledge_chunks_org_document_idx').on(t.organizationId, t.documentId),
    index('knowledge_chunks_org_source_idx').on(t.organizationId, t.sourceId),
  ],
);
