-- =============================================================================
-- Docker entrypoint wrapper for bootstrap.sql
--
-- PostgreSQL's docker-entrypoint-initdb.d runs plain .sql files with no way to
-- pass psql variables, so this wrapper supplies the development passwords and
-- then delegates. bootstrap.sql stays the single source of truth for roles,
-- databases, extensions and grants — this file must never duplicate that logic.
--
-- Development credentials only. Production bootstrapping runs bootstrap.sql
-- directly with generated passwords.
-- =============================================================================

\set app_password '''moka_dev_app'''
\set migrator_password '''moka_dev_migrator'''

\i /moka-db/bootstrap.sql
