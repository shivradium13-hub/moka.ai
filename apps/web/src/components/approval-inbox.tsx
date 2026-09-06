'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote } from '@/components/ui';

interface Approval {
  id: string;
  runId: string | null;
  toolName: string;
  summary: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * The human approval gate (master prompt §21).
 *
 * The card shows what will happen in plain language, and the two buttons are
 * deliberately asymmetric: Approve is the destructive-consequence action, so
 * it does not get the comfortable default styling. Nothing runs until someone
 * presses it, and the API independently re-checks that the person pressing it
 * holds the permission the action requires.
 */
export function ApprovalInbox({ approvals }: { approvals: Approval[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setError(null);
    setBusy(id);
    try {
      await browserApi(`/v1/agents/approvals/${id}`, { method: 'POST', body: { decision } });
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The decision could not be recorded.',
      );
    } finally {
      setBusy(null);
    }
  }

  if (approvals.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Approvals"
          description="Consequential actions pause here until a person authorises them."
        />
        <p className="px-5 py-4 text-xs text-[--color-muted]">Nothing is waiting for approval.</p>
      </Card>
    );
  }

  return (
    <Card className="border-amber-300">
      <CardHeader
        title={`${approvals.length} action${approvals.length === 1 ? '' : 's'} awaiting your approval`}
        description="An agent has paused. Nothing has run yet."
      />
      <div className="px-5 pt-3">
        <ErrorNote message={error} />
      </div>

      <ul className="divide-y divide-[--color-line]">
        {approvals.map((approval) => {
          const expired = new Date(approval.expiresAt).getTime() < Date.now();

          return (
            <li key={approval.id} className="px-5 py-4">
              <p className="text-sm font-medium">{approval.summary}</p>
              <p className="mt-0.5 font-mono text-[11px] text-[--color-muted]">
                {approval.toolName} · requested {new Date(approval.createdAt).toLocaleString()}
              </p>

              {expired ? (
                <p className="mt-2 text-xs text-[--color-muted]">
                  This request has expired and can no longer be approved. A pending approval is a
                  held privilege, so it does not last indefinitely.
                </p>
              ) : (
                <div className="mt-3 flex gap-2">
                  {/* Reject is the safe default and gets the primary affordance. */}
                  <Button
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void decide(approval.id, 'rejected')}
                  >
                    {busy === approval.id ? 'Working…' : 'Reject'}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => void decide(approval.id, 'approved')}
                  >
                    Approve this action
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
