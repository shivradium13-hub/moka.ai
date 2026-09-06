# Blocked migrations

Migrations here are **written but not applied**, because the environment lacks
something they require. The migration runner reads only `*.sql` files directly
in `packages/db/drizzle/`, so a subdirectory is ignored by construction — these
cannot half-apply or apply out of order.

## Why not just put them in sequence?

A runner that "skips" a migration it cannot apply breaks the linear model: skip
`0004`, apply `0005`, then apply `0004` later, and the schema has been built in
an order no one tested. Keeping blocked work outside the sequence entirely is
the honest alternative.

## Current contents

### `0004_embeddings.sql` — requires the `vector` extension (pgvector)

Adds `embedding_models` and `knowledge_embeddings`, plus the HNSW index that
makes dense retrieval possible. Until it is applied:

- The text side of the Knowledge Engine works fully — ingestion, chunking, and
  **sparse (full-text) retrieval**.
- Dense retrieval and RRF fusion are inert. `HybridRetriever` reports
  `denseAvailable: false` and returns sparse-only results rather than
  pretending to have searched vectors.

**This file is UNVERIFIED.** It has never been executed, because pgvector is
not installable on this machine without a decision that is the operator's to
make (see `docs/roadmap.md` §B1). Review it before first use.

## To unblock

1. Make pgvector available (`docs/roadmap.md` §B1 — WSL2 + Docker recommended).
2. Move the file into `packages/db/drizzle/`, renumbered to whatever the next
   sequence number is at that time.
3. `pnpm db:migrate`
4. Seed an embedding model, then backfill embeddings for existing chunks.
