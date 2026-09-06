# MOKA AI

Multi-tenant AI workspace and AI workforce platform.

> **Standalone product.** MOKA AI shares no code, data, users, APIs, business
> logic, branding or configuration with any other product.

**Status: Phase 1 (Foundation) complete.** Authentication, organizations,
multi-tenancy, RBAC, auditing and the base UI are implemented and tested.
No AI functionality exists yet — see [docs/roadmap.md](docs/roadmap.md).

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
  config/    Zod-validated environment loader.
  crypto/    Envelope encryption, Argon2id, token hashing.
  db/        Drizzle schema, SQL migrations, RLS policies, seeds.
  tenancy/   Tenant context enforcement helpers.
infra/db/    Bootstrap SQL and the dev cluster script.
tests/       Security suites (run against real PostgreSQL).
docs/        Architecture, security, database, roadmap.
```

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
