import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { serverApiOrNull } from '@/lib/api-server';
import { HeroConsole } from '@/components/marketing/hero-console';
import {
  AgentIcon,
  ChatIcon,
  KeyIcon,
  KnowledgeIcon,
  LedgerIcon,
  ResearchIcon,
  RouteIcon,
  UsersIcon,
} from '@/components/marketing/icons';
import {
  Container,
  CtaPair,
  DarkPoint,
  Eyebrow,
  FeatureCard,
  PrimaryCta,
  SecondaryCta,
  Section,
  SectionHeading,
} from '@/components/marketing/primitives';

export const metadata: Metadata = {
  // Absolute: the home page's title already carries the brand, so the root
  // layout's `%s · MOKA AI` template would only repeat it.
  title: { absolute: 'MOKA AI — the AI workspace your compliance team can sign off on' },
  description:
    'Documents, agents, research and customer chatbots in one multi-tenant workspace. Every model call metered, every citation traced to a page actually fetched, every consequential action approved by a human.',
};

interface MeResponse {
  user: { id: string };
  activeOrganizationId: string | null;
}

/**
 * Entry point.
 *
 * A signed-in visitor still goes straight to their dashboard, decided from the
 * SERVER's view of the session so the application shell never flashes for
 * someone who is not authenticated. Everyone else gets the public site.
 *
 * The session probe is wrapped because the marketing page must not depend on
 * the API being reachable: the home page is the one page that most needs to
 * stay up when the backend is down. `redirect` throws, so it is called outside
 * the catch rather than being swallowed by it.
 */
export default async function Home() {
  let me: MeResponse | null = null;
  try {
    me = await serverApiOrNull<MeResponse>('/v1/auth/me');
  } catch {
    me = null;
  }
  if (me) redirect('/dashboard');

  return (
    <>
      <Hero />
      <Surfaces />
      <Pipeline />
      <AgentGates />
      <Citations />
      <Gateway />
      <SecurityBand />
      <ClosingCta />
    </>
  );
}

function Hero() {
  return (
    <div className="relative overflow-hidden border-b border-line">
      <div className="grid-backdrop absolute inset-0" aria-hidden="true" />
      <Container className="relative py-16 sm:py-24">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
          <div className="animate-rise">
            <Link
              href="/product#agents"
              className="inline-flex items-center gap-2 rounded-full border border-line bg-white py-1 pr-3 pl-1 text-xs font-medium text-muted transition hover:border-ink/20 hover:text-ink"
            >
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">
                New
              </span>
              Agent runtime with human approval gates
            </Link>

            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem] lg:leading-[1.05]">
              The AI workspace your <span className="gradient-text">compliance team</span> can sign
              off on.
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-relaxed text-pretty text-muted">
              MOKA AI puts your documents, your agents and your models in one place — then keeps a
              record of every retrieval, every model call and every action, so an answer can be
              checked six months after it was given.
            </p>

            <CtaPair className="mt-8" />

            <p className="mt-5 text-sm text-muted">
              Free plan, no card. Bring your own provider keys, and take them with you.
            </p>
          </div>

          <HeroConsole />
        </div>
      </Container>
    </div>
  );
}

const SURFACES = [
  {
    icon: <KnowledgeIcon />,
    title: 'Knowledge engine',
    body: 'Upload a document and it is parsed, chunked and searchable in the same request. Each chunk carries its heading breadcrumb inside its text, so a retrieved fragment still makes sense on its own.',
  },
  {
    icon: <AgentIcon />,
    title: 'Agents',
    body: 'Typed tools, per-agent allowlists, risk ceilings and a human approval step for anything consequential. An agent is a constraint on what a user can already do — never a new grant.',
  },
  {
    icon: <ResearchIcon />,
    title: 'Research',
    body: 'The model never writes a URL. It writes a number. Every link a reader sees comes from a ledger of pages actually fetched, recorded with the final URL, the time and a hash of the response.',
  },
  {
    icon: <ChatIcon />,
    title: 'Customer chatbots',
    body: 'Ground a public chatbot in your own documents, pin it to specific origins, and keep every conversation in the same workspace your team already works in.',
  },
];

function Surfaces() {
  return (
    <Section className="border-b border-line bg-chalk">
      <SectionHeading
        eyebrow="One workspace"
        title="Four surfaces, one set of documents and one bill."
        description="Most teams end up with a chatbot in one tool, a knowledge base in another and an agent script nobody owns. MOKA AI is the workspace those three should have been."
      />
      <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {SURFACES.map((surface) => (
          <FeatureCard
            key={surface.title}
            icon={surface.icon}
            title={surface.title}
            href="/product"
          >
            {surface.body}
          </FeatureCard>
        ))}
      </div>
    </Section>
  );
}

const STEPS = [
  {
    step: '01',
    title: 'Retrieve',
    body: 'Full-text and trigram search are fused with Reciprocal Rank Fusion, so a typo still finds the paragraph and two incomparable score scales never have to be normalised against each other.',
  },
  {
    step: '02',
    title: 'Route',
    body: 'The router picks a model from the capabilities a request actually needs, then plans fallbacks. Only transient failures walk the plan — retrying a malformed request elsewhere buys the same error twice.',
  },
  {
    step: '03',
    title: 'Act',
    body: 'Every tool call passes four gates before it runs, and anything consequential stops for a person. That approval authorises exactly one execution, not a standing permission.',
  },
  {
    step: '04',
    title: 'Account',
    body: 'Every call writes a usage record — failures included, because a failed call still consumed provider quota. Cost is stored in integer micro-dollars, and unknown is stored as unknown, never as free.',
  },
];

function Pipeline() {
  return (
    <Section className="border-b border-line">
      <SectionHeading
        eyebrow="How it works"
        title="What happens between the question and the answer."
        description="Four stages, each one observable. If you cannot explain why the model said what it said, you cannot defend it to a customer."
      />
      <ol className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((item) => (
          <li key={item.step} className="bg-white p-6">
            <span className="font-mono text-xs font-semibold text-accent">{item.step}</span>
            <h3 className="mt-3 text-base font-semibold tracking-tight">{item.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

const GATES = [
  {
    label: 'The tool exists',
    body: 'Resolved from a typed registry, not from a name the model produced.',
  },
  {
    label: 'It is on this agent’s allowlist',
    body: 'Configured by an administrator, and unreachable from any prompt.',
  },
  {
    label: 'Its risk is within the ceiling',
    body: 'Each tool carries a risk level; each agent carries a maximum it may reach.',
  },
  {
    label: 'The invoking user holds the permission',
    body: 'The gate that stops an agent from becoming a privilege-escalation path.',
  },
];

function AgentGates() {
  return (
    <div className="relative overflow-hidden bg-night">
      <div className="grid-backdrop-dark absolute inset-0" aria-hidden="true" />
      <Container className="relative py-20 sm:py-28">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-start">
          <div>
            <SectionHeading
              tone="dark"
              eyebrow="Agents"
              title="We assume the prompt injection worked."
              description="Injection cannot be solved at the prompt layer — delimiters can be imitated and instructions argued with. So the test suite assumes the attack succeeded: a scripted model reads a poisoned document and does exactly what it says."
            />
            <p className="mt-5 max-w-xl text-base leading-relaxed text-night-muted">
              Nothing is deleted. Authorization depends on the caller&rsquo;s role and the
              agent&rsquo;s allowlist, and neither is reachable from any prompt. Consequential
              actions then pause for a human, and that approval authorises exactly one execution.
            </p>
            <SecondaryCta href="/security" className="mt-8">
              Read the security model
            </SecondaryCta>
          </div>

          <div>
            <Eyebrow tone="dark">Four gates, every call</Eyebrow>
            <ol className="mt-5 space-y-3">
              {GATES.map((gate, index) => (
                <li
                  key={gate.label}
                  className="flex gap-4 rounded-2xl border border-night-line bg-night-soft p-5"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet/15 font-mono text-xs font-semibold text-violet">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">{gate.label}</p>
                    <p className="mt-1 text-sm leading-relaxed text-night-muted">{gate.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Container>
    </div>
  );
}

function Citations() {
  return (
    <Section className="border-b border-line bg-chalk">
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center">
        <div>
          <SectionHeading
            eyebrow="Research"
            title="A citation is a lookup, not a generation."
            description="Ask a model to cite its sources and it will produce a bibliography: plausible titles, plausible authors, URLs that resolve to nothing. It is not lying — it is completing a pattern."
          />
          <p className="mt-5 text-base leading-relaxed text-muted">
            A fabricated citation is worse than none, because it turns an unsupported claim into an
            apparently sourced one, which is the form people stop checking. So the model never gets
            the chance: it writes a reference number, and the link comes from a ledger of what was
            actually retrieved.
          </p>
          <ul className="mt-6 space-y-3 text-sm leading-relaxed text-muted">
            <li className="flex gap-3">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden="true"
              />
              A reference naming no real source is removed — and you are told it was.
            </li>
            <li className="flex gap-3">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden="true"
              />
              A quotation absent from the page it cites is flagged, not quietly tidied away.
            </li>
            <li className="flex gap-3">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                aria-hidden="true"
              />
              When nothing could be fetched, the model is not called at all.
            </li>
          </ul>
        </div>

        <div className="grid gap-4">
          <div className="rounded-2xl border border-danger/25 bg-white p-6">
            <p className="text-xs font-semibold tracking-[0.12em] text-danger uppercase">
              When the model writes the URL
            </p>
            <p className="mt-3 font-mono text-[13px] leading-relaxed text-muted">
              <span className="line-through decoration-danger/60">
                Henderson &amp; Roy (2021), acme.com/research/refund-elasticity
              </span>
            </p>
            <p className="mt-3 text-sm text-danger">404 — the paper does not exist.</p>
          </div>

          <div className="rounded-2xl border border-emerald-600/25 bg-white p-6">
            <p className="text-xs font-semibold tracking-[0.12em] text-emerald-700 uppercase">
              When the model writes a reference
            </p>
            <p className="mt-3 font-mono text-[13px] leading-relaxed text-ink">
              Annual plans are refundable within 30 days{' '}
              <span className="rounded bg-accent-soft px-1 text-accent">[2]</span>
            </p>
            <p className="mt-3 font-mono text-[12px] leading-relaxed text-muted">
              [2] docs.internal/billing/refunds
              <br />
              final URL after redirects · fetched 14:02 UTC · sha256 4f2a…9c1
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}

const GATEWAY = [
  {
    icon: <RouteIcon />,
    title: 'Provider-agnostic routing',
    body: 'Describe the capabilities a task needs and let the router choose the model. Swapping providers becomes a configuration change rather than a rewrite.',
  },
  {
    icon: <KeyIcon />,
    title: 'Bring your own keys',
    body: 'Provider credentials are sealed per organization with envelope encryption, and decrypted only inside the request that uses them.',
  },
  {
    icon: <LedgerIcon />,
    title: 'Usage you can reconcile',
    body: 'Token counts stay authoritative and cost is stored as integer micro-dollars, so a price you learn about later can be backfilled exactly.',
  },
  {
    icon: <UsersIcon />,
    title: 'Real multi-tenancy',
    body: 'Organizations, roles and per-tenant row-level security in the database itself — not a WHERE clause some future query forgets to add.',
  },
];

function Gateway() {
  return (
    <Section className="border-b border-line">
      <SectionHeading
        eyebrow="AI gateway"
        title="Your keys, your models, your ledger."
        description="The gateway sits between your workspace and every provider, so the choice of model stays a decision you can revisit rather than a dependency you are stuck with."
      />
      <div className="mt-12 grid gap-5 sm:grid-cols-2">
        {GATEWAY.map((item) => (
          <FeatureCard key={item.title} icon={item.icon} title={item.title}>
            {item.body}
          </FeatureCard>
        ))}
      </div>
    </Section>
  );
}

function SecurityBand() {
  return (
    <div className="bg-night">
      <Container className="py-20 sm:py-28">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <SectionHeading
            tone="dark"
            eyebrow="Security"
            title="Built for the review you will be asked to pass."
          />
          <SecondaryCta href="/security">See the full security model</SecondaryCta>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DarkPoint title="Isolation enforced by PostgreSQL">
            Row-level security policies scope every tenant table. The isolation suite fails the
            build rather than skipping when it cannot reach a database.
          </DarkPoint>
          <DarkPoint title="Guarded egress">
            Outbound traffic goes through a checked fetch that validates the address in the
            connection path — checking a hostname and then letting fetch re-resolve it is a
            DNS-rebinding hole.
          </DarkPoint>
          <DarkPoint title="Encrypted credential vault">
            Provider keys are sealed with envelope encryption per organization. Passwords use
            Argon2id, and tokens are stored hashed.
          </DarkPoint>
          <DarkPoint title="Approvals scoped to one run">
            A human approval authorises a single execution of a single action — never a standing
            grant the agent can reuse later.
          </DarkPoint>
          <DarkPoint title="robots.txt as an egress control">
            A missing robots.txt permits; a 403 or a 500 denies. A server that will not show us its
            rules has not invited us to guess them.
          </DarkPoint>
          <DarkPoint title="Drills, not assumptions">
            Backup and restore, readiness and ledger reconciliation are tested by making them fail
            for real. A monitor that has never fired is not known to work.
          </DarkPoint>
        </div>
      </Container>
    </div>
  );
}

function ClosingCta() {
  return (
    <Section className="bg-white">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-chalk px-6 py-16 text-center sm:px-16">
        <div className="grid-backdrop absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Put your team&rsquo;s AI work somewhere you can audit it.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">
            Start on the free plan with your own documents and your own provider key. Nothing to
            install, no card, no sales call.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <PrimaryCta href="/signup">Create your workspace</PrimaryCta>
            <SecondaryCta href="/pricing">Compare plans</SecondaryCta>
          </div>
        </div>
      </div>
    </Section>
  );
}
