# MOKA AI — Architecture

> **Status:** Phase 0 (analysis). No application code written yet.
> **Scope rule:** MOKA AI is a standalone product. No MokaStore code, data, users, APIs, branding or config is used or referenced anywhere.

---

## 1. Environment assessment (measured, not assumed)

Probed on the target machine at `D:\Ai` on 2026-09-06.

| Item | Finding | Impact |
|---|---|---|
| Working dir `D:\Ai` | **Completely empty**, not a git repo | Greenfield. No legacy stack to inherit or migrate. |
| Node.js | v24.20.0 | Good. Supports everything proposed. |
| npm | 11.19.0 | Present. `pnpm` absent but installable via bundled `corepack`. |
| pnpm / yarn / bun | Not installed | `corepack enable pnpm` — no download needed. |
| Git | 2.55.0 | Present. Identity configured (`shivradium13-hub`). |
| Python | 3.14.7 | Available for an optional ML sidecar. |
| **PostgreSQL** | **17.11 installed and RUNNING on :5432** | Major head start. Service `postgresql-x64-17`. |
| **pgvector** | **NOT INSTALLED** | **Phase 2 blocker.** See Risk R3. |
| Postgres extensions present | `pgcrypto`, `pg_trgm`, `unaccent`, `citext`, `uuid-ossp` (61 total) | Covers FTS, fuzzy search, UUIDs. Only `vector` is missing. |
| Redis / Valkey | Not installed | Required for queues, rate limits, sessions, stream state. |
| **Docker / Docker Compose** | **NOT INSTALLED** | Blocks §28 sandbox, §29 browser isolation, containerised pgvector. |
| **WSL2** | **NOT INSTALLED** (`HypervisorPresent: False`) | Prerequisite for Docker on Windows 11 **Home**. |
| CPU virtualization | `VirtualizationFirmwareEnabled: True` | **WSL2 is installable.** Not a hardware blocker. |
| MSVC Build Tools | Not installed | Blocks compiling pgvector natively and some native npm modules. |
| **RAM** | **7.3 GB** | **Hard constraint. Shapes the whole dev plan.** See R1. |
| CPU | 6 cores / 12 logical | Adequate. |
| Disk free | C: 84 GB, D: 59 GB | Adequate. |
| OS | Windows 11 **Home** Single Language | No Hyper-V. Docker only via the WSL2 backend. No gVisor. |
| `LongPathsEnabled` | `0` (disabled) | Monorepo + pnpm paths can exceed the 260-char limit. |
| npm registry | Reachable (750 ms) | Fine. |

**Conclusion:** this machine is a viable *development* box for Phases 1–7. It is **not** a viable host for Phase 8 (sandbox / browser agent) or Phase 10 (production), and it needs three fixes before Phase 2 can begin.

---

## 2. Cost and licensing posture (§2 compliance)

Every dependency is classified before adoption.

### FREE / OPEN SOURCE — the entire core

| Component | Choice | Licence |
|---|---|---|
| Runtime | Node.js 24 | MIT |
| Language | TypeScript (strict) | Apache-2.0 |
| Monorepo | pnpm workspaces + Turborepo | MIT |
| Frontend | Next.js 15 (App Router), React 19 | MIT |
| Styling | Tailwind CSS v4 | MIT |
| Components | shadcn/ui (copied in, not a dependency) | MIT |
| Backend | NestJS on the Fastify adapter | MIT |
| Validation | Zod | MIT |
| Database | PostgreSQL 17 | PostgreSQL Licence |
| Vector | pgvector | PostgreSQL Licence |
| ORM / migrations | Drizzle ORM + drizzle-kit | Apache-2.0 |
| Cache / queue broker | **Valkey** (not Redis — see below) | BSD-3-Clause |
| Job queue | BullMQ | MIT |
| Auth | Better Auth (organization, API-key, 2FA plugins) | MIT |
| Logging | pino | MIT |
| Tracing | OpenTelemetry SDK | Apache-2.0 |
| PDF parsing | unpdf / pdfjs | Apache-2.0 / MIT |
| DOCX parsing | mammoth | BSD-2 |
| XLSX parsing | exceljs | MIT |
| CSV parsing | papaparse | MIT |
| HTML extraction | cheerio + @mozilla/readability | MIT / Apache-2.0 |
| OCR | tesseract.js | Apache-2.0 |
| robots.txt | hand-written in `packages/net` (see below) | — |
| Browser automation | Playwright | Apache-2.0 |
| Local embeddings | fastembed / ONNX (bge-small-en-v1.5) | Apache-2.0 |
| Local reranker | bge-reranker-base (ONNX) | Apache-2.0 |
| Testing | Vitest + Playwright Test | MIT / Apache-2.0 |

### PAID — pre-approved in the brief only
Domain, server, Claude Code, and authorized AI provider API usage (OpenAI / Anthropic / Gemini).

### LICENCE TRAPS AVOIDED
This is why several choices above differ from the obvious default.

| Obvious pick | Problem | Our choice |
|---|---|---|
| **Redis** ≥ 7.4 | RSALv2 / SSPL — source-available, not OSI open source | **Valkey** (BSD-3, Linux Foundation). Wire-compatible; BullMQ and every client work unchanged. |
| **MinIO** | Relicensed to **AGPLv3** — network copyleft reaches a hosted SaaS | Storage sits behind a `StorageDriver` interface. Dev = local filesystem. Prod = **SeaweedFS** (Apache-2.0); S3/R2 remain an *optional* paid driver. |
| **HashiCorp Vault** | **BUSL** — not open source | **OpenBao** (Apache-2.0) fork, and only in Phase 10. Phases 1–9 use an env-supplied root key. |
| npm **`xlsx`** (SheetJS) | Community build pulled from the npm registry | **exceljs** (MIT). |
| Pinecone / Weaviate Cloud | Paid SaaS | **pgvector**, inside the Postgres we already run. |
| Clerk / Auth0 | Paid SaaS at scale | **Better Auth**, self-hosted. |
| LangChain | Not paid, but heavy, unstable API, and it obscures the security-critical control flow | Hand-written gateway and agent runtime. Every tool call must pass our own permission gate — that logic has to be ours. |
| **`robots-parser`** (npm) | Not a licence problem — a *placement* one. robots.txt is egress policy, and the failure behaviour that matters (deny on 403, deny on 5xx, escape regex metacharacters in patterns) is a security decision we need to own and test, not inherit. | ~250 lines in `packages/net/robots.ts`, RFC 9309, 36 tests. |
| **Brave / Serper / Tavily / Exa** search APIs | **Paid**, and avoidable — so not bundled (§2). Scraping Google or Bing instead is ruled out flatly: their terms prohibit it, and the brief forbids bypassing a provider's terms. | **SearXNG** (AGPL, run as a service by the operator, never linked into our code) when configured; **explicit URLs** otherwise, which is the correct tool for "read these pages" rather than a degraded mode. |

### DEFERRED PAID DECISIONS (not needed until Phase 9/10)
- **Payment processor** (Stripe or equivalent). Real money movement cannot be self-hosted. It is a per-transaction fee, not a SaaS subscription. The *entitlement and credit ledger is entirely ours* and was built in Phase 9; the processor remains a thin adapter behind a `PaymentGateway` interface, and **no implementation of it exists**. The default gateway refuses and says so; a `ManualPaymentGateway` lets an administrator record a payment arranged elsewhere, attributably. §45 forbids faking the confirmation, and activating a paid plan without money moving would be the most damaging possible instance of that.
- **Transactional email.** Self-hosted SMTP has severe deliverability problems. Abstracted behind a `Mailer` interface; the decision is deferred.

---

## 3. Recommended folder structure

```
moka-ai/
├─ apps/
│  ├─ web/                 Next.js 15 — dashboard, chat, agent builder, admin
│  ├─ api/                 NestJS/Fastify — REST + SSE. The ONLY process that writes to the DB.
│  ├─ worker/              BullMQ consumers: ingest, crawl, embed, automations, agent jobs
│  └─ widget/              Embeddable chatbot bundle (vanilla TS, zero secrets, <30 KB)
├─ packages/
│  ├─ config/              Zod-validated env loader. Fails fast at boot.
│  ├─ core/                Domain types, typed errors, Result, shared Zod schemas
│  ├─ crypto/              Envelope encryption, secret redaction, fingerprinting
│  ├─ tenancy/             TenantContext, guards, RLS session binding, scoped repositories
│  ├─ db/                  Drizzle schema, migrations, RLS policies, seeds
│  ├─ ai/                  Gateway, provider adapters, model registry, router, usage meter
│  ├─ knowledge/           Parsers, chunkers, embedders, retrievers, RRF hybrid search
│  ├─ agents/              Agent runtime, tool engine, permissions, approvals
│  ├─ net/                 safeFetch — the single SSRF-guarded egress point
│  └─ ui/                  shadcn-based shared components
├─ infra/
│  ├─ docker/              compose: postgres+pgvector, valkey, seaweedfs
│  └─ sandbox/             Sandbox images (Phase 8, Linux host only)
├─ tests/
│  ├─ security/            The 10 mandatory suites from §39
│  └─ e2e/
├─ docs/                   architecture.md, security.md, database.md, roadmap.md
└─ .env.example
```

**Why `api` is a separate service rather than Next.js route handlers:**

1. Agent runs are long-lived streams with tool loops — a poor fit for route-handler lifecycles.
2. The public API (§33) needs its own API-key auth, versioning, scopes and rate limits, independent of browser sessions.
3. The embeddable widget (§22) calls cross-origin; keeping it off the Next.js origin avoids entangling CORS with application middleware.
4. **One DB-writing surface** means one place to enforce RLS binding, permission guards and audit. That is a security property, not a preference.

---

## 4. AI Gateway design (§3, §16, §17)

Strict layering — the browser never sees a provider key:

```
Browser ─▶ apps/web ─▶ apps/api ─▶ AI Gateway ─▶ Model Router ─▶ Provider Adapter ─▶ Provider API
```

**Gateway request pipeline**

1. Authenticate, then derive `TenantContext` (org, user, scopes). Never from the request body.
2. Check entitlements and credit balance (§34/§35). Reject early if exhausted. **Implemented in Phase 9, and the ordering is load-bearing**: an explicitly requested model is checked against the plan's allowlist BEFORE routing, because routing resolves credentials and would otherwise answer "no credential is configured for anthropic" to a caller whose plan simply excludes that model — the wrong answer, and a leak of which providers this deployment has.
3. Resolve the credential — Moka-managed or BYOK. Decrypt **in memory only**; never logged, never placed in prompts, never surfaced in errors.
4. `ModelRouter.select(capabilities, policy)` returns `{provider, model, fallbacks[]}`.
5. The adapter streams, producing a **normalized event union**.
6. `UsageMeter` records tokens in/out, latency and estimated cost into `usage_records`.
7. Errors map to a normalized taxonomy with secrets redacted.

**Normalized stream event union** — this is what makes providers swappable:

```ts
type GatewayEvent =
  | { type: 'text_delta';  text: string }
  | { type: 'tool_call';   id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'citation';    sourceId: string; chunkId: string; score: number }
  | { type: 'usage';       inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'error';       code: GatewayErrorCode; message: string }   // user-safe text only
  | { type: 'done';        finishReason: FinishReason };
```

Every adapter (OpenAI, Anthropic, Gemini) maps its native stream into exactly this shape. Adding a provider means one adapter file plus a registry entry — no call sites change.

**Model Router** is capability-based, not name-based. Models declare capabilities (`coding`, `reasoning`, `vision`, `long_context`, `fast`, `cheap`); requests declare requirements; the router selects by policy (organization preference → capability match → cost → latency), with a fallback chain on provider failure (§47).

---

## 5. Knowledge Engine design (§6–§14)

Three **separate** paths. Conflating them is the most common failure mode in this product category.

### Path A — Static knowledge (RAG)

```
Source → Parser → Cleaner → Chunker → Metadata → Embedder → pgvector
```

Processed asynchronously via BullMQ. State machine: `UPLOADED → PROCESSING → READY | FAILED`.

**Retrieval is hybrid, with no paid dependency:**
- Dense: pgvector HNSW, cosine distance.
- Sparse: PostgreSQL FTS (`tsvector` + GIN).
- Fusion: **Reciprocal Rank Fusion**, computed in SQL.
- Optional rerank: local ONNX cross-encoder.
- **Every query filters by `organization_id` first**, and RLS enforces it again underneath.

**Embedding-model versioning is designed in from day one.** Embeddings live in a separate table keyed by `(chunk_id, embedding_model_id)` rather than as a column on the chunk. Two models can therefore coexist during a re-embedding migration, and switching models never becomes a destructive schema change. HNSW caps at 2000 dimensions, and the model registry enforces that limit.

### Path B — Live business data (deliberately NOT RAG)

Rapidly changing data — order status, stock, price, delivery — is **never** embedded. It is fetched through typed, permissioned tools:

```
Question → Auth → Tenant check → Customer authorization → getOrder(id) → live DB → validated result → answer
```

The model never receives SQL access, a connection string, or an unbounded query tool.

### Path C — Web research *(implemented in Phase 7)*

```
Question → Search → Collect → Extract → Verify → Synthesize → Cite
              │        │                              │
              │        └─ robots.txt, then safeFetch  └─ verifyAnswer, after the fact
              └─ explicit URLs, or SearXNG if configured. Never a paid API.
```

All egress goes through `safeFetch` (SSRF-guarded) and is preceded by a robots.txt check. Citations are captured at fetch time from genuinely retrieved documents — **never generated by the model** (§9, §45).

The model is not shown URLs at all: it sees `[1] Pricing — example.com` and cites by number, so it has nothing to copy and nothing to invent. `verifyAnswer` then removes any marker naming no real source and any URL appearing in no fetched excerpt.

**When nothing was collected, the model is not called.** A question plus an instruction to cite everything plus nothing to cite is the most reliable way to produce a fabricated bibliography, and there is deliberately no fallback to answering from priors when search or fetching fails.

The pipeline is a pure orchestrator over injected collaborators — a fetcher, a robots checker, a model — so every failure path is testable without a network. See `docs/security.md` §4.6.

**Answers must state which path they came from.** Customer knowledge, live business data and external web information are labelled distinctly in the response.

---

## 6. Agent architecture (§18–§21, §26)

Agent configuration is data, not code: instructions, model policy, tool allowlist, knowledge scope, memory policy, permissions, limits, budget, approval policy.

**Runtime loop** — bounded on four axes simultaneously (max steps, max tool calls, max tokens, wall-clock timeout):

```
Request → Auth → Tenant → Load config → Assemble context
  ↳ loop:
      Plan → Select tool
        → Validate args against schema
        → Permission check (READ | DRAFT | EXECUTE)
        → Risk gate → approval required? ──yes──▶ pause, persist, await human
        → Inject tenant scope server-side
        → Execute
        → Validate output
        → Audit
      → Observe → continue or stop
→ Response → Audit
```

**Tool contract** (§19). Every tool declares name, description, input schema, output schema, permission level, risk level, tenant scope and audit requirement. There is no generic `runSql` tool, and there never will be.

**Approval engine** (§21) presents action, resource, old value, new value and reason, with Cancel and Approve. Execution happens **only** after explicit human authorization, and the decision is written to `approvals` and `audit_logs`.

Marketplace agents (§26) pass through the identical gate. Being "official" grants no privilege escalation.

---

## 6b. Customer chatbots (§22–§24)

The public chatbot reuses the agent runtime above rather than a simplified copy, because the internet-facing path is the one that most needs the real authorisation gates. What differs is the principal and the tool set, and both differences are structural.

```
Visitor's browser
  │  loader script on the customer's site (draws a launcher + iframe)
  ▼
Chat frame  ── our origin, strict CSP, frame-ancestors = deployment allowlist
  │  x-moka-key: public deployment key      (names the tenant)
  │  x-moka-visitor: conversation token     (names the conversation)
  ▼
POST /public/chat/*
  │  resolveDeployment(key)   → narrow RLS policy, NO organization bound
  │  assertOriginAllowed()    → advisory; frame-ancestors is the real control
  │  resumeConversation()     → scoped to the organization the key resolved to
  ▼
CustomerContext  ── one organization, one conversation, NO ROLE
  ▼
AgentRuntime  ── customer principal, maxSteps 4, one read-only tool
  │  search_knowledge, source allowlist captured in a CLOSURE
  ▼
decideGrounding(what retrieval ACTUALLY returned)
  │  nothing retrieved + grounding required → discard the answer, refuse honestly
  ▼
Reply + citations derived from retrieval, never from the model's own account
```

**Handoff is a deterministic endpoint behind a button**, not a tool. A person asking for a person must not depend on a model agreeing, and keeping it out of the tool set is what lets the customer tool set stay strictly read-only — nothing the model can reach writes anything.

**Cost containment matters more here than anywhere else**, because the spend lands on the organization that published the bot and the trigger is anyone who can load their home page. Bounds are constants rather than columns so no configuration mistake can raise them: 4 steps per turn, 12 replayed history messages, 60 messages per conversation, plus per-conversation and per-address rate limits from the deployment record.

See `docs/security.md` §4.5 for the boundary in full.

---

## 7. Multi-tenancy (§5)

Three enforcement layers, defence in depth:

1. **Request layer.** `TenantContext` is derived *only* from the authenticated session or API key. Any `organization_id` arriving in a body, query string or header is ignored **and logged as a security event**.
2. **Data layer.** PostgreSQL **Row-Level Security** with `FORCE ROW LEVEL SECURITY` on every tenant table. The application connects as a non-superuser role, and each transaction opens with `SET LOCAL app.current_org_id`. Policy: `USING (organization_id = current_setting('app.current_org_id')::uuid)`.
3. **Test layer.** The Tenant A/B suite runs against real PostgreSQL in CI and must fail closed.

Layer 2 is the important one: a hand-written query that *forgets* `WHERE organization_id = ...` still cannot leak data. Application correctness stops being the last line of defence.

---

## 8. Observability (§42)

pino structured JSON logs, with a **redaction serializer applied at the logger level** so a secret cannot be logged even by accident. Correlation IDs propagate end to end: `request_id`, `agent_execution_id`, `tool_execution_id`. Spans are OpenTelemetry-compatible from day one; a self-hosted collector (SigNoz, or Grafana/Loki/Tempo — both OSS) is wired in during Phase 10.

---

## 9. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **7.3 GB RAM.** Cannot run web + api + worker + Postgres + Valkey + local embeddings + Playwright concurrently. | **High** | Run Postgres and Valkey natively rather than containerised in dev. Never run the browser agent and the local embedding model together. Use Turborepo task filtering so only the needed apps start. Provider embeddings are the low-memory alternative. Plan for a larger machine before Phase 8. |
| **R2** | **No Docker/WSL2.** Blocks the sandbox (§28), browser isolation (§29) and containerised pgvector. | **High** | Virtualization is firmware-enabled, so WSL2 *is* installable (admin rights, a reboot, ~2–3 GB). Required before Phase 8; not required for Phase 1. |
| **R3** | **pgvector missing.** | **High** | Blocks Phase 2 only. Three options are laid out in `docs/roadmap.md`; the recommended path is WSL2 + Docker `pgvector/pgvector:pg17`, which also resolves R2. |
| **R4** | No MSVC Build Tools — blocks a native pgvector build and some native npm modules. | Medium | Prefer pure-JS/WASM libraries throughout (already reflected in the §2 choices), which avoids the toolchain entirely. |
| **R5** | **True sandboxing is not achievable on Windows 11 Home.** No Hyper-V, no gVisor. | **High** | Do **not** ship a fake sandbox — §45 forbids it. §27/§28 target a remote Linux runner and stay marked TODO until one exists. |
| **R6** | `LongPathsEnabled=0` combined with deep pnpm monorepo paths exceeding 260 characters. | Medium | Enable long paths via registry (admin), keep the repo at a short root, or move to the WSL2 filesystem. |
| **R7** | **Prompt injection reaching an EXECUTE-level tool.** | **Critical** | The highest-severity product risk. Retrieved content and tool output are *data, never instructions*. Tool allowlists are bound at configuration time and are not model-negotiable. Every EXECUTE action requires human approval regardless of content. Full treatment in `docs/security.md`. |
| **R8** | Embedding dimension / model lock-in. | Medium | Embeddings live in a separate table keyed by model; re-embedding is a background job rather than a migration. Designed in from the start. |
| **R9** | Cost blow-up from unbounded agent loops. | High | Four simultaneous budgets per run (steps, tool calls, tokens, wall clock), plus a per-organization credit pre-check before every provider call. |
| **R10** | **Scope.** The 10 phases as specified represent a 12–18 month programme for a team, not a short project. | **High** | Phases are independently shippable and ordered by dependency. Stated plainly so the plan is not mistaken for a sprint. |
| **R11** | Email deliverability — no SMTP infrastructure exists. | Medium | Abstracted behind `Mailer`; the decision is deferred to Phase 9. |
| **R12** | Real billing requires a payment processor, an unavoidable per-transaction cost. | Low | The entitlement and credit ledger is fully ours; the processor is a replaceable adapter. Nothing before Phase 9 depends on it. |
