-- =============================================================================
-- 0007_chatbots — customer-facing chatbots, deployments and conversations
--
-- Run as: moka_migrator
--
-- Master prompt §22–24. These are the first tables reachable by someone who is
-- not a user of this platform at all — an anonymous member of the public, on
-- somebody else's website. Everything below follows from that one fact.
--
-- THE PRINCIPAL
-- A visitor is NOT a user with a low role. They hold no role, and so no
-- permission (see CustomerContext in @moka/core). Modelling them as `viewer`
-- would have handed every passer-by the ability to list an organization's
-- projects and members, because that is what `viewer` means.
--
-- THE PUBLICATION BOUNDARY
-- `chatbot_sources` is the only knowledge a chatbot may quote. It is a
-- publication decision, not a filter: anything attached can be read aloud to
-- the internet. An empty list means the bot can retrieve nothing, which with
-- grounding on means it answers nothing — the correct default for a surface
-- whose failure mode is publishing internal documents.
-- =============================================================================

-- =============================================================================
-- chatbots
-- =============================================================================

CREATE TABLE chatbots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid        REFERENCES projects (id) ON DELETE SET NULL,

  name            text        NOT NULL,
  description     text,
  /*
   * Operator-authored persona. Trusted like an agent's instructions, with one
   * difference worth stating: it is effectively PUBLISHED. A determined
   * visitor can persuade a model to recite its own system prompt, and no
   * instruction reliably prevents that. Nothing confidential belongs here, and
   * the builder UI says so.
   */
  instructions    text        NOT NULL DEFAULT '',
  -- Served from configuration, never generated. A model-written greeting is a
  -- paid call on every page view, seen by everyone and checked by no one.
  greeting        text,
  model_id        text,

  /*
   * Grounding: no retrieved passage, no answer.
   *
   * A support bot answering from model priors will confidently describe a
   * refund policy the organization does not have, to a customer who will then
   * hold them to it. Defaulting this on makes for a worse demo and a better
   * product. It is switchable because a general-purpose concierge is a real
   * use case, and hiding the switch only invites workarounds.
   */
  require_grounding boolean   NOT NULL DEFAULT true,
  min_passages    integer     NOT NULL DEFAULT 1,
  max_passages    integer     NOT NULL DEFAULT 6,

  handoff_enabled boolean     NOT NULL DEFAULT true,
  -- A stranger's transcript is not ours to keep indefinitely.
  retention_days  integer     NOT NULL DEFAULT 30,

  -- 'draft' by default: a chatbot is not live until someone publishes it.
  status          text        NOT NULL DEFAULT 'draft',
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT chatbots_status_valid CHECK (status IN ('draft', 'active', 'disabled')),
  CONSTRAINT chatbots_passages_bounded CHECK (
    min_passages BETWEEN 1 AND 20 AND max_passages BETWEEN 1 AND 20
    AND min_passages <= max_passages
  ),
  CONSTRAINT chatbots_retention_bounded CHECK (retention_days BETWEEN 1 AND 3650)
);

CREATE INDEX chatbots_org_created_idx ON chatbots (organization_id, created_at DESC);
CREATE UNIQUE INDEX chatbots_org_name_unique ON chatbots (organization_id, lower(name))
  WHERE deleted_at IS NULL;

-- =============================================================================
-- chatbot_sources — what this bot may say out loud
-- =============================================================================

CREATE TABLE chatbot_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  chatbot_id      uuid        NOT NULL REFERENCES chatbots (id) ON DELETE CASCADE,
  source_id       uuid        NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  attached_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX chatbot_sources_unique ON chatbot_sources (chatbot_id, source_id);
CREATE INDEX chatbot_sources_org_idx ON chatbot_sources (organization_id, chatbot_id);

-- =============================================================================
-- chatbot_deployments
--
-- `public_key` is PUBLIC by design: it is pasted into the customer's HTML and
-- is readable by every visitor. It NAMES a deployment and grants nothing —
-- possession gets you a fresh, empty conversation with a bot that was
-- published on purpose, which is exactly what any visitor already has. So it
-- is stored in plaintext, and treating it as a secret would be theatre.
-- =============================================================================

CREATE TABLE chatbot_deployments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  chatbot_id      uuid        NOT NULL REFERENCES chatbots (id) ON DELETE CASCADE,

  name            text        NOT NULL,
  public_key      text        NOT NULL,
  /*
   * Sites this deployment may appear on. This list does two jobs of very
   * different strength, and conflating them is the mistake to avoid:
   *
   *   STRONG — it becomes the `frame-ancestors` directive on the chat frame,
   *     enforced by the visitor's own browser and unforgeable by a third-party
   *     site. A real control against unauthorised embedding.
   *   WEAK — it is also compared against the Origin header on API calls, which
   *     any non-browser client can set to anything. That stops casual reuse
   *     and nothing more.
   *
   * Empty means the deployment is embeddable NOWHERE. That is the correct
   * failure direction for a list that controls publication.
   */
  allowed_origins text[]      NOT NULL DEFAULT '{}',

  -- Ceilings on an unauthenticated public surface.
  messages_per_minute   integer NOT NULL DEFAULT 10,
  conversations_per_hour integer NOT NULL DEFAULT 30,

  status          text        NOT NULL DEFAULT 'active',
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,

  CONSTRAINT chatbot_deployments_status_valid CHECK (status IN ('active', 'revoked')),
  CONSTRAINT chatbot_deployments_rates_bounded CHECK (
    messages_per_minute BETWEEN 1 AND 120 AND conversations_per_hour BETWEEN 1 AND 1000
  )
);

-- Globally unique: a public key must resolve to exactly one deployment across
-- the whole installation, since the lookup happens before any tenant is known.
CREATE UNIQUE INDEX chatbot_deployments_public_key_unique ON chatbot_deployments (public_key);
CREATE INDEX chatbot_deployments_org_idx ON chatbot_deployments (organization_id, chatbot_id);

-- =============================================================================
-- chat_conversations
--
-- `visitor_token_hash` IS a secret, unlike the public key above, and is stored
-- hashed exactly like a session token. It authorises reading and continuing
-- ONE conversation, and expires.
-- =============================================================================

CREATE TABLE chat_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  chatbot_id      uuid        NOT NULL REFERENCES chatbots (id) ON DELETE CASCADE,
  deployment_id   uuid        NOT NULL REFERENCES chatbot_deployments (id) ON DELETE CASCADE,

  visitor_token_hash text     NOT NULL,
  -- Where the conversation was opened from, for the staff inbox. Deliberately
  -- the only provenance we keep: no IP, no fingerprint, no cross-visit id.
  origin          text,

  status          text        NOT NULL DEFAULT 'open',
  message_count   integer     NOT NULL DEFAULT 0,

  handoff_requested_at timestamptz,
  handoff_claimed_by   uuid   REFERENCES users (id) ON DELETE SET NULL,
  handoff_claimed_at   timestamptz,

  started_at      timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  -- A conversation is not a login. The token stops working here.
  expires_at      timestamptz NOT NULL,
  closed_at       timestamptz,

  CONSTRAINT chat_conversations_status_valid CHECK (
    status IN ('open', 'awaiting_human', 'with_human', 'closed')
  )
);

CREATE UNIQUE INDEX chat_conversations_token_unique ON chat_conversations (visitor_token_hash);
CREATE INDEX chat_conversations_org_activity_idx
  ON chat_conversations (organization_id, last_activity_at DESC);
CREATE INDEX chat_conversations_org_status_idx
  ON chat_conversations (organization_id, status, last_activity_at DESC);

-- =============================================================================
-- chat_messages
-- =============================================================================

CREATE TABLE chat_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,

  role            text        NOT NULL,
  content         text        NOT NULL,
  /*
   * What the assistant was SHOWN when it wrote this, derived from what
   * retrieval actually returned. NOT the model's own account of its sources:
   * asking a model which documents it used yields a plausible list, and a
   * fabricated citation is worse than none — it turns an unsupported answer
   * into an apparently sourced one.
   */
  citations       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error_code      text,

  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,
  -- Set only for a staff reply after handoff.
  author_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_messages_role_valid CHECK (role IN ('visitor', 'assistant', 'human', 'notice'))
);

CREATE INDEX chat_messages_conversation_idx
  ON chat_messages (organization_id, conversation_id, created_at);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE chatbots ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbots FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chatbots
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE chatbot_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_sources FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chatbot_sources
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_conversations
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_messages
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

-- -----------------------------------------------------------------------------
-- chatbot_deployments: the one table with a narrow public read path
--
-- THE PROBLEM
-- A visitor arrives holding only a public key. To bind their request to an
-- organization we must first look the key up — but the table is FORCE RLS, so
-- an unbound connection sees zero rows. Same shape as "which organizations do
-- I belong to?" in 0002_user_scope.sql.
--
-- THE WRONG FIX
-- Granting the application BYPASSRLS, or hiding the lookup behind a
-- SECURITY DEFINER function. Either creates a code path that can read every
-- tenant's rows, which is the property this whole design exists to refuse.
--
-- THE FIX
-- The same one as 0002: express the exception as a POLICY, as narrowly as it
-- can be written. A third setting, app.current_deployment_key, makes visible
-- exactly the deployment whose public key was presented, and nothing else.
--
-- WHY THIS DOES NOT WIDEN TENANT QUERIES
-- The public branch is guarded by `current_org_id() IS NULL`. withTenant() and
-- withCustomer() bind ONLY an organization and never the key, so inside any
-- tenant-scoped transaction the branch is unreachable. Only
-- Database.withDeploymentKey() binds the key, and it never binds an
-- organization. tests/security/customer-boundary.test.ts asserts both halves,
-- including that binding an organization suppresses the public branch.
--
-- WITH CHECK is deliberately NOT widened. The public path may READ one
-- deployment row; it may never INSERT or UPDATE anything here.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_deployment_key() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_deployment_key', true), '')
$$;

GRANT EXECUTE ON FUNCTION current_deployment_key() TO moka_app;

ALTER TABLE chatbot_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_deployments FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chatbot_deployments
  USING (
    organization_id = current_org_id()
    OR (
      current_org_id() IS NULL
      AND public_key = current_deployment_key()
      -- A revoked deployment stops resolving immediately, without waiting for
      -- anything to expire. Revocation must be effective, not eventual.
      AND status = 'active'
      AND revoked_at IS NULL
    )
  )
  WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  chatbots, chatbot_sources, chatbot_deployments, chat_conversations TO moka_app;

/*
 * chat_messages gets no UPDATE, deliberately — but it does get DELETE.
 *
 * The two are not the same property and the distinction is the point. A
 * transcript is the record of what was said to a member of the public in the
 * organization's name, so it must not be possible to REWRITE one: no UPDATE
 * privilege means the application cannot alter what a message said, and a
 * quiet edit is not a thing this system can do.
 *
 * Erasure is different. A stranger's conversation is not ours to keep, and
 * retention has to be able to remove it — so DELETE is granted, and the
 * cascade from chat_conversations works as a result. You cannot change what
 * was said; you can destroy it.
 */
GRANT SELECT, INSERT, DELETE ON chat_messages TO moka_app;
