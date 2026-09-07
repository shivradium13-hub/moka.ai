import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverApiOrNull } from '@/lib/api-server';
import { ChatbotBuilder } from '@/components/chatbot-builder';

interface ChatbotResponse {
  chatbot: {
    id: string;
    name: string;
    description: string | null;
    instructions: string;
    greeting: string | null;
    requireGrounding: boolean;
    handoffEnabled: boolean;
    retentionDays: number;
    status: string;
    sourceIds: string[];
  };
}

interface SourcesResponse {
  sources: Array<{ id: string; name: string; type: string; status: string }>;
}

interface DeploymentsResponse {
  deployments: Array<{
    id: string;
    name: string;
    publicKey: string;
    allowedOrigins: string[];
    status: string;
    createdAt: string;
  }>;
}

export default async function ChatbotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [botData, sourcesData, deploymentsData] = await Promise.all([
    serverApiOrNull<ChatbotResponse>(`/v1/chatbots/${id}`),
    serverApiOrNull<SourcesResponse>('/v1/knowledge/sources'),
    serverApiOrNull<DeploymentsResponse>(`/v1/chatbots/${id}/deployments`),
  ]);

  if (!botData) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/chatbots" className="text-xs text-[--color-muted] hover:underline">
          ← Chatbots
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{botData.chatbot.name}</h1>
      </div>

      <ChatbotBuilder
        chatbot={botData.chatbot}
        sources={sourcesData?.sources ?? []}
        deployments={deploymentsData?.deployments ?? []}
      />
    </div>
  );
}
