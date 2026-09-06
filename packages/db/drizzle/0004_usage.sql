-- =============================================================================
-- 0004_usage — AI usage ledger
--
-- Run as: moka_migrator
--
-- Every provider call writes one row. This is the basis for the usage
-- dashboard (§35) and, in Phase 9, for credit enforcement and billing.
--
-- APPEND-ONLY, like audit_logs: moka_app is granted INSERT and SELECT but not
-- UPDATE or DELETE. A ledger that application code can rewrite is not a
-- ledger, and this one will eventually decide what customers are charged.
-- =============================================================================

CREATE TABLE usage_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  project_id         uuid        REFERENCES projects (id) ON DELETE SET NULL,
  -- No FK: usage must survive the deletion of the user who incurred it.
  user_id            uuid,

  provider_id        text        NOT NULL,
  model_id           text        NOT NULL,
  operation          text        NOT NULL,

  input_tokens       integer     NOT NULL DEFAULT 0,
  output_tokens      integer     NOT NULL DEFAULT 0,
  cache_write_tokens integer     NOT NULL DEFAULT 0,
  cache_read_tokens  integer     NOT NULL DEFAULT 0,

  /*
   * Integer MICRO-dollars, and NULLABLE.
   *
   * NULL means "pricing for this model is not known in this build" — it does
   * NOT mean free. Token counts above are still authoritative, so cost can be
   * backfilled once pricing is configured. Storing 0 instead would silently
   * under-report spend, and money is exactly where a guess must not be made.
   */
  cost_micro_usd     bigint,

  latency_ms         integer     NOT NULL DEFAULT 0,
  finish_reason      text,
  -- Set when the call failed, using the normalised ProviderError code.
  error_code         text,
  request_id         text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_records_operation_valid CHECK (operation IN ('chat', 'stream', 'embedding')),
  CONSTRAINT usage_records_tokens_sane CHECK (
    input_tokens >= 0 AND output_tokens >= 0
    AND cache_write_tokens >= 0 AND cache_read_tokens >= 0
  ),
  CONSTRAINT usage_records_cost_sane CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0)
);

CREATE INDEX usage_records_org_created_idx ON usage_records (organization_id, created_at DESC);
CREATE INDEX usage_records_org_model_idx   ON usage_records (organization_id, model_id);
CREATE INDEX usage_records_org_project_idx ON usage_records (organization_id, project_id);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_records
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

-- INSERT + SELECT only. No UPDATE, no DELETE.
GRANT SELECT, INSERT ON usage_records TO moka_app;
