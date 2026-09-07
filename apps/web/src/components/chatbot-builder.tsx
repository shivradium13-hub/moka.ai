'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { API_URL, ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, EmptyState, ErrorNote, Field } from '@/components/ui';

interface Chatbot {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  greeting: string | null;
  requireGrounding: boolean;
  handoffEnabled: boolean;
  retentionDays: number;
  status: string;
  sourceIds: string[];
}

interface Source {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface Deployment {
  id: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  status: string;
  createdAt: string;
}

export function ChatbotBuilder({
  chatbot,
  sources,
  deployments,
}: {
  chatbot: Chatbot;
  sources: Source[];
  deployments: Deployment[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>(chatbot.sourceIds);

  const liveDeployments = deployments.filter((d) => d.status === 'active');
  const canGoLive = selected.length > 0 || !chatbot.requireGrounding;

  async function call(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorNote message={error} />

      {/* ---------------------------------------------------------------- */}
      {/* Publication — the decision with real consequences                 */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Published knowledge"
          description="Anything in a source you attach here can be quoted, word for word, to any visitor. Nothing else can."
        />

        {sources.length === 0 ? (
          <EmptyState
            title="No knowledge sources"
            description="Upload documents under Knowledge first, then publish a source to this chatbot."
          />
        ) : (
          <>
            <ul className="divide-y divide-[--color-line]">
              {sources.map((source) => {
                const on = selected.includes(source.id);
                return (
                  <li key={source.id} className="flex items-center gap-3 px-5 py-3">
                    <input
                      id={`source-${source.id}`}
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setSelected(
                          on ? selected.filter((s) => s !== source.id) : [...selected, source.id],
                        )
                      }
                      className="h-4 w-4"
                    />
                    <label htmlFor={`source-${source.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{source.name}</span>
                      <span className="block truncate text-xs text-[--color-muted]">
                        {source.type}
                      </span>
                    </label>
                    {on ? (
                      <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                        public
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-[--color-line] px-5 py-3">
              <Button
                disabled={busy}
                onClick={() =>
                  void call(
                    () =>
                      browserApi(`/v1/chatbots/${chatbot.id}/sources`, {
                        method: 'POST',
                        body: { sourceIds: selected },
                      }),
                    'Could not update the published sources.',
                  )
                }
              >
                {busy ? 'Saving…' : 'Save published sources'}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Behaviour                                                         */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader title="Behaviour" />
        <div className="space-y-4 px-5 py-4">
          <Toggle
            label="Only answer from published knowledge"
            hint="Recommended. With this off, the chatbot will answer from the model's general knowledge — confidently, and sometimes wrongly, about your business."
            checked={chatbot.requireGrounding}
            disabled={busy}
            onChange={(value) =>
              void call(
                () =>
                  browserApi(`/v1/chatbots/${chatbot.id}`, {
                    method: 'PATCH',
                    body: { requireGrounding: value },
                  }),
                'Could not change that setting.',
              )
            }
          />

          <Toggle
            label="Offer to pass the visitor to a person"
            hint="Shows a button in the widget. It always works, whatever the assistant says — a person asking for a person should not depend on a model agreeing."
            checked={chatbot.handoffEnabled}
            disabled={busy}
            onChange={(value) =>
              void call(
                () =>
                  browserApi(`/v1/chatbots/${chatbot.id}`, {
                    method: 'PATCH',
                    body: { handoffEnabled: value },
                  }),
                'Could not change that setting.',
              )
            }
          />

          <div className="flex items-center gap-3 border-t border-[--color-line] pt-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {chatbot.status === 'active' ? 'Live' : 'Not live'}
              </p>
              <p className="text-xs text-[--color-muted]">
                {chatbot.status === 'active'
                  ? 'Answering visitors on every active deployment.'
                  : canGoLive
                    ? 'Deployments will not resolve until this chatbot is live.'
                    : 'Publish at least one knowledge source before going live, or it will have nothing to say.'}
              </p>
            </div>
            <div className="ml-auto shrink-0">
              <Button
                variant={chatbot.status === 'active' ? 'danger' : 'primary'}
                disabled={busy || (chatbot.status !== 'active' && !canGoLive)}
                onClick={() =>
                  void call(
                    () =>
                      browserApi(`/v1/chatbots/${chatbot.id}`, {
                        method: 'PATCH',
                        body: { status: chatbot.status === 'active' ? 'disabled' : 'active' },
                      }),
                    'Could not change the status.',
                  )
                }
              >
                {chatbot.status === 'active' ? 'Take offline' : 'Go live'}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Deployments                                                       */}
      {/* ---------------------------------------------------------------- */}
      <DeploymentPanel
        chatbotId={chatbot.id}
        deployments={deployments}
        busy={busy}
        onCall={call}
      />

      {liveDeployments.length > 0 && chatbot.status === 'active' ? null : (
        <p className="text-xs text-[--color-muted]">
          This chatbot is not reachable by anyone yet. It needs to be live and to have at least one
          deployment naming the sites it may appear on.
        </p>
      )}
    </div>
  );
}

function DeploymentPanel({
  chatbotId,
  deployments,
  busy,
  onCall,
}: {
  chatbotId: string;
  deployments: Deployment[];
  busy: boolean;
  onCall: (fn: () => Promise<unknown>, fallback: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const origins = String(form.get('origins') ?? '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    await onCall(
      () =>
        browserApi(`/v1/chatbots/${chatbotId}/deployments`, {
          method: 'POST',
          body: { name: String(form.get('name') ?? ''), allowedOrigins: origins },
        }),
      'Could not create the deployment.',
    );
    setOpen(false);
  }

  return (
    <Card>
      <CardHeader
        title="Deployments"
        description="Each deployment is a snippet for one set of sites, with its own key you can revoke on its own."
      />

      {deployments.length === 0 ? (
        <EmptyState
          title="Not deployed anywhere"
          description="Create a deployment to get an embed snippet."
        />
      ) : (
        <ul className="divide-y divide-[--color-line]">
          {deployments.map((deployment) => (
            <li key={deployment.id} className="px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{deployment.name}</p>
                  <p className="truncate text-xs text-[--color-muted]">
                    {deployment.allowedOrigins.join(', ') || 'No sites — embeddable nowhere'}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {deployment.status === 'active' ? (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void onCall(
                          () =>
                            browserApi(`/v1/chatbots/deployments/${deployment.id}`, {
                              method: 'DELETE',
                            }),
                          'Could not revoke the deployment.',
                        )
                      }
                    >
                      Revoke
                    </Button>
                  ) : (
                    <span className="text-xs text-[--color-muted]">revoked</span>
                  )}
                </div>
              </div>

              {deployment.status === 'active' ? (
                <EmbedSnippet publicKey={deployment.publicKey} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-[--color-line] px-5 py-3">
        {open ? (
          <form onSubmit={create} className="space-y-3">
            <Field label="Name" name="name" required placeholder="Marketing site" />
            <Field
              label="Sites"
              name="origins"
              required
              placeholder="https://example.com https://*.example.com"
              hint="One origin per site, space or comma separated. A wildcard covers subdomains but not the bare domain. This list is what the browser enforces when deciding who may embed the chat window."
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create deployment'}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            New deployment
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * The embed snippet.
 *
 * The key is shown in full and in the clear, unlike a credential. It is public
 * by design — it is about to be pasted into a page anyone can view the source
 * of — and hiding it would only suggest it were something it is not.
 */
function EmbedSnippet({ publicKey }: { publicKey: string }) {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="${API_URL}/public/widget/v1/moka-chat.js" data-moka-key="${publicKey}" async></script>`;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-[--color-muted]">Paste before &lt;/body&gt;</p>
        <button
          type="button"
          className="ml-auto text-xs text-[--color-accent] hover:underline"
          onClick={() => {
            void navigator.clipboard.writeText(snippet).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-gray-50 p-3 text-[11px] leading-relaxed">
        <code>{snippet}</code>
      </pre>
      <p className="mt-1 text-xs text-[--color-muted]">
        This key is public — it appears in your page source. It lets a visitor start a conversation
        and nothing else.
      </p>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-[--color-muted]">{hint}</span>
      </span>
    </label>
  );
}
