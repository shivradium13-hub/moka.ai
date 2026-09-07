# MOKA AI — Development Roadmap

> **Status: Phase 9 (SaaS) COMPLETE.** Phases 1–7 and 9 done. Phase 8 cannot
> be built on this machine (no Hyper-V, no gVisor — see the caveat below).
> Standing limits unchanged: no provider API key, so no live model call has
> been made; pgvector unavailable, so retrieval is lexical (§B1); and no web
> search engine configured, so research runs against supplied URLs (§B4).
> Verified 2026-09-07.

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

## Phase 5 — completion record (Agent Engine)

| Check | Result |
|---|---|
| Typecheck | 20/20 tasks, strict, zero errors |
| Lint | 11/11 packages, **0 errors, 0 warnings** |
| Unit tests | **407 passed** — incl. **42 in `@moka/agents`** |
| Build | 11/11 |
| Security suites | 88 passed (agent tables now covered by the RLS suite) |

### The security model, in one sentence

**An agent is a CONSTRAINT on what a user can already do — never a grant.**

Every tool call passes four gates: the tool must exist, be on that agent's
allowlist, sit within the agent's risk ceiling, **and the INVOKING USER must
hold the tool's permission**. The fourth is the one that matters and the
easiest to omit; without it, a viewer runs an admin-configured agent and
deletes projects they could never delete by hand.

`authorizeToolCall` is pure — no database, no clock, no I/O — so the entire
authorisation model is one readable function and is exhaustively testable.

### How prompt injection is actually handled

Stated plainly in the code: **prompt injection cannot be prevented at the
prompt layer.** Delimiters can be imitated; instructions can be argued with.
Everything in `prompt.ts` raises the cost of a successful injection and none of
it is the control that stops one.

So the injection suite does not test "the model resisted" — that would be
testing the model, and it would pass or fail for reasons outside our control.
Instead **it assumes the injection succeeded completely.** The scripted model
is fully compromised: it reads a malicious "policy document" and does exactly
what the document says, calling `delete_project`.

The system holds anyway, at four independent layers:

| The agent is… | Result |
|---|---|
| not allowlisted for the tool | denied — `NOT_ON_AGENT_ALLOWLIST` |
| allowlisted but read-level | denied — `EXCEEDS_AGENT_PERMISSION_LEVEL` |
| fully permitted, invoked by a **viewer** | denied — `USER_LACKS_PERMISSION` |
| fully permitted, invoked by an **owner** | **paused for human approval** |

Nothing is deleted in any of the four. Only after a human approves does it run
— and that approval is consumed, so it authorises exactly one execution.

### Mutation-tested

Gate 4 was deleted from `authorizeToolCall`: **5 tests failed**, including the
privilege-escalation case in the injection suite. Restored, back to 42 passing.
The gate is load-bearing, not decorative.

### Verified end to end

- The tool catalogue shows risk and approval requirements **to humans**;
  models are never told which tools are privileged, because that only helps an
  injected instruction pick a target
- Running an agent with no provider credential fails cleanly (503) and the run
  is still recorded with `PROVIDER_NO_CREDENTIAL`
- A **member** attempting to grant an agent `delete_project` is refused with an
  actionable `INSUFFICIENT_PERMISSION` naming the missing permission

### Smaller decisions worth recording

- **Tool outputs are schema-validated too.** A result goes straight back into
  model context, so an unexpected shape is both a correctness problem and an
  injection surface. Observations are also size-capped.
- **Arguments are validated before an approval is requested**, so a human is
  never asked to authorise a call that could not have run anyway.
- **Denials are recorded, not just successes.** A refused call is exactly the
  event worth reviewing later. `tool_executions` is append-only.
- **Malformed model output is treated as prose**, never as a guessed tool call.
  Improvising arguments for a privileged operation is the one thing that must
  not happen.
- **There is no generic `run_sql` or `fetch_url` tool.** Those turn every
  downstream control into a matter of trusting the model's judgement.
- **`max_steps` is a column, not a constant**, because a non-terminating loop
  is an agent's default failure mode.

### Deviations and gaps

| Planned | Actual | Reason |
|---|---|---|
| Agent runtime driven by a real model | Implemented; **never run against a live provider** | No API key here. The loop is verified against a scripted model, which is what made the compromised-model tests possible at all. |
| Native provider tool-use | JSON convention over the provider-agnostic `chat` | The gateway's `chat` is deliberately provider-neutral. Native tool-use per provider is Phase 5b, and the parse path is conservative in the meantime. |
| Agent builder wizard (§25) | API + read-only UI with an approval inbox | The approval inbox was the part that could not wait — a paused agent with no way to decide it is useless. The wizard belongs with the business agents in Phase 7. |
| Agent memory (§15) | Not started | Deliberately deferred; memory is its own design with its own retention and isolation questions. |

---

## Phase 6 — completion record

**Gate met.** `pnpm verify` passes, and `pnpm test:security` passes against a real PostgreSQL 17 database including the new **security suite 8 — customer boundary**.

| Check | Result |
|---|---|
| Typecheck | 22/22 tasks, strict mode, zero errors |
| Lint | 12/12 packages, 0 errors, 0 warnings |
| Unit tests | **506 passed** (`@moka/chat` 78 new, `@moka/agents` +10, `@moka/api` +11) |
| Build | 12/12 packages |
| **Security suites** | **113 passed** — customer boundary 25 new |

### What this phase actually is

Phases 1–5 had exactly one kind of principal: an authenticated member of an organization. Phase 6 adds a second one that is structurally different — an anonymous member of the public, standing on somebody else's website — and almost every decision below follows from that.

**A visitor is not a user with a low role. They hold no role at all.**

The tempting shortcut is `role: 'viewer'`. It is wrong in a way that is easy to miss: `viewer` carries `project:read`, `organization:read` and `member:read`, so a stranger on a customer's marketing page would inherit the ability to list the organization's projects and members, and the four-gate authoriser would permit every one of those calls — correctly, having been told the caller was a viewer.

So `CustomerContext` has no role field. `hasPermission` is not merely uncalled on the customer path; it does not typecheck. `authorizeToolCall` branches on a `Principal` union, and the customer branch asks three questions that all default to no: is the tool `customerSafe`, is it read-only, and is it free of an approval gate.

### The five structural controls

| Control | Why it is structural rather than advisory |
|---|---|
| **Role-less principal** | Nothing reachable from a visitor's context can produce a permission. |
| **`customerSafe` opt-in** | A tool added to the platform is unreachable by the public until someone writes the flag and a reviewer sees it. The risk check re-derives publishability from what the tool *does*, catching a mis-declared entry at call time. |
| **Retrieval scope as a closure** | The public `search_knowledge` captures its source allowlist. The model cannot widen it because there is no argument naming it. |
| **Grounding checked afterwards** | The answer is discarded if retrieval returned nothing, however confident the model was. The prompt asking it not to invent is the nudge; this is the control. |
| **Rendering behind an origin boundary** | Model output never renders in the customer's own origin, so an escaping bug in our renderer cannot become XSS on their site. |

### The one narrow public read path

A visitor arrives holding only a public key, so the organization cannot be bound until that key is looked up — the same chicken-and-egg as "which organizations do I belong to?" in Phase 1. It gets the same answer: a **narrow RLS policy**, not `BYPASSRLS`, not a `SECURITY DEFINER` function.

    USING (organization_id = current_org_id()
           OR (current_org_id() IS NULL
               AND public_key = current_deployment_key()
               AND status = 'active' AND revoked_at IS NULL))
    WITH CHECK (organization_id = current_org_id())

The `current_org_id() IS NULL` guard is what stops it widening tenant queries, and a test pins that: tenant B binds its own organization *and* presents tenant A's key, and sees only its own rows. `WITH CHECK` is untouched, so the public path reads one row and writes nothing. Revocation is effective immediately rather than eventually, because `status = 'active'` is part of the policy.

### A real bug the suite found

The test "a chatbot cannot be attached to another tenant's knowledge source" **failed**: the insert succeeded.

PostgreSQL performs referential integrity checks with row security disabled — documented and deliberate, since otherwise a foreign key would leak the existence of invisible rows through constraint violations. So `REFERENCES knowledge_sources(id)` was satisfied by any source in the installation, and the RLS policy on the join row only checked *its own* `organization_id`, which tenant A's row satisfied.

Nothing leaked today: `knowledge_chunks` is itself RLS-protected and the service checks ownership before writing. But "two independent controls happen to save us" is not "this cannot happen".

`0010_chat_tenant_integrity.sql` carries `organization_id` into the key itself. A composite `FOREIGN KEY (organization_id, source_id)` makes same-tenancy a *referential* constraint rather than a policy — which holds in the one place policies do not apply. The same shape exists on some Phase 1–5 joins; that is recorded in `docs/security.md` as a known item rather than folded into this phase.

### Mutation testing

| Mutation | Result |
|---|---|
| Removed `current_org_id() IS NULL` from the deployment policy | **1 test failed** — the guard test, exactly as intended |
| Replaced the customer branch with `hasPermission('viewer', …)` | **7 unit + 2 security tests failed**, including "a viewer outranks a visitor" and "refuses every shipped staff tool" |

### Verified end to end against the running stack

- Widget loader served with `cross-origin-resource-policy: cross-origin` — required, and easy to miss, because helmet's `same-origin` default would otherwise make every customer's browser refuse it with nothing but a console warning
- Chat frame CSP carries a **per-response** style nonce and a **per-deployment** `frame-ancestors`; an unknown key still renders, framed by nobody, so a 404-vs-200 difference cannot be used to sort real keys from invented ones
- Session from a non-allowlisted origin → `403`, with a `chat.origin_not_allowed` security event naming the presented origin
- Session from `https://shop.example.com.evil.net` → `403` (the suffix trap)
- Session with **no** `Origin` header → `403`
- Session from the allowed origin → visitor token issued
- Forged visitor token → `403`; valid token with an unknown public key → `404`, before the token is considered
- Handoff button → conversation moves to `awaiting_human` and appears in the staff inbox
- Staff reply stored as role `human` with the author's user id, so a transcript never blurs which sentences a person wrote
- A second organization: conversation list empty, transcript by id `404`, chatbot list empty

### Deliberately not built

| Not built | Why |
|---|---|
| **Authenticated end-customer identity** (order lookup, "where is my parcel") | Needs a customer-authentication mechanism that does not exist yet, and authorization checked against that authenticated identity rather than an identifier typed into the chat. Building the lookup first would be building the vulnerability. Phase 7. |
| **Scheduled retention purge** | The job queue needs Valkey, which needs Docker (§B2). Shipping a timer that dies with the process, while an operator believes their retention policy is running, would be worse than an honest button (§45). The endpoint exists and works; the schedule does not. |
| **Streaming replies** | The gateway's streaming path exists but has never been driven by a live provider. Wiring a token stream to a public surface without once seeing it work is how you ship a widget that hangs. |
| **A chatbot preview inside the app** | Would need a live model to be anything but theatre. |

### Not verified

**No live model call has been made.** There is still no provider API key here, so the public chat path has been exercised against a scripted model and against the real gateway with no credential — which produces the honest failure: the visitor gets *"I'm having trouble answering right now. If you'd like, I can pass this to a person"*, the error code is recorded, and no answer is fabricated. What a real model does with the public system prompt is unknown.

The widget's browser behaviour — shadow DOM, iframe, `postMessage`, `sessionStorage` — has **not been exercised in a browser**. The assets are served with the right headers and their source is asserted on (no `innerHTML`, no `eval`, no secrets, no wildcard `postMessage` target), but nobody has clicked the launcher.

`infra/docker/compose.yml` remains untested for the same reason as every prior phase.

---

## Phase 7 — completion record

**Gate met.** `pnpm verify` passes, and `pnpm test:security` passes against a real PostgreSQL 17 database including the new **security suite 6 — SSRF**.

| Check | Result |
|---|---|
| Typecheck | 24/24 tasks, strict mode, zero errors |
| Lint | 13/13 packages, 0 errors, 0 warnings |
| Unit tests | **697 passed** (`@moka/research` 141 new, `@moka/net` +36, `@moka/agents` +15) |
| Build | 13/13 packages |
| **Security suites** | **151 passed** — SSRF 38 new |

### The honest problem at the top of this phase

Path C is "question → search → collect → extract → verify → synthesize → cite". Every stage is buildable with no paid dependency except the first, and there is no way to pretend otherwise:

| Option | Verdict |
|---|---|
| Brave / Serper / Tavily / Exa / Bing APIs | Good, cheap, and **paid**. The brief permits paid services only where technically unavoidable, and this one is avoidable. None is bundled. |
| Scraping Google or Bing | **Ruled out flatly.** The brief says never bypass a provider's terms, and their terms prohibit it. It would also break without warning and take a tenant's crawl down with it. |
| **SearXNG, self-hosted** | FREE and open source. AGPL — run as a service, never linked into our code, so the licence obligation stays with the operator's own deployment. Supported, and the recommended configuration. |
| **Explicit URLs** | No engine at all. Always available, needs nothing. |

So the default is explicit URLs, SearXNG is used if the operator configures one, and **research works out of the box with sources a person names rather than appearing to work by inventing them**. `GET /v1/research/capabilities` reports which is configured, and the UI says "no search engine is configured" rather than offering a keyword box that silently returns nothing.

For the most common real request — "read these three competitor pages and tell me what they say" — explicit URLs are not a fallback. They are the correct tool.

### Gate 1 — no fabricated citations

The model never writes a URL. It writes `[3]`.

Every URL in a finished answer comes from a ledger of documents actually fetched: final URL after redirects, fetch time, SHA-256 of the bytes, and the exact excerpt placed in the prompt. What the model *sees* is `[1] Pricing — example.com` — a number, a title and a host. Not the URL, because putting the string we are trying to stop it producing directly into its context makes copying it the path of least resistance.

`verifyAnswer` then runs on what it actually said:

- a `[n]` naming no ledger entry is **removed** and reported;
- an absolute URL appearing in no fetched excerpt is **removed** and reported;
- a quotation absent from the source it cites is **flagged**, not deleted, because models paraphrase inside quotation marks and deleting on a miss would mangle honest answers.

**And when nothing was collected, the model is not called at all.** Handing a model a question, an instruction to cite everything, and nothing to cite is the single most reliable way to produce an invented bibliography. The same applies when search fails: there is deliberately no fallback to "answer anyway".

The UI shows the correction rather than hiding it. It would look better to quietly strip a fabricated citation and present a clean answer; it would also mean a user never learns that the model invents sources, which is the single most useful thing for them to know when deciding how much to trust the paragraph in front of them.

### Gate 2 — SSRF, tested through the features

`packages/net` already tested `safeFetch` in isolation. Suite 6 tests the thing historically more likely to be wrong: that the features which make outbound requests actually go through it, and that the guard holds when reached the way an attacker reaches it — a research URL, a crawl seed, a redirect from a page we were legitimately reading.

A guard that is correct and bypassed is not a guard. Most SSRF incidents are not a broken IP check; they are a second code path that forgot to call it.

### robots.txt is an egress control, not a courtesy

`packages/net/robots.ts` implements RFC 9309 — group matching, longest-match precedence with Allow winning ties, `*` and `$` wildcards, `Crawl-delay`. It sits beside `safeFetch` because both are egress policy: SSRF rules decide which addresses we may dial, robots rules decide which paths we are permitted to.

The failure policy is the part that matters. 404 permits; **401/403 and 5xx deny**. A server that will not show us its rules has not invited us to guess them, and crawling blind because we could not read them is the cautious reading in reverse.

Pattern matching escapes regex metacharacters before compiling — a robots pattern is attacker-controlled text from a third-party site.

### A misattribution found during verification

The first end-to-end SSRF test reported every blocked address as `robots_disallowed`. Technically the robots check *had* refused it — because fetching `robots.txt` from `169.254.169.254` is itself blocked, and an unreadable robots.txt denies by default. Two controls in the right order, and a wrong explanation.

It was still wrong to report. "Their robots.txt disallows it" is a false statement about a publisher that does not exist, and it hides the real cause from the operator reading the result. `RobotsService` now rethrows an egress refusal instead of folding it into a policy decision, and the pipeline re-classifies it as `blocked`.

The user-facing detail stays coarse in both cases: a caller who can tell "blocked because private" from "blocked because it did not resolve" has a working internal port scanner.

### Business agent templates (§25, §26)

A template is a **name, instructions, a risk ceiling and a tool allowlist** — nothing else. It creates an ordinary agent row, and an agent built from an official template passes through exactly the same authorisation gates as one typed in by hand. §26 requires that; the cheapest way to guarantee it is for there to be no other gate.

The list is shorter than the brief's, because a template can only be honest about tools that exist:

| Template | What it actually is |
|---|---|
| Research assistant | The Path C pipeline. |
| Website analyst | Reads a site you have crawled. Cannot edit or publish. |
| Sales research assistant | Researches a prospect and drafts an approach. **Not connected to a CRM** — there isn't one. |
| Marketing writer / Social drafter | Draft only. **Nothing can publish anything**, and the instructions say so, because a model claiming to have posted something is the failure that embarrasses a user in public. |
| Workspace analyst | Reports on **this workspace**. Not Google Analytics. |
| Project assistant | The only one above READ, and DRAFT rather than EXECUTE. |

Every template carries a `limitations` list, it is never empty, and `validateTemplates` fails a test if one is. The builder shows it as prominently as the summary. A picker that lists six capabilities and no limits sells a product that does not exist, and the user finds out from a wrong answer instead of from us.

`web_research` is deliberately **not** `customerSafe`. A public chatbot able to call it would be an open SSRF and traffic-amplification proxy, driven by strangers and billed to the organization that published the bot. A test asserts every tool in every template is refused for a customer principal.

### A new permission

`research:run`, granted to member and above — **not** to viewer. Research is not a read of our data: every run spends provider tokens and sends requests from our address range to whoever is being researched. Both are things a viewer should not be able to cause.

### Mutation testing

| Mutation | Result |
|---|---|
| Stop re-validating redirect hops in `safeFetch` | **3 security tests failed** — every redirect-escape case |
| Answer anyway when nothing was collected | **5 unit + 6 security tests failed** |
| Accept any citation marker without checking the ledger | **2 unit tests failed** |
| Render model output as HTML in the chat widget (Phase 6 control, re-checked) | **2 unit tests failed** |

### Verified end to end against the running stack, and against real sites

- Research aimed at `169.254.169.254`, `127.0.0.1:55432`, `localhost:4000`, `file:///etc/passwd` and `example.com:6379` → **all five refused**, no model called, and every refusal attributed to the address rather than to a publisher
- Crawl of `https://example.com/` → 1 page fetched, 1 indexed with its source URL recorded, and the one outbound link correctly rejected as off-host
- Crawl of a Wikipedia path its robots.txt disallows → **0 pages fetched**, refusal reported with reason `robots`
- Crawl of an SVG → fetched, correctly refused as not a readable document
- IANA's `Disallow:` (empty, meaning "allow everything") correctly read as permissive — one of the parser traps, confirmed in production
- Research against a real page → collected successfully, then failed at the provider with `PROVIDER_NO_CREDENTIAL`, which is the honest state with no API key
- Agent created from the `research` template with the template's ceiling and tools; an unknown `templateId` rejected with a message naming the field rather than silently creating a tool-less agent

### Deliberately not built

| Not built | Why |
|---|---|
| A bundled search provider | The good ones are paid and the free ones prohibit scraping. Adding a paid adapter is a decision for whoever runs this, not a default. |
| Asynchronous crawling | The job queue needs Valkey, which needs Docker (§B2). The page and byte budgets are what keep a crawl inside one request; the default of 50 pages is chosen so it finishes, not because 50 is the right number. |
| A shared robots.txt cache | Same reason. Per-process caching is a real limitation behind multiple instances, not a correctness problem — every instance reaches the same decision from the same file. |
| Sitemap-driven crawling | Parsed out of robots.txt and stored, not yet used to seed a crawl. |
| A relevance threshold on excerpts | With no dense retriever (§B1) there is no embedding to score with, and a similarity number computed from nothing would be worse than the honest keyword window in use. |

### Not verified

**No live model call has been made.** There is still no provider API key, so synthesis has only run against a scripted model — which is what made the fabrication tests possible at all, since a real model sometimes behaves and a test that passes for that reason is a test of the model.

**The SearXNG adapter has never spoken to a real instance.** There is none here and running one needs Docker (§B2). It follows the documented request and response shape and is tested against a local server speaking that shape — the same approach taken for the provider adapters in Phase 3, and honest about the same gap.

The **fetch, extract, robots and SSRF halves are verified against real sites**, which is the half this phase's gates are about.

---

## Phase 9 — completion record

**Gate met.** `pnpm verify` passes, and `pnpm test:security` passes against a real PostgreSQL 17 database including the new **security suite 11 — entitlement enforcement**.

| Check | Result |
|---|---|
| Typecheck | 26/26 tasks, strict mode, zero errors |
| Lint | 14/14 packages, 0 errors, 0 warnings |
| Unit tests | **762 passed** (`@moka/billing` 64 new) |
| Build | 14/14 packages |
| **Security suites** | **181 passed** — entitlement enforcement 30 new |

### The gate, and the thing it is easiest to misread

"Entitlement enforcement tests; no hard-coded limits."

Every commercial limit is a row, resolved at call time: override → plan → deny. There is deliberately **no third fallback to a code constant**, because that constant would be the hard-coded limit the design exists to remove, and it would take over silently the moment somebody forgot to seed a plan.

But the gate does **not** mean every number becomes purchasable. Two kinds of limit live in this codebase and conflating them would be the worst possible reading:

| | Examples | Where they live |
|---|---|---|
| **Entitlements** | agents, chatbots, AI credit, seats, storage | Database rows. Selling more of them is the business model. |
| **Safety ceilings** | the public chatbot's 4-step budget, crawler page and depth maxima, SSRF blocked ranges, upload cap | **Constants, and they stay constants.** |

Making a safety ceiling purchasable would mean selling a weaker security posture to whoever pays most — the enterprise tier would be the one whose chatbot can be driven into an unbounded loop by a stranger. `SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS` names them, and two tests assert none has become a feature key or a seeded row.

### The escalation this had to rule out

The thing being limited must not be able to raise its own limit — and that is a **grant**, not a code review:

```sql
GRANT SELECT ON plans, plan_entitlements, entitlement_overrides TO moka_app;
```

A bug able to `UPDATE plan_entitlements` would not be a limit bypass in one place. It would be every limit at once, silently, with the enforcement code still passing its own tests. Six tests in suite 11 assert the application cannot insert, update or delete a plan, an entitlement or an override — including trying to grant *itself* one.

The consequence is deliberate: overrides are granted out of band by someone with database access. There is no self-service path to a higher limit, and the absence of an endpoint is backed by the absence of a privilege.

### Counting at the moment of the check

`currentUsage` runs a real `SELECT count(*)` every time rather than reading a cache. That is the difference between an enforced limit and a decorative one: with a cache, a customer at their limit can create one more of everything on every instance holding a stale count. It costs a query per creation, which is rare and is not on the per-token path.

### The credit ledger

`credit_transactions` is authoritative; `credits.balance_micro_usd` is a cache of its sum, because a pre-flight check on every provider call cannot sum a million rows. Suite 11 reconciles them.

- Append-only: `SELECT` and `INSERT`, no `UPDATE`, no `DELETE`.
- **Sign discipline is a database constraint.** A `debit` of +500 would silently add credit *and reconcile perfectly against a wrong balance* — obvious in review, invisible in production.
- An adjustment must carry a reason; an unexplained one is indistinguishable from a mistake six months later.
- Integer micro-dollars throughout.

### Two honest limitations, handled rather than hidden

**Concurrency.** The cost of a call is unknown until it returns, so the pre-check is a *balance* check and a burst can each pass it before any debits. The bound is one call per concurrent request. The debit is a single atomic `UPDATE` so none is lost; the balance is allowed to go **negative** because clamping would conceal the overspend; and the next pre-check refuses. Reserving a pessimistic maximum instead would make usable credit a fraction of what was bought.

**Unpriced calls.** `estimateCost` returns null rather than inventing a figure when a model's pricing is missing. Charging a guess invents a number people budget against; charging zero silently makes that model free and unlimited — the cheapest possible exploit, since a customer need only use whichever model nobody has priced. So a zero-amount debit flagged `unpriced` is written, the balance pre-check still requires positive credit, and both the usage page and the plan panel say "N calls could not be priced". The gap surfaces as the registry bug it is.

`0013_unpriced_debits.sql` exists because 0012's sign constraint — correct for every charging debit — forbade exactly this row. Relaxed in one direction only: a debit may be zero **if and only if** it is flagged unpriced.

### Payment: not implemented, and not pretended

§45 forbids a fake payment confirmation, and the most damaging instance would be here — activating a paid plan without money moving means real credit, real provider calls, no revenue.

`UnavailablePaymentGateway` is the default and refuses with an explanation rather than queueing something that never completes. `ManualPaymentGateway` (`BILLING_MANUAL_PAYMENTS=true`) lets an administrator record that payment was arranged elsewhere — invoice billing and self-hosted deployments are how most likely customers would pay — and it is honest because a *person* asserts it, attributably, into the audit log and a log line that says "without an online payment".

A downgrade to the free plan is always permitted without a gateway. Refusing a cancellation because no processor is configured would be a hostage-taking.

### A real bug found during verification

The model allowlist was checked inside the provider fallback loop. `planRoute` resolves credentials as part of choosing a model and throws before that loop is entered, so a caller asking for a model their plan excludes was told **"no credential is configured for anthropic"** — the wrong answer, and a small leak of which providers the deployment has.

Architecture §4 puts entitlements at step 2 and credentials at step 3, and this is why that order is not decorative. An explicitly requested model is now checked before routing; the per-candidate check stays inside the loop, because the router may fall back to a model the plan excludes and checking only the primary would make the fallback path a way around the allowlist.

### A second bug, in the seed

`pnpm db:seed` had stopped being idempotent despite its own header promising it was. The cause is the same shape as the empty-membership bug from Phase 1: `SELECT id FROM organizations WHERE slug = $1` runs unbound, RLS correctly returns zero rows even when the row exists, and the seed then inserted a duplicate.

Fixed with the narrow policy that already exists for exactly this — bind `app.current_user_id` and read the organizations that user belongs to (`0002_user_scope.sql`). No new privilege and no RLS exception.

### Mutation testing

| Mutation | Result |
|---|---|
| `GRANT INSERT, UPDATE, DELETE` on the catalogue to `moka_app` | **8 security tests failed** — every "cannot edit" case, plus the resolution tests once a mutation wrote a row |
| A missing entitlement row resolves to `unlimited` | **3 unit tests failed** |

### Verified end to end against the running stack

- A new organization lands on the **free** plan with a $2.00 allowance, both taken from the catalogue by key rather than written in code
- Second chatbot → `402 QUOTA_EXCEEDED`, *"Your plan includes 1 chatbots. You are using 1."*
- Third agent → `402`; fourth project → `402`, each naming the limit and current usage so a UI can render an upgrade prompt rather than a wall
- A model the free plan excludes → `402` **before** any provider is contacted
- A drained balance → `402` on a permitted model, before the credential is resolved
- Plan change with no processor → `changed: false` and a message saying plainly that nothing was charged
- With `BILLING_MANUAL_PAYMENTS=true`, an administrator activation succeeds, the new limits apply immediately from data, and the log records the acting user id beside *"subscription activated without an online payment"*

### Deliberately not built

| Not built | Why |
|---|---|
| A Stripe (or any) card adapter | Real money movement is a per-transaction fee, not a licensing problem — it is simply not built, and §45 forbids faking the confirmation. The interface and the webhook requirements are written down where whoever implements it will read them. |
| A self-service "add credit" endpoint | It would be a self-service way to spend somebody else's provider quota. |
| An admin UI for entitlement overrides | An override raising your own limit is the escalation this phase exists to prevent. Granting one is a database action by someone with database access. |
| A scheduled monthly allowance | The job queue needs Valkey, which needs Docker (§B2). The endpoint exists, is idempotent per period, and the UI says plainly that allowances are issued on demand — an operator who believed they renewed automatically would find out from an outage. |
| Seat enforcement | The count query and the entitlement exist, but there is no invitation flow yet, so there is no creation path to enforce at. Enforcing nothing would be worse than saying so. |
| `usage_records` monthly partitioning | Planned in `docs/database.md` and still not done. A performance item for Phase 10, not a correctness one. |

### Not verified

**No live provider call has been made**, so no credit has ever been debited from a real cost. The debit path is exercised by unit tests and by the pre-check refusing at zero; what a real token bill does to the balance is unknown.

The plan **numbers** are a plausible starting shape, not a pricing decision. Nobody has done the unit economics, and the free tier's $2 allowance in particular is a guess at "enough to evaluate the product". Presenting them as considered would be the false precision this codebase avoids elsewhere.

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

### B4 — No web search engine (limits Phase 7 research, does not block it)
No search engine is configured. There is deliberately no bundled provider: the good ones are paid, and scraping the free ones violates their terms (§2). Research therefore runs against URLs a user supplies, which is the correct tool for "read these pages and tell me what they say" and is not a degraded mode for it.

To enable keyword search, run a **SearXNG** instance (FREE, open source, AGPL — run as a service, so the obligation stays with the operator's deployment) and set `SEARXNG_URL`. It may be a private address; that exception is derived from the config value alone and never from a request. Docker makes this easiest, so B2 makes B4 easier too.

The UI reports which mode it is in rather than offering a keyword box that silently returns nothing.

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
| **6 — Customer Chatbot** *(COMPLETE)* | Builder, widget bundle, deployments, support agent, customer boundary, handoff | **Security suite 8** ✅; widget contains no secret ✅ | Phase 5 |
| **7 — Business Agents** *(COMPLETE)* | Templates, Path C research pipeline, website crawler, agent builder | **Security suite 6 (SSRF)** ✅; no fabricated citations ✅ | Phases 5, 6 |
| **8 — Advanced AI** | Coding agent, sandbox, browser agent, MCP, agent-to-agent | **Security suites 7, 9** | **B2 resolved + a Linux host** |
| **9 — SaaS** *(COMPLETE)* | Plans, entitlements, credits, usage dashboard, enforcement, billing boundary | **Security suite 11** ✅; no hard-coded limits ✅ | Phase 5 |
| **10 — Production** | Security audit, performance and load testing, backup and restore drill, failure recovery, deployment, monitoring | Full security suite + restore drill | All |

### Phase 8 caveat
Phase 8 cannot be completed on the current machine. Windows 11 Home has no Hyper-V and no gVisor, so genuine isolation for AI-generated code is unavailable. Per §45 we will not ship a stub that merely appears to sandbox. The coding agent and sandbox stay explicitly marked TODO and disabled until a Linux host exists.

### Honest scope note
The full ten-phase programme is 12–18 months of work for a team, not a short project. Phases are ordered by dependency and each is independently shippable, so value lands continuously rather than only at the end.

---

## Working rules for every task (§44)

1. Inspect the relevant files. 2. Understand dependencies. 3. Write a short plan. 4. Implement. 5. Run tests. 6. Typecheck. 7. Lint. 8. Build where applicable. 9. Review security. 10. Fix failures. 11. Summarise changes.

No fake implementations (§45). Anything unimplemented is marked `TODO` and reported as unimplemented — never presented as working.
