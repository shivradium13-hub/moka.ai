-- =============================================================================
-- 0008_customer_actor — admit the customer actor type into the audit trail
--
-- Run as: moka_migrator
--
-- Split from 0007 rather than appended to it. 0007 had already been applied,
-- and the migration runner refuses to re-run a modified file — deliberately,
-- since a migration whose contents change after the fact means two databases
-- that both claim to be at the same version are not. The right response to
-- that guard is a new migration, not a way around it.
--
-- WHY THE CONSTRAINT HAS TO CHANGE
-- Public chat activity is audited like everything else: a conversation opened,
-- a handoff requested, a deployment resolved by an unknown caller. The actor
-- in those rows is a CUSTOMER — an anonymous visitor with no user id — and the
-- constraint from 0001 predates that principal existing. Left as it was, every
-- audit write on the public path would fail, and the one surface reachable by
-- strangers would be the one with no trail.
-- =============================================================================

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_type_valid;

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_valid
  CHECK (actor_type IN ('user', 'api_key', 'agent', 'system', 'customer'));
