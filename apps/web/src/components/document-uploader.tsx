'use client';

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

interface IngestResult {
  documentId: string;
  status: string;
  chunkCount: number;
  warnings: string[];
  deduplicated: boolean;
}

/** Read a File into base64 without loading it twice. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const result = String(reader.result);
      // Strip the `data:<mime>;base64,` prefix.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function DocumentUploader({
  sourceId,
  supportedExtensions,
  maxBytes,
}: {
  sourceId: string;
  supportedExtensions: string[];
  maxBytes: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<'file' | 'text'>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);

    // Check client-side for a fast, clear message. The server enforces the
    // same limit independently — this check is convenience, never protection.
    if (maxBytes > 0 && file.size > maxBytes) {
      setError(`File exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
      event.target.value = '';
      return;
    }

    setBusy(true);
    try {
      setResult(
        await browserApi<IngestResult>('/v1/knowledge/documents/upload', {
          method: 'POST',
          body: {
            sourceId,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            contentBase64: await toBase64(file),
          },
        }),
      );
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? describeApiError(err)
          : 'Upload failed. Please try again.',
      );
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      setResult(
        await browserApi<IngestResult>('/v1/knowledge/documents/text', {
          method: 'POST',
          body: {
            sourceId,
            title: String(form.get('title') ?? ''),
            text: String(form.get('text') ?? ''),
          },
        }),
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? describeApiError(err) : 'Could not save the text.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Add knowledge"
        description={
          supportedExtensions.length > 0
            ? `Accepts ${supportedExtensions.join(', ')}.`
            : undefined
        }
      />

      <div className="flex gap-1 border-b border-[--color-line] px-5 pt-3">
        {(['file', 'text'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-t-lg px-3 py-1.5 text-xs font-medium transition ${
              tab === value
                ? 'border-b-2 border-[--color-accent] text-[--color-ink]'
                : 'text-[--color-muted] hover:text-[--color-ink]'
            }`}
          >
            {value === 'file' ? 'Upload file' : 'Paste text'}
          </button>
        ))}
      </div>

      <div className="space-y-4 p-5">
        {tab === 'file' ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[--color-muted]">
              Choose a file
            </span>
            <input
              type="file"
              disabled={busy}
              onChange={(e) => void uploadFile(e)}
              accept={supportedExtensions.join(',')}
              className="block w-full text-xs file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border-0 file:bg-[--color-accent] file:px-3 file:text-xs file:font-medium file:text-white disabled:opacity-50"
            />
          </label>
        ) : (
          <form onSubmit={submitText} className="space-y-4">
            <Field label="Title" name="title" required placeholder="Refund Policy" />
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[--color-muted]">
                Content (Markdown headings become chunk breadcrumbs)
              </span>
              <textarea
                name="text"
                required
                rows={8}
                placeholder={'# Refund Policy\n\n## Eligibility\n\nCustomers may request…'}
                className="w-full rounded-lg border border-[--color-line] bg-white p-3 font-mono text-xs outline-none focus:border-[--color-accent]"
              />
            </label>
            <Button type="submit" disabled={busy}>
              {busy ? 'Ingesting…' : 'Ingest text'}
            </Button>
          </form>
        )}

        {busy ? (
          <p className="text-xs text-[--color-muted]">
            Parsing, chunking and indexing… this runs inline, so large files take a moment.
          </p>
        ) : null}

        <ErrorNote message={error} />

        {result ? (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            {result.deduplicated
              ? 'Already ingested — this exact file is present, so nothing was duplicated.'
              : `Indexed into ${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'}.`}
            {result.warnings.length > 0 ? (
              <ul className="mt-1 list-inside list-disc text-amber-800">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** Surface field-level validation detail, which is where the useful message lives. */
function describeApiError(error: ApiError): string {
  const detail = error.details;
  const file = detail?.['file'];
  if (typeof file === 'string') return file;
  const fields = detail?.['fields'];
  if (Array.isArray(fields) && fields.length > 0) return fields.join('; ');
  return error.message;
}
