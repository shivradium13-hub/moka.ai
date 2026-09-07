-- =============================================================================
-- 0014 — Row-level security on `roles`
--
-- FOUND BY THE READINESS PROBE, NOT BY A REVIEW.
--
-- `roles` was created in 0001 with a NULLABLE `organization_id`: NULL means a
-- system role, and a value was reserved for the per-organization custom roles
-- the design anticipates. It was then never given a policy, because on the day
-- it was written every row was a system role and nothing leaked.
--
-- That is exactly the shape of the bug this migration closes. Nothing is
-- exposed TODAY. The first INSERT with a non-null `organization_id` — the
-- first custom role anyone creates — would be readable by every other tenant,
-- and no request would fail to indicate it. A latent cross-tenant read is
-- worth fixing while it is still latent and costs one migration, rather than
-- after it is a disclosure and costs an incident.
--
-- THE POLICY
--
--   organization_id IS NULL      → a system role, readable by everyone. The
--                                  permission lookup needs this and runs both
--                                  inside and outside a tenant transaction.
--   organization_id = current_org_id() → your own custom roles.
--
-- WITH CHECK is deliberately stricter than USING: it refuses NULL. `moka_app`
-- holds only SELECT here, so it cannot write at all today; the clause is there
-- so that if a write grant is ever added, the application cannot mint a new
-- SYSTEM role — which would be a privilege-escalation primitive rather than a
-- data leak.
--
-- Foreign keys from `organization_members.role_key` are unaffected:
-- referential-integrity checks run as the table owner with RLS bypassed, so a
-- membership can still reference a system role it cannot see.
-- =============================================================================

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON roles
  USING (
    organization_id IS NULL
    OR organization_id = current_org_id()
  )
  WITH CHECK (organization_id = current_org_id());
