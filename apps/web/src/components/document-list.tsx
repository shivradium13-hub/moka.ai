'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote } from '@/components/ui';

interface DocumentSummary {
  id: string;
  title: string;
  mimeType: string;
  byteSize: number;
  pageCount: number | null;
  status: string;
  chunkCount: number;
  warnings: string[];
  createdAt: string;
}

interface Chunk {
  id: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  page: number | null;
  section: string | null;
  headingPath: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Document list with a chunk inspector (§13).
 *
 * Being able to see the exact chunks matters: chunk boundaries are the single
 * biggest determinant of retrieval quality, and "why did it not find that?" is
 * almost always answered by looking at how the text was split.
 */
export function DocumentList({ documents }: { documents: DocumentSummary[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(documentId: string) {
    if (expanded === documentId) {
      setExpanded(null);
      setChunks([]);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const data = await browserApi<{ chunks: Chunk[] }>(
        `/v1/knowledge/documents/${documentId}/chunks`,
      );
      setChunks(data.chunks);
      setExpanded(documentId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load chunks.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(documentId: string) {
    setError(null);
    setBusy(true);
    try {
      await browserApi(`/v1/knowledge/documents/${documentId}`, { method: 'DELETE' });
      if (expanded === documentId) {
        setExpanded(null);
        setChunks([]);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the document.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Documents" description="Expand a document to inspect its chunks." />
      <div className="px-5 pt-3">
        <ErrorNote message={error} />
      </div>

      <ul className="divide-y divide-[--color-line]">
        {documents.map((document) => (
          <li key={document.id}>
            <div className="flex items-center gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{document.title}</p>
                <p className="truncate text-xs text-[--color-muted]">
                  {formatBytes(document.byteSize)} · {document.chunkCount} chunk
                  {document.chunkCount === 1 ? '' : 's'}
                  {document.pageCount ? ` · ${document.pageCount} page${document.pageCount === 1 ? '' : 's'}` : ''}
                  {' · '}
                  {document.status}
                </p>
                {document.warnings.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc text-[11px] text-amber-700">
                    {document.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="ml-auto flex shrink-0 gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => void toggle(document.id)}>
                  {expanded === document.id ? 'Hide chunks' : 'View chunks'}
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => void remove(document.id)}>
                  Delete
                </Button>
              </div>
            </div>

            {expanded === document.id ? (
              <div className="space-y-2 border-t border-[--color-line] bg-gray-50 px-5 py-4">
                {chunks.length === 0 ? (
                  <p className="text-xs text-[--color-muted]">No chunks stored.</p>
                ) : (
                  chunks.map((chunk) => (
                    <div
                      key={chunk.id}
                      className="rounded-lg border border-[--color-line] bg-white p-3"
                    >
                      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[--color-muted]">
                        <span className="font-mono">#{chunk.chunkIndex}</span>
                        {chunk.headingPath.length > 0 ? (
                          <span>{chunk.headingPath.join(' › ')}</span>
                        ) : null}
                        {chunk.page ? <span>· p.{chunk.page}</span> : null}
                        <span className="ml-auto">~{chunk.tokenCount} tokens (estimated)</span>
                      </div>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed">{chunk.content}</p>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
