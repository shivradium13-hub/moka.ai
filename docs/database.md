# MOKA AI — Database Design

> **Status:** Phase 0 (design). No migrations written yet.
> Engine: **PostgreSQL 17.11** (already installed and running locally on :5432).
> ORM / migrations: **Drizzle ORM** + drizzle-kit.
> Required extension not yet present: **`vector` (pgvector)** — see `docs/roadmap.md`.

---

## 1. Conventions

| Convention | Rule |
|---|---|
| Primary keys | `uuid` (v7 where ordering helps insert locality) |
| Timestamps | `timestamptz`, always UTC. `created_at`, `updated_at` on every table |
| Soft delete | `deleted_at timestamptz NULL` on user-visible content only. Never on audit or usage tables |
| Tenant column | `organization_id uuid NOT NULL` on **every** tenant-owned table — no exceptions, no nullable variants |
| Naming | `snake_case`, plural table names |
| Money | `numeric(18,6)` for cost. **Never floating point** |
| Enums | Postgres native enums for closed sets; text + check constraint where the set will grow |
| JSON | `jsonb`, always with a Zod schema at the application boundary |

**Every tenant table gets RLS** (policy defined in `docs/security.md` §2.2) and this index as its first index:

```sql
CREATE INDEX ON <table> (organization_id, created_at DESC);
```

Foreign keys to tenant tables use `ON DELETE CASCADE` only where the child is genuinely owned by the parent. Audit, usage and approval records use `ON DELETE RESTRICT` — history must not vanish when its subject is deleted.

---

## 2. Extensions required

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- present
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- present, fuzzy search
CREATE EXTENSION IF NOT EXISTS "unaccent";    -- present, FTS normalisation
CREATE EXTENSION IF NOT EXISTS "citext";      -- present, case-insensitive email
CREATE EXTENSION IF NOT EXISTS "vector";      -- ** MISSING — Phase 2 blocker **
```

---

## 3. Identity and tenancy

```
users ──< organization_members >── organizations
                                        │
                                        └──< projects
```

**`users`** — `id`, `email citext UNIQUE`, `email_verified_at`, `password_hash` (Argon2id), `name`, `avatar_url`, `mfa_secret_encrypted`, `last_login_at`, timestamps.
*Not tenant-scoped* — a user can belong to several organizations.

**`organizations`** — `id`, `name`, `slug UNIQUE`, `plan_id`, `dek_wrapped bytea NOT NULL` (per-org data encryption key, see security §3.1), `settings jsonb`, `status`, timestamps. **This is the tenant root.**

**`organization_members`** — `id`, `organization_id`, `user_id`, `role_id`, `invited_by`, `joined_at`, `status`. `UNIQUE (organization_id, user_id)`.

**`roles`** — `id`, `organization_id NULL` (null = system role), `name`, `is_system bool`. **`permissions`** — `id`, `key`, `description`. **`role_permissions`** — join table.

**`projects`** — `id`, `organization_id`, `name`, `slug`, `description`, `settings jsonb`, timestamps. `UNIQUE (organization_id, slug)`.

**`sessions`** — `id`, `user_id`, `token_hash`, `active_organization_id`, `ip`, `user_agent`, `expires_at`. Server-side, revocable.

---

## 4. AI gateway

**`providers`** — `id`, `key` (`openai` | `anthropic` | `google` | `custom`), `name`, `base_url`, `status`. Global, not tenant-scoped.

**`models`** — `id`, `provider_id`, `model_key`, `display_name`, `capabilities text[]` (`coding`, `reasoning`, `vision`, `long_context`, `fast`, `cheap`), `context_window`, `max_output_tokens`, `input_cost_per_1m numeric(18,6)`, `output_cost_per_1m numeric(18,6)`, `supports_streaming`, `supports_tools`, `status`. Global registry; the router reads capabilities from here rather than hard-coding model names.

**`credentials`** — the Moka Credentials vault.

| Column | Notes |
|---|---|
| `id`, `organization_id` | tenant-scoped, RLS |
| `provider_id` | which provider |
| `name` | user-facing label |
| `type` | `moka_managed` \| `byok` |
| `ciphertext bytea NOT NULL` | AES-256-GCM. **Excluded from every default select** |
| `iv bytea`, `auth_tag bytea` | per-record |
| `fingerprint text` | non-reversible, for display and dedupe |
| `last_four text` | display only |
| `status` | `active` \| `disabled` \| `revoked` |
| `last_tested_at`, `last_test_result` | outcome only, never the response body |
| `expires_at`, `rotated_at`, `created_by` | lifecycle |

AAD binds ciphertext to `(organization_id, id, provider_id)` so a row cannot be moved between organizations or credentials.

---

## 5. Conversations

**`conversations`** — `id`, `organization_id`, `project_id NULL`, `user_id`, `agent_id NULL`, `chatbot_id NULL`, `title`, `model_id NULL`, `metadata jsonb`, `last_message_at`, timestamps, `deleted_at`.

**`messages`** — `id`, `organization_id`, `conversation_id`, `role` (`system`|`user`|`assistant`|`tool`), `content text`, `content_blocks jsonb` (attachments, citations, tool calls), `model_id NULL`, `input_tokens`, `output_tokens`, `cost_usd numeric(18,6)`, `finish_reason`, `error_code NULL`, `parent_message_id NULL` (edit/regenerate branching), `created_at`.

Indexes: `(conversation_id, created_at)`, plus a GIN FTS index on `content` for conversation search (§16).

---

## 6. Knowledge engine

This is the most consequential part of the schema.

```
knowledge_sources ──< knowledge_documents ──< knowledge_chunks ──< knowledge_embeddings
```

**`knowledge_sources`** — `id`, `organization_id`, `project_id NULL`, `type` (`UPLOAD`|`WEBSITE`|`TEXT`|`URL`|`BUSINESS_DATA`|`FAQ`|`PRODUCT_DATA`|`POLICY`, extensible), `name`, `config jsonb` (crawl depth, domain restrictions, schedule), `status` (`UPLOADED`|`PROCESSING`|`READY`|`FAILED`), `error_message`, `last_indexed_at`, timestamps.

The `type` column is text + check constraint rather than a native enum, so adding `NOTION`, `GOOGLE_DRIVE`, `GITHUB`, `SLACK` or `MCP` is a data change, not a migration that touches the RAG engine (§11).

**`knowledge_documents`** — `id`, `organization_id`, `source_id`, `external_id`, `title`, `url`, `mime_type`, `byte_size`, `checksum` (dedupe), `page_count`, `raw_storage_key` (object store), `extracted_text_key`, `status`, `error_message`, `metadata jsonb`, timestamps. `UNIQUE (source_id, checksum)`.

**`knowledge_chunks`** — text and metadata **only, no vector column**.

`id`, `organization_id`, `document_id`, `source_id`, `chunk_index`, `content text`, `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`, `token_count`, `page NULL`, `section NULL`, `heading_path text[]`, `metadata jsonb`, timestamps.

Indexes: `(organization_id, document_id, chunk_index)`, GIN on `content_tsv`, GIN trigram on `content`.

**`knowledge_embeddings`** — the deliberate separation.

```sql
id                  uuid PK
organization_id     uuid NOT NULL
chunk_id            uuid NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE
embedding_model_id  uuid NOT NULL REFERENCES embedding_models(id)
embedding           vector(1024) NOT NULL
created_at          timestamptz
UNIQUE (chunk_id, embedding_model_id)
```

**Why a separate table.** Putting the vector on the chunk row hard-codes one model and one dimension into the schema. Changing embedding model would then be a destructive migration with downtime and no rollback. With this design two models coexist during a re-embed, retrieval selects by `embedding_model_id`, and cutover is a config flip. Re-embedding becomes a background job.

**`embedding_models`** — `id`, `provider_id NULL` (null = local ONNX), `model_key`, `dimensions int`, `max_input_tokens`, `cost_per_1m numeric(18,6)`, `is_default`, `status`. A check constraint enforces `dimensions <= 2000`, the HNSW limit.

Vector index:

```sql
CREATE INDEX ON knowledge_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

> **Dimension note.** `vector(n)` is fixed per column. Supporting models of differing dimensions means either one nullable column per supported dimension, or a partitioned table per dimension. Recommendation: **partition `knowledge_embeddings` by `embedding_model_id`**, so each partition holds one dimension and one HNSW index. Decided concretely at the start of Phase 2.

**Hybrid retrieval** runs dense (HNSW cosine) and sparse (FTS on `content_tsv`) branches, both filtered by `organization_id`, and fuses them with Reciprocal Rank Fusion in SQL. No paid vector database.

---

## 7. Memory (§15)

**`memories`** — `id`, `organization_id`, `scope` (`conversation`|`project`|`agent`|`user`), `scope_id`, `user_id NULL`, `agent_id NULL`, `kind` (`fact`|`preference`|`summary`), `content text`, `embedding_id NULL`, `source_message_id NULL`, `confidence numeric`, `expires_at NULL`, `disabled_at NULL`, timestamps.

Kept deliberately separate from knowledge: different lifecycle, different retention, user-deletable, and never auto-populated with anything matching a secret pattern.

---

## 8. Agents and tools

**`agents`** — `id`, `organization_id`, `project_id NULL`, `name`, `description`, `instructions text`, `model_policy jsonb` (required capabilities, preferred model, fallbacks), `memory_policy jsonb`, `limits jsonb` (max steps, max tool calls, max tokens, timeout), `budget_usd numeric(18,6)`, `approval_policy jsonb`, `template_key NULL`, `version int`, `status`, timestamps.

**`agent_tools`** — `agent_id`, `tool_id`, `permission_level` (`READ`|`DRAFT`|`EXECUTE`), `config jsonb`. The allowlist, read fresh from the database on every run.

**`agent_knowledge`** — `agent_id`, `source_id`. Scopes retrieval.

**`agent_permissions`** — explicit grants beyond tool level.

**`tools`** — `id`, `organization_id NULL` (null = built-in), `key`, `name`, `description`, `input_schema jsonb`, `output_schema jsonb`, `default_permission_level`, `risk_level` (`low`|`medium`|`high`), `requires_approval bool`, `tenant_scoped bool`, `audit_required bool`, `handler_key`, `status`.

**`agent_executions`** — `id`, `organization_id`, `agent_id`, `conversation_id NULL`, `trigger` (`chat`|`api`|`automation`|`agent`), `status` (`running`|`awaiting_approval`|`succeeded`|`failed`|`cancelled`|`budget_exceeded`), `step_count`, `input_tokens`, `output_tokens`, `cost_usd`, `started_at`, `ended_at`, `error_code`.

**`tool_executions`** — `id`, `organization_id`, `agent_execution_id`, `tool_id`, `step_index`, `input jsonb` (validated, redacted), `output jsonb` (validated, redacted), `permission_level`, `approval_id NULL`, `status`, `duration_ms`, `error_code`, `created_at`.

**`approvals`** — `id`, `organization_id`, `agent_execution_id`, `tool_execution_id NULL`, `action`, `resource_type`, `resource_id`, `old_value jsonb`, `new_value jsonb`, `reason text`, `status` (`pending`|`approved`|`rejected`|`expired`), `decided_by NULL`, `decided_at NULL`, `expires_at`.

---

## 9. Chatbots (§22) — IMPLEMENTED (0007–0010)

Five tables, all RLS-protected. They are the first tables in the schema reachable by someone who is not a user of the platform at all, and three properties follow from that.

**`chatbots`** — `id`, `organization_id`, `project_id NULL`, `name`, `description`, `instructions`, `greeting`, `model_id`, `require_grounding bool DEFAULT true`, `min_passages`, `max_passages`, `handoff_enabled`, `retention_days`, `status` (`draft`|`active`|`disabled`), timestamps, `deleted_at`.

Defaults to `draft`: a chatbot is not live until someone publishes it. `instructions` is operator-authored and trusted like an agent's — but it is effectively **published**, since a determined visitor can persuade a model to recite its own system prompt and no instruction reliably prevents that. The builder UI says so in those words.

**`chatbot_sources`** — `chatbot_id`, `source_id`, `attached_by`.

The **publication boundary**, not a filter. Anything in an attached source can be quoted verbatim to any visitor; anything not attached is unreachable however the conversation goes. Empty means the bot retrieves nothing, which with grounding on means it answers nothing — the correct default for a surface whose failure mode is publishing internal documents to the internet.

**`chatbot_deployments`** — `id`, `organization_id`, `chatbot_id`, `name`, `public_key text UNIQUE`, `allowed_origins text[] NOT NULL DEFAULT '{}'`, `messages_per_minute`, `conversations_per_hour`, `status` (`active`|`revoked`), `revoked_at`.

`public_key` is a public identifier, not a credential. It is pasted into the customer's HTML and readable by every visitor, so it is stored in plaintext and returned in full by the API — treating it as a secret would be theatre. It grants exactly what any visitor already has: a fresh, empty conversation with a bot that was published on purpose.

`allowed_origins` empty means embeddable **nowhere**, which is the correct failure direction for a list that controls publication.

This is the **one table with a narrow public read path**. A visitor arrives holding only a key, so the organization cannot be bound until it is looked up — the same shape as `0002_user_scope.sql`, and answered the same way:

```sql
CREATE POLICY tenant_isolation ON chatbot_deployments
  USING (
    organization_id = current_org_id()
    OR (current_org_id() IS NULL
        AND public_key = current_deployment_key()
        AND status = 'active' AND revoked_at IS NULL)
  )
  WITH CHECK (organization_id = current_org_id());
```

`current_org_id() IS NULL` is what stops it widening tenant queries; `WITH CHECK` is untouched, so the public path reads one row and writes nothing; and `status = 'active'` inside the policy makes revocation effective immediately rather than eventually.

**`chat_conversations`** — `id`, `organization_id`, `chatbot_id`, `deployment_id`, `visitor_token_hash UNIQUE`, `origin`, `status` (`open`|`awaiting_human`|`with_human`|`closed`), `message_count`, handoff fields, `expires_at`, `closed_at`.

`visitor_token_hash` **is** a secret, unlike the public key, and is hashed like a session token. `origin` is the only provenance kept: no IP, no fingerprint, nothing that follows a person between visits. Staff need to tell two live conversations apart, not identify people, so the inbox shows a per-conversation pseudonym derived from the conversation id alone.

**`chat_messages`** — `conversation_id`, `role` (`visitor`|`assistant`|`human`|`notice`), `content`, `citations jsonb`, `error_code`, token counts, `author_user_id` (staff replies only).

`citations` records what the assistant was **shown**, derived from retrieval — not the model's account of its own sources, which is plausible rather than true.

Grants are `SELECT, INSERT, DELETE` — **no `UPDATE`**. The two are different properties: what was said to a member of the public in the organization's name cannot be rewritten, but a stranger's transcript can be erased, because retention has to be able to destroy it.

### Composite foreign keys (0010)

Every parent reference in these tables carries `organization_id`:

```sql
FOREIGN KEY (organization_id, source_id) REFERENCES knowledge_sources (organization_id, id)
```

PostgreSQL performs referential integrity checks **with row security disabled**, so a single-column `REFERENCES parent(id)` is satisfied by any row in the installation — visible or not — and an RLS policy that only checks the child row's `organization_id` will store a cross-tenant pointer without complaint. Security suite 8 found exactly that. Carrying the tenant into the key makes same-tenancy a referential constraint rather than a policy, which holds in the one place policies do not apply. See `docs/security.md` §4.5.

---

## 10. Billing, entitlements, usage (§34, §35)

Deliberately three layers, so limits are never hard-coded in application code:

```
plans ──< plan_entitlements
              │
organizations ─┴─< subscriptions ──< entitlement_overrides
                                          │
                                     usage_records ──▶ enforcement
```

**`plans`** — `id`, `key`, `name`, `price_monthly numeric`, `currency`, `status`.

**`plan_entitlements`** — `plan_id`, `feature_key`, `limit_value numeric NULL` (null = unlimited), `unit`. Feature keys cover AI credits, allowed models, agent count, chatbot count, knowledge storage, API calls, automations, sandbox access, MCP access, team seats.

**`subscriptions`** — `id`, `organization_id`, `plan_id`, `status`, `current_period_start/end`, `cancel_at`, `external_ref NULL` (payment processor, Phase 9).

**`entitlement_overrides`** — per-organization exceptions without cloning a plan.

**`credits`** — `id`, `organization_id`, `balance numeric(18,6)`, `granted`, `consumed`, `reset_at`. Append-only ledger entries in `credit_transactions`.

**`usage_records`** — `id`, `organization_id`, `project_id NULL`, `user_id NULL`, `kind` (`chat`|`agent_run`|`tool_call`|`embedding`|`research`|`storage`|`sandbox`|`api`), `provider_id NULL`, `model_id NULL`, `quantity numeric`, `unit`, `input_tokens`, `output_tokens`, `cost_usd numeric(18,6)`, `latency_ms`, `request_id`, `created_at`.

High write volume. Indexed on `(organization_id, created_at DESC)` and `(organization_id, kind, created_at DESC)`. **Range-partition by month** from the start — retrofitting partitioning onto a large table is painful.

---

## 11. API, MCP, automation

**`api_keys`** — `id`, `organization_id`, `name`, `key_hash` (Argon2id), `prefix` (display), `scopes text[]`, `rate_limit_per_min`, `last_used_at`, `expires_at`, `revoked_at`, `created_by`.

**`mcp_servers`** — `id`, `organization_id`, `name`, `transport`, `endpoint`, `credential_id NULL`, `status`, `last_discovered_at`.
**`mcp_tools`** — `id`, `organization_id`, `mcp_server_id`, `tool_key`, `input_schema jsonb`, `permission_level`, `risk_level`, `enabled`. MCP tools are mirrored into the same permission model as native tools; they get no shortcut around the gate.

**`automations`** — `id`, `organization_id`, `project_id NULL`, `name`, `trigger_type` (`schedule`|`event`|`webhook`|`manual`), `schedule_cron NULL`, `timezone`, `action jsonb`, `agent_id NULL`, `permissions jsonb`, `retry_policy jsonb`, `owner_user_id`, `status`, `next_run_at`.
**`automation_runs`** — `id`, `organization_id`, `automation_id`, `status`, `attempt`, `started_at`, `ended_at`, `output jsonb`, `error_code`.

---

## 12. Audit

**`audit_logs`** — `id`, `organization_id`, `actor_type` (`user`|`api_key`|`agent`|`system`), `actor_id`, `action`, `resource_type`, `resource_id`, `before jsonb`, `after jsonb`, `request_id`, `ip`, `user_agent`, `outcome`, `created_at`.

Append-only: the `moka_app` role holds `INSERT` and `SELECT` grants but **no `UPDATE` or `DELETE`**. Month-partitioned. No soft delete, no cascade — audit history survives deletion of its subject.

---

## 13. Migration safety (§46)

1. Inspect the current schema before generating anything.
2. Generate with drizzle-kit; **review the SQL by hand** — never apply blind.
3. Every migration is checked for destructive operations (`DROP`, `ALTER ... TYPE`, `NOT NULL` on populated columns).
4. Destructive changes require the expand/contract pattern: add, backfill, switch reads, then drop in a later release.
5. Migrations run under a role distinct from the application role.
6. No migration runs against production without a verified backup and a written rollback plan.
7. RLS policies are created **in the same migration** as the table they protect, never in a follow-up — a table must never exist unprotected.

---

## 14. Table inventory

Against the §36 list, with deviations noted:

`users`, `organizations`, `organization_members`, `roles`, `permissions`, `role_permissions`*, `sessions`*, `projects`, `conversations`, `messages`, `providers`, `models`, `credentials`, `agents`, `agent_tools`, `agent_permissions`, `agent_knowledge`*, `agent_executions`*, `tools`, `tool_executions`, `knowledge_sources`, `knowledge_documents`, `knowledge_chunks`, `knowledge_embeddings`*, `embedding_models`*, `memories`, `chatbots`, `chatbot_deployments`, `subscriptions`, `plans`, `plan_entitlements`*, `entitlement_overrides`*, `usage_records`, `credits`, `credit_transactions`*, `chatbot_sources`*, `chat_conversations`*, `chat_messages`*, `api_keys`, `mcp_servers`, `mcp_tools`, `automations`, `automation_runs`, `approvals`, `audit_logs`

`*` = added beyond the §36 list, each for a stated reason:

- **`knowledge_embeddings` + `embedding_models`** — avoids hard-coding one embedding model into the schema (§6).
- **`agent_executions`** — `tool_executions` needs a parent run to attach to; without it there is nowhere to record budgets, step counts or run status.
- **`plan_entitlements` / `entitlement_overrides`** — §34 explicitly requires `Plan → Entitlement → Usage → Enforcement` and forbids hard-coded limits. A flat `entitlements` table cannot express both plan defaults and per-organization exceptions.
- **`chatbot_sources`** — the publication boundary between a chatbot and the knowledge it may quote. §36 assumed one implicit scope; making it an explicit join is what lets an organization decide, per chatbot, which internal documents become readable by the public.
- **`chat_conversations` / `chat_messages`** — the §36 list has `conversations` and `messages` for STAFF chat. A visitor conversation is a different thing with a different principal, a different retention policy and a different token, and merging them would put an anonymous stranger's transcript in the same table as a member's.
- **`role_permissions`, `sessions`, `agent_knowledge`, `credit_transactions`** — required join tables and ledgers, not redundant entities.

No table in the §36 list has been dropped.
