import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { ConversationInbox } from '@/components/conversation-inbox';

interface ConversationsResponse {
  conversations: Array<{
    id: string;
    chatbotId: string;
    status: string;
    origin: string | null;
    visitor: string;
    messageCount: number;
    handoffRequestedAt: string | null;
    startedAt: string;
    lastActivityAt: string;
  }>;
}

/**
 * The handoff inbox.
 *
 * Deliberately its own page rather than a tab inside one chatbot: a person
 * answering handoffs wants everything waiting, not one bot at a time.
 */
export default async function InboxPage() {
  const [waiting, all] = await Promise.all([
    serverApiOrNull<ConversationsResponse>('/v1/chat/conversations?status=awaiting_human'),
    serverApiOrNull<ConversationsResponse>('/v1/chat/conversations'),
  ]);

  const waitingList = waiting?.conversations ?? [];
  const recent = (all?.conversations ?? []).filter((c) => c.status !== 'awaiting_human');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Visitors are shown by a per-conversation label, not a name. We record where a conversation
          was opened from and nothing else about who opened it.
        </p>
      </div>

      <ConversationInbox title="Waiting for a person" conversations={waitingList} urgent />

      <Card>
        <CardHeader title="Recent conversations" />
        {recent.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="Conversations appear here once a chatbot is live and someone talks to it."
          />
        ) : (
          <ConversationInbox conversations={recent} />
        )}
      </Card>
    </div>
  );
}
