-- =============================================================================
-- MOKA AI — database bootstrap
--
-- Run ONCE, by a superuser, before the first migration.
-- This is the only step that requires superuser rights; everything afterwards
-- runs as moka_migrator (schema) or moka_app (runtime).
--
-- Usage (from the repository root):
--
--   psql -U postgres -h 127.0.0.1 -d postgres ^
--        -v app_password="'...'" -v migrator_password="'...'" ^
--        -f infra/db/bootstrap.sql
--
-- Generate two distinct passwords first:
--   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
--
-- WHY TWO ROLES (docs/security.md §2.2):
--   moka_migrator  owns the schema and may create tables and policies.
--   moka_app       is the runtime role. It is NOT the table owner and has
--                  NOBYPASSRLS, so Row-Level Security genuinely constrains it.
--                  If the application connected as the owner, RLS would be
--                  silently skipped and tenant isolation would be theatre.
-- =============================================================================

\set ON_ERROR_STOP on

-- --- Roles -------------------------------------------------------------------
-- NOSUPERUSER / NOBYPASSRLS are stated explicitly rather than relied upon as
-- defaults, so a future PostgreSQL default change cannot weaken this.

-- NOTE: \gexec is used rather than a DO block, because psql does NOT
-- interpolate :variables inside dollar-quoted strings — the password would be
-- passed through literally as the text ":app_password".

SELECT format(
  'CREATE ROLE moka_migrator LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
  :migrator_password)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moka_migrator')
\gexec

SELECT format('ALTER ROLE moka_migrator PASSWORD %L', :migrator_password)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moka_migrator')
\gexec

SELECT format(
  'CREATE ROLE moka_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
  :app_password)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moka_app')
\gexec

SELECT format('ALTER ROLE moka_app PASSWORD %L', :app_password)
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moka_app')
\gexec

-- --- Database ----------------------------------------------------------------
-- CREATE DATABASE cannot run inside a transaction or a DO block, so it is
-- guarded by \gexec instead.

SELECT 'CREATE DATABASE moka_ai OWNER moka_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'moka_ai')
\gexec

-- --- Test database (used by the security suites) ------------------------------

SELECT 'CREATE DATABASE moka_ai_test OWNER moka_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'moka_ai_test')
\gexec

-- --- Per-database setup -------------------------------------------------------

\connect moka_ai

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Revoke the implicit PUBLIC grant so only named roles have access.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO moka_app;
GRANT ALL ON SCHEMA public TO moka_migrator;
ALTER SCHEMA public OWNER TO moka_migrator;

\connect moka_ai_test

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO moka_app;
GRANT ALL ON SCHEMA public TO moka_migrator;
ALTER SCHEMA public OWNER TO moka_migrator;

\echo ''
\echo 'Bootstrap complete.'
\echo 'Databases: moka_ai, moka_ai_test'
\echo 'Roles:     moka_migrator (schema owner), moka_app (runtime, NOBYPASSRLS)'
\echo ''
\echo 'Next: put the two connection strings into .env, then run: pnpm db:migrate'
\echo ''
