-- =============================================================================
-- 0015 — Phase 8: MCP servers and agent-to-agent delegation
--
-- Two features, one migration, because they share a single property: both let
-- an agent reach something OUTSIDE its own tool list, and both are therefore
-- authorisation surfaces before they are features.
-- =============================================================================


-- =============================================================================
-- mcp_servers — external tool providers an operator has registered
--
-- AN MCP SERVER IS A THIRD PARTY, NOT A PLUGIN.
--
-- It is a remote host, chosen by an operator who may not have read its source,
-- which gets to put text in front of a model that holds this organization's
-- authority. Everything below follows from taking that seriously.
--
-- Note what this table does NOT store: nothing the SERVER says about itself.
-- Tool names, descriptions and schemas are fetched live and re-validated on
-- every discovery, because caching a remote party's self-description means
-- trusting a snapshot of it. What IS stored is what the OPERATOR decided.
-- =============================================================================

CREATE TABLE mcp_servers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  name            text        NOT NULL,
  -- Becomes part of every imported tool name (`mcp__<slug>__<tool>`), so it is
  -- constrained to what can appear in an identifier a model must reproduce
  -- verbatim. Unique per organization: two servers sharing a slug would
  -- collide in the namespace that exists to prevent collisions.
  slug            text        NOT NULL,

  /*
   * Transport. `http` is the only implemented value and the CHECK enforces it.
   *
   * The MCP specification also defines a `stdio` transport in which the client
   * SPAWNS THE SERVER AS A CHILD PROCESS from a configured command line. That
   * is arbitrary command execution driven by a database row — anyone who could
   * write here would choose a command for the server to run. Security suite 7
   * asserts no shipped path can spawn a process, and this constraint is the
   * database half of that guarantee.
   *
   * It is a CHECK rather than an enum so that the refusal is visible in the
   * schema, alongside the reason.
   */
  transport       text        NOT NULL DEFAULT 'http',

  -- Validated by safeFetch on every request, not merely on registration: an
  -- operator-supplied URL is an SSRF surface indistinguishable from a crawl
  -- seed, and DNS can change between registration and use.
  url             text        NOT NULL,

  /*
   * The ceiling an operator accepts for THIS server's tools.
   *
   * Defaults to `read` — the most restrictive setting — so a server registered
   * by someone who changed nothing else gets the safest configuration rather
   * than the most useful one. A server never supplies this; it has no way to,
   * because the client's wire schema has no field for it.
   *
   * This is a CEILING, not a grant. The agent's own permission level and the
   * invoking user's permissions both still apply afterwards.
   */
  risk_ceiling    text        NOT NULL DEFAULT 'read',

  enabled         boolean     NOT NULL DEFAULT true,

  -- Optional credential for the server, from the vault. Never stored here.
  credential_id   uuid,

  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mcp_servers_transport_valid CHECK (transport IN ('http')),
  CONSTRAINT mcp_servers_risk_valid      CHECK (risk_ceiling IN ('read', 'draft', 'execute')),
  CONSTRAINT mcp_servers_slug_format     CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,30}$'),
  -- http(s) only. A `file://` or `gopher://` URL would be a different class of
  -- problem entirely, and safeFetch would refuse it — this refuses it earlier,
  -- where an operator can see why.
  CONSTRAINT mcp_servers_url_scheme      CHECK (url ~ '^https?://')
);

CREATE UNIQUE INDEX mcp_servers_org_slug_unique ON mcp_servers (organization_id, slug);
CREATE INDEX mcp_servers_org ON mcp_servers (organization_id);

-- Composite key target: referential-integrity checks BYPASS row-level
-- security, so same-tenancy has to be expressible as a constraint rather than
-- as a policy wherever one table points at another.
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_org_id_unique UNIQUE (organization_id, id);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mcp_servers
  USING (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_servers TO moka_app;


-- =============================================================================
-- agent_runs.parent_run_id + delegation_depth — the delegation chain
--
-- Recorded rather than merely bounded in code, for two reasons:
--
--   1. When a delegated run does something surprising, the first question is
--      "who asked for this?", and the answer is the chain, not any one agent.
--   2. Depth and cycles are enforced in `authorizeDelegation`, which is pure
--      and holds within one request. The stored chain is what makes the
--      enforcement auditable after the fact.
--
-- The composite foreign key is doing real work here: without it, a run in
-- tenant A could name a parent run in tenant B, and the RI check would not
-- notice because RI bypasses RLS. With it, the parent must belong to the same
-- organization or the insert fails.
-- =============================================================================

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_org_id_unique UNIQUE (organization_id, id);

ALTER TABLE agent_runs
  ADD COLUMN parent_run_id    uuid,
  ADD COLUMN delegation_depth integer NOT NULL DEFAULT 0,
  -- The delegating agent, kept even if the run row is later purged on a
  -- different schedule.
  ADD COLUMN delegated_by     uuid;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_parent_same_org
    FOREIGN KEY (organization_id, parent_run_id)
    REFERENCES agent_runs (organization_id, id) ON DELETE SET NULL;

/*
 * Depth is bounded in the database as well as in code.
 *
 * `MAX_DELEGATION_DEPTH` is 3, and this allows 0..3. Two enforcement points
 * for one rule is usually a smell, but this one is a SAFETY CEILING: if the
 * pure check were ever bypassed by a new code path, an unbounded delegation
 * chain would be a runaway billing event rather than a wrong answer. The
 * database is the backstop that cannot be forgotten.
 */
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_delegation_depth_bounded
    CHECK (delegation_depth >= 0 AND delegation_depth <= 3);

-- A root run has no parent and depth 0; a delegated run has both. Neither half
-- alone is meaningful, and a row with one but not the other is a bug we would
-- rather not store.
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_delegation_consistent
    CHECK (
      (parent_run_id IS NULL AND delegation_depth = 0)
      OR (parent_run_id IS NOT NULL AND delegation_depth > 0)
    );

CREATE INDEX agent_runs_parent ON agent_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
