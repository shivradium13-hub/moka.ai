-- =============================================================================
-- 0001_init — identity, tenancy, projects, audit
--
-- Run as: moka_migrator
--
-- This migration creates tables, indexes, GRANTS and RLS POLICIES together in
-- ONE transaction (docs/database.md §13.7). A tenant table must never exist,
-- even momentarily, without the policy that protects it — so splitting the
-- policies into a follow-up migration is forbidden by design, not convention.
-- =============================================================================

-- --- Extensions ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- GLOBAL TABLES (deliberately not tenant-scoped)
-- =============================================================================

-- users: a person may belong to several organizations, so identity is global.
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text        NOT NULL,
  email_verified_at    timestamptz,
  password_hash        text        NOT NULL,
  name                 text        NOT NULL,
  avatar_url           text,
  mfa_secret_encrypted text,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_format    CHECK (position('@' in email) > 1)
);
CREATE UNIQUE INDEX users_email_unique ON users (email);

-- roles / permissions: seeded from code (@moka/core). Kept in the database so
-- member roles have referential integrity and custom roles have a home later.
CREATE TABLE roles (
  key             text PRIMARY KEY,
  organization_id uuid,
  name            text        NOT NULL,
  rank            text        NOT NULL,
  is_system       boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_key       text NOT NULL REFERENCES roles (key)       ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions (key) ON DELETE CASCADE
);
CREATE UNIQUE INDEX role_permissions_unique ON role_permissions (role_key, permission_key);

-- =============================================================================
-- TENANT ROOT
-- =============================================================================

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  slug        text        NOT NULL,
  -- Per-org DEK wrapped under the root KEK (iv || authTag || ciphertext, base64).
  dek_wrapped text        NOT NULL,
  status      text        NOT NULL DEFAULT 'active',
  settings    text        NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT organizations_status_valid CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT organizations_slug_format  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE UNIQUE INDEX organizations_slug_unique ON organizations (slug);

-- roles.organization_id FK added here, now that organizations exists.
ALTER TABLE roles
  ADD CONSTRAINT roles_organization_id_fk
  FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE;

-- =============================================================================
-- SESSIONS (user-owned, spans organizations, so not tenant-scoped)
-- =============================================================================

CREATE TABLE sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash             text        NOT NULL,
  active_organization_id uuid        REFERENCES organizations (id) ON DELETE SET NULL,
  ip                     text,
  user_agent             text,
  expires_at             timestamptz NOT NULL,
  revoked_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions (token_hash);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- =============================================================================
-- TENANT-SCOPED TABLES
-- =============================================================================

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users (id)         ON DELETE CASCADE,
  role_key        text        NOT NULL REFERENCES roles (key),
  status          text        NOT NULL DEFAULT 'active',
  invited_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_status_valid CHECK (status IN ('active', 'suspended'))
);
CREATE UNIQUE INDEX organization_members_org_user_unique ON organization_members (organization_id, user_id);
CREATE INDEX organization_members_org_created_idx ON organization_members (organization_id, created_at DESC);
CREATE INDEX organization_members_user_idx        ON organization_members (user_id);

CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email           text        NOT NULL,
  role_key        text        NOT NULL REFERENCES roles (key),
  token_hash      text        NOT NULL,
  invited_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  status          text        NOT NULL DEFAULT 'pending',
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_status_valid CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT invitations_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX invitations_token_hash_unique ON invitations (token_hash);
CREATE INDEX invitations_org_created_idx ON invitations (organization_id, created_at DESC);

CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text        NOT NULL,
  slug            text        NOT NULL,
  description     text,
  settings        text        NOT NULL DEFAULT '{}',
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);
CREATE INDEX projects_org_created_idx ON projects (organization_id, created_at DESC);
CREATE UNIQUE INDEX projects_org_slug_unique ON projects (organization_id, slug);

-- audit_logs: ON DELETE RESTRICT — history must outlive its subject.
CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  actor_type      text        NOT NULL,
  actor_id        uuid,
  action          text        NOT NULL,
  resource_type   text        NOT NULL,
  resource_id     text,
  before          jsonb,
  after           jsonb,
  request_id      text,
  ip              text,
  user_agent      text,
  outcome         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_actor_type_valid CHECK (actor_type IN ('user', 'api_key', 'agent', 'system')),
  CONSTRAINT audit_logs_outcome_valid    CHECK (outcome IN ('success', 'failure'))
);
CREATE INDEX audit_logs_org_created_idx  ON audit_logs (organization_id, created_at DESC);
CREATE INDEX audit_logs_org_action_idx   ON audit_logs (organization_id, action);
CREATE INDEX audit_logs_resource_idx     ON audit_logs (organization_id, resource_type, resource_id);

-- =============================================================================
-- ROW-LEVEL SECURITY
--
-- The policy reads a transaction-local setting written by Database.withTenant().
--
--   current_setting('app.current_org_id', true)  -> NULL when unset
--   NULLIF(..., '')                              -> NULL when blank
--   NULL = organization_id                       -> NULL -> not TRUE -> no rows
--
-- So an unbound connection sees nothing. The system fails CLOSED.
-- NULLIF matters: a blank string would raise on ::uuid, turning a missing
-- context into a 500 rather than a clean empty result.
--
-- FORCE is required because the table owner would otherwise bypass RLS.
-- =============================================================================

CREATE OR REPLACE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$;

-- organizations: the tenant root matches on its own primary key.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING      (id = current_org_id())
  WITH CHECK (id = current_org_id());

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_members
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON projects
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
  USING      (organization_id = current_org_id())
  WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- GRANTS
--
-- moka_app receives the narrowest set that the application actually needs.
-- audit_logs is INSERT + SELECT only: no UPDATE, no DELETE, so application
-- code cannot rewrite history even if it tries (docs/security.md §11).
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users,
  sessions,
  organizations,
  organization_members,
  invitations,
  projects
TO moka_app;

GRANT SELECT, INSERT ON audit_logs TO moka_app;

-- Seeded reference data: read-only at runtime.
GRANT SELECT ON roles, permissions, role_permissions TO moka_app;

GRANT EXECUTE ON FUNCTION current_org_id() TO moka_app;
