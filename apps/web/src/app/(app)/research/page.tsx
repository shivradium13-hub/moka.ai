import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { ResearchConsole } from '@/components/research-console';

interface Capabilities {
  providers: Array<{ id: string; label: string; configured: boolean; note: string | null }>;
}

interface RunsResponse {
  runs: Array<{
    id: string;
    question: string;
    status: string;
    answer: string | null;
    searchProvider: string;
    citationCount: number;
    startedAt: string;
  }>;
}

export default async function ResearchPage() {
  const [capabilities, runsData] = await Promise.all([
    serverApiOrNull<Capabilities>('/v1/research/capabilities'),
    serverApiOrNull<RunsResponse>('/v1/research'),
  ]);

  const runs = runsData?.runs ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Research</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Reads pages and answers from them. Every source is a page that was actually fetched — the
          assistant cites by number and never writes a link, so it cannot invent one.
        </p>
      </div>

      <ResearchConsole capabilities={capabilities ?? { providers: [] }} />

      <Card>
        <CardHeader
          title="Past runs"
          description="Each keeps the pages it read and the text it was shown, so an answer can be checked later."
        />
        {runs.length === 0 ? (
          <EmptyState title="No runs yet" description="Ask a question above." />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {runs.map((run) => (
              <li key={run.id} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <p className="min-w-0 truncate text-sm">{run.question}</p>
                  <span className="ml-auto shrink-0 text-xs text-[--color-muted]">
                    {run.status === 'answered'
                      ? `${run.citationCount} source${run.citationCount === 1 ? '' : 's'}`
                      : run.status.replace('_', ' ')}
                    {' · '}
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </div>
                {run.answer ? (
                  <p className="mt-1 truncate text-xs text-[--color-muted]">{run.answer}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
