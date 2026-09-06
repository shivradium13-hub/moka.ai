import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { ProjectManager } from '@/components/project-manager';

interface ProjectsResponse {
  projects: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    createdAt: string;
  }>;
}

export default async function ProjectsPage() {
  const data = await serverApiOrNull<ProjectsResponse>('/v1/projects');
  const projects = data?.projects ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Every project below belongs to the active organization. Row-Level Security makes another
          organization&apos;s projects unreachable, not merely hidden.
        </p>
      </div>

      <ProjectManager initialProjects={projects} />

      {projects.length === 0 ? (
        <Card>
          <CardHeader title="No projects yet" />
          <EmptyState
            title="Create your first project"
            description="Projects scope knowledge, agents and conversations in later phases."
          />
        </Card>
      ) : null}
    </div>
  );
}
