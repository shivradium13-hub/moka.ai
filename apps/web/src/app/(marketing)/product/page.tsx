import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  AgentIcon,
  ChatIcon,
  KnowledgeIcon,
  ResearchIcon,
  RouteIcon,
} from '@/components/marketing/icons';
import {
  Container,
  Eyebrow,
  PageHero,
  PrimaryCta,
  SecondaryCta,
  Section,
} from '@/components/marketing/primitives';

export const metadata: Metadata = {
  title: 'Product — knowledge, agents, research and chatbots',
  description:
    'A tour of the four surfaces in a MOKA AI workspace and the gateway underneath them: how documents are indexed, how agents are constrained, how citations are verified, and how model usage is metered.',
};

/**
 * The product tour.
 *
 * Written as alternating detail sections rather than a feature matrix: each
 * one states what the surface does, then the design decision behind it. A
 * grid of thirty checkmarks tells a reader nothing they can evaluate.
 */
export default function ProductPage() {
  return (
    <>
      <PageHero
        eyebrow="Product"
        title="One workspace, four surfaces, and a gateway underneath."
        description="Your documents are indexed once and reused everywhere — by the people searching them, the agents acting on them, the research runs citing them, and the chatbot answering your customers with them."
      />

      <nav aria-label="On this page" className="border-b border-line bg-white">
        <Container className="flex flex-wrap gap-x-6 gap-y-2 py-4 text-sm">
          {SURFACES.map((surface) => (
            <a
              key={surface.id}
              href={`#${surface.id}`}
              className="text-muted transition hover:text-ink"
            >
              {surface.eyebrow}
            </a>
          ))}
        </Container>
      </nav>

      {SURFACES.map((surface, index) => (
        <Detail key={surface.id} surface={surface} flipped={index % 2 === 1} />
      ))}

      <Section className="bg-night">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
            The fastest way to judge it is to load your own documents.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-night-muted">
            The free plan exists to be evaluated on real data, not on a sandbox we picked.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <PrimaryCta href="/signup">Start free</PrimaryCta>
            <SecondaryCta href="/pricing">See plans</SecondaryCta>
          </div>
        </div>
      </Section>
    </>
  );
}

interface Surface {
  id: string;
  icon: ReactNode;
  eyebrow: string;
  title: string;
  lead: string;
  points: Array<{ title: string; body: string }>;
  panel: { caption: string; lines: Array<{ text: string; tone?: 'muted' | 'accent' }> };
}

const SURFACES: Surface[] = [
  {
    id: 'knowledge',
    icon: <KnowledgeIcon />,
    eyebrow: 'Knowledge engine',
    title: 'Documents that stay intelligible after they are cut up.',
    lead: 'Upload a file and it is parsed, chunked and indexed in the same request. Retrieval fuses two lexical retrievers, so a misremembered word still lands on the right paragraph.',
    points: [
      {
        title: 'Breadcrumbs inside the chunk',
        body: 'Each chunk carries its heading path — Refund Policy > Eligibility — inside its own text, because a retrieved fragment has to make sense alone. That is how both the model and the citation UI will see it.',
      },
      {
        title: 'Rank fusion, not score normalisation',
        body: 'PostgreSQL full-text ranking and trigram similarity are combined with Reciprocal Rank Fusion, which uses ordinal rank only. Two incomparable score scales never have to be forced onto one axis.',
      },
      {
        title: 'Honest about what is lexical',
        body: 'Semantic search needs the pgvector extension, and where it is not installed the interface says retrieval is lexical instead of implying more. Dense retrieval joins the same fusion call as a third list when it is available.',
      },
    ],
    panel: {
      caption: 'retrieval · fused ranking',
      lines: [
        { text: 'query  "refund window anual plans"', tone: 'accent' },
        { text: 'fts     rank 3  ts_rank_cd 0.41' },
        { text: 'trigram rank 1  similarity 0.72' },
        { text: 'rrf     Refund Policy > Eligibility', tone: 'accent' },
        { text: 'chunk   "Annual plans may be refunded…"' },
      ],
    },
  },
  {
    id: 'agents',
    icon: <AgentIcon />,
    eyebrow: 'Agents',
    title: 'An agent is a constraint, never a grant.',
    lead: 'Agents call typed tools, and every call is authorised four times before it runs. The last check is the one that matters: the invoking user must already hold the permission.',
    points: [
      {
        title: 'Four gates on every tool call',
        body: 'The tool must exist in the registry, sit on that agent’s allowlist, fall within the agent’s risk ceiling, and be a permission the calling user already has. None of those four is reachable from a prompt.',
      },
      {
        title: 'Approvals that expire on use',
        body: 'Consequential actions pause and wait for a person. The approval authorises exactly one execution — not the action in general, and not the next time the agent decides to take it.',
      },
      {
        title: 'Tested against a successful attack',
        body: 'The suite does not test that injection is blocked. It scripts a model that has already been compromised and asserts that nothing destructive is reachable anyway, because authorization never consulted the prompt.',
      },
    ],
    panel: {
      caption: 'agent run · authorization',
      lines: [
        { text: 'tool    crm.update_account' },
        { text: 'gate 1  registry ......... ok' },
        { text: 'gate 2  allowlist ........ ok' },
        { text: 'gate 3  risk high <= high  ok' },
        { text: 'gate 4  caller permission  ok' },
        { text: 'result  HELD — approval required', tone: 'accent' },
      ],
    },
  },
  {
    id: 'research',
    icon: <ResearchIcon />,
    eyebrow: 'Research',
    title: 'A source is a document we fetched.',
    lead: 'Not a URL a model produced, not a title it remembered, not a snippet a search engine returned. Every link in a finished answer is a lookup into a ledger of pages that were actually retrieved.',
    points: [
      {
        title: 'The model never writes a URL',
        body: 'It writes a reference number. The ledger records the final URL after redirects, the time of the fetch and a hash of what came back, so the same run is still auditable months later.',
      },
      {
        title: 'The answer is checked against the ledger',
        body: 'A reference naming no real source is removed, a URL appearing in none of the fetched pages is removed, and a quotation absent from its source is flagged. All three are reported rather than quietly cleaned up.',
      },
      {
        title: 'Nothing fetched means no model call',
        body: 'Handing a model a question, an instruction to cite everything and nothing to cite is the most reliable way to get an invented bibliography. Refusing costs one provider call and saves a fabrication.',
      },
    ],
    panel: {
      caption: 'research run · citation ledger',
      lines: [
        { text: 'fetch   docs.internal/billing/refunds' },
        { text: '        200 · 14:02:11Z · sha256 4f2a…9c1' },
        { text: 'fetch   status.example.com/incidents' },
        { text: '        403 robots.txt · DENIED', tone: 'accent' },
        { text: 'verify  2 refs ok · 1 removed', tone: 'accent' },
      ],
    },
  },
  {
    id: 'chatbots',
    icon: <ChatIcon />,
    eyebrow: 'Chatbots',
    title: 'A customer-facing bot grounded in the same documents.',
    lead: 'Build a chatbot on the knowledge your team already uploaded, pin it to the origins you name, and read the transcripts in the workspace rather than a separate console.',
    points: [
      {
        title: 'Grounded in your sources, not the open web',
        body: 'The bot answers from the documents you gave it, and the same retrieval path your team uses internally decides what it sees.',
      },
      {
        title: 'Origins and keys are scoped',
        body: 'A deployment is bound to the origins you list, with its own key. A key that leaks cannot be replayed from somewhere you never approved.',
      },
      {
        title: 'Conversations stay in one place',
        body: 'Transcripts land in the shared inbox, next to the agent runs and approvals, so the customer-facing surface is not a separate system of record.',
      },
    ],
    panel: {
      caption: 'chatbot deployment',
      lines: [
        { text: 'origins  https://acme.com' },
        { text: '         https://help.acme.com' },
        { text: 'sources  12 documents · 1,884 chunks' },
        { text: 'grounding strict — no ungrounded reply', tone: 'accent' },
        { text: 'transcripts → workspace inbox' },
      ],
    },
  },
  {
    id: 'gateway',
    icon: <RouteIcon />,
    eyebrow: 'AI gateway',
    title: 'Every model call goes through one metered path.',
    lead: 'Requests travel router → credential → adapter → provider. That single path is why usage, cost and failure are answerable questions rather than four dashboards that disagree.',
    points: [
      {
        title: 'Routing by capability',
        body: 'The router selects a model from what a request actually needs and plans fallbacks. Only transient failures walk the plan, because retrying a malformed request elsewhere just buys the same error twice.',
      },
      {
        title: 'Failures are metered too',
        body: 'Every call writes a usage record, failures included, since a failed call still consumed provider quota. Cost is integer micro-dollars, and unknown pricing is stored as unknown rather than as zero.',
      },
      {
        title: 'Your own provider keys',
        body: 'Credentials are held per organization in an encrypted vault and decrypted only for the request that uses them, so the relationship with your provider stays yours.',
      },
    ],
    panel: {
      caption: 'gateway · usage record',
      lines: [
        { text: 'route   capability: long-context, tools' },
        { text: 'model   selected · fallback planned' },
        { text: 'tokens  in 8,412 · out 693' },
        { text: 'cost    1,204 micro-usd', tone: 'accent' },
        { text: 'status  error → still recorded', tone: 'accent' },
      ],
    },
  },
];

function Detail({ surface, flipped }: { surface: Surface; flipped: boolean }) {
  return (
    <Section
      id={surface.id}
      className={`border-b border-line ${flipped ? 'bg-chalk' : 'bg-white'}`}
    >
      <div className="grid gap-14 lg:grid-cols-2 lg:items-start">
        <div className={flipped ? 'min-w-0 lg:order-2' : 'min-w-0'}>
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            {surface.icon}
          </span>
          <div className="mt-5">
            <Eyebrow>{surface.eyebrow}</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {surface.title}
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-pretty text-muted">{surface.lead}</p>
          </div>

          <dl className="mt-8 space-y-6">
            {surface.points.map((point) => (
              <div key={point.title} className="border-l-2 border-line pl-5">
                <dt className="text-base font-semibold tracking-tight">{point.title}</dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-muted">{point.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className={flipped ? 'min-w-0 lg:order-1' : 'min-w-0'}>
          <TerminalPanel panel={surface.panel} />
        </div>
      </div>
    </Section>
  );
}

/** A small trace panel. Illustrative of the shape of the record, not a live feed. */
function TerminalPanel({ panel }: { panel: Surface['panel'] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-night-line bg-night shadow-xl shadow-ink/10 lg:sticky lg:top-24">
      <div className="flex items-center gap-2 border-b border-night-line px-4 py-3">
        <span className="h-2 w-2 rounded-full bg-violet" aria-hidden="true" />
        <p className="font-mono text-[11px] text-night-muted">{panel.caption}</p>
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6">
        {panel.lines.map((line) => (
          <div
            key={line.text}
            className={line.tone === 'accent' ? 'text-violet' : 'text-night-muted'}
          >
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
