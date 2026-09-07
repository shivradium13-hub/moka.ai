import { serverApiOrNull } from '@/lib/api-server';
import { Card, CardHeader, EmptyState } from '@/components/ui';
import { PlanPanel } from '@/components/plan-panel';

interface BillingSummary {
  plan: {
    key: string;
    name: string;
    status: string;
    priceMonthlyCents: number | null;
    currentPeriodEnd: string;
  } | null;
  features: Array<{
    feature: string;
    label: string;
    unit: string;
    limit: number | null;
    current: number;
    included: boolean;
    allowedValues: string[] | null;
  }>;
  credit: {
    balanceMicroUsd: number | null;
    display: string;
    unpricedCallsThisPeriod: number;
  };
}

interface UsageSummary {
  period: { start: string; key: string };
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    knownCostMicroUsd: number;
    knownCostDisplay: string;
    unpricedCalls: number;
    failedCalls: number;
  };
  byModel: Array<{
    modelId: string;
    providerId: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    knownCostDisplay: string;
    unpricedCalls: number;
  }>;
  byDay: Array<{ day: string; calls: number; knownCostMicroUsd: number }>;
}

export default async function UsagePage() {
  const [billing, usage] = await Promise.all([
    serverApiOrNull<BillingSummary>('/v1/billing'),
    serverApiOrNull<UsageSummary>('/v1/billing/usage'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Usage and plan</h1>
        <p className="mt-1 text-xs text-[--color-muted]">
          Every limit here comes from your plan, not from the code. Usage is counted when it is
          checked, so these numbers are current rather than cached.
        </p>
      </div>

      <PlanPanel billing={billing} />

      {usage ? <UsagePanel usage={usage} /> : null}
    </div>
  );
}

function UsagePanel({ usage }: { usage: UsageSummary }) {
  const { totals } = usage;

  return (
    <>
      <Card>
        <CardHeader
          title="AI usage this period"
          description={`Since ${new Date(usage.period.start).toLocaleDateString()}`}
        />
        <div className="grid grid-cols-2 gap-px bg-[--color-line] sm:grid-cols-4">
          <Stat label="Calls" value={totals.calls.toLocaleString()} />
          <Stat label="Input tokens" value={totals.inputTokens.toLocaleString()} />
          <Stat label="Output tokens" value={totals.outputTokens.toLocaleString()} />
          <Stat label="Cost" value={totals.knownCostDisplay} />
        </div>

        {/*
          Reported beside the total, never folded into it. "$4.20 across 300
          calls, 12 of which could not be priced" is honest; "$4.20" alone is a
          number somebody will budget against.
        */}
        {totals.unpricedCalls > 0 ? (
          <div className="border-t border-[--color-line] bg-amber-50 px-5 py-3 text-xs text-amber-900">
            <p className="font-medium">
              {totals.unpricedCalls} call{totals.unpricedCalls === 1 ? '' : 's'} could not be priced.
            </p>
            <p className="mt-0.5">
              The cost above excludes them, so it understates the real spend. Pricing for those
              models is not configured in this build — a gap on our side, not a free tier.
            </p>
          </div>
        ) : null}

        {totals.failedCalls > 0 ? (
          <div className="border-t border-[--color-line] px-5 py-2.5 text-xs text-[--color-muted]">
            {totals.failedCalls} call{totals.failedCalls === 1 ? '' : 's'} failed. A failed call
            still consumed provider quota and latency, so it is counted here.
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="By model" />
        {usage.byModel.length === 0 ? (
          <EmptyState title="No usage yet" description="Model calls appear here once made." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-[--color-line] text-left text-[--color-muted]">
                <tr>
                  <th className="px-5 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium">Calls</th>
                  <th className="px-3 py-2 font-medium">In</th>
                  <th className="px-3 py-2 font-medium">Out</th>
                  <th className="px-5 py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[--color-line]">
                {usage.byModel.map((row) => (
                  <tr key={`${row.providerId}:${row.modelId}`}>
                    <td className="px-5 py-2 font-mono">{row.modelId}</td>
                    <td className="px-3 py-2">{row.calls.toLocaleString()}</td>
                    <td className="px-3 py-2">{row.inputTokens.toLocaleString()}</td>
                    <td className="px-3 py-2">{row.outputTokens.toLocaleString()}</td>
                    <td className="px-5 py-2 text-right">
                      {row.unpricedCalls > 0 && row.calls === row.unpricedCalls ? (
                        <span className="text-[--color-muted]">not priced</span>
                      ) : (
                        row.knownCostDisplay
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-5 py-4">
      <p className="text-xs text-[--color-muted]">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tracking-tight">{value}</p>
    </div>
  );
}
