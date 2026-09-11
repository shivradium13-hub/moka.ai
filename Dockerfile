# syntax=docker/dockerfile:1.7
# =============================================================================
# MOKA AI — API image
#
# Builds `apps/api` (NestJS on Fastify) and the twelve workspace packages it
# depends on, from a pnpm monorepo.
#
# Build from the REPOSITORY ROOT, not from apps/api:
#   docker build -t moka-api .
#
# ─────────────────────────────────────────────────────────────────────────────
# DECISIONS WORTH KNOWING BEFORE CHANGING ANYTHING HERE
#
# DEBIAN, NOT ALPINE. There are no native dependencies — Argon2 comes from
# `hash-wasm`, and `pg` and `undici` are pure JavaScript — so Alpine would
# build. It is still not used, because the SSRF guard supplies undici a custom
# DNS `lookup` and resolves every address before connecting. musl and glibc do
# not resolve identically, and the difference would land in a security control
# rather than in a warning. A ~90 MB size saving is not worth introducing an
# untested variable there.
#
# THREE STAGES. Build tooling (typescript, tsup, esbuild, vitest) never reaches
# the final image: the runtime stage installs `--prod` from the same lockfile
# and receives only compiled `dist` output.
#
# NON-ROOT. The process cannot write to its own code, so a bug that reaches the
# filesystem cannot rewrite the application. The storage volume is chowned
# explicitly, since it is the one path that must be writable.
#
# NO MIGRATIONS AT STARTUP. Deliberate — see the note above CMD.
# ─────────────────────────────────────────────────────────────────────────────

# Node 22 LTS. `engines` requires >=20.11.0; development used Node 24, so this
# is one line to change if you would rather match exactly.
ARG NODE_VERSION=22-bookworm-slim


# =============================================================================
# Stage 1 — base: the toolchain, shared by build and runtime
# =============================================================================
FROM node:${NODE_VERSION} AS base

# Corepack provisions the exact pnpm pinned in `packageManager` (12.3.4).
# Pinned rather than "latest" because a different pnpm major can resolve a
# lockfile differently, which would mean shipping dependency versions nobody
# tested.
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

WORKDIR /app


# =============================================================================
# Stage 2 — build: install everything, compile, discard nothing yet
# =============================================================================
FROM base AS build

# --- Manifests first, so the dependency layer caches independently of source.
# Listed explicitly rather than copied with a glob: Docker's COPY flattens
# globs across directories, which would put every package.json in one place and
# break the workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json          apps/api/
# Present only to satisfy the lockfile — apps/web is a workspace member, and
# `--frozen-lockfile` fails if its manifest is missing. Its source is excluded
# by .dockerignore.
COPY apps/web/package.json          apps/web/
COPY packages/agents/package.json   packages/agents/
COPY packages/ai/package.json       packages/ai/
COPY packages/billing/package.json  packages/billing/
COPY packages/chat/package.json     packages/chat/
COPY packages/config/package.json   packages/config/
COPY packages/core/package.json     packages/core/
COPY packages/crypto/package.json   packages/crypto/
COPY packages/db/package.json       packages/db/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/net/package.json      packages/net/
COPY packages/research/package.json packages/research/
COPY packages/tenancy/package.json  packages/tenancy/

# `--frozen-lockfile` is the point of this line: it fails rather than silently
# resolving something new, so the image cannot quietly ship dependency versions
# that were never tested.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --- Source, and the build itself.
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# `--filter=@moka/api...` — the trailing `...` includes DEPENDENCIES. Every
# workspace package resolves to `dist/`, so a build that skipped them would
# fail at runtime on a missing module rather than at build time.
RUN pnpm turbo run build --filter=@moka/api...


# =============================================================================
# Stage 3 — runtime: production dependencies and compiled output only
# =============================================================================
FROM base AS runtime

ENV NODE_ENV=production

# Manifests again, so `--prod` resolves from the identical lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY packages/agents/package.json   packages/agents/
COPY packages/ai/package.json       packages/ai/
COPY packages/billing/package.json  packages/billing/
COPY packages/chat/package.json     packages/chat/
COPY packages/config/package.json   packages/config/
COPY packages/core/package.json     packages/core/
COPY packages/crypto/package.json   packages/crypto/
COPY packages/db/package.json       packages/db/
COPY packages/knowledge/package.json packages/knowledge/
COPY packages/net/package.json      packages/net/
COPY packages/research/package.json packages/research/
COPY packages/tenancy/package.json  packages/tenancy/

# `--prod` drops typescript, tsup, esbuild, vitest and the rest of the build
# toolchain. `--ignore-scripts` because no runtime dependency needs a
# postinstall — esbuild is the only package that does, and it is a build
# dependency that is not installed here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# --- Compiled output. Each workspace package resolves through its `dist`, so
# the symlinks pnpm just created need something to point at.
COPY --from=build /app/apps/api/dist            apps/api/dist
COPY --from=build /app/packages/agents/dist     packages/agents/dist
COPY --from=build /app/packages/ai/dist         packages/ai/dist
COPY --from=build /app/packages/billing/dist    packages/billing/dist
COPY --from=build /app/packages/chat/dist       packages/chat/dist
COPY --from=build /app/packages/config/dist     packages/config/dist
COPY --from=build /app/packages/core/dist       packages/core/dist
COPY --from=build /app/packages/crypto/dist     packages/crypto/dist
COPY --from=build /app/packages/db/dist         packages/db/dist
COPY --from=build /app/packages/knowledge/dist  packages/knowledge/dist
COPY --from=build /app/packages/net/dist        packages/net/dist
COPY --from=build /app/packages/research/dist   packages/research/dist
COPY --from=build /app/packages/tenancy/dist    packages/tenancy/dist

# --- The uploads volume.
# Created and chowned at build time so it is writable by the non-root user even
# when Railway mounts an empty volume over it. `STORAGE_LOCAL_PATH` must point
# here; if it points anywhere else the process cannot write and uploads fail.
RUN mkdir -p /data/storage && chown -R node:node /data

# Owning the application directory is deliberately NOT granted. The process can
# read its code and cannot modify it.
USER node

# Documentation only. The listening port comes from PORT at runtime.
EXPOSE 4000

# --- Liveness, and only liveness.
#
# This hits `/health`, which consults NOTHING, rather than `/health/ready`,
# which checks the database. That distinction is the whole point: a failing
# healthcheck here tells the orchestrator to RESTART the container. Wire it to
# a readiness probe and a database blip restarts every instance in a loop,
# turning a recoverable outage into a reconnect storm against a database that
# is already struggling.
#
# `node -e` rather than curl, so the image needs no extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const p=process.env.PORT||4000;require('http').get({host:'127.0.0.1',port:p,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# --- Start.
#
# TWO THINGS ARE HAPPENING HERE.
#
# 1. `API_PORT=${PORT:-4000}`. Railway assigns a port through `PORT`; this
#    application reads `API_PORT`, validated by the config schema. Mapping it
#    here rather than editing the schema keeps the application unchanged and
#    platform-agnostic — nothing in the codebase learns what Railway is.
#
# 2. `exec`. Without it, the shell stays PID 1 and swallows SIGTERM, so the
#    graceful-shutdown handlers in main.ts — which close the server and drain
#    the connection pool — would never run, and the platform would eventually
#    SIGKILL mid-request. With `exec`, node becomes PID 1 and receives the
#    signal directly.
#
# MIGRATIONS ARE NOT RUN HERE, ON PURPOSE. Putting `db:migrate` in the start
# command means every replica races to migrate on every deploy, and one failure
# crash-loops the service. Migrations are an operator action against a database,
# not a side effect of a container starting. See docs/deployment.md §2.
CMD ["sh", "-c", "API_PORT=${PORT:-4000} exec node apps/api/dist/main.js"]
