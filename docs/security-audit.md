# Security audit

**Scope:** MOKA AI, phases 1–10, as of 2026-09-07.
**Method:** design review against the implementation, plus 227 automated assertions in 11 security suites and 32 in 3 operational drills, all run against real PostgreSQL 16 with the production role model.
**Auditor:** the same party that wrote the code. That is a real limitation and §11 says what it means.

---

## 1. Summary

The system's tenant isolation rests on PostgreSQL row-level security with `FORCE ROW LEVEL SECURITY`, a two-role model in which no role holds `BYPASSRLS`, and an application that can never name a tenant it was not authenticated as. That foundation is sound and is tested adversarially rather than descriptively.

Two genuine defects were found during this audit. Both were latent — neither was exploitable in the deployed configuration on the day it was found, and neither would have produced any error when it became exploitable. That is the characteristic failure mode of this architecture and is the reason the audit focused where it did.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `roles` carried `organization_id` with no RLS policy | Medium (latent) | **Fixed** — `0014_roles_rls.sql` |
| 2 | Cached credit balance diverged from the authoritative ledger | Medium | **Detected and corrected**; cause not reproducible in current code |
| 3 | No sandbox for AI-generated code | High, **accepted** | Phase 8 not built; capability absent rather than faked |
| 4 | No live provider verification | Medium, **accepted** | No provider key has ever existed on this machine |
| 5 | Rate limiting is per-process without Redis | Medium | Mitigated: production refuses to boot without `REDIS_URL` |
| 6 | Retrieval is lexical, not vector | Low (not security) | pgvector unavailable on this host |

---

## 2. What was audited

| Area | Suites | Assertions |
|---|---|---|
| Tenant isolation | 1 | 29 |
| Unauthorized tool execution | 2 | included in agent suites |
| Credential exposure | 3 | 7 |
| Credential vault | — | 25 |
| Privilege escalation | 4 | 17 |
| SSRF and robots compliance | 6 | 26 |
| Arbitrary command execution | 7 | 7 |
| Customer boundary | 8 | 25 |
| File access isolation | 9 | 15 |
| Knowledge isolation | 10 | 17 |
| Entitlement enforcement | 11 | 30 |
| RBAC synchronisation | — | 8 |
| Backup, restore, readiness, reconciliation | drills | 32 |

34 tables, 27 of them organization-scoped, all 27 with RLS **enabled and forced**, and 27 policies. The 7 without RLS carry no `organization_id` and hold no tenant data (`users`, `permissions`, `role_permissions`, `plans`, the migration ledger and similar).

Every suite is **mutation-tested**: a control is removed, the suite is re-run, and it must fail. Records in `docs/roadmap.md`.

---

## 3. Finding 1 — `roles` had no policy (fixed)

**Found by:** the readiness probe added in Phase 10, on its first execution. Not by review, and not by any of the 227 pre-existing assertions.

`roles` was created in migration `0001` with a **nullable** `organization_id`: `NULL` for the four system roles, and a value reserved for the per-organization custom roles the design anticipates. It was then never given a policy, because on the day it was written every row was a system role and nothing could leak.

**Impact.** Nothing was exposed. The first `INSERT` with a non-null `organization_id` — the first custom role anyone created — would have been readable by every other tenant, and no request would have failed to indicate it. `moka_app` holds only `SELECT` here, so this was an information disclosure (the existence and name of another organization's custom roles), not a write path.

**Why review missed it.** Every isolation review asks "does this tenant table have a policy?". `roles` does not read as a tenant table — it is a reference table that happens to have an optional tenant column. The probe does not make that judgement; it asks the catalog a mechanical question, and mechanical questions do not get tired.

**Fix.** `0014_roles_rls.sql` enables and forces RLS with:

```sql
USING (organization_id IS NULL OR organization_id = current_org_id())
WITH CHECK (organization_id = current_org_id())
```

`WITH CHECK` is deliberately stricter than `USING`: it refuses `NULL`, so that if a write grant is ever added the application still cannot mint a **system** role — which would be a privilege-escalation primitive rather than a disclosure. Foreign keys from `organization_members.role_key` are unaffected, because referential-integrity checks bypass RLS.

**Generalisation.** The class of bug is "an organization-scoped table without a policy", and it is now checked continuously rather than periodically: `Database.probe()` runs on every readiness poll, and `tests/drills/readiness.test.ts` proves the probe fires by creating such a table for real.

---

## 4. Finding 2 — credit cache diverged from the ledger

**Found by:** `infra/billing/reconcile.mjs`, on its first execution against the development database.

`credit_transactions` is the authoritative ledger — append-only, enforced by `GRANT` rather than by convention. `credits.balance_micro_usd` is a cache of its sum, because a pre-flight check before every provider call cannot sum a million rows.

The development database held a `$2.00` grant in the ledger against a cached balance of `$0.00`.

**Investigation.** The current `grant()` path was examined directly: the SQL Drizzle emits was captured and the equivalent statement executed by hand against a clean database. Both are correct — the upsert adds the amount on conflict and inserts the ledger row in the same transaction.

**Conclusion, stated at its actual strength.** The divergence is real and was corrected from the ledger. Its cause was **not reproduced** in current code, and the most likely explanation is a stale artifact from earlier Phase 9 development, before the reconciliation fix recorded in the roadmap. It is not claimed to be fixed, because no defect in current code was identified. It is claimed to be *detectable*, which is the change that matters.

**What changed as a result.** `pnpm billing:reconcile` now exists as an operator tool, and `tests/drills/reconcile.test.ts` proves it fires: it plants a real divergence and asserts a non-zero exit. The tool reports and never writes — deciding a customer's balance is a business judgement, and auto-repair would destroy the evidence of whatever caused the drift.

The tool also **refuses** to run as a role subject to RLS. With no organization bound, both tables read empty, every organization trivially reconciles, and the tool would print a confident all-clear having examined nothing. That refusal is itself asserted in the drill.

---

## 5. The control that would fail silently

Worth isolating, because it is the single highest-consequence configuration in the system.

Every tenant-isolation control reduces to *the connecting role is subject to RLS*. Point `DATABASE_URL` at a superuser and every policy stops applying — all of them, at once. Nothing errors. Every request succeeds. Every test that runs as `moka_app` still passes. The only symptom is one customer seeing another's data.

`postgres://postgres@…` is what most tutorials print and what a hurried operator reaches for when a permission error blocks a deploy, so this is a plausible mistake rather than an exotic one.

Two guards, added in Phase 10:

- **Static:** `findProductionViolations` refuses to boot in production if `DATABASE_URL` names the `postgres` user, or if `DATABASE_URL` equals `DATABASE_MIGRATION_URL` (the owner can run `ALTER TABLE … DISABLE ROW LEVEL SECURITY`).
- **Runtime:** `Database.assertRuntimeRoleIsConstrained()` asks the server whether the connected role has `rolsuper` or `rolbypassrls` and refuses to listen if so. It runs in **every** environment, not only production — a development database that quietly has no isolation is where the habit forms.

Both are asserted in `tests/drills/readiness.test.ts`, including that the refusal message names the *consequence* rather than the rule. An operator who reads "must not be a superuser" at 3am looks for the flag that turns the check off; one who reads that every tenant would be served every other tenant's data does not.

---

## 6. Areas reviewed and found sound

**Composite foreign keys.** Referential-integrity checks bypass RLS. This was found in Phase 6 as a real cross-tenant write (a source belonging to tenant B could be attached to tenant A's chatbot) and fixed by carrying `organization_id` into the key itself, making same-tenancy a referential constraint. Applied consistently in `0010` and after.

**Credential vault.** Envelope encryption, AES-GCM, with additional authenticated data binding each credential to `(organizationId, credentialId, providerId)`. A credential row copied to another organization does not decrypt. Ciphertext is byte-identical across backup and restore (asserted in the drill). The master key lives only in the environment, so a stolen backup is not a credential compromise — provided the key is not stored beside it, which `docs/operations.md` says explicitly.

**Secrets never reach the browser, the logs, the prompts or the errors.** Suite 3 asserts this against real responses, log output, traces and assembled prompts, rather than against a redaction function in isolation.

**SSRF.** Enforced at connect time via a custom `lookup`, so DNS rebinding cannot win a race between validation and connection, and re-validated on every redirect hop. Asserted through the crawler and research **features** — the way an attacker would reach it — not only against `safeFetch`. The configured-internal-host exception derives from `SEARXNG_URL` alone and remains an allowlist of exact hostnames.

**Citations.** The model cites by number and never writes a URL; the ledger maps numbers to sources afterwards, and verification happens after the fact. A model cannot fabricate a citation to a page it did not read, because it has no way to express one. With zero sources collected, the pipeline returns `NO_SOURCES` **without calling the model at all**.

**Entitlements.** Limits resolve override → plan → `not_included`, with no code fallback. `moka_app` holds only `SELECT` on the plan catalogue, so the application cannot raise the limits it is checked against. Three-state semantics (number / `null` = unlimited / absent = not included) keep "unlimited" and "not entitled" from collapsing into each other.

**Append-only ledgers.** Enforced by `GRANT`, not convention. This is why `restore.mjs` deliberately does **not** use `--no-acl`: dropping the ACLs would silently give the application the ability to rewrite its own billing history.

**No command execution.** The shipped application imports no `child_process`, `worker_threads` or `vm`, evaluates no string as code, and exposes no agent tool that runs anything. Suite 7 scans the shipped source and asserts against the real tool registry.

---

## 7. Accepted risks

Each of these is a capability the system does **not** have. §45 forbids shipping something that appears to work, so in each case nothing ships rather than something partial.

### 7.1 No sandbox (High)

Phase 8's coding agent requires genuine isolation for AI-generated code. The development machine is Windows 11 Home: no Hyper-V, no gVisor. Nothing resembling a sandbox ships in its place.

The current posture is nonetheless strong, for a reason worth stating precisely: **the safest way to survive a sandbox escape is to have nothing to escape from.** There is no `exec` to reach, no `vm` to escape, and no `eval` for a prompt to talk its way into. Suite 7 keeps that true — the day someone adds `child_process` to a service, the build fails and the conversation happens before the merge.

This is a deferral, not a solution. Phase 8 cannot ship without real isolation.

### 7.2 No live provider verification (Medium)

No provider API key has ever been present on this machine, so **this codebase has never made a live model call.** The gateway, router, credential vault and usage ledger are exercised against the provider contract — request shape, error mapping, token accounting, fallback ordering — and not against the provider.

What that leaves unverified: real error taxonomies, real rate-limit behaviour, real token counts, and real latency. Those must be validated in a staging environment with a real key before any production traffic.

### 7.3 Rate limiting is per-process without Redis (Medium)

`InMemoryRateLimiter` is genuine and works, within one process. Behind two instances it limits half of what an operator would assume. Mitigated by configuration refusing to boot in production without `REDIS_URL`; the Valkey driver itself is a `TODO`, marked as such rather than faked.

### 7.4 Single-node file storage (Medium, operational)

Uploaded files live on local disk. `REDIS_URL` makes rate limiting shared, but storage is not, so a multi-node deployment needs an object-storage driver first. Documented in `docs/operations.md` §8 rather than left to be discovered.

### 7.5 Lexical retrieval (Low)

pgvector is unavailable on this host, so retrieval is lexical rather than semantic. A quality limitation, not a security one — isolation is enforced identically either way, and suite 10 asserts it.

---

## 8. Threat model coverage

| Threat | Control | Asserted by |
|---|---|---|
| Tenant A reads Tenant B's data | RLS, forced, `NOBYPASSRLS` roles | suites 1, 9, 10; readiness probe |
| Forged `organization_id` in a request | tenant identity derived from session/key, never from the client | suite 1 |
| Cross-tenant write via a foreign key | composite FKs `(organization_id, id)` | suites 8, 10 |
| Member escalates to admin/owner | permission gate then role lattice | suite 4 |
| Prompt injection alters tool access | allowlist resolved before the model runs; observations neutralised | suite 5 |
| Agent reaches the network or the shell | no such tool exists; no `exec` in shipped code | suites 2, 7 |
| SSRF to metadata/internal services | connect-time address check, per-hop redirect re-validation | suite 6 |
| Credential theft via API, log or prompt | serializer-level exclusion; AAD-bound envelope encryption | suite 3, vault suite |
| Chatbot visitor reaches staff data | customer principal holds no role; read-only, published-only | suite 8 |
| Application raises its own limits | `SELECT`-only grant on the plan catalogue | suite 11 |
| Application rewrites billing history | append-only by `GRANT` | suite 11, restore drill |
| Backup silently empty under RLS | role-checked backup, TOC verified | backup drill |
| Restore silently drops the ACLs | no `--no-acl`, no `--no-owner`; grants re-asserted | restore drill |
| A new table ships without a policy | readiness probe queries the catalog | readiness drill |
| Balance drifts from the ledger | reconciliation tool, exit 2 | reconcile drill |
| Boot against a superuser | refuses to start, in every environment | readiness drill |

---

## 9. Not covered by any test

Stated so the coverage above is not read as more than it is:

- **Sandbox escape.** No sandbox exists (§7.1). Suite 7 asserts the *absence of the capability*, which is a different and weaker claim than "escapes fail".
- **Live provider behaviour** (§7.2).
- **Multi-instance behaviour.** Everything is exercised single-node. Shared-state assumptions behind a load balancer are unverified.
- **Denial of service under load.** Rate limits are asserted functionally, not under contention. See `docs/performance.md` for what the benchmark does and does not establish.
- **Physical and host security.** Out of scope; the deployment target is not fixed.
- **Dependency supply chain.** Lockfile is committed and versions pinned; no automated advisory scanning is wired up.

---

## 10. Recommendations

In priority order.

1. **Before any production traffic:** run `pnpm test:security` and `pnpm test:drill` against the production database, as the production roles. The readiness probe and the boot guard both catch configuration mistakes that nothing else will.
2. **Before Phase 8:** obtain a host with real isolation primitives. The coding agent is not buildable safely without one, and a partial sandbox is worse than none because it invites trust.
3. **Before charging anyone:** validate the gateway against a real provider key in staging. Token accounting and error mapping are the least-verified code in the system.
4. **Wire `pnpm billing:reconcile` into a nightly job** and alert on exit code 2. It is the only thing that will notice a drifting balance.
5. **Alert on the readiness log line** naming missing row-level security. Treat it as a data-exposure incident, not a health blip.
6. **Implement the Valkey rate limiter** before running more than one instance.
7. **Add advisory scanning** to CI.

---

## 11. On the independence of this audit

This audit was performed by the party that wrote the code, which is the weakest form of audit there is. Its findings are real and reproducible, and the two defects in §3 and §4 were both found by tools built during this phase rather than by inspection — which is some evidence that the tooling, at least, is not merely agreeing with its author.

It is not a substitute for external review. In particular, an auditor who did not write the code would be better placed to challenge the *assumptions*, and the assumptions are where this design would fail if it fails: that RLS is correctly applied to every current and future tenant table, that no code path connects as a bypassing role, and that a model's output never becomes an instruction. The first two are now continuously machine-checked. The third is not, and cannot fully be.
