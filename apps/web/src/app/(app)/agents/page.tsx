import { serverApiOrNull } from '@/lib/api-server';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui';
import { ApprovalInbox } from '@/components/approval-inbox';
import { AgentBuilder } from '@/components/agent-builder';

interface AgentsResponse {
  agents: Array<{
    id: string;
    name: string;
    description: string | null;
    permissionLevel: string;
    tools: string[];
    maxSteps: number;
    status: string;
  }>;
}

interface ToolsResponse {
  tools: Array<{
    name: string;
    description: string;
    risk: string;
    permission: string;
    requiresApproval: boolean;
    customerSafe: boolean;
  }>;
}

interface TemplatesResponse {
  templates: Array<{
    id: string;
    name: string;
    summary: string;
    limitations: string[];
    permissionLevel: string;
    tools: string[];
  }>;
}

interface ApprovalsResponse {
  approvals: Array<{
    id: string;
    runId: string | null;
    toolName: string;
    summary: string;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>;
}

interface RunsResponse {
  runs: Array<{
    id: string;
    agentId: string;
    status: string;
    input: string;
    output: string | null;
    stepsUsed: number;
    errorCode: string | null;
    startedAt: string;
  }>;
}

export default async function AgentsPage() {
  const [agentsData, toolsData, approvalsData, runsData, templatesData] = await Promise.all([
    serverApiOrNull<AgentsResponse>('/v1/agents'),
    serverApiOrNull<ToolsResponse>('/v1/agents/tools'),
    serverApiOrNull<ApprovalsResponse>('/v1/agents/approvals'),
    serverApiOrNull<RunsResponse>('/v1/agents/runs'),
    serverApiOrNull<TemplatesResponse>('/v1/agents/templates'),
  ]);

  const agents = agentsData?.agents ?? [];
  const tools = toolsData?.tools ?? [];
  const templates = templatesData?.templates ?? [];
  const approvals = approvalsData?.approvals ?? [];
  const runs = runsData?.runs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          An agent can only ever do what <em>you</em> could do by hand. Every tool call is checked
          against your own role, not the agent&apos;s configuration.
        </p>
      </div>

      {/* Pending approvals come first: someone is blocked waiting on them. */}
      <ApprovalInbox approvals={approvals} />

      <AgentBuilder templates={templates} tools={tools} />

      <Card>
        <CardHeader
          title="Available tools"
          description="Risk and approval requirements are shown here for humans. Models are never told which tools are privileged."
        />
        {tools.length === 0 ? (
          <EmptyState title="No tools" description="No tools are registered." />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {tools.map((tool) => (
              <li key={tool.name} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium">{tool.name}</p>
                  <p className="truncate text-xs text-[--color-muted]">{tool.description}</p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <RiskPill risk={tool.risk} />
                  {tool.requiresApproval ? <Badge>needs approval</Badge> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Agents" />
        {agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            description="Start from a template above, or build one from scratch."
          />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {agents.map((agent) => (
              <li key={agent.id} className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="truncate text-xs text-[--color-muted]">
                      {agent.tools.length} tool{agent.tools.length === 1 ? '' : 's'} ·{' '}
                      {agent.maxSteps} step limit
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <RiskPill risk={agent.permissionLevel} />
                    <span className="text-xs text-[--color-muted]">{agent.status}</span>
                  </div>
                </div>
                {agent.tools.length > 0 ? (
                  <p className="mt-1.5 font-mono text-[11px] text-[--color-muted]">
                    {agent.tools.join(', ')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent runs"
          description="Every run is recorded, including those that failed before reaching a model."
        />
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" description="Run an agent to see its history here." />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <p className="min-w-0 truncate text-sm">{run.input}</p>
                  <span className="ml-auto shrink-0 text-xs text-[--color-muted]">
                    {run.status}
                    {run.errorCode ? ` · ${run.errorCode}` : ''} · {run.stepsUsed} steps
                  </span>
                </div>
                {run.output ? (
                  <p className="mt-1 truncate text-xs text-[--color-muted]">{run.output}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
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
