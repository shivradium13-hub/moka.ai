'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, EmptyState, ErrorNote } from '@/components/ui';

interface Feature {
  feature: string;
  label: string;
  unit: string;
  limit: number | null;
  current: number;
  included: boolean;
  allowedValues: string[] | null;
}

interface BillingSummary {
  plan: {
    key: string;
    name: string;
    status: string;
    priceMonthlyCents: number | null;
    currentPeriodEnd: string;
  } | null;
  features: Feature[];
  credit: {
    balanceMicroUsd: number | null;
    display: string;
    unpricedCallsThisPeriod: number;
  };
}

/**
 * Plan and entitlements.
 *
 * Renders THREE distinct states per feature, because the underlying model has
 * three and collapsing any two of them misinforms:
 *
 *   a number → "3 of 10"
 *   null     → "Unlimited"
 *   excluded → "Not on this plan"
 *
 * A UI that showed "0 of 0" for an excluded feature would tell a customer they
 * had used something up when they never had it, and the support ticket that
 * follows is about the wrong thing.
 */
export function PlanPanel({ billing }: { billing: BillingSummary | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!billing) {
    return (
      <Card>
        <CardHeader title="Plan" />
        <EmptyState
          title="Plan unavailable"
          description="Could not read the plan for this organization."
        />
      </Card>
    );
  }

  if (!billing.plan) {
    return (
      <Card className="border-amber-300">
        <CardHeader
          title="No subscription"
          description="This organization has no plan, so nothing new can be created."
        />
        <div className="px-5 py-4 text-xs text-[--color-muted]">
          Existing data is unaffected. An administrator can set a plan, or the catalogue may not
          have been seeded on this deployment.
        </div>
      </Card>
    );
  }

  async function grantAllowance() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await browserApi<{ granted: boolean; message: string }>(
        '/v1/billing/credit/period-allowance',
        { method: 'POST' },
      );
      setNotice(result.message);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue the allowance.');
    } finally {
      setBusy(false);
    }
  }

  const plan = billing.plan;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={`${plan.name} plan`}
          description={
            plan.priceMonthlyCents === null
              ? 'Negotiated pricing.'
              : plan.priceMonthlyCents === 0
                ? 'Free.'
                : `$${(plan.priceMonthlyCents / 100).toFixed(2)} per month.`
          }
        />

        <div className="space-y-3 px-5 py-4">
          <ErrorNote message={error} />
          {notice ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{notice}</p>
          ) : null}

          <div className="flex items-center gap-3">
            <div>
              <p className="text-xs text-[--color-muted]">AI credit remaining</p>
              <p
                className={`text-lg font-semibold tracking-tight ${
                  (billing.credit.balanceMicroUsd ?? 0) <= 0 ? 'text-[--color-danger]' : ''
                }`}
              >
                {billing.credit.display}
              </p>
            </div>
            <div className="ml-auto">
              <Button variant="secondary" disabled={busy} onClick={() => void grantAllowance()}>
                {busy ? 'Working…' : 'Issue this period’s allowance'}
              </Button>
            </div>
          </div>

          {/*
            Said plainly rather than hidden behind a tooltip. An operator who
            believes allowances renew automatically will find out from an
            outage, not from a doc.
          */}
          <p className="text-xs text-[--color-muted]">
            Allowances are issued on demand, not on a schedule — there is no job queue on this
            deployment. Issuing twice in one period does nothing.
          </p>

          {billing.credit.unpricedCallsThisPeriod > 0 ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {billing.credit.unpricedCallsThisPeriod} call
              {billing.credit.unpricedCallsThisPeriod === 1 ? '' : 's'} this period could not be
              priced and were not charged. Your usage figure understates the real spend.
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="What your plan includes"
          description="Counted now, not cached. These are the numbers enforcement actually uses."
        />
        <ul className="divide-y divide-[--color-line]">
          {billing.features.map((feature) => (
            <li key={feature.feature} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">{feature.label}</p>
                {feature.allowedValues ? (
                  <p className="truncate font-mono text-[11px] text-[--color-muted]">
                    {feature.allowedValues.join(', ')}
                  </p>
                ) : null}
              </div>
              <div className="ml-auto shrink-0 text-xs">
                <FeatureValue feature={feature} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function FeatureValue({ feature }: { feature: Feature }) {
  if (!feature.included) {
    return <span className="text-[--color-muted]">Not on this plan</span>;
  }
  if (feature.allowedValues) {
    return <span className="text-[--color-muted]">restricted</span>;
  }
  if (feature.limit === null) {
    return <span className="text-[--color-muted]">Unlimited</span>;
  }

  const atLimit = feature.current >= feature.limit;
  const display =
    feature.unit === 'bytes'
      ? `${formatBytes(feature.current)} of ${formatBytes(feature.limit)}`
      : feature.unit === 'micro_usd'
        ? `$${(feature.limit / 1_000_000).toFixed(2)} per period`
        : `${feature.current.toLocaleString()} of ${feature.limit.toLocaleString()}`;

  return <span className={atLimit ? 'font-medium text-[--color-danger]' : ''}>{display}</span>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
