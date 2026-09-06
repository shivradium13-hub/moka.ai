import { serverApiOrNull } from '@/lib/api-server';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';

interface MembersResponse {
  members: Array<{
    id: string;
    userId: string;
    email: string;
    name: string;
    role: string;
    status: string;
    joinedAt: string | null;
  }>;
}

export default async function MembersPage() {
  const data = await serverApiOrNull<MembersResponse>('/v1/organization/members');
  const members = data?.members ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Roles are enforced server-side. What is rendered here is presentation, never permission.
        </p>
      </div>

      <Card>
        <CardHeader title="Organization members" />
        {members.length === 0 ? (
          <EmptyState
            title="No members visible"
            description="Your role may not include permission to read the member list."
          />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-[--color-muted]">{member.email}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Badge>{member.role}</Badge>
                  <span className="text-xs text-[--color-muted]">{member.status}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-[--color-muted]">
        Invitations and role editing are wired in the API (member:invite, member:update_role) and
        surfaced in the UI in Phase 2.
      </p>
    </div>
  );
}
