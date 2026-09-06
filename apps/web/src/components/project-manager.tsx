'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
}

export function ProjectManager({ initialProjects }: { initialProjects: Project[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      // No organization id is sent. The API derives it from the session, and
      // would log any organization id found here as a security event.
      await browserApi('/v1/projects', {
        method: 'POST',
        body: {
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          description: String(form.get('description') ?? '') || null,
        },
      });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    setBusy(true);
    try {
      await browserApi(`/v1/projects/${id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <ErrorNote message={error} />
        <div className="ml-auto">
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'New project'}
          </Button>
        </div>
      </div>

      {open ? (
        <Card>
          <CardHeader title="New project" />
          <form onSubmit={create} className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Name" name="name" required placeholder="Customer Support" />
            <Field
              label="Slug"
              name="slug"
              required
              placeholder="customer-support"
              hint="Lowercase letters, numbers and hyphens."
            />
            <div className="sm:col-span-2">
              <Field label="Description" name="description" placeholder="Optional" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {initialProjects.length > 0 ? (
        <Card>
          <ul className="divide-y divide-[--color-line]">
            {initialProjects.map((project) => (
              <li key={project.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{project.name}</p>
                  <p className="truncate text-xs text-[--color-muted]">
                    {project.slug}
                    {project.description ? ` · ${project.description}` : ''}
                  </p>
                </div>
                <div className="ml-auto shrink-0">
                  <Button variant="danger" disabled={busy} onClick={() => void remove(project.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
