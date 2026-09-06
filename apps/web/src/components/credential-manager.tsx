'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Badge, Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

interface Credential {
  id: string;
  providerId: string;
  name: string;
  fingerprint: string;
  lastFour: string;
  baseUrl: string | null;
  status: string;
  isDefault: boolean;
  lastUsedAt: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  revokedAt: string | null;
  createdAt: string;
}

interface TestResult {
  ok: boolean;
  reason?: string;
  providerCode?: string;
}

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
];

export function CredentialManager({
  credentials,
  activeProviders,
}: {
  credentials: Credential[];
  activeProviders: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = event.currentTarget;
    const data = new FormData(form);

    try {
      await browserApi('/v1/credentials', {
        method: 'POST',
        body: {
          providerId: String(data.get('providerId') ?? ''),
          name: String(data.get('name') ?? ''),
          apiKey: String(data.get('apiKey') ?? ''),
          baseUrl: String(data.get('baseUrl') ?? '') || null,
        },
      });
      // Clear the form immediately so the key does not linger in the DOM.
      form.reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(describe(err, 'Could not save the credential.'));
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, path: string, method = 'POST', body?: unknown) {
    setError(null);
    setBusy(true);
    try {
      await browserApi(`/v1/credentials/${id}${path}`, {
        method,
        ...(body !== undefined ? { body } : {}),
      });
      router.refresh();
    } catch (err) {
      setError(describe(err, 'The action could not be completed.'));
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setError(null);
    setBusy(true);
    try {
      const result = await browserApi<TestResult>(`/v1/credentials/${id}/test`, { method: 'POST' });
      setTests((previous) => ({ ...previous, [id]: result }));
      router.refresh();
    } catch (err) {
      setTests((previous) => ({
        ...previous,
        [id]: { ok: false, reason: describe(err, 'The test could not be run.') },
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <ErrorNote message={error} />
        <div className="ml-auto">
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Add credential'}
          </Button>
        </div>
      </div>

      {open ? (
        <Card>
          <CardHeader
            title="Add a provider credential"
            description="Paste the key once. It is encrypted on arrival and cannot be read back."
          />
          <form onSubmit={create} className="grid gap-4 p-5 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[--color-muted]">Provider</span>
              <select
                name="providerId"
                defaultValue="anthropic"
                className="h-9 w-full rounded-lg border border-[--color-line] bg-white px-2 text-sm outline-none focus:border-[--color-accent]"
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>

            <Field label="Name" name="name" required placeholder="Production key" />

            <div className="sm:col-span-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[--color-muted]">API key</span>
                <input
                  name="apiKey"
                  type="password"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-…"
                  className="h-9 w-full rounded-lg border border-[--color-line] bg-white px-3 font-mono text-sm outline-none focus:border-[--color-accent]"
                />
                <span className="mt-1 block text-xs text-[--color-muted]">
                  Stored encrypted. Only the last four characters remain visible.
                </span>
              </label>
            </div>

            <div className="sm:col-span-2">
              <Field
                label="Custom endpoint (optional)"
                name="baseUrl"
                placeholder="https://my-proxy.example.com/v1"
                hint="For self-hosted or proxied deployments. Must be a public HTTPS address."
              />
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Encrypting…' : 'Save credential'}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {credentials.length > 0 ? (
        <Card>
          <ul className="divide-y divide-[--color-line]">
            {credentials.map((credential) => {
              const result = tests[credential.id];
              const revoked = credential.status === 'revoked';

              return (
                <li key={credential.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {credential.name}{' '}
                        <span className="font-mono text-xs text-[--color-muted]">
                          ····{credential.lastFour}
                        </span>
                      </p>
                      <p className="truncate text-xs text-[--color-muted]">
                        {credential.providerId}
                        {credential.baseUrl ? ` · ${credential.baseUrl}` : ''}
                        {credential.lastUsedAt
                          ? ` · last used ${new Date(credential.lastUsedAt).toLocaleString()}`
                          : ' · never used'}
                      </p>
                    </div>

                    <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                      <StatusPill status={credential.status} />
                      {credential.isDefault && !revoked ? <Badge>default</Badge> : null}
                      {activeProviders.includes(credential.providerId) && !revoked ? (
                        <Badge>in use</Badge>
                      ) : null}
                    </div>
                  </div>

                  {result ? (
                    <p
                      className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                        result.ok
                          ? 'bg-emerald-50 text-emerald-900'
                          : 'bg-amber-50 text-amber-900'
                      }`}
                    >
                      {result.ok
                        ? 'Connection succeeded — the provider accepted this key.'
                        : (result.reason ?? 'The test failed.')}
                    </p>
                  ) : null}

                  {!revoked ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="secondary" disabled={busy} onClick={() => void test(credential.id)}>
                        Test connection
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(credential.id, '', 'PATCH', {
                            enabled: credential.status !== 'active',
                          })
                        }
                      >
                        {credential.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => void act(credential.id, '/revoke')}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-[--color-muted]">
                      Revoked
                      {credential.revokedAt
                        ? ` on ${new Date(credential.revokedAt).toLocaleString()}`
                        : ''}
                      . Revocation is permanent; add a new credential to restore access.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'revoked'
        ? 'bg-red-50 text-red-700'
        : 'bg-gray-100 text-gray-600';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}

/** Surface field-level detail where the API provided it. */
function describe(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const fields = error.details?.['fields'];
  if (Array.isArray(fields) && fields.length > 0) return fields.join('; ');
  const apiKey = error.details?.['apiKey'];
  if (typeof apiKey === 'string') return apiKey;
  const baseUrl = error.details?.['baseUrl'];
  if (typeof baseUrl === 'string') return baseUrl;
  return error.message;
}
