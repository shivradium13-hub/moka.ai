-- =============================================================================
-- 0009_chat_tool_executions — correlate tool executions with chat conversations
--
-- Run as: moka_migrator
--
-- A chatbot turn is NOT an agent run: no human started it, there is no
-- `agent_runs` row, and `run_id` is therefore null for every tool call made on
-- behalf of a visitor. Without this column those rows would be evidence that a
-- tool was called and denied, with no way to say in which conversation — which
-- is most of what makes the record useful.
--
-- DELIBERATELY NOT A FOREIGN KEY.
--
-- Two reasons, and the second is the real one:
--
--  1. `tool_executions` is append-only for the application (SELECT and INSERT,
--     no UPDATE, no DELETE). An `ON DELETE SET NULL` reference needs UPDATE on
--     the referencing table and would force us to widen that grant; an
--     `ON DELETE CASCADE` would need DELETE. Either weakens the append-only
--     property to satisfy a constraint.
--
--  2. The reference SHOULD outlive its target. Conversations are erased on
--     retention because a stranger's transcript is not ours to keep. The
--     record that a public chatbot attempted a privileged tool call and was
--     refused is a security event, and it should still be there afterwards. A
--     dangling id here is not an inconsistency — it is the point.
-- =============================================================================

ALTER TABLE tool_executions ADD COLUMN conversation_id uuid;

CREATE INDEX tool_executions_conversation_idx
  ON tool_executions (organization_id, conversation_id, created_at);
