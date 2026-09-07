-- =============================================================================
-- 0010_chat_tenant_integrity — make tenant consistency a referential constraint
--
-- Run as: moka_migrator
--
-- FOUND BY A TEST, WHICH IS THE POINT OF WRITING THEM.
--
-- `tests/security/customer-boundary.test.ts` asserted that tenant A cannot
-- attach tenant B's knowledge source to its own chatbot. The insert SUCCEEDED,
-- and understanding why is worth the space:
--
--   PostgreSQL performs referential integrity checks WITH ROW SECURITY
--   DISABLED. That is documented and deliberate — without it, a foreign key
--   would leak the existence of invisible rows through constraint violations.
--   But it means `chatbot_sources.source_id REFERENCES knowledge_sources(id)`
--   is satisfied by ANY source in the installation, visible or not.
--
--   The RLS policy on `chatbot_sources` then checks only
--   `organization_id = current_org_id()`, which tenant A's own row satisfies.
--   So the join row inserts: tenant A's chatbot, pointing at tenant B's source.
--
-- Retrieval would not actually have leaked anything today — `knowledge_chunks`
-- is itself RLS-protected, so tenant A's scope still cannot read tenant B's
-- passages, and the application layer checks ownership before writing. But
-- "two independent controls happen to save us" is not the same as "this cannot
-- happen", and a dangling cross-tenant pointer is precisely the sort of thing a
-- later optimisation turns into a leak.
--
-- THE FIX
-- Carry `organization_id` into the foreign key itself. A COMPOSITE reference on
-- (organization_id, <id>) makes "the parent belongs to the same tenant" a
-- referential constraint rather than a policy — and because RI checks bypass
-- RLS, this holds even in the one place policies do not apply. It is enforced
-- for the migrator, for the application role, and for any future code path that
-- forgets to check.
--
-- SCOPE NOTE (§45): this migration fixes the Phase 6 tables. The same shape
-- exists on some earlier joins (`agent_tools.agent_id`, for one). Those have
-- the same "no leak today, wrong tomorrow" character and are recorded in
-- docs/security.md as a known item rather than quietly changed here, because
-- rewriting five phases of constraints belongs in its own reviewed change.
-- =============================================================================

-- Composite uniques for the parents. Redundant with each primary key, which is
-- the point: they exist only so a composite foreign key has something to name.
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_org_id_unique
  UNIQUE (organization_id, id);

ALTER TABLE chatbots ADD CONSTRAINT chatbots_org_id_unique
  UNIQUE (organization_id, id);

ALTER TABLE chatbot_deployments ADD CONSTRAINT chatbot_deployments_org_id_unique
  UNIQUE (organization_id, id);

ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_org_id_unique
  UNIQUE (organization_id, id);

-- --- chatbot_sources ---------------------------------------------------------

ALTER TABLE chatbot_sources DROP CONSTRAINT chatbot_sources_chatbot_id_fkey;
ALTER TABLE chatbot_sources DROP CONSTRAINT chatbot_sources_source_id_fkey;

ALTER TABLE chatbot_sources ADD CONSTRAINT chatbot_sources_chatbot_same_org
  FOREIGN KEY (organization_id, chatbot_id) REFERENCES chatbots (organization_id, id)
  ON DELETE CASCADE;

-- The one the test was actually about: a chatbot may only publish a knowledge
-- source belonging to its own organization.
ALTER TABLE chatbot_sources ADD CONSTRAINT chatbot_sources_source_same_org
  FOREIGN KEY (organization_id, source_id) REFERENCES knowledge_sources (organization_id, id)
  ON DELETE CASCADE;

-- --- chatbot_deployments -----------------------------------------------------

ALTER TABLE chatbot_deployments DROP CONSTRAINT chatbot_deployments_chatbot_id_fkey;

ALTER TABLE chatbot_deployments ADD CONSTRAINT chatbot_deployments_chatbot_same_org
  FOREIGN KEY (organization_id, chatbot_id) REFERENCES chatbots (organization_id, id)
  ON DELETE CASCADE;

-- --- chat_conversations ------------------------------------------------------

ALTER TABLE chat_conversations DROP CONSTRAINT chat_conversations_chatbot_id_fkey;
ALTER TABLE chat_conversations DROP CONSTRAINT chat_conversations_deployment_id_fkey;

ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_chatbot_same_org
  FOREIGN KEY (organization_id, chatbot_id) REFERENCES chatbots (organization_id, id)
  ON DELETE CASCADE;

ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_deployment_same_org
  FOREIGN KEY (organization_id, deployment_id)
  REFERENCES chatbot_deployments (organization_id, id) ON DELETE CASCADE;

-- --- chat_messages -----------------------------------------------------------

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_conversation_id_fkey;

-- Also closes a second door: without this, a tenant could write a message row
-- carrying its own organization_id but pointing at another tenant's
-- conversation. The RLS policy alone would allow that, because the row it
-- checks is the message, not the conversation.
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_conversation_same_org
  FOREIGN KEY (organization_id, conversation_id)
  REFERENCES chat_conversations (organization_id, id) ON DELETE CASCADE;
