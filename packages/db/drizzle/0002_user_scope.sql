-- =============================================================================
-- 0002_user_scope — let a user read their OWN memberships
--
-- Run as: moka_migrator
--
-- THE PROBLEM
-- "Which organizations do I belong to?" is a legitimate query that spans
-- organizations, so it has no single organization to bind. Under 0001 it
-- returned nothing: organization_members is FORCE RLS, and an unbound
-- connection correctly sees zero rows.
--
-- THE WRONG FIX
-- Granting the application BYPASSRLS, or routing this through a
-- SECURITY DEFINER function owned by a privileged role. Both create a
-- code path that can read every tenant's data, defeating the point of RLS.
--
-- THE FIX
-- Express the exception as a POLICY. A second, narrowly-scoped setting
-- (app.current_user_id) lets a session read the membership rows belonging to
-- that user, and nothing else.
--
-- WHY THIS DOES NOT WIDEN TENANT QUERIES
-- The user-scoped branch is guarded by `current_org_id() IS NULL`. Database
-- .withTenant() binds ONLY the organization, never the user, so inside a
-- tenant-scoped transaction the branch is unreachable and isolation is
-- unchanged. Only Database.withUserScope() binds the user, and it never binds
-- an organization. tests/security/tenant-isolation.test.ts asserts both halves.
--
-- WITH CHECK is deliberately NOT widened: a user-scoped session may READ its
-- memberships but may never INSERT or UPDATE anything.
-- =============================================================================

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION current_user_id() TO moka_app;

-- --- organization_members -----------------------------------------------------

DROP POLICY tenant_isolation ON organization_members;

CREATE POLICY tenant_isolation ON organization_members
  USING (
    organization_id = current_org_id()
    OR (current_org_id() IS NULL AND user_id = current_user_id())
  )
  WITH CHECK (organization_id = current_org_id());

-- --- organizations ------------------------------------------------------------

DROP POLICY tenant_isolation ON organizations;

CREATE POLICY tenant_isolation ON organizations
  USING (
    id = current_org_id()
    OR (
      current_org_id() IS NULL
      AND EXISTS (
        SELECT 1 FROM organization_members m
         WHERE m.organization_id = organizations.id
           AND m.user_id = current_user_id()
           AND m.status = 'active'
      )
    )
  )
  WITH CHECK (id = current_org_id());
