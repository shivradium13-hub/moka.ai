-- =============================================================================
-- 0006_agents — agent runtime, tool execution and approvals
--
-- Run as: moka_migrator
--
-- Master prompt §18–21. The security model in one line:
--
--   An agent is a CONSTRAINT on what a user can already do — never a grant.
--
-- Every tool call is authorised against BOTH the agent's allowlist and the
-- invoking user's own role. An agent can therefore only ever narrow what its
-- caller could have done by hand. Without that, an agent becomes a privilege
-- escalation path: a viewer runs an "admin assistant" and deletes projects.
-- =============================================================================

-- =============================================================================
-- agents
-- =============================================================================

CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid        REFERENCES projects (id) ON DELETE SET NULL,

  name            text        NOT NULL,
  description     text,
  -- Operator-authored system instructions. TRUSTED input: written by a member
  -- of this organization, not by a document or a tool result.
  instructions    text        NOT NULL DEFAULT '',

  model_id        text,

  /*
   * The ceiling on what this agent may do, independent of its tool list.
   *   read    — may only call tools that read
   *   draft   — may additionally produce drafts and reversible changes
   *   execute — may additionally perform consequential actions
   * A tool is callable only if the agent's level covers its risk AND the
   * invoking user holds the tool's permission.
   */
  permission_level text       NOT NULL DEFAULT 'read',

  -- Runaway protection. A loop that cannot terminate is the default failure
  -- mode of an agent, so the limits are columns, not constants.
  max_steps       integer     NOT NULL DEFAULT 8,
  max_tokens      integer     NOT NULL DEFAULT 32000,

  status          text        NOT NULL DEFAULT 'active',
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT agents_permission_level_valid CHECK (permission_level IN ('read', 'draft', 'execute')),
  CONSTRAINT agents_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT agents_steps_bounded CHECK (max_steps BETWEEN 1 AND 50),
  CONSTRAINT agents_tokens_bounded CHECK (max_tokens BETWEEN 100 AND 500000)
);

CREATE INDEX agents_org_created_idx ON agents (organization_id, created_at DESC);
CREATE UNIQUE INDEX agents_org_name_unique ON agents (organization_id, lower(name))
  WHERE deleted_at IS NULL;

-- =============================================================================
-- agent_tools — the explicit allowlist
--
-- An agent may call NOTHING unless it is listed here. Deny by default: a tool
-- added to the platform is not automatically available to existing agents.
-- =============================================================================

CREATE TABLE agent_tools (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id        uuid        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  tool_name       text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_tools_unique ON agent_tools (agent_id, tool_name);
CREATE INDEX agent_tools_org_idx ON agent_tools (organization_id, agent_id);

-- =============================================================================
-- agent_runs
-- =============================================================================

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id        uuid        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- The invoking user. Their role is the ceiling on the run's authority, so
  -- this is a security-relevant field, not just provenance.
  user_id         uuid,

  status          text        NOT NULL DEFAULT 'running',
  input           text        NOT NULL,
  output          text,
  error_code      text,

  steps_used      integer     NOT NULL DEFAULT 0,
  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,

  request_id      text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  CONSTRAINT agent_runs_status_valid CHECK (
    status IN ('running', 'succeeded', 'failed', 'awaiting_approval', 'cancelled')
  )
);

CREATE INDEX agent_runs_org_started_idx ON agent_runs (organization_id, started_at DESC);
CREATE INDEX agent_runs_agent_idx       ON agent_runs (organization_id, agent_id);

-- =============================================================================
-- approvals — the human gate (§21)
--
-- A high-risk tool call becomes a row here INSTEAD of executing. Nothing about
-- this table is advisory: the executor refuses to run a gated tool without a
-- matching approved row.
-- =============================================================================

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id          uuid        REFERENCES agent_runs (id) ON DELETE CASCADE,

  tool_name       text        NOT NULL,
  -- What the user is being asked to authorise, in their terms.
  summary         text        NOT NULL,
  resource_type   text,
  resource_id     text,
  -- Redacted before write, like every other JSON payload we store.
  tool_input      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  before_value    jsonb,
  after_value     jsonb,

  status          text        NOT NULL DEFAULT 'pending',
  requested_by    uuid,
  decided_by      uuid,
  decided_at      timestamptz,
  -- A pending approval is a held privilege; it must not last forever.
  expires_at      timestamptz NOT NULL,
  -- Set once the approved call has actually run, so one approval cannot
  -- authorise repeated executions.
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT approvals_status_valid CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired')
  ),
  CONSTRAINT approvals_decided_consistent CHECK (
    (status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)
  )
);

CREATE INDEX approvals_org_status_idx  ON approvals (organization_id, status, created_at DESC);
CREATE INDEX approvals_run_idx         ON approvals (organization_id, run_id);

-- =============================================================================
-- tool_executions — the record of what actually ran
--
-- APPEND-ONLY, like audit_logs and usage_records. This is the evidence trail
-- for "what did the agent do", and evidence that application code can rewrite
-- is not evidence.
-- =============================================================================

CREATE TABLE tool_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  run_id          uuid        REFERENCES agent_runs (id) ON DELETE SET NULL,
  approval_id     uuid        REFERENCES approvals (id) ON DELETE SET NULL,

  tool_name       text        NOT NULL,
  -- 'ok' | 'denied' | 'failed' | 'awaiting_approval'
  outcome         text        NOT NULL,
  -- Set when denied, so a refusal can be explained after the fact.
  denial_reason   text,

  tool_input      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  tool_output     jsonb,
  duration_ms     integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tool_executions_outcome_valid CHECK (
    outcome IN ('ok', 'denied', 'failed', 'awaiting_approval')
  )
);

CREATE INDEX tool_executions_org_created_idx ON tool_executions (organization_id, created_at DESC);
CREATE INDEX tool_executions_run_idx         ON tool_executions (organization_id, run_id);
CREATE INDEX tool_executions_tool_idx        ON tool_executions (organization_id, tool_name);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE agent_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tools FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_tools
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_runs
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approvals
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_executions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tool_executions
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON agents, agent_tools, agent_runs, approvals TO moka_app;

-- Append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON tool_executions TO moka_app;
