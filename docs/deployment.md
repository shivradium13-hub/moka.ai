# Deployment

How to get MOKA AI running, and — more importantly — **which piece goes where**.

---

## 1. The short version

MOKA AI is two deployable units with different shapes, and they do not belong on the same kind of host.

| Unit | What it is | Vercel? |
|---|---|---|
| `apps/web` | Next.js 15. Pure API client: no database access, no server routes, one workspace dependency. | **Yes.** This is exactly what Vercel is for. |
| `apps/api` | NestJS on Fastify. Long-running process, connection pool, local disk, in-request agent loops. | **No.** Three things break silently — see the note in §2. Railway instead: §3. |

So: **web on Vercel, API on a container host, PostgreSQL managed.**

That is not a limitation of Vercel. It is what the API currently is — a stateful server that writes to disk and holds a pool. Putting it on a serverless platform would produce something that boots, serves traffic, passes a smoke test, and quietly loses every uploaded file.

---

## 2. Deploying the web app to Vercel

> **Why the API is not here.** Three things break on serverless, two of them
> silently. Uploads: `IngestionService` builds `LocalStorageDriver`
> unconditionally and `STORAGE_DRIVER=s3` is accepted then ignored, so on a
> filesystem that is read-only except a per-invocation `/tmp`, an upload
> returns `200` and the bytes cease to exist. Rate limiting: production demands
> `REDIS_URL` but the Redis driver is still a TODO, so per-invocation means no
> limiting at all while the config gate makes it look configured. And the API
> is a server, not a handler — `app.listen()` plus a connection pool per
> instance, with agent loops running inline past any function timeout. §3 puts
> it on Railway instead.


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

### 2.3 One thing to check before the first build

The repo pins `"packageManager": "pnpm@12.3.4"` and `"engines": { "node": ">=20.11.0" }`. Vercel reads `packageManager` and provisions that pnpm through corepack.

If the build image does not yet offer pnpm 12, the install step fails immediately and loudly — which is the good kind of failure, but it will be your first one. Either select a newer Node version in **Project Settings → General → Node.js Version**, or pin `packageManager` to a pnpm major the image supports and re-run `pnpm install` locally so the lockfile matches. Do not delete the field: without it Vercel guesses, and a guessed package manager against a `pnpm-lock.yaml` is how a build resolves different dependency versions than the ones that were tested.

### 2.4 Environment variables

Only one is required:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com` | The deployed API's origin. No trailing slash. |

**Set it before the first build.** `NEXT_PUBLIC_` variables are inlined at build time, so changing it later needs a redeploy, not a restart.

### 2.5 The build refuses to publish secrets

`apps/web/next.config.mjs` runs `findLeakyPublicVars` — the same function that stops the API booting with a leaky variable — and **throws** if any `NEXT_PUBLIC_` name looks like a secret (`secret`, `password`, `token`, `api_key`, `private`, `credential`, `encryption`, `database_url`, `_dsn`).

This matters more on a hosting platform than it does locally. Environment variables get set in a dashboard by whoever has access, and anything `NEXT_PUBLIC_` is shipped to every visitor's browser. A `NEXT_PUBLIC_ENCRYPTION_KEY` added in a hurry would be published to the internet by the next deploy.

It throws rather than warns, deliberately: a warning in build output is a line nobody reads; a failed deploy is a conversation.

```
Error: Refusing to build: these NEXT_PUBLIC_ variables look like secrets and
would be inlined into the browser bundle, where every visitor can read them:
NEXT_PUBLIC_ENCRYPTION_KEY.
```

### 2.6 After it deploys

Add the Vercel domain to the API's `CORS_ORIGINS`, or every authenticated request will fail at the browser. The app's routes authenticate by cookie, so CORS is doing real work there — it is what stops another site making authenticated requests with a user's session.

---

## 3. Deploying the API to Railway

`Dockerfile`, `.dockerignore` and `railway.json` are in the repository root and are already configured. Railway reads `railway.json` automatically, so there is nothing to fill in on the Build tab.

### 3.1 Create the service

1. [railway.app/new](https://railway.app/new) → **Deploy from GitHub repo** → pick `moka.ai`.
2. Leave the root directory as the repository root. **Do not set it to `apps/api`** — the Dockerfile builds the whole workspace and the pnpm lockfile lives at the root.
3. Railway detects `railway.json`, sees `"builder": "DOCKERFILE"`, and stops guessing.

### 3.2 Add a volume — before the first deploy

**Settings → Volumes → New Volume**, mount path exactly:

```
/data
```

Uploaded documents are written to disk. Without a volume they live in the container's writable layer and are destroyed on every redeploy — the upload returns `200` and the file is gone by the next deploy. The image creates `/data/storage` and chowns it to the non-root user, so an empty volume mounted there is writable immediately.

### 3.3 Environment variables — the complete list

Paste these into **Variables → Raw Editor**. Replace every `<...>`. Nothing here has a default that is safe to leave.

```
NODE_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://moka_app:<APP_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require
DATABASE_MIGRATION_URL=postgresql://moka_migrator:<MIGRATOR_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require
DATABASE_SSL=true
DATABASE_POOL_MAX=10

AUTH_SECRET=<32 random bytes, base64>
ENCRYPTION_KEY=<32 random bytes, base64>
SESSION_TTL_SECONDS=2592000

REDIS_URL=<redis:// or rediss:// URL>

STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/data/storage

CORS_ORIGINS=https://<your-project>.vercel.app

API_HOST=0.0.0.0
```

Generate the two secrets separately — they must not be the same value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Do not set `PORT`.** Railway injects it, and the container maps it to `API_PORT` at startup. Setting it yourself will fight the platform.

**Do not set `API_PORT`.** Same reason — it is derived.

**Do not set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY`.** Production refuses to boot with them, on purpose: an instance-wide key means every organization spends the operator's key, which makes per-tenant cost attribution, quotas and revocation fictional. Provider credentials belong to an organization, added through Moka Credentials.

What each one is for, and what happens if it is wrong:

| Variable | Required | If wrong |
|---|---|---|
| `NODE_ENV` | yes | Anything but `production` skips every hardening check below |
| `DATABASE_URL` | yes | Must be `moka_app`. A superuser here silently disables all tenant isolation — the process refuses to start |
| `DATABASE_MIGRATION_URL` | yes | Must differ from `DATABASE_URL`; the owner can turn RLS off |
| `DATABASE_SSL` | yes | `false` sends every row in the clear; boot refused |
| `AUTH_SECRET` | yes | Session signing key, ≥32 bytes base64 |
| `ENCRYPTION_KEY` | yes | Exactly 32 bytes base64. **Lose it and every stored credential is unrecoverable** |
| `REDIS_URL` | yes | Boot refused without it — see the caveat in §3.6 |
| `CORS_ORIGINS` | yes | No `localhost`, no `http://`. Wrong value = every logged-in request fails in the browser |
| `API_HOST` | yes | Must not be `127.0.0.1`, or the service is unreachable |
| `STORAGE_LOCAL_PATH` | yes | Must be under the mounted volume, or uploads vanish |
| `LOG_LEVEL` | yes | `debug`/`trace` refused in production; verbose logs capture request content |
| `DATABASE_POOL_MAX` | no | Defaults to 10. Lower it if your database plan caps connections |
| `SEARXNG_URL` | no | Only if you self-host SearXNG for web search |
| `BILLING_MANUAL_PAYMENTS` | no | `true` lets an admin activate a paid plan against an off-system payment |

### 3.4 Run the migrations — from your machine, once

Migrations are deliberately **not** in the container start command. Every replica would race to migrate on each deploy, and one failure would crash-loop the service. A migration is an operator action against a database, not a side effect of a container booting.

```bash
DATABASE_MIGRATION_URL="postgresql://moka_migrator:<MIGRATOR_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require" pnpm db:migrate
```

Then seed the roles, permissions and plan catalogue:

```bash
DATABASE_URL="postgresql://moka_app:<APP_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require" DATABASE_MIGRATION_URL="postgresql://moka_migrator:<MIGRATOR_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require" pnpm db:seed
```

Run migrations **before** the first deploy finishes, or at least before anyone uses the service. The API starts fine against an unmigrated database — readiness reports `schema: "ok"` because a database with no tables has no unprotected ones — so an empty database will not stop a deploy going live.

### 3.5 Verify the deployment

Railway gates the deploy on `/health/ready` (set in `railway.json`), so a version that cannot reach its database never receives traffic — the previous one keeps serving. Once it is live:

```bash
curl https://<your-service>.up.railway.app/health/ready
```

```json
{"status":"ok","database":"ok","schema":"ok","rateLimiter":"shared"}
```

`schema` is the one to read carefully. Anything other than `ok` means an organization-scoped table is missing its row-level security — treat it as a data-exposure incident, not a health blip. `"unknown"` means the check could not run, which is not the same as passing.

Then run the drill against the live database:

```bash
TEST_DATABASE_URL="postgresql://moka_app:<APP_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require" TEST_DATABASE_MIGRATION_URL="postgresql://moka_migrator:<MIGRATOR_PASSWORD>@<DB_HOST>/moka_ai?sslmode=require" pnpm test:drill
```

It asserts that RLS is enabled **and forced** on every tenant table, that the grants making the ledgers append-only survived, and that the boot guard refuses a bypassing role.

### 3.6 Do not raise the replica count

`railway.json` pins `"numReplicas": 1`. Two things break at two replicas, and both break quietly:

- **Rate limiting.** `REDIS_URL` is required by config, but the Redis driver is still a `TODO` — only `InMemoryRateLimiter` exists. On one instance that is "per-process" and honest. On two it is half the limit an operator thinks they set.
- **File storage.** The volume is attached to one instance. A second replica cannot see the first's uploads.

Scale vertically instead until both are addressed.

### 3.7 What the Dockerfile does, in one paragraph

Three stages on `node:22-bookworm-slim`. The build stage installs the full workspace with `--frozen-lockfile` and runs `turbo run build --filter=@moka/api...` — the trailing `...` includes the twelve workspace dependencies, each of which resolves through its own `dist`. The runtime stage reinstalls with `--prod` from the same lockfile and copies only compiled output, so typescript, tsup, esbuild and vitest never reach the image. It runs as the non-root `node` user, cannot write to its own code, and maps Railway's `PORT` to `API_PORT` in the start command so nothing in the application has to know what Railway is. Debian rather than Alpine is deliberate: the SSRF guard supplies undici a custom DNS lookup, and musl and glibc do not resolve identically — not a difference worth introducing into a security control to save 90 MB.

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

The order is not arbitrary: the web build inlines the API's URL, and the API will not start without a database.

1. **Database** (§4). Provision Postgres, run `infra/db/bootstrap.sql` as a superuser to create `moka_app` and `moka_migrator`, then `pnpm db:migrate` and `pnpm db:seed` from your machine.
2. **API** (§3). Railway, repository root, add the `/data` volume *before* the first deploy, paste the variables from §3.3. Confirm `GET /health/ready` returns `"schema":"ok"`.
3. **Web** (§2). Vercel, Root Directory `apps/web`, `NEXT_PUBLIC_API_URL` set to the Railway URL **before** the first build.
4. **CORS.** Put the real Vercel domain in the API's `CORS_ORIGINS` and redeploy. Until this is done every logged-in request fails in the browser.
5. **Verify.** `pnpm test:drill` against the live database, then create two organizations and confirm neither can see the other's data before letting anyone real near it.
