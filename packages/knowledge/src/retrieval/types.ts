/**
 * Retrieval contracts (docs/architecture.md §5).
 *
 * The hybrid design is dense (pgvector HNSW) + sparse (PostgreSQL FTS), fused
 * with Reciprocal Rank Fusion. Only the sparse half is operational today:
 * pgvector is not installed (docs/roadmap.md §B1), so the dense retriever is
 * absent rather than stubbed.
 *
 * `RetrievalResult.mode` reports what actually ran. A caller is never told a
 * vector search happened when it did not — §45.
 */

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly content: string;
  readonly page: number | null;
  readonly section: string | null;
  readonly headingPath: readonly string[];
  readonly documentTitle: string;
  readonly documentUrl: string | null;
  /** Fused score. Comparable within one result set only, not across queries. */
  readonly score: number;
  /** Which retrievers contributed, and each one's rank. */
  readonly signals: Readonly<Record<string, number>>;
}

export const RetrievalMode = {
  /** Full-text only. The current state while pgvector is unavailable. */
  SPARSE_ONLY: 'sparse_only',
  /** Vector only. Used when a query has no useful lexical form. */
  DENSE_ONLY: 'dense_only',
  /** Both, fused with RRF. The intended steady state. */
  HYBRID: 'hybrid',
} as const;

export type RetrievalMode = (typeof RetrievalMode)[keyof typeof RetrievalMode];

export interface RetrievalQuery {
  readonly text: string;
  readonly limit: number;
  /** Restrict to specific sources; empty means all sources in the organization. */
  readonly sourceIds?: readonly string[];
  readonly projectId?: string | null;
}

export interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly mode: RetrievalMode;
  /**
   * False while pgvector is unavailable. Surfaced to the UI so a user can see
   * that results are lexical rather than semantic, instead of silently
   * receiving worse answers than they expect.
   */
  readonly denseAvailable: boolean;
  readonly tookMs: number;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Chosen over score normalisation because the two retrievers produce
 * incomparable scales — cosine distance and ts_rank do not share units, and
 * min-max normalising them makes the fusion sensitive to outliers in either
 * list. RRF uses only ordinal rank, so it is scale-free.
 *
 * k=60 is the value from the original Cormack et al. formulation and is a
 * reasonable default; it damps the influence of the very top ranks enough that
 * one retriever cannot dominate.
 */
export const RRF_K = 60;

export function reciprocalRankFusion<T>(
  lists: ReadonlyArray<{ name: string; items: readonly T[] }>,
  keyOf: (item: T) => string,
  k: number = RRF_K,
): Array<{ key: string; item: T; score: number; signals: Record<string, number> }> {
  const accumulated = new Map<
    string,
    { item: T; score: number; signals: Record<string, number> }
  >();

  for (const list of lists) {
    list.items.forEach((item, index) => {
      const key = keyOf(item);
      const rank = index + 1;
      const contribution = 1 / (k + rank);

      const existing = accumulated.get(key);
      if (existing) {
        existing.score += contribution;
        existing.signals[list.name] = rank;
      } else {
        accumulated.set(key, {
          item,
          score: contribution,
          signals: { [list.name]: rank },
        });
      }
    });
  }

  return [...accumulated.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.score - a.score);
}
