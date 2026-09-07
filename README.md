# MOKA AI

Multi-tenant AI workspace and AI workforce platform.

> **Standalone product.** MOKA AI shares no code, data, users, APIs, business
> logic, branding or configuration with any other product.

**Status: Phase 5 (Agent Engine) complete.** Phases 1–5 delivered:

- **Phase 1** — authentication, organizations, multi-tenancy, RBAC, auditing
- **Phase 2** — document ingestion, chunking, full-text retrieval with RRF fusion
- **Phase 3** — provider-agnostic AI gateway, model router, usage ledger, SSRF-guarded egress
- **Phase 4** — per-organization encrypted credential vault with BYOK
- **Phase 5** — agent runtime, typed tools, permission gates, human approvals

Two things are deliberately not working, and the code says so rather than
pretending otherwise:

- **Semantic (vector) search** needs the pgvector extension, which is not
  installable here without an operator decision ([roadmap](docs/roadmap.md) §B1).
  Retrieval is lexical, and the UI states that.
- **No AI provider API key exists in this environment**, so no live model call
  has ever been made. `GET /v1/ai/models` reports every model as unavailable.
  The adapters are written to the documented contracts and tested against
  fixtures of those contracts, not against the providers themselves.

---

## Quick start

Requires Node.js ≥ 20.11 and PostgreSQL 17 installed (the server itself does
not need to be running — the dev cluster script creates its own).

```bash
npm install -g pnpm
pnpm install
```

Create the development database. This makes a self-contained PostgreSQL cluster
under `./local/pgdata` on port **55432**, so it needs no superuser password and
leaves any existing PostgreSQL service untouched:

```bash
node infra/db/dev-cluster.mjs init
```

Copy `.env.example` to `.env`, then set the four database URLs the script
prints, and generate the two keys:

```bash
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

```bash
node -e "console.log('AUTH_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
```

Apply migrations and seed the fixtures:

```bash
pnpm db:migrate && pnpm db:seed
```

Run everything:

```bash
pnpm dev
```

The API listens on `http://localhost:4000`, the web app on
`http://localhost:3000`. The seed creates two isolated organizations; sign in as
`owner-a@example.test` or `owner-b@example.test` with the password printed by
the seed script.

---

## Verification

```bash
pnpm verify
```

Runs typecheck → lint → unit tests → build. Then the database-backed suites:

```bash
pnpm test:security
```

And the operational drills:

```bash
pnpm test:drill
```

All three must pass. Every one of these suites **fails rather than skips** when
it cannot reach a database: a silently skipped isolation test turns a missing
guarantee into a green build.

The drills are separate from the security suites because they create and drop
databases and need a superuser connection — making the security suites depend
on all that would make them something people skip. They test controls by
making them fail for real: creating an organization-scoped table with no
policy, planting a divergence in the credit ledger, taking a backup the wrong
way. A monitor that has never been observed to fire is not known to work.

---

## Layout

```
apps/
  api/       NestJS + Fastify. The only process that writes to the database.
  web/       Next.js 15 dashboard.
packages/
  core/      Domain types, typed errors, RBAC, redaction.
  knowledge/ Parsers, chunking, retrieval, storage driver.
  agents/    Tool contracts, authorization, prompt isolation, runtime.
  chat/      Customer-chatbot logic: origins, keys, grounding, the widget.
  research/  Citation ledger, crawl policy, search providers, Path C pipeline.
  billing/   Plans, entitlements, the credit ledger, the payment boundary.
  ai/        Provider adapters, model registry, router, cost accounting.
  net/       safeFetch and robots.txt — the guarded egress point.
  config/    Zod-validated environment loader.
  crypto/    Envelope encryption, Argon2id, token hashing.
  db/        Drizzle schema, SQL migrations, RLS policies, seeds.
  tenancy/   Tenant context enforcement helpers.
infra/
  db/        Bootstrap SQL, dev cluster, backup and restore.
  billing/   Credit-ledger reconciliation.
  bench/     Isolation-overhead benchmark.
tests/
  security/  11 suites, against real PostgreSQL.
  drills/    Backup/restore, readiness, reconciliation.
docs/        Architecture, security, audit, operations, performance, roadmap.
```

---

## Knowledge Engine

Upload a document and it is parsed, chunked and indexed immediately. Each chunk
carries its heading breadcrumb *inside* its text — `Refund Policy > Eligibility`
— because a retrieved fragment has to be intelligible on its own, which is how
both the model and the citation UI will see it.

Retrieval currently fuses two lexical retrievers with Reciprocal Rank Fusion:
PostgreSQL full-text (`ts_rank_cd`) and trigram similarity for typo tolerance.
RRF uses ordinal rank only, so the two incomparable score scales never have to
be normalised against each other. When pgvector arrives, dense retrieval joins
the same fusion call as a third list.

Ingestion runs **inline** in the request today (bounded by a 25 MB cap) because
the intended BullMQ queue needs Valkey, which needs Docker. The document status
column already models the async lifecycle.

---

## AI Gateway

Requests go `router → credential → adapter → provider`. The router picks a
model from required capabilities and plans fallbacks; only transient failures
walk the plan, because retrying a malformed request elsewhere just buys the
same error twice.

Every call writes a `usage_records` row — failures included, since a failed
call still consumed provider quota. Cost is stored as **integer
micro-dollars**, and `NULL` where pricing is unknown. `NULL` means unknown, not
free: token counts stay authoritative so cost can be backfilled.

All outbound traffic goes through `safeFetch`, which validates the address in
the connection path itself rather than before it — checking a hostname and then
letting `fetch` re-resolve it is a DNS-rebinding hole.

---

## Agents

**An agent is a constraint on what a user can already do — never a grant.**

Every tool call passes four gates: the tool exists, it is on that agent's
allowlist, its risk is within the agent's ceiling, and **the invoking user
holds the tool's permission**. The last one is what stops an agent becoming a
privilege-escalation path.

Prompt injection is handled honestly. It cannot be prevented at the prompt
layer — delimiters can be imitated and instructions argued with. So the test
suite assumes the injection *succeeded*: a scripted model reads a malicious
document and does exactly what it says. Nothing is deleted, because
authorisation depends on the caller's role and the agent's allowlist, neither
of which is reachable from any prompt. Consequential actions then pause for a
human, and that approval authorises exactly one execution.

---

## Research and crawling

**A source is a document we fetched.** Not a URL a model produced, not a title
it remembered, not a snippet a search engine returned.

Ask a model to research something and cite its sources and it will produce a
bibliography: plausible titles, plausible authors, URLs that resolve to nothing.
It is not lying, it is completing a pattern — and a fabricated citation is worse
than none, because it turns an unsupported claim into an apparently sourced one,
which is the form people stop checking.

So the model is never given the chance. **It does not write URLs. It writes
`[3]`.** Every link a reader sees comes from a ledger of pages actually
retrieved, recording the final URL after redirects, the time, and a hash of what
came back. A citation is a lookup, not a generation.

Afterwards, the answer is checked against that ledger. A `[n]` naming no real
source is removed; a URL appearing in none of the fetched pages is removed; a
quotation absent from the source it cites is flagged. All three are reported to
the user rather than quietly cleaned up — someone deciding how much to trust a
paragraph is better served by knowing the model invented two references in it
than by a tidier page.

And when nothing could be fetched, **the model is not called at all**. Handing
it a question, an instruction to cite everything, and nothing to cite is the
most reliable way to get an invented bibliography. Refusing costs one provider
call and saves a fabrication.

Six months later the run is still auditable: `research_sources` keeps the
excerpt each source contributed, so anyone can see exactly what was in front of
the model when it wrote a sentence.

### Searching the web

There is deliberately **no bundled search provider**. The good ones are paid,
and scraping the free ones violates their terms. So:

- **Explicit URLs** always work and need nothing configured. For the most
  common real request — "read these three pages and tell me what they say" —
  this is not a fallback, it is the right tool.
- **SearXNG**, self-hosted and open source, enables keyword search. Set
  `SEARXNG_URL`.

The UI says which mode it is in. A research feature that appears to search the
web and does not is exactly the quiet failure this design exists to avoid.

### robots.txt is an egress control, not a courtesy

A site's robots.txt is the machine-readable form of its terms for automated
clients, and fetching a path a publisher has said in writing not to fetch is
not something a rate limiter makes acceptable. So it lives next to the SSRF
guard: those rules decide which *addresses* we may dial, these decide which
*paths* we are permitted to.

The failure policy is the part that matters. A missing robots.txt permits. A
**403 or a 500 denies** — a server that will not show us its rules has not
invited us to guess them, and crawling blind because we could not read them is
the cautious reading in reverse.

The crawler also honours `noindex` by reading a page and not storing it, and
identifies itself honestly (`MokaAI-Crawler/1.0`) so a site owner can block us
specifically. Impersonating a browser would be a small deception with no upside.

### Agent templates

A template is a name, instructions, a risk ceiling and a tool allowlist —
nothing more. It creates an ordinary agent, and one built from an official
template passes through exactly the same authorisation gates as one typed in by
hand. Being official grants nothing.

Every template states what it **cannot** do, and that list is never empty: the
sales assistant says plainly that it is not connected to a CRM, the social
drafter that it cannot publish anything. A picker that lists six capabilities
and no limits sells a product that does not exist, and the user finds out from
a wrong answer instead of from us.

---

## Customer chatbots

**A visitor is not a user with a low role. They hold no role at all.**

A chatbot answers members of the public on the customer's own website. That
makes them the first principal in the system who is not a member of any
organization, and the design turns on refusing one tempting shortcut:
modelling them as `role: 'viewer'`. A viewer can read projects and members, so
that single line would publish an organization's internal list to every
passer-by — and the authoriser would permit it, correctly, having been told the
caller was a viewer.

So `CustomerContext` carries no role. `hasPermission` on that path does not
merely go uncalled; it does not typecheck. A tool is reachable by the public
only if it is explicitly marked `customerSafe`, is read-only, and is not
approval-gated — three conditions that each default to refusing, so publishing
something to the internet takes a sentence rather than an omission.

Four more things are structural rather than advisory:

- **Publishing knowledge is an explicit act.** A chatbot can quote exactly the
  sources attached to it and nothing else, and the retrieval call used on the
  public path returns nothing for an empty list rather than falling back to
  "no restriction". The scope is captured in a closure, so a model cannot
  widen it — there is no argument naming it.
- **Grounding is checked after the fact.** If retrieval returned nothing, the
  answer is discarded and replaced with "I don't know" however confident the
  model was. Asking it not to invent things is the nudge; this is the control.
- **Citations come from what was retrieved**, never from what the model says it
  used. A fabricated citation is worse than none — it turns an unsupported
  answer into an apparently sourced one.
- **Asking for a human is a button, not a tool.** The one request that must not
  depend on a model agreeing to it, made most often by someone the bot has just
  failed. Keeping it out of the tool set is also what lets that set stay
  strictly read-only.

The widget is two pieces: a small loader on the customer's page, and the chat
UI in a cross-origin iframe on ours. Model output shaped by documents we did
not write is never rendered inside a customer's origin, where an escaping
mistake in our renderer would become XSS on their site. Inside the frame every
message is set with `textContent` — no `innerHTML`, no Markdown renderer — and
the frame's CSP is `default-src 'none'` with a per-response style nonce.

The embed key **is public**, and is treated that way: it is stored in plaintext
and shown in full, because it is about to be pasted into a page anyone can view
the source of. It buys a fresh, empty conversation — exactly what any visitor
already has. The per-conversation visitor token is the opposite, and is hashed
at rest like a session token.

An origin allowlist does two jobs of very different strength, and the code says
so: it becomes `frame-ancestors` on the chat frame, which the visitor's own
browser enforces and no third-party site can forge past; and it is compared
against the `Origin` header on API calls, which any non-browser client can set
to anything. The first is a real control. The second stops casual reuse and
nothing more.

---

## Moka Credentials

Provider API keys are stored under envelope encryption: a root key wraps a
per-organization data key, which encrypts each credential.

`credentials.id` deliberately has **no database default**. The ciphertext's
AES-GCM additional authenticated data binds it to
`(organization, credential, provider)`, so the id must exist before encryption.
The consequence is the point: an attacker with *write* access to the database
still cannot read another tenant's key, because moving a ciphertext row
invalidates it. That is tested by physically copying one tenant's encrypted
bytes into another tenant's row and confirming it will not decrypt.

Only a non-reversible fingerprint and the last four characters are stored for
display. The plaintext appears in no column, no log, no audit record and no
API response — each of which is asserted by a test.

---

## Plans, limits and credit

**No limit is written in the code.** Every commercial limit is a row, resolved
when it is checked: a per-organization override, then the plan, then denial.
There is deliberately no third fallback to a constant — that constant would be
the hard-coded limit this design exists to remove, and it would take over
silently the moment a plan was unseeded.

A limit has three states, and collapsing any two of them is a real bug:

| Value | Meaning |
|---|---|
| a number | that many |
| `null` | **unlimited** — not zero |
| no row | **not included** — the plan does not offer it |

`limit ?? 0` breaks every customer on an unlimited plan. `limit ?? Infinity`
gives the product away. The type models all three so neither is expressible.

Counting happens **at the moment of the check** — a real `SELECT count(*)`,
never a cache. With a cache, a customer at their limit can create one more of
everything on every instance holding a stale count.

### The application cannot raise its own limit

This is a database grant, not a code review:

```sql
GRANT SELECT ON plans, plan_entitlements, entitlement_overrides TO moka_app;
```

A bug able to `UPDATE plan_entitlements` would not be a limit bypass in one
place — it would be every limit at once, silently, with the enforcement code
still passing its own tests. Overrides are granted out of band by someone with
database access; there is no self-service path to a higher limit, and the
absence of an endpoint is backed by the absence of a privilege.

### Entitlements are not safety ceilings

Agents, chatbots, credit and seats are the plan, and selling more of them is
the business model. The public chatbot's 4-step budget, the crawler's page
ceiling, the SSRF blocked ranges and the upload cap are **not for sale** and
stay constants. Making one purchasable would mean selling a weaker security
posture to whoever pays most — the enterprise tier would be the one whose
chatbot can be driven into an unbounded loop by a stranger.

### The credit ledger

`credit_transactions` is the record; the balance is a **cache** of its sum,
because a check on every provider call cannot sum a million rows. A security
test reconciles them, and when they disagree the ledger wins — a ledger is
what you can show a customer disputing a bill.

Append-only, integer micro-dollars, and sign discipline enforced by the
database: a `debit` of +500 would silently *add* credit and reconcile perfectly
against a wrong balance, which is exactly the class of bug that is obvious in
review and invisible in production.

Two things are stated rather than hidden:

- **Concurrency.** A call's cost is unknown until it returns, so the pre-check
  is a balance check and a burst can each pass it before any debits. The
  overshoot is bounded by one call per concurrent request, the debit itself is
  atomic, and the balance is allowed to go **negative** — clamping at zero
  would conceal the overspend rather than record it.
- **Unpriced calls.** When a model's pricing is not configured, nothing is
  charged and the gap is recorded loudly. Charging a guess invents a figure
  people budget against; charging zero silently would make that model free and
  unlimited, which is the cheapest possible exploit. The usage page reports
  "N calls could not be priced" beside the total, never folded into it.

### Payment

**No card processor is integrated, and nothing pretends otherwise.** Activating
a paid plan without money moving would mean real credit, real provider calls
and no revenue — the most damaging possible fake confirmation.

The default gateway refuses and explains. With `BILLING_MANUAL_PAYMENTS=true`,
an administrator can record that payment was arranged elsewhere: invoice
billing and self-hosted deployments are how most likely customers would pay,
and it is honest because a *person* asserts it, attributably, into the audit
log. Downgrading to the free plan always works without a gateway — refusing a
cancellation because no processor is configured would be a hostage-taking.

---

## How tenant isolation works

Three layers, in order of how much they are relied upon — the last one least:

1. **Row-Level Security.** Every tenant table has `FORCE ROW LEVEL SECURITY`.
   The application connects as `moka_app`, which is neither the table owner nor
   holds `BYPASSRLS`. Each transaction binds `app.current_org_id`; policies read
   it. With nothing bound, every policy matches nothing and queries return zero
   rows. **A query that forgets its `WHERE organization_id` cannot leak.**
2. **Derived tenant context.** The organization comes from the session and is
   re-verified against `organization_members` on every request. Any
   organization id found in a request body, query, header or path is discarded
   and logged as a security event — including one that matches, since accepting
   matches would let an attacker enumerate valid ids.
3. **Assertions.** `assertBelongsToTenant` re-checks loaded records. It should
   be unreachable; it exists so a missing policy fails loudly rather than
   silently.

Full detail in [docs/security.md](docs/security.md).

---

## Running it in production

Full runbook in [docs/operations.md](docs/operations.md). The one thing that
matters most is short enough to repeat here.

**The application must connect as `moka_app`, and `moka_app` must not be a
superuser and must not hold `BYPASSRLS`.**

Everything else in the system is recoverable. This is not. Every
tenant-isolation control reduces to "the connecting role is subject to
row-level security" — point `DATABASE_URL` at a superuser and every policy
stops applying at once. Nothing errors. Every request succeeds. Every test that
runs as `moka_app` still passes. The only symptom is one customer seeing
another customer's data.

The process therefore refuses to start if it detects such a role, in every
environment rather than only in production. If a deploy fails with *"Refusing
to start: the application connects as …"*, fix the connection string rather
than working around it.

Two more places where the obvious action is the wrong one, both explained in
the runbook:

- **`pg_dump` with `--enable-row-security` produces a successful-looking,
  completely empty backup** under `FORCE ROW LEVEL SECURITY`. `pnpm db:backup`
  checks the role rather than trusting the exit code.
- **`pg_restore --no-acl` silently removes security controls.** The usage and
  credit ledgers are append-only *because of their grants*, not because of
  application logic. `pnpm db:restore` preserves them.

---

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Run API and web app |
| `pnpm verify` | typecheck → lint → test → build |
| `pnpm test:security` | Security suites against real PostgreSQL |
| `pnpm test:drill` | Backup/restore, readiness and reconciliation drills |
| `pnpm db:migrate` | Apply SQL migrations |
| `pnpm db:seed` | Seed roles, permissions and tenant fixtures |
| `pnpm db:backup` | Dump the database (refuses a role that would produce an empty one) |
| `pnpm db:restore` | Restore, preserving ownership, policies and grants |
| `pnpm billing:reconcile` | Compare cached balances against the credit ledger |
| `pnpm bench` | Measure the cost of row-level security |
| `node infra/db/dev-cluster.mjs <init\|start\|stop\|status\|destroy>` | Manage the dev database |

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — stack, dependency licensing, gateway and knowledge design, risks
- [docs/security.md](docs/security.md) — threat model, tenant isolation, credentials, AI-specific controls
- [docs/database.md](docs/database.md) — schema, conventions, migration safety
- [docs/security-audit.md](docs/security-audit.md) — findings, threat-model coverage, accepted risks
- [docs/operations.md](docs/operations.md) — deploy, backup, restore, failure recovery, monitoring
- [docs/performance.md](docs/performance.md) — measured isolation overhead, and what is not measured
- [docs/roadmap.md](docs/roadmap.md) — phase plan and blockers
