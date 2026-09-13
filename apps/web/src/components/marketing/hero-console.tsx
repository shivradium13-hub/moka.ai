/**
 * The hero's product still.
 *
 * Drawn in markup rather than shipped as a screenshot: a PNG of a UI goes
 * stale the week after it is taken, weighs more than this does, and cannot be
 * read by anyone using a screen reader. This renders crisply at any zoom and
 * costs no extra request.
 *
 * What it shows is the actual shape of an agent run — four authorization
 * gates, then a pause for a human on the one consequential step — because
 * that sequence is the product's argument, not decoration.
 */

const TRACE = [
  {
    tool: 'knowledge.search',
    detail: 'query: "refund window for annual plans"',
    verdict: 'allowed',
    note: '4 gates passed',
  },
  {
    tool: 'research.fetch',
    detail: 'https://docs.internal/billing/refunds',
    verdict: 'allowed',
    note: 'robots.txt: permitted',
  },
  {
    tool: 'crm.update_account',
    detail: 'account: ACME-4471 · risk: high',
    verdict: 'held',
    note: 'awaiting approval',
  },
] as const;

function Dot({ tone }: { tone: 'allowed' | 'held' }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
        tone === 'allowed' ? 'bg-emerald-400' : 'bg-amber-400'
      }`}
    />
  );
}

export function HeroConsole() {
  return (
    // `min-w-0` because this sits in a grid column: without it the panel's
    // min-content width (the longest monospace line) would widen the column
    // and push the hero copy past the viewport on a narrow screen.
    <div className="animate-rise min-w-0 rounded-2xl border border-night-line bg-night shadow-2xl shadow-ink/20 [animation-delay:220ms]">
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-night-line px-4 py-3">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <p className="ml-2 min-w-0 truncate font-mono text-[11px] text-night-muted">
          agents / support-triage / run_8f21c4
        </p>
        <span className="ml-auto shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          Paused for approval
        </span>
      </div>

      <div className="space-y-4 p-5">
        {/* The run trace */}
        <ol className="space-y-2.5">
          {TRACE.map((step) => (
            <li
              key={step.tool}
              className={`flex gap-3 rounded-xl border px-3.5 py-3 ${
                step.verdict === 'held'
                  ? 'border-amber-400/25 bg-amber-400/[0.06]'
                  : 'border-night-line bg-white/[0.03]'
              }`}
            >
              <Dot tone={step.verdict} />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] text-white">{step.tool}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-night-muted">
                  {step.detail}
                </p>
              </div>
              <span
                className={`shrink-0 self-center text-[10px] font-medium ${
                  step.verdict === 'held' ? 'text-amber-300' : 'text-emerald-300'
                }`}
              >
                {step.note}
              </span>
            </li>
          ))}
        </ol>

        {/* The approval the run is waiting on */}
        <div className="rounded-xl border border-night-line bg-night-soft p-4">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-night-muted uppercase">
            Human approval required
          </p>
          <p className="mt-2 text-sm leading-relaxed text-white">
            Set <span className="font-mono text-violet">ACME-4471</span> to{' '}
            <span className="font-mono text-violet">churn_risk</span> and open a retention task.
          </p>
          <div className="mt-3.5 flex items-center gap-2">
            <span className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-xs font-semibold text-ink">
              Approve once
            </span>
            <span className="inline-flex h-8 items-center rounded-lg border border-night-line px-3 text-xs font-semibold text-night-muted">
              Reject
            </span>
            <span className="ml-auto font-mono text-[10px] text-night-muted">
              scope: 1 execution
            </span>
          </div>
        </div>

        {/* Grounded answer with real citations */}
        <div className="rounded-xl border border-night-line bg-white/[0.03] p-4">
          <p className="text-sm leading-relaxed text-night-muted">
            Annual plans are refundable within 30 days of renewal{' '}
            <span className="rounded bg-violet/20 px-1 font-mono text-[11px] text-violet">[1]</span>
            , pro-rated after that{' '}
            <span className="rounded bg-violet/20 px-1 font-mono text-[11px] text-violet">[2]</span>
            .
          </p>
          <div className="mt-3 space-y-1.5 border-t border-night-line pt-3">
            <p className="font-mono text-[11px] text-night-muted">
              <span className="text-violet">[1]</span> Refund Policy &gt; Eligibility · retrieved
              14:02 UTC
            </p>
            <p className="font-mono text-[11px] text-night-muted">
              <span className="text-violet">[2]</span> Billing FAQ &gt; Annual terms · retrieved
              14:02 UTC
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
