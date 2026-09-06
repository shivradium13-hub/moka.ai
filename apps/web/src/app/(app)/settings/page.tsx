import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';

interface OrganizationResponse {
  organization: { id: string; name: string; slug: string; createdAt: string };
}
interface AuditResponse {
  entries: Array<{
    id: string;
    actorType: string;
    action: string;
    resourceType: string;
    outcome: string;
    createdAt: string;
  }>;
}

export default async function SettingsPage() {
  const [org, audit] = await Promise.all([
    serverApiOrNull<OrganizationResponse>('/v1/organization'),
    serverApiOrNull<AuditResponse>('/v1/organization/audit-log?limit=25'),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader title="Organization" />
        <dl className="divide-y divide-[--color-line] text-sm">
          <Row label="Name" value={org?.organization.name ?? '—'} />
          <Row label="Slug" value={org?.organization.slug ?? '—'} />
          <Row label="Organization ID" value={org?.organization.id ?? '—'} mono />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Audit log"
          description="Append-only. The application role holds no UPDATE or DELETE grant on this table."
        />
        {!audit || audit.entries.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            description="Either no activity has been recorded, or your role lacks audit:read."
          />
        ) : (
          <ul className="divide-y divide-[--color-line] text-sm">
            {audit.entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-4 px-5 py-2.5">
                <span className="font-mono text-xs">{entry.action}</span>
                <span className="text-xs text-[--color-muted]">{entry.resourceType}</span>
                <span className="ml-auto text-xs text-[--color-muted]">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <dt className="text-xs text-[--color-muted]">{label}</dt>
      <dd className={`ml-auto ${mono ? 'font-mono text-xs' : 'text-sm'}`}>{value}</dd>
    </div>
  );
}
