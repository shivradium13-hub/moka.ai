import Link from 'next/link';
import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { ChatbotCreator } from '@/components/chatbot-creator';

interface ChatbotsResponse {
  chatbots: Array<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    requireGrounding: boolean;
    handoffEnabled: boolean;
    sourceIds: string[];
    createdAt: string;
  }>;
}

export default async function ChatbotsPage() {
  const data = await serverApiOrNull<ChatbotsResponse>('/v1/chatbots');
  const chatbots = data?.chatbots ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Chatbots</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          A chatbot answers members of the public on your own website. It can only quote knowledge
          you explicitly publish to it, and it can never take an action on anyone&apos;s behalf.
        </p>
      </div>

      <ChatbotCreator />

      <Card>
        <CardHeader title="Your chatbots" />
        {chatbots.length === 0 ? (
          <EmptyState
            title="No chatbots yet"
            description="Create one, publish a knowledge source to it, then deploy it to a site."
          />
        ) : (
          <ul className="divide-y divide-[--color-line]">
            {chatbots.map((bot) => (
              <li key={bot.id}>
                <Link
                  href={`/chatbots/${bot.id}`}
                  className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-gray-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{bot.name}</p>
                    <p className="truncate text-xs text-[--color-muted]">
                      {bot.sourceIds.length === 0
                        ? 'No knowledge published — it cannot answer anything yet'
                        : `${bot.sourceIds.length} source${bot.sourceIds.length === 1 ? '' : 's'} published`}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {bot.requireGrounding ? null : (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                        ungrounded
                      </span>
                    )}
                    <StatusPill status={bot.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'draft'
        ? 'bg-gray-100 text-gray-600'
        : 'bg-red-50 text-red-700';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>
  );
}
