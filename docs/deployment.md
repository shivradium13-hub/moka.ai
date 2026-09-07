# Deployment

How to get MOKA AI running, and — more importantly — **which piece goes where**.

---

## 1. The short version

MOKA AI is two deployable units with different shapes, and they do not belong on the same kind of host.

| Unit | What it is | Vercel? |
|---|---|---|
| `apps/web` | Next.js 15. Pure API client: no database access, no server routes, one workspace dependency. | **Yes.** This is exactly what Vercel is for. |
| `apps/api` | NestJS on Fastify. Long-running process, connection pool, local disk, in-request agent loops. | **No.** Three things break silently. §3 says which. |

So: **web on Vercel, API on a container host, PostgreSQL managed.**

That is not a limitation of Vercel. It is what the API currently is — a stateful server that writes to disk and holds a pool. Putting it on a serverless platform would produce something that boots, serves traffic, passes a smoke test, and quietly loses every uploaded file.

---

## 2. Deploying the web app to Vercel

### 2.1 What you need first

The web app is a **client**. It is useless without an API to talk to, and the API's address is baked in at build time (`NEXT_PUBLIC_API_URL` is inlined into the bundle, not read at runtime). So deploy the API first, or expect to redeploy the web app once you have its URL.

### 2.2 Import the repository

The repo has no git remote yet. Push it somewhere Vercel can read, then import the project at [vercel.com/new](https://vercel.com/new).

**Set Root Directory to `apps/web`.** This is the one setting that matters. Vercel then reads `apps/web/vercel.json`, which handles the monorepo:

```json
"installCommand": "cd ../.. && pnpm install --frozen-lockfile",
"buildCommand":   "cd ../.. && npx turbo run build --filter=@moka/web..."
```

The `...` suffix is not decoration — it tells Turborepo to build `@moka/web` **and its dependencies**. `@moka/core` resolves to `dist/`, so a build that skipped it would fail on a missing module. Verified from a clean tree: 11 tasks, ~39s cold.

### 2.3 Environment variables

Only one is required:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com` | The deployed API's origin. No trailing slash. |

**Set it before the first build.** `NEXT_PUBLIC_` variables are inlined at build time, so changing it later needs a redeploy, not a restart.

### 2.4 The build refuses to publish secrets

`apps/web/next.config.mjs` runs `findLeakyPublicVars` — the same function that stops the API booting with a leaky variable — and **throws** if any `NEXT_PUBLIC_` name looks like a secret (`secret`, `password`, `token`, `api_key`, `private`, `credential`, `encryption`, `database_url`, `_dsn`).

This matters more on a hosting platform than it does locally. Environment variables get set in a dashboard by whoever has access, and anything `NEXT_PUBLIC_` is shipped to every visitor's browser. A `NEXT_PUBLIC_ENCRYPTION_KEY` added in a hurry would be published to the internet by the next deploy.

It throws rather than warns, deliberately: a warning in build output is a line nobody reads; a failed deploy is a conversation.

```
Error: Refusing to build: these NEXT_PUBLIC_ variables look like secrets and
would be inlined into the browser bundle, where every visitor can read them:
NEXT_PUBLIC_ENCRYPTION_KEY.
```

### 2.5 After it deploys

Add the Vercel domain to the API's `CORS_ORIGINS`, or every authenticated request will fail at the browser. The app's routes authenticate by cookie, so CORS is doing real work there — it is what stops another site making authenticated requests with a user's session.

---

## 3. Why the API does not go on Vercel

Not a matter of taste. Three concrete things break, and the first two break **silently**, which is the failure mode this codebase spends the most effort avoiding.

### 3.1 Every uploaded file would be lost

`IngestionService` constructs `LocalStorageDriver(config.STORAGE_LOCAL_PATH)` unconditionally. `STORAGE_DRIVER=s3` is accepted by the config schema and then **ignored** — the S3 driver is an open TODO (`Phase 2b`), because the obvious candidate (MinIO) is AGPLv3 and that licence reaches a hosted SaaS.

A serverless filesystem is read-only except `/tmp`, and `/tmp` does not survive the invocation. So an upload would return `200`, write bytes that immediately cease to exist, and fail at retrieval. The Knowledge Engine would look like it worked.

**Needed first:** an S3-compatible storage driver.

### 3.2 Rate limiting would be worse than none

Production config **refuses to boot without `REDIS_URL`** — a guard added precisely so the in-memory limiter could not silently become the production limiter. But `ValkeyRateLimiter` is still a TODO. Only `InMemoryRateLimiter` exists.

On one long-running box that means "per-process", which is a real limitation and is documented as one. On serverless it means **per-invocation** — every request potentially gets a fresh empty bucket, so there is effectively no rate limiting at all, while the config gate makes the deployment look correctly configured. A limit that reports as present and is absent is worse than one that is honestly missing.

**Needed first:** the Valkey/Redis rate limiter.

### 3.3 It is a server, not a handler

`main.ts` calls `app.listen()` and holds a `pg.Pool`. Serverless needs an exported handler, and each concurrent instance would open its own pool — exhausting Postgres connections without a pooler in front.

Two smaller consequences follow. `assertRuntimeRoleIsConstrained()` runs at boot, which on serverless means on every cold start, adding a `pg_roles` round trip each time. And agent runs, crawls and research all execute **inline in the request** — a 10-step agent loop against a real provider will exceed Vercel's function ceiling routinely.

### 3.4 What to use instead

Any host that runs a container or a long-lived Node process: Railway, Render, Fly.io, or a plain VPS. `pnpm build && node apps/api/dist/main.js` is the whole runtime story. See `docs/operations.md` for the deployment, backup and monitoring runbook.

---

## 4. The database

PostgreSQL 16+, managed is fine (Neon, Supabase, RDS, or your own). What is **not** optional is the two-role model.

Run `infra/db/bootstrap.sql` as a superuser to create them:

| Role | Owns | Used by | Bypasses RLS |
|---|---|---|---|
| `moka_migrator` | every table | migrations only | no (`NOBYPASSRLS`) |
| `moka_app` | nothing | the running API | no (`NOBYPASSRLS`) |

**The application must connect as `moka_app`.** This is the single highest-consequence setting in the system: every tenant-isolation control reduces to "the connecting role is subject to row-level security". Point `DATABASE_URL` at a superuser and every policy stops applying at once — nothing errors, every request succeeds, and one customer is served another customer's data.

Managed providers hand you an owner-ish role by default (`neondb_owner`, `postgres`), and using it directly is the mistake this guard exists for:

```
Refusing to start: the application connects as "postgres", which is a superuser.
```

The process exits `1` and binds nothing. Fix the connection string; do not work around it.

### 4.1 Connection pooling

If you put a pooler in front (Neon's pooled endpoint, PgBouncer, Supabase's `:6543`), use **transaction mode**. Tenant binding uses `set_config('app.current_org_id', $1, true)` — the `true` makes it transaction-local, which is exactly what survives transaction-mode pooling. Session mode also works; statement mode does not.

### 4.2 Migrate and verify

```bash
pnpm db:migrate
```

```bash
pnpm test:drill
```

Run the drill against the deployed database, as the deployed roles. It asserts that RLS is enabled **and forced** on every tenant table, that the grants making the ledgers append-only survived, and that the boot guard refuses a bypassing role. A restore or a provider migration that quietly dropped ACLs is exactly what it catches.

---

## 5. Production configuration checklist

The API refuses to start in production unless all of these hold. Each is refused because the failure is silent, not because the rule is tidy — full reasoning in `docs/operations.md` §2.4.

| Setting | Required |
|---|---|
| `DATABASE_URL` | connects as `moka_app`, not `postgres` |
| `DATABASE_MIGRATION_URL` | **different** from `DATABASE_URL` |
| `DATABASE_SSL` | `true` |
| `REDIS_URL` | set — but see §3.2, the driver is still a TODO |
| `API_HOST` | not `127.0.0.1` |
| `CORS_ORIGINS` | your Vercel domain, `https://` only, no `localhost` |
| `LOG_LEVEL` | not `debug` or `trace` |
| `ANTHROPIC_API_KEY` etc. | **unset** — per-organization credentials only |
| `ENCRYPTION_KEY` | 32 random bytes, base64, backed up off the server |

Losing `ENCRYPTION_KEY` makes every stored provider credential unrecoverable. That is the design, not a bug. Do not store it beside the backups.

---

## 6. What will not work yet, wherever you deploy it

Stated plainly rather than discovered after launch (§45):

- **No AI does anything without a provider credential.** No live model call has ever been made by this codebase. Add a credential per organization through Moka Credentials; instance-wide keys are refused in production.
- **Retrieval is lexical, not semantic.** pgvector was unavailable during development. Isolation is enforced identically either way; quality is not.
- **File uploads need a persistent disk.** See §3.1.
- **Rate limiting is per-process.** See §3.2.
- **No sandbox**, so the Phase 8 coding agent and browser agent are absent. MCP and agent-to-agent delegation do ship.
- **Research runs against supplied URLs** unless you self-host SearXNG and set `SEARXNG_URL`.

---

## 7. A realistic first deployment

```bash
pnpm verify && pnpm test:security
```

1. **Database.** Provision Postgres, run `infra/db/bootstrap.sql` as a superuser, then `pnpm db:migrate`.
2. **API.** Deploy to a container host with the §5 environment. Confirm `GET /health/ready` returns `{"status":"ok","database":"ok","schema":"ok"}`. A `schema` of anything but `ok` is a data-exposure signal, not a health blip.
3. **Web.** Import to Vercel with Root Directory `apps/web` and `NEXT_PUBLIC_API_URL` pointing at the API.
4. **CORS.** Add the Vercel domain to the API's `CORS_ORIGINS` and restart.
5. **Verify.** Run `pnpm test:drill` against the live database, and check that a second tenant cannot see the first's data before letting anyone real near it.
