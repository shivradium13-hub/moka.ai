-- =============================================================================
-- 0003_knowledge — knowledge sources, documents and chunks
--
-- Run as: moka_migrator
--
-- NOTE ON pgvector
-- This migration deliberately requires NO vector type. The Phase 0 design put
-- embeddings in their own table keyed by (chunk_id, embedding_model_id) rather
-- than as a column on the chunk (docs/database.md §6). That decision was made
-- to avoid hard-coding one embedding model into the schema — and it also means
-- the entire text side of the Knowledge Engine can ship, and be tested, before
-- pgvector is available. The vector side arrives in 0004_embeddings.sql.
--
-- Sparse (full-text) retrieval is therefore fully functional now; dense
-- retrieval and RRF fusion light up when 0004 is applied.
--
-- As in 0001, tables, GRANTs and RLS policies land in ONE transaction so that
-- a tenant table never exists unprotected.
-- =============================================================================

-- =============================================================================
-- knowledge_sources
-- =============================================================================

CREATE TABLE knowledge_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid        REFERENCES projects (id) ON DELETE SET NULL,
  type            text        NOT NULL,
  name            text        NOT NULL,
  -- Type-specific settings: crawl depth, domain allowlist, schedule, and so on.
  -- Validated by a Zod schema per type at the application boundary.
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'PENDING',
  error_message   text,
  last_indexed_at timestamptz,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  -- Extending this list is a one-line ALTER. The part that must NOT require
  -- rewriting is the ingestion dispatch, which is a code registry keyed by
  -- this value (packages/knowledge/src/sources/registry.ts).
  CONSTRAINT knowledge_sources_type_valid CHECK (type IN (
    'UPLOAD', 'WEBSITE', 'TEXT', 'URL', 'BUSINESS_DATA', 'FAQ', 'PRODUCT_DATA', 'POLICY'
  )),
  CONSTRAINT knowledge_sources_status_valid CHECK (status IN (
    'PENDING', 'PROCESSING', 'READY', 'FAILED'
  ))
);

CREATE INDEX knowledge_sources_org_created_idx  ON knowledge_sources (organization_id, created_at DESC);
CREATE INDEX knowledge_sources_org_type_idx     ON knowledge_sources (organization_id, type);
CREATE INDEX knowledge_sources_project_idx      ON knowledge_sources (organization_id, project_id);

-- =============================================================================
-- knowledge_documents
-- =============================================================================

CREATE TABLE knowledge_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  source_id          uuid        NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  -- Identifier in the originating system (URL path, Drive file id, …).
  external_id        text,
  title              text        NOT NULL,
  url                text,
  mime_type          text        NOT NULL,
  byte_size          bigint      NOT NULL DEFAULT 0,
  -- SHA-256 of the raw bytes. Drives idempotent re-ingestion.
  checksum           text        NOT NULL,
  page_count         integer,
  -- Keys into the storage driver, never filesystem paths from user input.
  raw_storage_key    text,
  extracted_text_key text,
  status             text        NOT NULL DEFAULT 'UPLOADED',
  error_message      text,
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT knowledge_documents_status_valid CHECK (status IN (
    'UPLOADED', 'PROCESSING', 'READY', 'FAILED'
  )),
  CONSTRAINT knowledge_documents_size_sane CHECK (byte_size >= 0)
);

CREATE INDEX knowledge_documents_org_created_idx ON knowledge_documents (organization_id, created_at DESC);
CREATE INDEX knowledge_documents_source_idx      ON knowledge_documents (organization_id, source_id);
CREATE INDEX knowledge_documents_status_idx      ON knowledge_documents (organization_id, status);

-- Re-uploading identical bytes to the same source is a no-op rather than a
-- duplicate. Scoped to the source so two sources may legitimately hold the
-- same file.
CREATE UNIQUE INDEX knowledge_documents_source_checksum_unique
  ON knowledge_documents (source_id, checksum);

-- =============================================================================
-- knowledge_chunks
--
-- Text and metadata ONLY. No vector column — see the note at the top.
-- =============================================================================

CREATE TABLE knowledge_chunks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  document_id     uuid        NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  source_id       uuid        NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  chunk_index     integer     NOT NULL,
  content         text        NOT NULL,

  -- Generated, so the index can never drift from the content it describes.
  -- 'english' is fixed at DDL time; per-source language configuration needs a
  -- second column and a partial index, which is deferred until a non-English
  -- corpus actually exists rather than guessed at now.
  content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  token_count     integer     NOT NULL DEFAULT 0,
  page            integer,
  section         text,
  -- Breadcrumb of enclosing headings, for citation display and context.
  heading_path    text[]      NOT NULL DEFAULT '{}',
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT knowledge_chunks_index_sane CHECK (chunk_index >= 0),
  CONSTRAINT knowledge_chunks_content_nonempty CHECK (length(btrim(content)) > 0)
);

CREATE UNIQUE INDEX knowledge_chunks_document_index_unique
  ON knowledge_chunks (document_id, chunk_index);
CREATE INDEX knowledge_chunks_org_document_idx ON knowledge_chunks (organization_id, document_id);
CREATE INDEX knowledge_chunks_org_source_idx   ON knowledge_chunks (organization_id, source_id);

-- Sparse retrieval. GIN over the generated tsvector.
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (content_tsv);

-- Fuzzy matching for short queries and typo tolerance.
CREATE INDEX knowledge_chunks_trgm_idx ON knowledge_chunks USING gin (content gin_trgm_ops);

-- =============================================================================
-- ROW-LEVEL SECURITY
--
-- Identical shape to 0001. Note there is NO user-scope branch here: unlike
-- organization_members, knowledge is never readable outside a bound
-- organization, so the policy stays as narrow as possible.
-- =============================================================================

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_sources
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_documents
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_chunks
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  knowledge_sources,
  knowledge_documents,
  knowledge_chunks
TO moka_app;
