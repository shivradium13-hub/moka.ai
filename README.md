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

Both must pass. The security suites **fail rather than skip** when they cannot
reach a database: a silently skipped isolation test turns a missing guarantee
into a green build.

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
  ai/        Provider adapters, model registry, router, cost accounting.
  net/       safeFetch — the single SSRF-guarded egress point.
  config/    Zod-validated environment loader.
  crypto/    Envelope encryption, Argon2id, token hashing.
  db/        Drizzle schema, SQL migrations, RLS policies, seeds.
  tenancy/   Tenant context enforcement helpers.
infra/db/    Bootstrap SQL and the dev cluster script.
tests/       Security suites (run against real PostgreSQL).
docs/        Architecture, security, database, roadmap.
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

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Run API and web app |
| `pnpm verify` | typecheck → lint → test → build |
| `pnpm test:security` | Security suites against real PostgreSQL |
| `pnpm db:migrate` | Apply SQL migrations |
| `pnpm db:seed` | Seed roles, permissions and tenant fixtures |
| `node infra/db/dev-cluster.mjs <init\|start\|stop\|status\|destroy>` | Manage the dev database |

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — stack, dependency licensing, gateway and knowledge design, risks
- [docs/security.md](docs/security.md) — threat model, tenant isolation, credentials, AI-specific controls
- [docs/database.md](docs/database.md) — schema, conventions, migration safety
- [docs/roadmap.md](docs/roadmap.md) — phase plan and blockers
