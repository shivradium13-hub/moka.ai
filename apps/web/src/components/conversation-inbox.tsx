'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, EmptyState, ErrorNote } from '@/components/ui';

interface Conversation {
  id: string;
  chatbotId: string;
  status: string;
  origin: string | null;
  visitor: string;
  messageCount: number;
  handoffRequestedAt: string | null;
  startedAt: string;
  lastActivityAt: string;
}

interface TranscriptMessage {
  id: string;
  role: string;
  content: string;
  citations: Array<{ documentTitle: string; page: number | null }>;
  errorCode: string | null;
  createdAt: string;
}

export function ConversationInbox({
  title,
  conversations,
  urgent = false,
}: {
  title?: string;
  conversations: Conversation[];
  urgent?: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const data = await browserApi<{ messages: TranscriptMessage[] }>(
        `/v1/chat/conversations/${id}`,
      );
      setTranscript(data.messages);
      setOpenId(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the conversation.');
    } finally {
      setBusy(false);
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = String(form.get('message') ?? '').trim();
    if (!message) return;

    setError(null);
    setBusy(true);
    try {
      await browserApi(`/v1/chat/conversations/${id}/reply`, {
        method: 'POST',
        body: { message },
      });
      const data = await browserApi<{ messages: TranscriptMessage[] }>(
        `/v1/chat/conversations/${id}`,
      );
      setTranscript(data.messages);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the reply.');
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
      {conversations.length === 0 ? (
        <EmptyState title="Nobody is waiting" description="Handoff requests appear here." />
      ) : (
        <ul className="divide-y divide-[--color-line]">
          {conversations.map((conversation) => (
            <li key={conversation.id} className="px-5 py-3">
              <button
                type="button"
                className="flex w-full items-center gap-3 text-left"
                onClick={() => void open(conversation.id)}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-medium">{conversation.visitor}</p>
                  <p className="truncate text-xs text-[--color-muted]">
                    {conversation.origin ?? 'unknown site'} · {conversation.messageCount} message
                    {conversation.messageCount === 1 ? '' : 's'} ·{' '}
                    {new Date(conversation.lastActivityAt).toLocaleString()}
                  </p>
                </div>
                <span className="ml-auto shrink-0 text-xs text-[--color-muted]">
                  {conversation.status.replace('_', ' ')}
                </span>
              </button>

              {openId === conversation.id ? (
                <div className="mt-3 space-y-3">
                  <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg bg-gray-50 p-3">
                    {transcript.map((message) => (
                      <div key={message.id}>
                        <p className="text-[11px] font-medium text-[--color-muted]">
                          {label(message.role)}
                        </p>
                        {/*
                          React escapes this. The transcript contains text a
                          stranger typed and text a model wrote about documents
                          we did not author, so it is rendered as text and never
                          as markup — the same rule the widget follows.
                        */}
                        <p className="whitespace-pre-wrap break-words text-xs">
                          {message.content}
                        </p>
                        {message.citations?.length ? (
                          <p className="mt-0.5 text-[11px] text-[--color-muted]">
                            Based on: {message.citations.map((c) => c.documentTitle).join(', ')}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  <form onSubmit={(event) => void reply(event, conversation.id)} className="flex gap-2">
                    <input
                      name="message"
                      placeholder="Reply as a person"
                      className="h-9 flex-1 rounded-lg border border-[--color-line] bg-white px-3 text-sm outline-none focus:border-[--color-accent]"
                    />
                    <Button type="submit" disabled={busy}>
                      Send
                    </Button>
                  </form>
                  <p className="text-[11px] text-[--color-muted]">
                    Your reply is labelled as coming from a person, so the transcript never blurs
                    which sentences you wrote and which the assistant did.
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );

  if (!title) {
    return (
      <div>
        <div className="px-5 pt-3">
          <ErrorNote message={error} />
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card className={urgent && conversations.length > 0 ? 'border-amber-300' : ''}>
      <CardHeader
        title={title}
        description="A visitor asked to speak to someone. Nothing has been sent to them yet."
      />
      <div className="px-5 pt-3">
        <ErrorNote message={error} />
      </div>
      {body}
    </Card>
  );
}

function label(role: string): string {
  if (role === 'visitor') return 'Visitor';
  if (role === 'assistant') return 'Assistant';
  if (role === 'human') return 'You (a person)';
  return 'System';
}
