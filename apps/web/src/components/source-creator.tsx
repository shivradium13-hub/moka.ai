'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

export function SourceCreator({ types }: { types: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      // No organization id is sent; the API derives it from the session.
      await browserApi('/v1/knowledge/sources', {
        method: 'POST',
        body: {
          name: String(form.get('name') ?? ''),
          type: String(form.get('type') ?? 'UPLOAD'),
        },
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the source.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>New source</Button>
    );
  }

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader title="New knowledge source" />
        <form onSubmit={create} className="space-y-4 p-5">
          <Field label="Name" name="name" required placeholder="Company Handbook" />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[--color-muted]">Type</span>
            <select
              name="type"
              defaultValue="UPLOAD"
              className="h-9 w-full rounded-lg border border-[--color-line] bg-white px-2 text-sm outline-none focus:border-[--color-accent]"
            >
              {(types.length > 0 ? types : ['UPLOAD']).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <ErrorNote message={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create source'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
