'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

export function ChatbotCreator() {
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
      const created = await browserApi<{ chatbot: { id: string } }>('/v1/chatbots', {
        method: 'POST',
        body: {
          name: String(form.get('name') ?? ''),
          description: String(form.get('description') ?? '') || null,
          greeting: String(form.get('greeting') ?? '') || null,
          instructions: String(form.get('instructions') ?? ''),
        },
      });
      setOpen(false);
      router.push(`/chatbots/${created.chatbot.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the chatbot.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>New chatbot</Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader
        title="New chatbot"
        description="It starts as a draft with no knowledge and no deployment, so it is not reachable by anyone yet."
      />
      <form onSubmit={create} className="space-y-4 px-5 py-4">
        <ErrorNote message={error} />
        <Field label="Name" name="name" required placeholder="Support assistant" />
        <Field
          label="Description"
          name="description"
          placeholder="What this chatbot is for (internal only)"
        />
        <Field
          label="Greeting"
          name="greeting"
          placeholder="Hi — how can I help?"
          hint="Shown before the visitor types anything. Written by you, never generated, so it costs nothing to display."
        />

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[--color-muted]">Instructions</span>
          <textarea
            name="instructions"
            rows={4}
            placeholder="You answer questions about our shipping and returns policy."
            className="w-full rounded-lg border border-[--color-line] bg-white px-3 py-2 text-sm outline-none focus:border-[--color-accent]"
          />
          {/*
            Worth saying plainly and not in a tooltip. A determined visitor can
            get a model to recite its own system prompt, and no instruction
            reliably prevents that — so this field is effectively public.
          */}
          <span className="mt-1 block text-xs text-[--color-muted]">
            Treat this as public. A visitor can sometimes persuade a chatbot to repeat its own
            instructions, so do not put anything confidential here.
          </span>
        </label>

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create chatbot'}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
