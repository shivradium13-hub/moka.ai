import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckIcon, MinusIcon } from '@/components/marketing/icons';
import {
  Eyebrow,
  PageHero,
  PrimaryCta,
  Section,
  SectionHeading,
} from '@/components/marketing/primitives';

export const metadata: Metadata = {
  title: 'Pricing — free to evaluate, $49 a month for a team',
  description:
    'Three plans: Free to evaluate on real data, Team at $49 per month, and Enterprise on negotiated limits. Bring your own provider keys on every plan.',
};

/**
 * PRICING SHOWN HERE MIRRORS THE SEED CATALOGUE, IT DOES NOT DRIVE IT.
 *
 * `packages/billing/src/plans.ts` is seed data; once seeded, the `plans` and
 * `plan_entitlements` tables are authoritative and an operator changes limits
 * with an UPDATE. Nothing on this page is consulted by any enforcement path.
 *
 * It is duplicated rather than fetched because `GET /v1/billing/plans`
 * requires ORG_READ — it answers "what could this organization upgrade to",
 * which is a different question from "what do we sell", and opening it to
 * anonymous callers to save a copy here would be the wrong trade. The cost of
 * that choice is real: CHANGE THIS PAGE WHEN THE CATALOGUE CHANGES.
 */

interface Plan {
  key: string;
  name: string;
  price: string;
  cadence: string;
  description: string;
  cta: { label: string; href: string };
  featured: boolean;
  highlights: string[];
}

const PLANS: Plan[] = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    description: 'Enough to evaluate the product on real data — your documents, your provider key.',
    cta: { label: 'Start free', href: '/signup' },
    featured: false,
    highlights: [
      '$2 of AI usage included',
      '2 seats, 3 projects',
      '2 agents · 50 runs a month',
      '3 knowledge sources · 100 MB',
      '1 chatbot · 200 messages a month',
      'Efficient models only',
    ],
  },
  {
    key: 'team',
    name: 'Team',
    price: '$49',
    cadence: 'per month',
    description: 'For a working team, with room to run agents in earnest rather than in a demo.',
    cta: { label: 'Start free, upgrade later', href: '/signup' },
    featured: true,
    highlights: [
      '$50 of AI usage included',
      '20 seats, 50 projects',
      '25 agents · 2,000 runs a month',
      '50 knowledge sources · 10 GB',
      '10 chatbots · 20,000 messages a month',
      'Every model in the registry',
    ],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    cadence: 'negotiated',
    description:
      'Unlimited unless a contract says otherwise, expressed as per-organization overrides.',
    cta: { label: 'Talk to us', href: '/signup' },
    featured: false,
    highlights: [
      'Usage and seats by agreement',
      'Unlimited projects and agents',
      'Unlimited knowledge storage',
      'Unlimited chatbot deployments',
      'Per-organization entitlement overrides',
      'Every model in the registry',
    ],
  },
];

/** `true` renders a check, `false` a dash, a string renders verbatim. */
const COMPARISON: Array<{
  group: string;
  rows: Array<[string, string | boolean, string | boolean, string | boolean]>;
}> = [
  {
    group: 'Workspace',
    rows: [
      ['Seats', '2', '20', 'Negotiated'],
      ['Projects', '3', '50', 'Unlimited'],
      ['Role-based access control', true, true, true],
      ['Audit trail', true, true, true],
    ],
  },
  {
    group: 'Knowledge',
    rows: [
      ['Knowledge sources', '3', '50', 'Unlimited'],
      ['Storage', '100 MB', '10 GB', 'Unlimited'],
      ['Fused lexical retrieval', true, true, true],
    ],
  },
  {
    group: 'Agents and research',
    rows: [
      ['Agents', '2', '25', 'Unlimited'],
      ['Agent runs a month', '50', '2,000', 'Unlimited'],
      ['Research runs a month', '20', '1,000', 'Unlimited'],
      ['Human approval gates', true, true, true],
    ],
  },
  {
    group: 'Chatbots',
    rows: [
      ['Chatbots', '1', '10', 'Unlimited'],
      ['Deployments', '1', '25', 'Unlimited'],
      ['Messages a month', '200', '20,000', 'Unlimited'],
    ],
  },
  {
    group: 'AI and API',
    rows: [
      ['Included AI usage', '$2', '$50', 'Negotiated'],
      ['Model access', 'Efficient models', 'All models', 'All models'],
      ['Bring your own provider keys', true, true, true],
      ['API requests a month', '1,000', '250,000', 'Unlimited'],
    ],
  },
];

const FAQ = [
  {
    q: 'What counts against the included AI usage?',
    a: 'Every model call the workspace makes, priced from the model registry and recorded in integer micro-dollars. Failed calls are recorded too, because a failed call still consumed provider quota. Where a price is not yet known it is stored as unknown rather than as zero, and backfilled once it is — token counts stay authoritative.',
  },
  {
    q: 'Can I use my own provider keys?',
    a: 'Yes, on every plan including Free. Keys are sealed per organization with envelope encryption and decrypted only inside the request that uses them. Usage on your own key is still metered so you keep one ledger, but your commercial relationship with the provider stays yours.',
  },
  {
    q: 'What happens when I reach a limit?',
    a: 'The action that would exceed the entitlement is refused and says which limit it hit. Nothing is silently truncated and no overage is billed without you choosing it — a surprise invoice is a worse outcome than a blocked request you can see and act on.',
  },
  {
    q: 'Are these numbers final?',
    a: 'They are a plausible starting shape, and we would rather say so. Limits live in the database, not in the code, so an operator changes what a plan includes without a deploy — which is also how an enterprise contract is expressed, as overrides on a real plan rather than a private plan nobody can reason about.',
  },
  {
    q: 'What is not working yet?',
    a: 'Semantic (vector) search needs the pgvector extension; where it is not installed, retrieval is lexical and the interface says so rather than implying more. There is also no bundled web-search provider — explicit URLs always work, and keyword search needs a self-hosted SearXNG instance you point us at.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes, and your data stays exportable. Provider keys are yours, documents are yours, and the usage ledger is a record you can read rather than a number we assert.',
  },
];

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Priced so you can evaluate it before you talk to anyone."
        description="Start free with your own documents and your own provider key. Upgrade when your agents are doing real work — not when a trial timer runs out."
      />

      <Section className="border-b border-line bg-chalk">
        <div className="grid gap-6 lg:grid-cols-3">
          {PLANS.map((plan) => (
            <PlanCard key={plan.key} plan={plan} />
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted">
          Prices in USD. Included AI usage is spend on model calls, metered per call and visible in
          your workspace.
        </p>
      </Section>

      <Section className="border-b border-line">
        <SectionHeading
          eyebrow="Compare"
          title="Every limit, side by side."
          description="Entitlements are rows in a table, not constants in our source. What a plan includes can change without a deploy."
        />
        <ComparisonTable />
      </Section>

      <Section id="faq" className="border-b border-line bg-chalk">
        <SectionHeading eyebrow="FAQ" title="The questions worth answering before you sign up." />
        <dl className="mt-12 grid gap-6 md:grid-cols-2">
          {FAQ.map((item) => (
            <div key={item.q} className="rounded-2xl border border-line bg-white p-6">
              <dt className="text-base font-semibold tracking-tight">{item.q}</dt>
              <dd className="mt-2.5 text-sm leading-relaxed text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section className="bg-night">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
            Start on the free plan today.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-night-muted">
            No card, no sales call, and no trial clock counting down while you wait for a document
            to be approved for upload.
          </p>
          <div className="mt-8 flex justify-center">
            <PrimaryCta href="/signup">Create your workspace</PrimaryCta>
          </div>
        </div>
      </Section>
    </>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-7 ${
        plan.featured
          ? 'border-accent bg-white shadow-lg shadow-accent/10 ring-1 ring-accent'
          : 'border-line bg-white'
      }`}
    >
      {plan.featured ? (
        <span className="absolute -top-3 left-7 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold tracking-wide text-white uppercase">
          Most teams start here
        </span>
      ) : null}

      <h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight">{plan.price}</span>
        <span className="text-sm text-muted">{plan.cadence}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">{plan.description}</p>

      <Link
        href={plan.cta.href}
        className={`mt-6 inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold transition ${
          plan.featured
            ? 'bg-accent text-white hover:opacity-90'
            : 'border border-line text-ink hover:border-ink/25 hover:bg-chalk'
        }`}
      >
        {plan.cta.label}
      </Link>

      <ul className="mt-7 space-y-3 border-t border-line pt-6">
        {plan.highlights.map((item) => (
          <li key={item} className="flex gap-3 text-sm text-ink">
            <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cell({ value }: { value: string | boolean }) {
  if (value === true) {
    return (
      <>
        <CheckIcon className="mx-auto h-4 w-4 text-accent" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <MinusIcon className="mx-auto h-4 w-4 text-line" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <span className="text-ink">{value}</span>;
}

function ComparisonTable() {
  return (
    <>
      {/*
       * The table is wider than a phone and scrolls inside its own box rather
       * than pushing the page sideways. Nothing about a clipped column says
       * "this scrolls", so the hint is shown where the clipping happens.
       */}
      <p className="mt-12 text-xs text-muted lg:hidden" aria-hidden="true">
        Scroll the table sideways to compare plans →
      </p>
      <div className="mt-3 overflow-x-auto rounded-2xl border border-line lg:mt-12">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Plan limits compared across Free, Team and Enterprise
          </caption>
          <thead>
            <tr className="bg-chalk">
              <th
                scope="col"
                className="px-5 py-4 text-left text-xs font-semibold tracking-[0.12em] text-muted uppercase"
              >
                Feature
              </th>
              {PLANS.map((plan) => (
                <th
                  key={plan.key}
                  scope="col"
                  className="px-5 py-4 text-center text-sm font-semibold tracking-tight"
                >
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          {COMPARISON.map((section) => (
            <tbody key={section.group}>
              <tr>
                <th
                  scope="colgroup"
                  colSpan={4}
                  className="border-t border-line bg-white px-5 pt-6 pb-2 text-left"
                >
                  <Eyebrow>{section.group}</Eyebrow>
                </th>
              </tr>
              {section.rows.map((row) => (
                <tr key={row[0]} className="border-t border-line">
                  <th scope="row" className="px-5 py-3.5 text-left font-medium text-ink">
                    {row[0]}
                  </th>
                  <td className="px-5 py-3.5 text-center text-muted">
                    <Cell value={row[1]} />
                  </td>
                  <td className="bg-accent-soft/40 px-5 py-3.5 text-center text-muted">
                    <Cell value={row[2]} />
                  </td>
                  <td className="px-5 py-3.5 text-center text-muted">
                    <Cell value={row[3]} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
