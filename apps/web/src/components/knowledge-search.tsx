'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote } from '@/components/ui';

interface SearchResponse {
  chunks: Array<{
    chunkId: string;
    content: string;
    page: number | null;
    section: string | null;
    headingPath: string[];
    documentTitle: string;
    score: number;
    signals: Record<string, number>;
  }>;
  mode: string;
  denseAvailable: boolean;
  tookMs: number;
}

/**
 * Retrieval playground.
 *
 * Shows exactly what the retriever returns, including which sub-retrievers
 * matched and at what rank. When an agent later answers from these chunks,
 * this is the page that explains why it said what it said.
 */
export function KnowledgeSearch() {
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const query = String(new FormData(event.currentTarget).get('query') ?? '').trim();
    if (!query) {
      setBusy(false);
      return;
    }

    try {
      setResult(await browserApi<SearchResponse>('/v1/knowledge/search', {
        method: 'POST',
        body: { query, limit: 8 },
      }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Search" description="Query the indexed knowledge for this organization." />
      <form onSubmit={onSubmit} className="flex gap-2 p-5">
        <input
          name="query"
          placeholder="e.g. how long do I have to request a refund"
          className="h-9 flex-1 rounded-lg border border-[--color-line] bg-white px-3 text-sm outline-none focus:border-[--color-accent]"
        />
        <Button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>

      <div className="px-5 pb-5">
        <ErrorNote message={error} />

        {result ? (
          <>
            <p className="mb-3 text-xs text-[--color-muted]">
              {result.chunks.length} result{result.chunks.length === 1 ? '' : 's'} in{' '}
              {result.tookMs} ms · mode <span className="font-mono">{result.mode}</span>
              {result.denseAvailable ? null : ' · lexical matching only'}
            </p>

            {result.chunks.length === 0 ? (
              <p className="text-xs text-[--color-muted]">
                Nothing matched. Try different words — without semantic search, spelling and
                phrasing matter.
              </p>
            ) : (
              <ul className="space-y-3">
                {result.chunks.map((chunk) => (
                  <li
                    key={chunk.chunkId}
                    className="rounded-lg border border-[--color-line] bg-gray-50 p-3"
                  >
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[--color-muted]">
                      <span className="font-medium text-[--color-ink]">{chunk.documentTitle}</span>
                      {chunk.headingPath.length > 0 ? (
                        <span>· {chunk.headingPath.join(' › ')}</span>
                      ) : null}
                      {chunk.page ? <span>· p.{chunk.page}</span> : null}
                      <span className="ml-auto font-mono">
                        {Object.entries(chunk.signals)
                          .map(([name, rank]) => `${name}#${rank}`)
                          .join(' ')}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed">{chunk.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </Card>
  );
}
