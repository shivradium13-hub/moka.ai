import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { DocumentUploader } from '@/components/document-uploader';
import { DocumentList } from '@/components/document-list';

interface SourceResponse {
  source: {
    id: string;
    type: string;
    name: string;
    status: string;
    documentCount: number;
    chunkCount: number;
  };
}

interface DocumentsResponse {
  documents: Array<{
    id: string;
    title: string;
    mimeType: string;
    byteSize: number;
    pageCount: number | null;
    status: string;
    chunkCount: number;
    warnings: string[];
    createdAt: string;
  }>;
}

interface Capabilities {
  supportedExtensions: string[];
  maxDocumentBytes: number;
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [sourceData, documentsData, capabilities] = await Promise.all([
    serverApiOrNull<SourceResponse>(`/v1/knowledge/sources/${id}`),
    serverApiOrNull<DocumentsResponse>(`/v1/knowledge/documents?sourceId=${id}`),
    serverApiOrNull<Capabilities>('/v1/knowledge/capabilities'),
  ]);

  // A source belonging to another organization is genuinely not found here —
  // RLS makes it unreachable, so this is a real 404, not a hidden 403.
  if (!sourceData) notFound();

  const documents = documentsData?.documents ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/knowledge" className="text-xs text-[--color-muted] hover:underline">
          ← Knowledge
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{sourceData.source.name}</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          {sourceData.source.type} · {sourceData.source.documentCount} document
          {sourceData.source.documentCount === 1 ? '' : 's'} · {sourceData.source.chunkCount} chunk
          {sourceData.source.chunkCount === 1 ? '' : 's'}
        </p>
      </div>

      <DocumentUploader
        sourceId={id}
        supportedExtensions={capabilities?.supportedExtensions ?? []}
        maxBytes={capabilities?.maxDocumentBytes ?? 0}
      />

      {documents.length === 0 ? (
        <Card>
          <CardHeader title="Documents" />
          <EmptyState
            title="Nothing ingested yet"
            description="Upload a file or paste text above. It is parsed, chunked and indexed immediately."
          />
        </Card>
      ) : (
        <DocumentList documents={documents} />
      )}
    </div>
  );
}
