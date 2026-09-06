-- =============================================================================
-- 0004_embeddings — dense retrieval (BLOCKED: requires pgvector)
--
-- ⚠ UNVERIFIED. This file has never been executed. pgvector is not available
--   on the current machine (docs/roadmap.md §B1). Review before first use.
--
-- Run as: moka_migrator, only after `CREATE EXTENSION vector` succeeds.
--
-- WHY EMBEDDINGS ARE A SEPARATE TABLE (docs/database.md §6)
-- Putting the vector on knowledge_chunks would hard-code one model and one
-- dimension into the schema. Changing embedding model would then be a
-- destructive migration with downtime and no rollback. Keyed by
-- (chunk_id, embedding_model_id) instead, two models coexist during a
-- re-embed, retrieval selects by model, and cutover is a config flip.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- embedding_models — registry
-- =============================================================================

CREATE TABLE embedding_models (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text        NOT NULL,
  display_name     text        NOT NULL,
  -- NULL means a locally hosted ONNX model rather than a provider API.
  -- The FK to `providers` is added in Phase 3, when that table exists.
  provider_key     text,
  dimensions       integer     NOT NULL,
  max_input_tokens integer     NOT NULL DEFAULT 512,
  cost_per_1m      numeric(18,6) NOT NULL DEFAULT 0,
  is_default       boolean     NOT NULL DEFAULT false,
  status           text        NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- HNSW cannot index beyond 2000 dimensions. Enforced here so an
  -- unindexable model cannot be registered in the first place.
  CONSTRAINT embedding_models_dimensions_indexable CHECK (dimensions > 0 AND dimensions <= 2000),
  CONSTRAINT embedding_models_status_valid CHECK (status IN ('active', 'deprecated'))
);

CREATE UNIQUE INDEX embedding_models_key_unique ON embedding_models (key);

-- At most one default, enforced by the database rather than by convention.
CREATE UNIQUE INDEX embedding_models_single_default
  ON embedding_models ((is_default)) WHERE is_default;

-- Global registry, not tenant data: read-only at runtime.
GRANT SELECT ON embedding_models TO moka_app;

-- =============================================================================
-- knowledge_embeddings
--
-- DIMENSION NOTE: `vector(n)` is fixed per column, so this table serves models
-- of exactly 1024 dimensions. Supporting a second dimension means partitioning
-- by embedding_model_id (one partition and one HNSW index per dimension).
-- Deferred until a second model is actually adopted — partitioning an empty
-- table now would be speculative complexity.
-- =============================================================================

CREATE TABLE knowledge_embeddings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  chunk_id           uuid        NOT NULL REFERENCES knowledge_chunks (id) ON DELETE CASCADE,
  embedding_model_id uuid        NOT NULL REFERENCES embedding_models (id),
  embedding          vector(1024) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX knowledge_embeddings_chunk_model_unique
  ON knowledge_embeddings (chunk_id, embedding_model_id);
CREATE INDEX knowledge_embeddings_org_model_idx
  ON knowledge_embeddings (organization_id, embedding_model_id);

-- Cosine distance, matching the normalised embeddings the Embedder contract
-- guarantees. m/ef_construction are conservative defaults suitable for a
-- memory-constrained host; tune once corpus size is known.
CREATE INDEX knowledge_embeddings_hnsw_idx
  ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- ROW-LEVEL SECURITY
--
-- Embeddings are a lossy encoding of tenant content and are therefore treated
-- as tenant data in their own right — an approximate reconstruction is still a
-- leak. Same policy shape as every other tenant table.
-- =============================================================================

ALTER TABLE knowledge_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_embeddings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_embeddings
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_embeddings TO moka_app;
