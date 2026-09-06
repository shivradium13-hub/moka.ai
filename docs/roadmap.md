# MOKA AI — Development Roadmap

> **Status: Phase 1 (Foundation) COMPLETE.** Verified on 2026-09-06.
> Phase 2 is blocked on pgvector (§B1) and awaits approval.

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
