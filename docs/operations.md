# Operations

Deployment, backup, restore, failure recovery and monitoring for MOKA AI.

This is a runbook, not an overview. It is written for somebody who is tired, possibly at 3am, and needs the next command rather than the philosophy. Where a step has a non-obvious reason, the reason is given — because a step whose purpose is not understood is a step that gets skipped when it is inconvenient.

---

## 1. The one thing to get right

Everything else in this document is recoverable. This is not:

**The application must connect to PostgreSQL as `moka_app`, and `moka_app` must not be a superuser and must not hold `BYPASSRLS`.**

Every tenant-isolation control in this system reduces to "the connecting role is subject to row-level security". Point `DATABASE_URL` at a superuser and every policy stops applying — not some of them, all of them, at once.

The failure is completely silent. Nothing errors. Every request succeeds. Every test that runs as `moka_app` still passes. The only symptom is one customer seeing another customer's data, and you learn about it from them.

Two guards exist because of how quiet that failure is:

- `loadConfig()` refuses to boot in production if `DATABASE_URL` names the `postgres` user.
- `Database.assertRuntimeRoleIsConstrained()` runs at boot in **every** environment, asks the server directly whether the connected role can bypass RLS, and refuses to listen if it can.

If a deploy fails with *"Refusing to start: the application connects as …"*, do not work around it. Fix the connection string.

---

## 2. Deployment

### 2.1 Prerequisites

| Component | Version | Cost |
|---|---|---|
| PostgreSQL | 16+ | FREE (open source) |
| Node.js | 20+ | FREE |
| pnpm | 9+ | FREE |
| Valkey (or Redis) | 7+ | FREE (Valkey is BSD; required in production) |

No paid third-party service is required to run this system. The only necessary paid items are a server, a domain, and provider API usage, which each organization supplies for itself through Moka Credentials.

### 2.2 First-time database setup

Run once, as a superuser. This creates the two roles and the database:

```bash
psql -f infra/db/bootstrap.sql
```

The two-role model matters and is not ceremony:

| Role | Owns | Used by | Bypasses RLS |
|---|---|---|---|
| `moka_migrator` | every table | migrations only | no (`NOBYPASSRLS`) |
| `moka_app` | nothing | the running application | no (`NOBYPASSRLS`) |

`moka_migrator` owns the tables, and a table owner is exempt from its own policies unless `FORCE ROW LEVEL SECURITY` is set — which is why every policy in this schema sets it. The application never connects as the owner, because the owner can run `ALTER TABLE … DISABLE ROW LEVEL SECURITY`.

### 2.3 Migrate

```bash
pnpm db:migrate
```

Migrations run as `moka_migrator` (`DATABASE_MIGRATION_URL`). They are append-only and checksum-verified: editing an already-applied migration is refused rather than silently re-applied. If you need to change something that has shipped, write a new migration.

### 2.4 Configure

Copy `.env.example` to `.env` and fill it in. Generate the two secrets rather than inventing them:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`ENCRYPTION_KEY` is the master key for the credential vault. **If you lose it, every stored provider credential is unrecoverable** — that is the design, not a limitation. Back it up somewhere that is not this server and not this repository.

Production refuses to start unless all of the following hold. Each is refused because the failure is silent, not because the rule is tidy:

| Setting | Required | Because |
|---|---|---|
| `REDIS_URL` | set | the in-memory rate limiter is per-process, so behind two instances it limits nothing |
| `DATABASE_SSL` | `true` | otherwise every row travels in the clear |
| `API_HOST` | not `127.0.0.1` | loopback-only means unreachable |
| `CORS_ORIGINS` | no `localhost`, no `http://` | a plaintext origin means session cookies in the clear |
| `DATABASE_URL` | not the `postgres` user | see §1 |
| `DATABASE_MIGRATION_URL` | different from `DATABASE_URL` | the owner can switch RLS off |
| `ANTHROPIC_API_KEY` etc. | unset | instance-wide keys make per-tenant cost, quotas and revocation fictional |
| `LOG_LEVEL` | not `debug`/`trace` | verbose logs capture request context and outlive it |

### 2.5 Build and start

```bash
pnpm verify
```

```bash
pnpm build && node apps/api/dist/main.js
```

`pnpm verify` runs typecheck, lint, unit tests and build. It does **not** run the security suites or the drills — those need a live database and are separate on purpose (see §6).

---

## 3. Backup

```bash
pnpm db:backup
```

### 3.1 Why the backup script insists on a superuser

This is the sharpest edge in the whole operational surface, so it is worth stating exactly.

Under `FORCE ROW LEVEL SECURITY`, what `pg_dump` produces depends on the role and the flags, and the three cases behave very differently:

| Role | Flags | Result |
|---|---|---|
| non-superuser | default | **exits 1** with a permission error |
| non-superuser | `--enable-row-security` | **exits 0, and the dump is EMPTY of tenant rows** |
| superuser | default | exits 0, all rows present |

The middle row is the dangerous one. It is a successful-looking backup, of the right shape, with a plausible file size, containing schema and no data. You find out at restore time.

So `infra/db/backup.mjs` checks the **role**, not the exit code: it refuses to run as any role lacking `rolsuper` or `rolbypassrls`, and it verifies the dump's table of contents before reporting success. A backup script that trusts an exit code is how a company discovers it has a year of empty backups.

### 3.2 What the backup contains

A custom-format `pg_dump` including roles, grants, policies and ownership. Credential ciphertext is included; the master key (`ENCRYPTION_KEY`) is **not** — it lives in the environment. A stolen backup is therefore not a credential compromise, provided the key was never stored beside it. Do not store them together.

---

## 4. Restore

```bash
pnpm db:restore -- --file=<dump> --database=<name>
```

Restoring over a production database additionally requires `MOKA_ALLOW_PRODUCTION_RESTORE=1`. A restore is the one operation that destroys data faster than any attacker, and the guard is deliberately awkward.

### 4.1 Why the restore does NOT use `--no-owner` or `--no-acl`

Those two flags appear in most restore instructions on the internet, and using them here would produce a database that starts, serves traffic, passes a smoke test, and has no tenant isolation.

`--no-acl` drops the `GRANT`s. Several controls in this system **are** grants rather than application logic:

- the usage and credit ledgers are append-only because `moka_app` holds `INSERT` and `SELECT` and no `UPDATE` or `DELETE`;
- the plan catalogue cannot be edited by the application because `moka_app` holds only `SELECT` on it.

Restore without the ACLs and the application silently gains the ability to rewrite its own billing history and raise the limits it is checked against.

`--no-owner` changes who owns the tables, which changes who `FORCE ROW LEVEL SECURITY` applies to.

`infra/db/restore.mjs` therefore preserves both, and checks that `moka_app` and `moka_migrator` exist before it starts — restoring grants for roles that do not exist yet produces warnings that are easy to scroll past.

### 4.2 After every restore

```bash
pnpm test:drill
```

The drill asserts, against the restored database, that RLS is enabled **and forced** on every tenant table, that the policies are identical to the source, that the helper functions exist, that the critical grants survived, that cross-tenant isolation still holds, and that credential ciphertext is byte-identical.

Do not skip this because the restore printed no errors. The failure modes above all print no errors.

---

## 5. Failure recovery

### 5.1 Readiness says `not_ready`

`GET /health/ready` returns 503 with a coarse body. The detail is in the log, deliberately — the endpoint is unauthenticated and must not become a reconnaissance surface.

| Body | Meaning | Action |
|---|---|---|
| `database: "failed"` | the pool cannot execute a statement | check PostgreSQL, network, credentials |
| `schema: "failed"` | an organization-scoped table has no RLS | **treat as a data-exposure incident**, see below |
| `schema: "unknown"` | the check could not run | investigate; do not read this as a pass |
| `rateLimiter: "per-process"` | no `REDIS_URL` | limits are per-instance only |

`schema: "failed"` means a table with an `organization_id` column has row-level security missing or not forced. Every query against that table returns every tenant's rows. Find the named table in the log, take the instance out of rotation, and write the migration. This is the failure that readiness exists to catch, and it is the one that will not announce itself any other way.

### 5.2 Liveness and readiness are not interchangeable

`/health` (liveness) consults **nothing**. If it reported the database's state, then a database outage would fail liveness on every instance, the orchestrator would restart all of them in a loop, and a recoverable outage would become a reconnect storm against a database that is already struggling.

`/health/ready` consults dependencies and is what the load balancer should use. Do not point a liveness probe at it.

### 5.3 The database is up but every query returns nothing

Almost always a missing tenant binding. Every policy resolves through `current_org_id()`, and when `app.current_org_id` is unset, policies match nothing and queries return zero rows. The system fails **closed** — an empty result is the safe failure, not a broken one.

Look for a query issued outside `withTenant()` / `withCustomer()`.

### 5.4 A provider credential stops working

Credentials are envelope-encrypted with AES-GCM, and the additional authenticated data binds each one to `(organizationId, credentialId, providerId)`. A credential row copied to another organization does not decrypt — that is the AAD doing its job, not corruption. Restoring a single credential row across tenants is not possible by design.

If `ENCRYPTION_KEY` changed, nothing decrypts. Restore the key; there is no recovery path without it.

---

## 6. Test gates

| Command | Needs | Runs in |
|---|---|---|
| `pnpm verify` | nothing | every commit, CI |
| `pnpm test:security` | live PostgreSQL | CI, before release |
| `pnpm test:drill` | live PostgreSQL + superuser | after any restore, before release |

The suites **fail rather than skip** when they cannot establish their preconditions. A silently skipped isolation test is worse than a failing one: it reports green while testing nothing.

Mutating a control to check that a suite catches it requires **rebuilding the package first** — the suites import `@moka/*` from `dist`, so editing source alone changes nothing the test can see. A mutation that appears "not caught" is usually a stale build.

---

## 7. Monitoring

What is worth alerting on, in rough order of how badly you want to know:

| Signal | Source | Severity |
|---|---|---|
| `readiness failed: … missing row-level security` | log | **page immediately** — data exposure |
| boot refusal: *"connects as … superuser"* | stderr, process exits | **page immediately** |
| `/health/ready` 503 sustained | probe | high |
| credit ledger vs. cached balance divergence | `pnpm billing:reconcile` | high — the ledger is authoritative |
| SSRF block on a user-supplied URL | log | informational; a spike is worth a look |
| robots.txt fetch failures | log | informational |
| approval queue depth | `agent_approvals` | product signal |

Logs are structured JSON with a request id echoed in `x-request-id`, so a user can quote an id from an error and it can be found.

**Secrets never appear in logs.** Credential values, master keys and provider keys are excluded at the serializer, not by redacting after the fact. Security suite 3 asserts this against real responses, logs, traces and prompts.

---

## 8. What is not covered here

Stated plainly rather than implied by omission (§45):

- **No sandbox.** The Phase 8 coding agent needs real isolation, which cannot be built on the current development machine (Windows 11 Home: no Hyper-V, no gVisor). Nothing that merely resembles a sandbox ships in its place.
- **No horizontal-scaling runbook.** The system is single-node today. `REDIS_URL` makes rate limiting shared, but local file storage is not, so a multi-node deployment needs an object-storage driver first.
- **No live provider verification.** No provider API key has ever been present on this machine, so no live model call has been made by this codebase. The gateway, router and ledger are exercised against the provider contract, not against the provider.
