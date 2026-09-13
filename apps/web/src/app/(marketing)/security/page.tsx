import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AgentIcon, KeyIcon, RouteIcon, ShieldIcon, UsersIcon } from '@/components/marketing/icons';
import {
  Container,
  Eyebrow,
  PageHero,
  PrimaryCta,
  SecondaryCta,
  Section,
  SectionHeading,
} from '@/components/marketing/primitives';

export const metadata: Metadata = {
  title: 'Security — tenant isolation, an encrypted vault, and guarded egress',
  description:
    'The threat model behind MOKA AI: row-level security as the isolation backstop, envelope-encrypted credentials, authorization that never consults the prompt, and a single guarded egress point.',
};

/**
 * The security page.
 *
 * It names the controls AND the limits, because the audience is somebody who
 * will check. A trust page that lists only strengths is read as marketing and
 * discounted accordingly; the section on what is not shipped is the part that
 * makes the rest credible.
 */
export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="A language model, untrusted text, and tools that touch customer data."
        description="That combination is the threat model. Every control below exists because of one specific way it goes wrong — not because a framework happened to offer the feature."
      />

      <Section className="border-b border-line bg-chalk">
        <SectionHeading
          eyebrow="The governing rule"
          title="Authorization never consults the prompt."
          description="Anything a model reads can be attacker-controlled: a document, a web page, a support ticket, a tool result. So nothing a model produces is ever treated as a decision about what it is allowed to do."
        />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <Principle icon={<UsersIcon />} title="Tenant context is derived">
            An organization id arriving in a body, query string, header or path is ignored, and its
            presence is recorded as a security event. Identity comes from the session or the API key
            record, and nowhere else.
          </Principle>
          <Principle icon={<AgentIcon />} title="Allowlists are set at config time">
            What an agent may call is decided by an administrator before the run, in a place no
            prompt can reach. The model chooses among permitted tools; it never widens the set.
          </Principle>
          <Principle icon={<ShieldIcon />} title="Consequences wait for a person">
            High-risk actions pause for human approval, and the approval authorises one execution of
            one action — not the action in general, and not the next time.
          </Principle>
        </div>
      </Section>

      <Section id="isolation" className="border-b border-line">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-start">
          <div>
            <Eyebrow>Tenant isolation</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              A forgotten WHERE clause returns zero rows, not someone else&rsquo;s data.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">
              Every tenant-owned table has row-level security enabled and forced. The application
              connects as a non-superuser role with no bypass, and each transaction sets the current
              organization locally, so the value cannot leak across a pooled connection.
            </p>
            <ul className="mt-7 space-y-4">
              <Point title="It fails closed">
                If the organization setting is unset, the policy matches nothing. The failure mode
                of a bug is an empty result, not a cross-tenant read.
              </Point>
              <Point title="Migrations hold different privileges">
                The schema is migrated by a more privileged role that the application process never
                holds, so a compromised app cannot rewrite its own policies.
              </Point>
              <Point title="Retrieval is isolated too">
                Chunk and embedding tables carry the same policy, because a knowledge base that
                leaks through search leaks just as completely as one that leaks through a query.
              </Point>
            </ul>
          </div>

          <CodePanel
            caption="policy on every tenant table"
            lines={[
              'ALTER TABLE documents ENABLE ROW LEVEL SECURITY;',
              'ALTER TABLE documents FORCE  ROW LEVEL SECURITY;',
              '',
              'CREATE POLICY tenant_isolation ON documents',
              '  USING      (organization_id =',
              "    current_setting('app.current_org_id', true)::uuid)",
              '  WITH CHECK (organization_id =',
              "    current_setting('app.current_org_id', true)::uuid);",
              '',
              '-- unset setting -> matches nothing -> fails closed',
            ]}
          />
        </div>
      </Section>

      <div className="bg-night">
        <Container className="py-20 sm:py-28">
          <div id="vault" className="grid gap-14 lg:grid-cols-2 lg:items-start">
            <div>
              <Eyebrow tone="dark">Credential vault</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
                A stolen ciphertext is not a usable ciphertext.
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-pretty text-night-muted">
                Provider keys are sealed with AES-256-GCM under a per-organization key, itself
                wrapped by a root key. The additional authenticated data binds each ciphertext to
                its organization, credential and provider — so a record copied into another
                organization&rsquo;s row fails authentication and cannot be decrypted at all.
              </p>
              <p className="mt-4 text-base leading-relaxed text-night-muted">
                That defeats tampering inside the database, not only theft of the file. Rotation
                re-wraps the per-organization keys without re-encrypting every credential.
              </p>
              <SecondaryCta href="/signup" className="mt-8">
                Bring your own keys
              </SecondaryCta>
            </div>

            <div className="grid gap-4">
              <DarkRule title="Never returned to the browser">
                The ciphertext column is excluded from every default select. One audited method
                reads it, and only for the request that needs it.
              </DarkRule>
              <DarkRule title="Never in a prompt">
                The prompt assembler receives a credential handle, never a value. There is no path
                by which a key reaches a model&rsquo;s context.
              </DarkRule>
              <DarkRule title="Never in logs or errors">
                Redaction is configured on the logger and the error serializers rather than applied
                at call sites, so a call site cannot opt out of it.
              </DarkRule>
              <DarkRule title="Displayed as a fingerprint">
                Only a non-reversible fingerprint and the last four characters are stored for
                display, in separate plain columns.
              </DarkRule>
            </div>
          </div>
        </Container>
      </div>

      <Section id="egress" className="border-b border-line">
        <div className="grid gap-14 lg:grid-cols-2 lg:items-start">
          <div>
            <Eyebrow>Egress</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              One guarded exit, checked in the connection path.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">
              Crawling, research, webhooks and tool calls all leave through the same checked fetch.
              It validates the address at connection time rather than before, because checking a
              hostname and then letting the client re-resolve it is a DNS-rebinding hole rather than
              a control.
            </p>
            <ul className="mt-7 space-y-4">
              <Point title="robots.txt decides paths, the SSRF guard decides addresses">
                A site&rsquo;s robots.txt is the machine-readable form of its terms for automated
                clients, so it sits next to the address check rather than in a politeness layer.
              </Point>
              <Point title="The failure policy is the interesting part">
                A missing robots.txt permits. A 403 or a 500 denies — a server that will not show us
                its rules has not invited us to guess them.
              </Point>
              <Point title="The crawler identifies itself honestly">
                It sends its own user agent so a site owner can block it specifically. Impersonating
                a browser would be a small deception with no upside.
              </Point>
            </ul>
          </div>

          <CodePanel
            caption="egress decisions"
            lines={[
              'GET https://docs.example.com/pricing',
              '  address check ... public ... ALLOW',
              '  robots.txt ...... permitted . ALLOW',
              '  200 · stored · sha256 recorded',
              '',
              'GET http://169.254.169.254/latest/meta-data/',
              '  address check ... link-local . DENY',
              '',
              'GET https://intranet.example/reports',
              '  robots.txt ...... 403 ....... DENY',
            ]}
          />
        </div>
      </Section>

      <Section className="border-b border-line bg-chalk">
        <SectionHeading
          eyebrow="Assurance"
          title="Controls are tested by making them fail for real."
          description="A monitor that has never been observed to fire is not known to work. The suites create an organization-scoped table with no policy, plant a divergence in the credit ledger, and take a backup the wrong way — then assert that each one is caught."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Principle icon={<ShieldIcon />} title="Isolation suites fail, never skip">
            Every database-backed suite fails rather than skipping when it cannot reach PostgreSQL.
            A silently skipped isolation test turns a missing guarantee into a green build.
          </Principle>
          <Principle icon={<RouteIcon />} title="Operational drills">
            Backup and restore, readiness and ledger reconciliation run as drills against real
            databases they create and drop, separately from the security suites.
          </Principle>
          <Principle icon={<KeyIcon />} title="Full audit trail">
            Credential lifecycle, role changes, approvals and agent runs all produce audit records,
            so an answer given in March is still explainable in September.
          </Principle>
        </div>
      </Section>

      <Section className="border-b border-line">
        <div className="rounded-2xl border border-line bg-white p-8 sm:p-10">
          <Eyebrow>Limits, stated plainly</Eyebrow>
          <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            What we do not claim.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            A trust page that lists only strengths is read as marketing and discounted accordingly.
            These are the gaps we know about.
          </p>
          <dl className="mt-8 grid gap-6 md:grid-cols-3">
            <div className="border-l-2 border-line pl-5">
              <dt className="text-sm font-semibold tracking-tight">
                Prompt injection is not prevented
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">
                It cannot be, at the prompt layer. It is contained instead: authorization never
                consults the prompt, so a successful injection still cannot reach anything the
                caller could not already do.
              </dd>
            </div>
            <div className="border-l-2 border-line pl-5">
              <dt className="text-sm font-semibold tracking-tight">
                Semantic search awaits an extension
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">
                Vector retrieval needs pgvector. Where it is not installed, retrieval is lexical and
                the interface says so rather than implying more than it does.
              </dd>
            </div>
            <div className="border-l-2 border-line pl-5">
              <dt className="text-sm font-semibold tracking-tight">
                Code execution needs real isolation
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">
                Sandboxed execution depends on container isolation on a Linux host. Where that is
                not available, the feature is off rather than approximated.
              </dd>
            </div>
          </dl>
        </div>
      </Section>

      <Section className="bg-white">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Bring the questions your security reviewer would ask.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">
            Start on the free plan and check the controls against your own documents and your own
            provider key.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <PrimaryCta href="/signup">Start free</PrimaryCta>
            <SecondaryCta href="/product">Tour the product</SecondaryCta>
          </div>
        </div>
      </Section>
    </>
  );
}

function Principle({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-6">
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
        {icon}
      </span>
      <h3 className="mt-5 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="border-l-2 border-line pl-5">
      <p className="text-base font-semibold tracking-tight">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function DarkRule({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-night-line bg-night-soft p-5">
      <h3 className="text-sm font-semibold tracking-tight text-white">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-night-muted">{children}</p>
    </div>
  );
}

function CodePanel({ caption, lines }: { caption: string; lines: string[] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-night-line bg-night shadow-xl shadow-ink/10 lg:sticky lg:top-24">
      <div className="flex items-center gap-2 border-b border-night-line px-4 py-3">
        <span className="h-2 w-2 rounded-full bg-violet" aria-hidden="true" />
        <p className="font-mono text-[11px] text-night-muted">{caption}</p>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6 text-night-muted">
        {lines.join('\n')}
      </pre>
    </div>
  );
}
