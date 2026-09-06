import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { CredentialManager } from '@/components/credential-manager';

interface CredentialsResponse {
  credentials: Array<{
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
  }>;
}

interface ModelsResponse {
  providers: string[];
}

export default async function CredentialsPage() {
  const [data, models] = await Promise.all([
    serverApiOrNull<CredentialsResponse>('/v1/credentials'),
    serverApiOrNull<ModelsResponse>('/v1/ai/models'),
  ]);

  const credentials = data?.credentials ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Moka Credentials</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Provider API keys for this organization. Keys are encrypted with a key unique to your
          organization and are never shown again after you save them.
        </p>
      </div>

      {/*
        Stated plainly rather than buried in docs. Someone pasting a production
        API key deserves to know exactly what happens to it.
      */}
      <div className="rounded-lg border border-[--color-line] bg-[--color-accent-soft] px-4 py-3 text-xs">
        <p className="font-medium text-[--color-ink]">How your keys are stored</p>
        <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[--color-muted]">
          <li>Encrypted with AES-256-GCM under a data key unique to this organization.</li>
          <li>
            Cryptographically bound to this organization — a copied database row will not decrypt
            elsewhere.
          </li>
          <li>Never written to logs, never returned by the API, never included in AI prompts.</li>
          <li>
            Only a non-reversible fingerprint and the last four characters are stored for display.
          </li>
        </ul>
      </div>

      <CredentialManager credentials={credentials} activeProviders={models?.providers ?? []} />

      {credentials.length === 0 ? (
        <Card>
          <CardHeader title="No credentials yet" />
          <EmptyState
            title="Add a provider key to enable AI features"
            description="Until a key is added, every model shows as unavailable rather than failing when you try to use it."
          />
        </Card>
      ) : null}
    </div>
  );
}
