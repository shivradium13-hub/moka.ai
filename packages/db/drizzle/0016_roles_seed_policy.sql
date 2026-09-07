-- =============================================================================
-- 0016 — Let the MIGRATION role manage system roles
--
-- FIXES A GAP INTRODUCED BY 0014.
--
-- 0014 gave `roles` a policy whose WITH CHECK is deliberately stricter than its
-- USING clause: it refuses `organization_id IS NULL`, so the application cannot
-- mint a new SYSTEM role. That reasoning stands and is not being relaxed.
--
-- What it missed is that `moka_migrator` is subject to FORCE ROW LEVEL SECURITY
-- too, and the seed — which inserts exactly those system roles, with a NULL
-- organization and no tenant bound — is run by the migration role. So 0014
-- made `pnpm db:seed` fail with "new row violates row-level security policy".
--
-- Caught by security suite 4 (rbac-sync), which asserts that every code-defined
-- permission is mirrored into the database. It failed the moment the seed could
-- no longer write, which is the suite doing precisely what it was written for.
--
-- THE FIX, AND WHY IT IS NOT A WEAKENING
--
-- A second policy, scoped `TO moka_migrator`. Postgres ORs permissive policies,
-- so the app role's rules are untouched: `moka_app` still cannot create a
-- system role, still cannot see another tenant's custom roles, and still holds
-- only SELECT here anyway.
--
-- Granting the migration role free rein over this table concedes nothing it did
-- not already have. It OWNS the table: it can ALTER it, DROP it, or turn RLS
-- off entirely. A policy that constrained it would be theatre — and worse,
-- theatre that breaks the seed. What matters is that the two roles are
-- separate and that the REQUEST-PATH role is the constrained one, which is
-- exactly the arrangement `assertRuntimeRoleIsConstrained` refuses to start
-- without.
-- =============================================================================

CREATE POLICY migrator_manages_system_roles ON roles
  TO moka_migrator
  USING (true)
  WITH CHECK (true);
