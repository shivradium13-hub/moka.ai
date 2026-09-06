import Link from 'next/link';
import { serverApiOrNull } from '@/lib/api-server';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { SourceCreator } from '@/components/source-creator';
import { KnowledgeSearch } from '@/components/knowledge-search';

interface Capabilities {
  supportedExtensions: string[];
  maxDocumentBytes: number;
  sourceTypes: string[];
  denseRetrievalAvailable: boolean;
  ingestionMode: string;
}

interface SourcesResponse {
  sources: Array<{
    id: string;
    type: string;
    name: string;
    status: string;
    documentCount: number;
    chunkCount: number;
    errorMessage: string | null;
    lastIndexedAt: string | null;
    createdAt: string;
  }>;
}

export default async function KnowledgePage() {
  const [capabilities, data] = await Promise.all([
    serverApiOrNull<Capabilities>('/v1/knowledge/capabilities'),
    serverApiOrNull<SourcesResponse>('/v1/knowledge/sources'),
  ]);

  const sources = data?.sources ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Documents ingested here are chunked and indexed for retrieval, scoped to this
          organization.
        </p>
      </div>

      {/*
        Retrieval capability is stated plainly rather than hidden. Semantic
        search genuinely is not running yet, and a user comparing results
        against expectations deserves to know why.
      */}
      {capabilities && !capabilities.denseRetrievalAvailable ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <p className="font-medium">Full-text search only</p>
          <p className="mt-0.5">
            Semantic (vector) search requires the pgvector extension, which is not installed on this
            server. Results are matched lexically — by words and spelling — not by meaning.
          </p>
        </div>
      ) : null}

      <KnowledgeSearch />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Sources</h2>
          <p className="mt-0.5 text-xs text-[--color-muted]">
            {capabilities
              ? `Accepts ${capabilities.supportedExtensions.join(', ')} up to ${Math.floor(
                  capabilities.maxDocumentBytes / 1024 / 1024,
                )} MB.`
              : null}
          </p>
        </div>
        <SourceCreator types={capabilities?.sourceTypes ?? []} />
      </div>

      {sources.length === 0 ? (
        <Card>
          <EmptyState
            title="No knowledge sources yet"
            description="Create a source, then upload documents or paste text into it."
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-[--color-line]">
            {sources.map((source) => (
              <li key={source.id}>
                <Link
                  href={`/knowledge/${source.id}`}
                  className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-gray-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{source.name}</p>
                    <p className="truncate text-xs text-[--color-muted]">
                      {source.documentCount} document{source.documentCount === 1 ? '' : 's'} ·{' '}
                      {source.chunkCount} chunk{source.chunkCount === 1 ? '' : 's'}
                      {source.errorMessage ? ` · ${source.errorMessage}` : ''}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Badge>{source.type}</Badge>
                    <StatusPill status={source.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Not yet implemented"
          description="Listed explicitly rather than stubbed."
        />
        <ul className="divide-y divide-[--color-line] text-sm">
          {[
            ['Semantic (vector) search and reranking', 'needs pgvector'],
            ['Website crawling with SSRF protection', 'Phase 2b'],
            ['Background ingestion queue', 'needs Valkey'],
            ['OCR for scanned documents', 'Phase 2b'],
          ].map(([label, note]) => (
            <li key={label} className="flex items-center justify-between px-5 py-3">
              <span className="text-[--color-muted]">{label}</span>
              <Badge>{note}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'READY'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'FAILED'
        ? 'bg-red-50 text-red-700'
        : 'bg-gray-100 text-gray-600';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>
  );
}
