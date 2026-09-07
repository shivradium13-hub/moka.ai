'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

interface Template {
  id: string;
  name: string;
  summary: string;
  limitations: string[];
  permissionLevel: string;
  tools: string[];
}

interface Tool {
  name: string;
  description: string;
  risk: string;
  permission: string;
  requiresApproval: boolean;
  customerSafe: boolean;
}

const LEVELS = [
  { value: 'read', label: 'Read only', hint: 'Can look things up. Changes nothing.' },
  { value: 'draft', label: 'Draft', hint: 'Can also create reversible things, like a project.' },
  {
    value: 'execute',
    label: 'Execute',
    hint: 'Can also take consequential actions. Each one pauses for your approval.',
  },
];

/**
 * The agent builder (master prompt §25).
 *
 * Deferred from Phase 5 with the business agents, because a builder is only
 * useful once there is something worth building. Two things it does that a
 * plain form would not:
 *
 *  - It shows every tool's RISK and whether it needs approval, next to the
 *    checkbox. A user granting a capability should see what they are granting
 *    at the moment they grant it, not discover it from a refusal later.
 *
 *  - It states each template's LIMITATIONS as prominently as its summary. A
 *    picker that lists six capabilities and no limits sells a product that
 *    does not exist.
 *
 * None of this is enforcement. Every tool call is authorised server-side
 * against the invoking user's own role, and this form cannot grant a
 * capability the user does not already have — the API refuses, naming the
 * permission that is missing.
 */
export function AgentBuilder({ templates, tools }: { templates: Template[]; tools: Tool[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [level, setLevel] = useState('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((t) => t.id === templateId) ?? null;

  function chooseTemplate(next: Template | null) {
    setTemplateId(next?.id ?? null);
    setSelected(next ? [...next.tools] : []);
    setLevel(next?.permissionLevel ?? 'read');
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(event.currentTarget);

    try {
      await browserApi('/v1/agents', {
        method: 'POST',
        body: {
          ...(templateId ? { templateId } : {}),
          name: String(form.get('name') ?? ''),
          description: String(form.get('description') ?? '') || null,
          instructions: String(form.get('instructions') ?? ''),
          permissionLevel: level,
          tools: selected,
        },
      });
      setOpen(false);
      chooseTemplate(null);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? // The API names the permission when a grant is refused, which is
            // the actionable half of the message.
            `${err.message}${err.details?.required ? ` (needs ${String(err.details.required)})` : ''}`
          : 'Could not create the agent.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>New agent</Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader
        title="New agent"
        description="An agent can only ever do what you could do by hand. Granting it a tool you do not have will be refused."
      />

      <form onSubmit={create} className="space-y-5 px-5 py-4">
        <ErrorNote message={error} />

        {/* ---------------------------------------------------------------- */}
        {/* Start from a template                                            */}
        {/* ---------------------------------------------------------------- */}
        <div>
          <p className="mb-2 text-xs font-medium text-[--color-muted]">Start from</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => chooseTemplate(null)}
              className={`rounded-lg border p-3 text-left transition ${
                templateId === null
                  ? 'border-[--color-accent] bg-[--color-accent-soft]'
                  : 'border-[--color-line] hover:bg-gray-50'
              }`}
            >
              <span className="block text-sm font-medium">Blank</span>
              <span className="block text-xs text-[--color-muted]">
                Choose the tools and instructions yourself.
              </span>
            </button>

            {templates.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseTemplate(item)}
                className={`rounded-lg border p-3 text-left transition ${
                  templateId === item.id
                    ? 'border-[--color-accent] bg-[--color-accent-soft]'
                    : 'border-[--color-line] hover:bg-gray-50'
                }`}
              >
                <span className="block text-sm font-medium">{item.name}</span>
                <span className="block text-xs text-[--color-muted]">{item.summary}</span>
              </button>
            ))}
          </div>
        </div>

        {/*
          Limitations, shown as prominently as the summary. This is the half a
          picker normally omits, and the half that stops someone expecting a
          CRM integration that does not exist.
        */}
        {template ? (
          <div className="rounded-lg bg-amber-50 px-3 py-2.5">
            <p className="text-xs font-medium text-amber-900">What this agent cannot do</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-900">
              {template.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <Field label="Name" name="name" required defaultValue={template?.name ?? ''} />
        <Field label="Description" name="description" placeholder="What this agent is for" />

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[--color-muted]">Instructions</span>
          <textarea
            name="instructions"
            rows={5}
            key={templateId ?? 'blank'}
            defaultValue={template ? '' : ''}
            placeholder={
              template
                ? 'Leave blank to use the template’s instructions, or write your own.'
                : 'You are a helpful assistant that…'
            }
            className="w-full rounded-lg border border-[--color-line] bg-white px-3 py-2 text-sm outline-none focus:border-[--color-accent]"
          />
        </label>

        {/* ---------------------------------------------------------------- */}
        {/* Ceiling                                                          */}
        {/* ---------------------------------------------------------------- */}
        <div>
          <p className="mb-2 text-xs font-medium text-[--color-muted]">
            How far this agent may go
          </p>
          <div className="space-y-1.5">
            {LEVELS.map((option) => (
              <label key={option.value} className="flex gap-2.5">
                <input
                  type="radio"
                  name="permissionLevel"
                  value={option.value}
                  checked={level === option.value}
                  onChange={() => setLevel(option.value)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-sm">{option.label}</span>
                  <span className="block text-xs text-[--color-muted]">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Tools                                                            */}
        {/* ---------------------------------------------------------------- */}
        <div>
          <p className="mb-2 text-xs font-medium text-[--color-muted]">
            Tools ({selected.length} selected)
          </p>
          <ul className="divide-y divide-[--color-line] rounded-lg border border-[--color-line]">
            {tools.map((tool) => {
              const on = selected.includes(tool.name);
              return (
                <li key={tool.name} className="flex items-start gap-3 px-3 py-2.5">
                  <input
                    id={`tool-${tool.name}`}
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setSelected(
                        on ? selected.filter((t) => t !== tool.name) : [...selected, tool.name],
                      )
                    }
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <label htmlFor={`tool-${tool.name}`} className="min-w-0 flex-1">
                    <span className="block font-mono text-xs font-medium">{tool.name}</span>
                    <span className="block text-xs text-[--color-muted]">{tool.description}</span>
                  </label>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <RiskPill risk={tool.risk} />
                    {tool.requiresApproval ? (
                      <span className="text-[11px] text-amber-800">needs approval</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-[--color-muted]">
            Risk is shown here for you. It is never described to the model — telling it which tools
            are privileged only helps an injected instruction pick a target.
          </p>
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create agent'}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function RiskPill({ risk }: { risk: string }) {
  const tone =
    risk === 'execute'
      ? 'bg-red-50 text-red-700'
      : risk === 'draft'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-emerald-50 text-emerald-700';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{risk}</span>;
}
