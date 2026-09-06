# MOKA AI — Development Roadmap

> **Status: Phase 4 (Moka Credentials) COMPLETE.** Phases 1–4 done, with two
> standing limits: no provider API key exists here, so no live model call has
> been made; and pgvector is unavailable, so retrieval is lexical (§B1).
> Verified 2026-09-06.

---

## Phase 1 — completion record

**Gate met.** `pnpm verify` (typecheck → lint → test → build) passes, and
`pnpm test:security` passes against a real PostgreSQL 17 database.

| Check | Result |
|---|---|
| Typecheck | 12/12 tasks, strict mode, zero errors |
| Lint | 7/7 packages, 0 errors, 0 warnings |
| Unit tests | **107 passed** (core 39, crypto 32, config 14, tenancy 13, api 9) |
| Build | 7/7 packages |
| **Security suites** | **44 passed** — tenant isolation 29, credential exposure 7, RBAC sync 8 |

### The isolation suite was proven to fail

A passing security test is worthless if it cannot fail. RLS was disabled on the
`projects` table alone and the suite was re-run: **16 tests failed**, including
`Tenant A queries Tenant B's project by id`, which returned a row instead of
none. RLS was restored and the suite returned to green. The tests are
load-bearing, not decorative.

### Verified end to end against the running stack

- Unauthenticated request to a protected route → `401`
- Wrong password and unknown account → byte-identical `INVALID_CREDENTIALS` response
- Tenant A reading Tenant B's project by id → `404`
- Tenant A deleting Tenant B's project → `404`
- **Tenant A creating a project with a forged `organizationId` in the body →
  the forged value was ignored, the project landed in Tenant A, and a
  `security.tenant.client_supplied_identity` event was logged with the
  violation location**
- Tenant A switching to Tenant B's organization → `403`
- Browser sign-in through the UI → tenant-scoped dashboard renders

### Two real bugs found and fixed during verification

1. **Membership list returned empty.** `listMemberships` used an unbound
   connection, which RLS correctly reduced to zero rows, so users saw no
   organizations. The fix was *not* to grant `BYPASSRLS`, which would have
   defeated the whole design, but to express the exception as a narrow policy
   (`0002_user_scope.sql`): a session may bind `app.current_user_id` and read
   its own membership rows, and only while no organization is bound. Six tests
   now pin that boundary, including one asserting the user branch is suppressed
   the moment an organization is bound.
2. **Organization slug uniqueness check was silently ineffective**, for the
   same reason. Replaced with insert-and-retry against the unique index, which
   also avoids leaking the existence of other tenants' organizations.

`Database.withSystemScope()` was **removed** as a result. It was a
bypass-shaped API that turned out to be unusable under `FORCE ROW LEVEL
SECURITY` anyway — keeping it would have been a footgun with no purpose.

### Deviations from the Phase 1 plan, and why

| Planned | Actual | Reason |
|---|---|---|
| Better Auth | Hand-rolled sessions (Argon2id, server-side, revocable) | Integrating Better Auth into NestJS added unverifiable risk. The requirements here — httpOnly cookies, hashed random tokens, per-request membership re-verification — are small, auditable, and fully tested. |
| `@node-rs/argon2` | `hash-wasm` (pure WebAssembly) | No MSVC build tools on this machine (R4). A native module without a prebuilt binary would fail to install. WASM removes the failure mode entirely. |
| drizzle-kit migrations | Hand-written SQL + a small runner | Policies, GRANTs and role ownership must land in the *same transaction* as the tables they protect. A generated diff cannot express that. drizzle-kit remains available for reviewing diffs. |
| `exactOptionalPropertyTypes` | Not enabled | Enabled `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. `exactOptionalPropertyTypes` fights NestJS and Drizzle typings hard enough that the cost outweighed the benefit. Recorded rather than silently dropped. |
| Valkey for rate limiting | In-memory driver behind a `RateLimiter` interface | Valkey needs Docker (R2). The in-memory driver genuinely works for single-process development, and `@moka/config` **refuses to boot in production without `REDIS_URL`** so it cannot silently become the production limiter. Marked TODO, not faked (§45). |
| Docker Compose for local infra | `infra/db/dev-cluster.mjs` | Docker is not installed. The script creates a loopback-only PostgreSQL cluster under `./local/pgdata` on port 55432 needing no superuser password. `infra/docker/compose.yml` exists for Phase 2 but is **untested** — there is no Docker here to test it with. |

### Known gaps carried into Phase 2

- `infra/docker/compose.yml` and `infra/db/bootstrap-docker.sql` are unverified.
- Member invitations and role editing exist in the API and are covered by RBAC
  tests, but have no UI yet.
- The Valkey-backed rate limiter is not implemented.
- Security suites 2, 5, 6, 7, 9, 10 belong to later phases and do not yet exist.

---

## Phase 2 — completion record (partial: text side complete, vector side blocked)

**Gate met.** Security suite 10 (knowledge isolation) passes against real
PostgreSQL. `pnpm verify` and `pnpm test:security` both pass.

| Check | Result |
|---|---|
| Typecheck | 14/14 tasks, strict, zero errors |
| Lint | 8/8 packages, 0 errors, 0 warnings |
| Unit tests | **226 passed** (knowledge 100, core 39, crypto 32, web 19, config 14, tenancy 13, api 9) |
| Build | 8/8 |
| **Security suites** | **63 passed** — tenant isolation 29, **knowledge isolation 19**, credential exposure 7, RBAC sync 8 |

### What the pgvector blocker did NOT stop

The Phase 0 design put embeddings in their own table keyed by
`(chunk_id, embedding_model_id)` rather than as a column on the chunk. That
decision was made so the embedding model would not be baked into the schema —
and it turned out to mean the entire text side of the Knowledge Engine could
ship and be tested without pgvector at all.

Delivered and verified:

- **Parsers** for TXT, Markdown, JSON, CSV/TSV, HTML, **PDF** and **DOCX**.
  PDF and DOCX are tested against real format-conformant fixtures, not text
  with a misleading extension.
- **Chunking** that never splits mid-sentence where a boundary exists, carries
  the heading breadcrumb *inside* the chunk text, never merges across
  headings, overlaps consecutive chunks, and force-splits pathological input.
- **Sparse retrieval**, already fused with **RRF** across two real retrievers:
  `ts_rank_cd` over a generated tsvector, and trigram similarity for typo
  tolerance. Adding the dense list later is one more entry in the same call.
- **Storage driver** with server-generated, tenant-prefixed keys.
- **Ingestion**: validate → store → parse → chunk → index, with SHA-256
  deduplication.
- **Knowledge UI**: sources, upload (file and paste), document list, chunk
  inspector, and a retrieval playground showing which retriever matched at
  which rank.

### Mutation-tested, again

RLS was disabled on `knowledge_chunks` alone: **9 tests failed**, including a
trigram search returning another tenant's chunk and a cross-tenant INSERT
succeeding. Restored, back to 63 passing. The suite is load-bearing.

### Verified end to end against the running stack

- PDF and Markdown ingested through the API → chunked → retrievable
- Query "how long do I have to request a refund" returned the correct chunk
  first, with breadcrumb `Refund Policy > Eligibility` and RRF signals
  `{fulltext: 1, trigram: 1}`
- Re-uploading identical bytes deduplicated instead of duplicating chunks
- **Tenant B searching for Tenant A's exact content returned zero chunks**
- Tenant B reading A's source → 404; uploading into A's source → 404
- Unsupported file type rejected with the list of accepted formats

### Bug found and fixed during verification

Tenant B opening Tenant A's source page returned **500 instead of 404**.
`serverApiOrNull` swallowed only 401/403, so the API's correct 404 propagated
as an unhandled error. No data leaked — the isolation held — but the wrong
status is both poor UX and a needless signal. Fixed by treating 404 as
"unavailable" (under RLS a foreign resource *is* genuinely invisible, so 404
is the right answer), and the predicate was moved into a pure module so it
could be regression-tested. That test now exists.

Hardening the same module also surfaced that `buildUrl` accepted
protocol-relative paths (`//host/x`). Not exploitable — concatenation keeps
them on the API origin as a path — but rejected now regardless.

### Deviations and honest gaps

| Planned | Actual | Reason |
|---|---|---|
| Dense retrieval, HNSW, RRF over dense+sparse | Sparse only; `denseAvailable: false` reported everywhere | pgvector unavailable (§B1). The API and UI both state plainly that matching is lexical rather than semantic — never claimed otherwise (§45). |
| Async ingestion via BullMQ | Runs **inline** in the request | Valkey needs Docker (§B2). Bounded by the 25 MB cap; the status column already models the async lifecycle, and the method is shaped to move behind a queue unchanged. |
| Multipart upload | Base64 JSON | Multipart arrives with the queue-backed pipeline. Encoded size is checked *before* decoding. |
| Website crawler with SSRF protection | Not started | Deferred to Phase 2b — it is a security-heavy component and deserved its own pass rather than being rushed alongside the pipeline. |
| OCR for scanned PDFs | Not implemented | Detected and reported as a warning ("N pages contained no extractable text") rather than silently ingesting an empty document. |
| `xlsx` support | Not implemented | `exceljs` was not added; CSV covers the tabular case for now. Listed rather than half-built. |

`packages/db/drizzle/_blocked/0004_embeddings.sql` contains the vector schema,
written but **never executed**. It sits outside the migration sequence so it
cannot half-apply or apply out of order. It is unverified; review before use.

---

## Phase 3 — completion record (gateway complete; live provider calls unverified)

| Check | Result |
|---|---|
| Typecheck | 18/18 tasks, strict, zero errors |
| Lint | 10/10 packages, **0 errors, 0 warnings** |
| Unit tests | **365 passed** (net 89, knowledge 100, ai 50, core 39, crypto 32, web 19, config 14, tenancy 13, api 9) |
| Build | 10/10 |
| Security suites | 63 passed (unchanged — Phase 3 added no tenant tables beyond `usage_records`) |

### `packages/net` — the SSRF guard, finally built

The ESLint rule banning raw HTTP clients has pointed at `@moka/net` since
Phase 1, but the package did not exist. It does now, and **89 tests** cover it.

DNS rebinding is defeated properly: validation runs in the undici Agent's
`lookup` hook, so the address checked is the address connected to, with no
window in between. The obvious design — resolve, check, then `fetch` — loses
that race, because `fetch` resolves again.

The test suite is the standard bypass repertoire: IPv4-mapped IPv6
(`::ffff:169.254.169.254`), decimal/octal/hex encodings, CGNAT, NAT64, ULA,
link-local, cloud metadata for four providers, and redirect-to-metadata
verified against a real local server.

**Two real bugs the tests caught:**

1. Mapped IPv6 addresses were blocked only because IPv6 parsing *failed*, not
   because they were unwrapped — and that also wrongly blocked mapped **public**
   addresses. Fixed by decoding the dotted-quad tail properly.
2. Changing `assertSafeUrl` to an options object created a silent footgun: an
   array structurally satisfies an all-optional type, so `assertSafeUrl(url,
   ['host'])` compiled and applied **no allowlist**. Now throws, with a
   regression test.

### The gateway

Provider-agnostic types, a code-based model registry, capability routing with
fallback, normalised errors, and integer-micro-dollar cost accounting.
Adapters for Anthropic and OpenAI use the official SDKs.

Adapters are tested against **local servers speaking each provider's documented
wire format** — request shape, SSE parsing, usage mapping, error normalisation.
That tests our half; it does not test theirs.

### Honesty about money and capability

- **Anthropic pricing** is real, with a cited source and date.
- **OpenAI/Google pricing could not be verified here**, so those models carry
  `pricing: null`, cost reports as `known: false`, and `usage_records.cost_micro_usd`
  is `NULL` — which means *unknown*, not free. Token counts are still recorded
  in full so cost can be backfilled. A fabricated dollar figure is worse than a
  missing one, because people budget against it.
- `GET /v1/ai/models` reports `available: false` for every provider without a
  credential, so the UI cannot offer a model that will fail.

### Correct current Anthropic API shape

Taken from the bundled `claude-api` reference rather than memory: adaptive
thinking (`thinking: {type:'adaptive'}`), `output_config.effort`, and **no
`budget_tokens`** — which is rejected with a 400 on Opus 5 / Sonnet 5 /
Fable 5.1 / Opus 4.7+. A test asserts `budget_tokens` never appears in a
request. The pinned SDK was also far too old (0.68 → 0.124) to type adaptive
thinking at all.

### Three bugs found during end-to-end verification

1. **`ProviderError` collapsed to a 500.** It is not an `AppError`, so the
   exception filter's catch-all swallowed it: "no provider configured" returned
   an opaque 500. Now mapped centrally — 503 for configuration, 502 for
   upstream auth, 429 for throttling, 400 for bad requests — with the precise
   normalised cause in `details.providerCode`.
2. **`code: "INTERNAL"` on a 400.** The machine-readable field contradicted the
   status. Added `PROVIDER_ERROR`, with throttling still reported as
   `RATE_LIMITED` so generic 429 retry logic keeps working.
3. **Streaming reported routing failures as a generic error.** `planRoute` ran
   outside the generator's `try`, so a "no credential" failure escaped after
   the SSE headers were already sent. Moved inside; the client now receives
   `PROVIDER_NO_CREDENTIAL` as a normal stream event.

### What is NOT verified

**No provider API key exists in this environment, so no live call has ever been
made.** Untested against real providers: authentication, real streaming
behaviour, rate-limit headers, real token accounting, and refusal handling.
The adapters are written to the documented contracts and tested against
fixtures of those contracts — that is the strongest claim available here.

### Deviations

| Planned | Actual | Reason |
|---|---|---|
| Gemini adapter | Registered in the catalogue, **adapter not implemented** | Listed as unavailable rather than half-built. Anthropic and OpenAI prove the abstraction; a third adds surface without adding confidence while none can be run. |
| Per-organization credentials | Instance-wide env vars | Moka Credentials is Phase 4. `CredentialsService.resolve()` already takes a `TenantContext` it does not yet use, so the vault drops in without touching callers. |
| Usage dashboard UI | API only (`GET /v1/ai/usage`) | Endpoint returns per-model totals plus recent calls, including an `unpricedCalls` count so the UI can say "cost unknown for N calls" instead of under-reporting. |

---

## Phase 4 — completion record (Moka Credentials)

| Check | Result |
|---|---|
| Typecheck | 18/18 tasks, strict, zero errors |
| Lint | 10/10 packages, **0 errors, 0 warnings** |
| Unit tests | 365 passed |
| Build | 10/10 |
| **Security suites** | **88 passed** — incl. **credential vault 25** |

### The design decision that carries the phase

`credentials.id` has **no database default**. The ciphertext's AES-GCM
Additional Authenticated Data binds it to
`(organization_id, credential_id, provider_id)`, so the id must exist *before*
the secret is encrypted — a generated default would mean encrypting against an
id we do not yet know.

That binding is what makes database tampering fail closed. An attacker with
**write** access to Postgres still cannot read another tenant's key, because
moving the ciphertext invalidates it. Four tests cover each axis, plus one that
performs the whole attack: physically copying Tenant A's encrypted bytes into a
row Tenant B owns, then trying to decrypt as Tenant B. It fails — the
cryptography refuses, not an application check.

### Verified end to end against the running stack

- Storing a key returns only `fingerprint`, `lastFour`, and status
- **The plaintext appears nowhere**: not in any database column, not in the
  audit log, not in the API log, not in the rendered HTML
- The audit trail records `providerId`, `name`, `fingerprint`, `lastFour` — and
  nothing else
- Adding a key flips `anthropic` to available; **revoking it flips availability
  straight back to empty**
- Revocation is one-way; re-enabling returns 409
- Tenant B sees no credentials, no providers, and gets 404 revoking Tenant A's key
- A duplicate key is rejected by fingerprint, without confirming the stored value

### Precedence, and why that order

Vault credentials **beat** environment variables. The reverse would mean an
operator's stray `ANTHROPIC_API_KEY` silently overriding every tenant's own key
and billing all their traffic to the instance owner. The env fallback is also
refused outright in production: one shared key across tenants defeats
per-tenant attribution, quota and revocation.

### Smaller decisions worth recording

- **The DEK is never cached.** A per-organization key held in a process-wide
  map is one bug away from the wrong tenant. Unwrapping is a single AES-GCM
  operation — microseconds against a provider network call.
- **A stored BYOK endpoint is re-validated at use time**, not only at write
  time, because the SSRF ruleset can tighten after a row was written.
- **A failed decrypt is a security event, not a routine error.** It means a row
  does not belong where it sits. Logged as such; the credential is treated as
  unusable and nothing about the stored bytes surfaces.
- **Revoke and delete are separate.** Revocation keeps the record for audit;
  deletion honours "remove my key from your systems". The audit row survives
  either way, because it never held the secret.
- **`credentials_revoked_consistent`** is a database CHECK: a revoked row must
  have a revocation timestamp, so "is it revoked?" has one answer rather than
  two fields that can disagree.

### Deviations and gaps

| Planned | Actual | Reason |
|---|---|---|
| Test connection verified against a live provider | Implemented, **never run successfully** | No API key exists here. The path is exercised: it decrypts, calls the adapter, records the result, and returns a normalised reason. What it does against a real key is unverified. |
| Per-credential permission scopes | Not implemented | Credential management is gated on `ORG_UPDATE`/`ORG_DELETE`. Finer scoping belongs with the API-key work in Phase 9 rather than being invented now. |
| Google adapter | Credential type accepted; **no adapter** | Consistent with Phase 3 — a key can be stored, but `describeSource` will report it unusable for chat until the adapter exists. |

---

## 0. Blockers to clear before Phase 2

Three environment gaps must be closed. **None of them block Phase 1**, so work can start immediately while these are arranged.

### B1 — pgvector is not installed (blocks Phase 2)

| Option | Effort | Trade-off |
|---|---|---|
| **A. WSL2 + Docker, run `pgvector/pgvector:pg17`** *(recommended)* | ~1 hour, admin rights, reboot, ~3 GB | Also unblocks B2 and the Phase 8 sandbox. Costs ~1–2 GB RAM while running — significant on a 7.3 GB machine. |
| B. Build pgvector from source for the native Windows PostgreSQL 17 | ~1–2 hours | Requires installing MSVC Build Tools (~2–6 GB). Keeps memory use low by reusing the existing native Postgres. No Docker, so B2 stays open. |
| C. Managed Postgres with pgvector (Neon/Supabase free tier) | ~15 min | Fastest, zero local memory. But it is an external dependency, free tiers have limits, and tenant data leaves the machine. Contradicts the self-hosted goal. |

**Recommendation: Option A.** It is the only one that also resolves B2 and the sandbox requirement, so it is one setup instead of three. If RAM pressure proves prohibitive, fall back to Option B.

### B2 — No Docker / WSL2 (blocks Phase 8; needed for Valkey)
Virtualization is enabled in firmware, so WSL2 is installable. Required for the sandbox and browser-agent isolation. Valkey can alternatively run as a native Windows build (Memurai or a Valkey Windows port) if Docker is deferred.

### B3 — Long paths disabled
`LongPathsEnabled = 0`. A deep pnpm monorepo can exceed the 260-character limit. Fix by enabling long paths in the registry (admin, one reboot), or keep the repo root short — `D:\Ai` already is, which mitigates most of this.

---

## Phase 1 — Foundation *(COMPLETE — see the completion record above)*

**Goal:** a running, typed, tested, multi-tenant skeleton with authentication and organizations. No AI yet.

**Definition of done:** Tenant A cannot see Tenant B data, proven by an automated test running against real PostgreSQL, and `typecheck`, `lint`, `test` and `build` all pass.

### 1.1 Repository and tooling
- `git init`; `.gitignore` (`.env` excluded, `.env.example` committed).
- `corepack enable pnpm`; pnpm workspaces + Turborepo.
- TypeScript **strict** (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint, Prettier.
- Lint rule banning raw `fetch`/`axios` outside `packages/net`, and banning raw pool access outside `packages/db`.
- Vitest configured; CI-equivalent script `pnpm verify` = typecheck → lint → test → build.

### 1.2 `packages/config`
Zod-validated environment loader that **fails fast at boot** with a readable message naming the missing variable. Rejects any `NEXT_PUBLIC_` name that looks like a secret.

### 1.3 `packages/db` — schema and RLS
- Drizzle schema for the Phase 1 subset: `users`, `organizations`, `organization_members`, `roles`, `permissions`, `role_permissions`, `sessions`, `projects`, `audit_logs`.
- Migration creates the `moka_app` non-superuser role (no `BYPASSRLS`).
- **RLS policies created in the same migration as each table.**
- `audit_logs` granted `INSERT`/`SELECT` only.
- Seed script: two organizations with distinct data, for the isolation test.

### 1.4 `packages/tenancy`
- `TenantContext` type and derivation from session or API key.
- Transaction wrapper issuing `SET LOCAL app.current_org_id`.
- Scoped repository base; raw pool access is not exported.
- Interceptor rejecting and logging any client-supplied `organization_id`.

### 1.5 `packages/crypto`
- AES-256-GCM envelope encryption with AAD binding.
- Per-organization DEK generation and wrapping at organization creation.
- Redaction serializers for pino and the error handler.
- Unit tests including a **negative test**: a ciphertext moved to another organization's row must fail to decrypt.

### 1.6 `apps/api` — NestJS on Fastify
- Bootstrap, security headers, CORS policy, request-ID middleware, pino logging with redaction.
- Global exception filter: typed errors, user-safe messages, no stack traces in production, request ID returned.
- Better Auth: email/password (Argon2id), sessions, organizations, invitations, membership.
- Guards: `AuthGuard` → `TenantGuard` → `PermissionGuard`, in that order.
- Rate limiting backed by Valkey.
- Endpoints: auth, organizations, members, invitations, projects, current user, health.
- Audit interceptor writing on every mutation.

### 1.7 `apps/web` — Next.js 15
- App Router, Tailwind v4, shadcn/ui components copied in.
- Login, signup, organization switcher, members, projects, settings shell, empty dashboard.
- Server-side session handling. **No provider keys or secrets reach the client.**
- UI permission state is presentation only; enforcement stays server-side.

### 1.8 Infrastructure
- `infra/docker/compose.yml` for PostgreSQL 17 + pgvector and Valkey (used once B1/B2 are resolved; native services work meanwhile).
- `.env.example` documenting every variable with a comment.

### 1.9 Tests — the Phase 1 gate
- Unit: crypto, config validation, permission evaluation, tenant derivation.
- Integration against real PostgreSQL: auth flows, organization CRUD, membership.
- **Security suite 1 — tenant isolation.** Tenant A attempts to read and write every Tenant B resource, including a forged `organization_id` in body, query, header and path. Also asserts directly at the SQL layer that a query *without* an org predicate returns zero rows under RLS.
- **Security suite 3 (partial) — credential exposure.** No secret appears in any response, log or error.

### 1.10 Verification
`pnpm verify` must pass end to end. **Phase 1 does not close while any security test fails.**

**Realistic estimate:** 3–5 focused working days.

---

## Phases 2–10

Each phase closes only when its work is implemented, typed, tested, linted, built, documented, authorized, tenant-safe, error-handled and logged (§48).

| Phase | Scope | Gate | Depends on |
|---|---|---|---|
| **2 — Knowledge Engine** | Source system, uploads, parsers (PDF/DOCX/TXT/CSV/XLSX/JSON/MD/HTML), chunking, embeddings, pgvector, hybrid retrieval + RRF, knowledge UI, async pipeline | **Security suite 10** — Tenant A knowledge never surfaces for Tenant B | B1 resolved |
| **3 — AI Gateway** | Provider abstraction, OpenAI/Anthropic/Gemini adapters, model registry, normalized streaming, capability router, fallbacks, usage tracking | Adapter conformance suite; provider-failure normalization | Phase 1 |
| **4 — Moka Credentials** | Vault UI, encryption, BYOK, test/rotate/revoke, audit | **Security suite 3** in full | Phase 3 |
| **5 — Agent Engine** | Runtime loop, tool engine, permission levels, approval engine, budgets, audit | **Security suites 2, 5** | Phases 3, 4 |
| **6 — Customer Chatbot** | Builder, widget bundle, deployments, support agent, customer authorization, handoff | **Security suite 8**; widget contains no secret | Phase 5 |
| **7 — Business Agents** | Sales, analytics, website, marketing, social, research templates; Path C research pipeline | **Security suite 6 (SSRF)**; no fabricated citations | Phases 5, 6 |
| **8 — Advanced AI** | Coding agent, sandbox, browser agent, MCP, agent-to-agent | **Security suites 7, 9** | **B2 resolved + a Linux host** |
| **9 — SaaS** | Plans, entitlements, credits, usage dashboard, enforcement, billing adapter | Entitlement enforcement tests; no hard-coded limits | Phase 5 |
| **10 — Production** | Security audit, performance and load testing, backup and restore drill, failure recovery, deployment, monitoring | Full security suite + restore drill | All |

### Phase 8 caveat
Phase 8 cannot be completed on the current machine. Windows 11 Home has no Hyper-V and no gVisor, so genuine isolation for AI-generated code is unavailable. Per §45 we will not ship a stub that merely appears to sandbox. The coding agent and sandbox stay explicitly marked TODO and disabled until a Linux host exists.

### Honest scope note
The full ten-phase programme is 12–18 months of work for a team, not a short project. Phases are ordered by dependency and each is independently shippable, so value lands continuously rather than only at the end.

---

## Working rules for every task (§44)

1. Inspect the relevant files. 2. Understand dependencies. 3. Write a short plan. 4. Implement. 5. Run tests. 6. Typecheck. 7. Lint. 8. Build where applicable. 9. Review security. 10. Fix failures. 11. Summarise changes.

No fake implementations (§45). Anything unimplemented is marked `TODO` and reported as unimplemented — never presented as working.
