import Link from 'next/link';
import { serverApiOrNull } from '@/lib/api-server';
import { Badge, Card, CardHeader } from '@/components/ui';

interface OrganizationResponse {
  organization: { id: string; name: string; slug: string; createdAt: string };
}
interface ProjectsResponse {
  projects: Array<{ id: string; name: string; slug: string }>;
}
interface MembersResponse {
  members: Array<{ id: string; name: string; role: string }>;
}

export default async function DashboardPage() {
  // Each call is independently permission-gated by the API. A viewer, for
  // example, receives 403 for members and simply sees no member count —
  // the page degrades rather than failing.
  const [org, projects, members] = await Promise.all([
    serverApiOrNull<OrganizationResponse>('/v1/organization'),
    serverApiOrNull<ProjectsResponse>('/v1/projects'),
    serverApiOrNull<MembersResponse>('/v1/organization/members'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {org?.organization.name ?? 'Dashboard'}
        </h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Phase 1 foundation — authentication, organizations and multi-tenancy.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Projects" value={projects?.projects.length ?? 0} href="/projects" />
        <Stat label="Members" value={members?.members.length ?? 0} href="/members" />
        <Stat label="Agents" value="—" hint="Phase 5" />
      </div>

      <Card>
        <CardHeader
          title="What is not built yet"
          description="Listed explicitly rather than stubbed, so nothing here pretends to work."
        />
        <ul className="divide-y divide-[--color-line] text-sm">
          {[
            ['Knowledge engine, RAG, pgvector', 'Phase 2'],
            ['AI gateway, model router, streaming', 'Phase 3'],
            ['Moka Credentials vault, BYOK', 'Phase 4'],
            ['Agent runtime, tools, approvals', 'Phase 5'],
            ['Website chatbot and widget', 'Phase 6'],
          ].map(([label, phase]) => (
            <li key={label} className="flex items-center justify-between px-5 py-3">
              <span className="text-[--color-muted]">{label}</span>
              <Badge>{phase}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: number | string;
  href?: string;
  hint?: string;
}) {
  const body = (
    <Card className="px-5 py-4 transition hover:border-[--color-accent]">
      <p className="text-xs text-[--color-muted]">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-[--color-muted]">{hint}</p> : null}
    </Card>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}
