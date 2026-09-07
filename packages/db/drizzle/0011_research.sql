-- =============================================================================
-- 0011_research — web research runs and the sources they actually fetched
--
-- Run as: moka_migrator
--
-- Master prompt §8, §9; architecture §5 Path C.
--
-- THE POINT OF THESE TWO TABLES
--
-- "No fabricated citations" is the gate this phase is measured on, and a claim
-- like that is worth very little unless someone can check it later. So the
-- citation ledger is persisted, including the EXCERPT the model was shown.
--
-- Six months after an answer was written, anyone can open the run and see the
-- URL that was finally fetched, when it was fetched, a hash of what came back,
-- and the exact text in front of the model when it wrote a given sentence.
-- That turns "the system does not fabricate sources" from an assertion about
-- code into something a person can verify from a row.
--
-- Candidates that were NOT collected are stored too, with the reason. An
-- answer that used two sources out of nine is a different answer from one that
-- had two candidates — and the reader deserves to be able to tell.
-- =============================================================================

CREATE TABLE research_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      uuid        REFERENCES projects (id) ON DELETE SET NULL,

  question        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'running',

  -- The answer as shown: invalid citation markers and invented URLs removed.
  answer          text,
  /*
   * What the model actually returned, before verification edited it.
   *
   * Kept deliberately. If the system silently corrected an answer, the person
   * relying on it should be able to see what was corrected — and a reviewer
   * looking into a bad answer needs the original, not our cleaned version of
   * it. Storing only the tidied text would hide our own edits.
   */
  raw_answer      text,

  -- 'seed' (URLs supplied by the user) or 'searxng'. An answer's provenance
  -- should be legible without reading the code that produced it.
  search_provider text        NOT NULL,
  /*
   * Verification signals: invalid markers, invented URLs, unverified quotes.
   * Stored per run so a PATTERN is visible. One fabricated URL is noise; the
   * same prompt producing them every time is a fact worth being able to find.
   */
  verification    jsonb       NOT NULL DEFAULT '{}'::jsonb,

  input_tokens    integer     NOT NULL DEFAULT 0,
  output_tokens   integer     NOT NULL DEFAULT 0,
  error_code      text,
  request_id      text,

  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  CONSTRAINT research_runs_status_valid CHECK (
    status IN ('running', 'answered', 'no_sources', 'no_results', 'failed')
  )
);

CREATE INDEX research_runs_org_started_idx ON research_runs (organization_id, started_at DESC);

-- =============================================================================
-- research_sources — the persisted citation ledger
-- =============================================================================

CREATE TABLE research_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  run_id          uuid        NOT NULL REFERENCES research_runs (id) ON DELETE CASCADE,

  -- The citation number the model was given. NULL for a candidate that was
  -- considered and never collected, which is why this is nullable.
  ordinal         integer,
  requested_url   text        NOT NULL,
  -- After redirects. This is what a citation points at, and it is what makes
  -- a citation reproducible: the requested URL may be a redirector.
  final_url       text,
  title           text,
  content_hash    text,
  -- Exactly the text placed in the prompt. The evidence, kept.
  excerpt         text,

  outcome         text        NOT NULL,
  detail          text,

  fetched_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT research_sources_outcome_valid CHECK (
    outcome IN ('collected', 'robots_disallowed', 'fetch_failed', 'blocked', 'not_html',
                'empty', 'duplicate')
  ),
  /*
   * A collected source must carry the four things that make it citable.
   * Enforced here rather than trusted, because a row missing its final URL or
   * its hash is a citation nobody can check — which is the failure mode this
   * whole table exists to rule out.
   */
  CONSTRAINT research_sources_collected_complete CHECK (
    outcome <> 'collected'
    OR (ordinal IS NOT NULL AND final_url IS NOT NULL
        AND content_hash IS NOT NULL AND fetched_at IS NOT NULL)
  )
);

CREATE INDEX research_sources_run_idx ON research_sources (organization_id, run_id);
-- Two sources cannot share a citation number within one run.
CREATE UNIQUE INDEX research_sources_run_ordinal_unique ON research_sources (run_id, ordinal);

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_runs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON research_runs
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_sources FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON research_sources
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- TENANT INTEGRITY
--
-- Composite keys, for the reason established in 0010: referential integrity
-- checks run with row security DISABLED, so a single-column reference is
-- satisfied by any row in the installation. Carrying organization_id into the
-- key makes same-tenancy a referential constraint rather than a policy.
-- =============================================================================

ALTER TABLE research_runs ADD CONSTRAINT research_runs_org_id_unique
  UNIQUE (organization_id, id);

ALTER TABLE research_sources DROP CONSTRAINT research_sources_run_id_fkey;
ALTER TABLE research_sources ADD CONSTRAINT research_sources_run_same_org
  FOREIGN KEY (organization_id, run_id) REFERENCES research_runs (organization_id, id)
  ON DELETE CASCADE;

-- =============================================================================
-- GRANTS
--
-- No UPDATE on research_sources: a source record is what was fetched at a
-- point in time, and a fetched page's hash is not something the application
-- should be able to revise afterwards. DELETE is granted so a run can be
-- removed with its evidence.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON research_runs TO moka_app;
GRANT SELECT, INSERT, DELETE ON research_sources TO moka_app;
