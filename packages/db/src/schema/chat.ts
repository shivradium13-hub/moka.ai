import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';
import { knowledgeSources } from './knowledge.js';

/**
 * Customer chatbot schema (master prompt §22–24).
 *
 * These are the first tables reachable by someone who is not a user of the
 * platform at all. Three properties follow from that and are worth naming:
 *
 *   - `chatbot_sources` is a PUBLICATION DECISION, not a filter. A knowledge
 *     source attached to a chatbot can be quoted verbatim to any passer-by.
 *     Retrieval on the public path is confined to this join, so a source that
 *     is not listed cannot be reached however the conversation goes.
 *
 *   - `chatbot_deployments.public_key` is public by design. It is pasted into
 *     the customer's HTML. It is stored in plaintext because it is not a
 *     secret; treating it as one would be theatre (see @moka/chat keys.ts).
 *
 *   - `chat_conversations.visitor_token_hash` IS a secret, and is stored
 *     hashed exactly like a session token.
 */

export const chatbots = pgTable(
  'chatbots',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    description: text('description'),
    /**
     * Operator-authored persona. Trusted in the same sense as an agent's
     * instructions — but note it is effectively published: a determined
     * visitor can get a model to recite it, so it must hold nothing secret.
     */
    instructions: text('instructions').notNull().default(''),
    /** Served from configuration, never generated. See @moka/chat greetingFor. */
    greeting: text('greeting'),
    modelId: text('model_id'),

    /** No retrieved passage, no answer. The anti-fabrication default. */
    requireGrounding: boolean('require_grounding').notNull().default(true),
    minPassages: integer('min_passages').notNull().default(1),
    maxPassages: integer('max_passages').notNull().default(6),

    handoffEnabled: boolean('handoff_enabled').notNull().default(true),
    /** Days a conversation is kept. A stranger's transcript is not ours to hoard. */
    retentionDays: integer('retention_days').notNull().default(30),

    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('chatbots_org_created_idx').on(t.organizationId, t.createdAt)],
);

/**
 * Which knowledge sources this chatbot may quote to the public.
 *
 * Empty means the chatbot can retrieve NOTHING, which with grounding on means
 * it answers nothing. That is the correct default for a surface whose mistake
 * mode is publishing internal documents to the internet.
 */
export const chatbotSources = pgTable(
  'chatbot_sources',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chatbotId: uuid('chatbot_id')
      .notNull()
      .references(() => chatbots.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    attachedBy: uuid('attached_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chatbot_sources_unique').on(t.chatbotId, t.sourceId)],
);

export const chatbotDeployments = pgTable(
  'chatbot_deployments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chatbotId: uuid('chatbot_id')
      .notNull()
      .references(() => chatbots.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** PUBLIC. Appears in the customer's page source. Grants no authority. */
    publicKey: text('public_key').notNull(),
    /** Sites this deployment may be embedded on. Empty means nowhere. */
    allowedOrigins: text('allowed_origins').array().notNull().default(sql`'{}'::text[]`),

    /** Per-conversation and per-origin ceilings on a public, unauthenticated surface. */
    messagesPerMinute: integer('messages_per_minute').notNull().default(10),
    conversationsPerHour: integer('conversations_per_hour').notNull().default(30),

    status: text('status').notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chatbot_deployments_public_key_unique').on(t.publicKey),
    index('chatbot_deployments_org_idx').on(t.organizationId, t.chatbotId),
  ],
);

export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    chatbotId: uuid('chatbot_id')
      .notNull()
      .references(() => chatbots.id, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => chatbotDeployments.id, { onDelete: 'cascade' }),

    /** SECRET. Hashed, like a session token. Identifies one conversation. */
    visitorTokenHash: text('visitor_token_hash').notNull(),
    /** The origin the conversation was opened from, for the staff inbox. */
    origin: text('origin'),

    status: text('status').notNull().default('open'),
    /** Bounded so one visitor cannot spend without limit. */
    messageCount: integer('message_count').notNull().default(0),

    handoffRequestedAt: timestamp('handoff_requested_at', { withTimezone: true }),
    handoffClaimedBy: uuid('handoff_claimed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    handoffClaimedAt: timestamp('handoff_claimed_at', { withTimezone: true }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    /** The visitor token stops working here. A conversation is not a login. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chat_conversations_token_unique').on(t.visitorTokenHash),
    index('chat_conversations_org_activity_idx').on(t.organizationId, t.lastActivityAt),
    index('chat_conversations_org_status_idx').on(t.organizationId, t.status),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversations.id, { onDelete: 'cascade' }),

    /** 'visitor' | 'assistant' | 'human' | 'notice' */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /**
     * What the assistant was SHOWN when it wrote this, derived from retrieval
     * rather than from the model's own account of its sources. A model-supplied
     * citation list is plausible, not true.
     */
    citations: jsonb('citations').notNull().default([]),
    /** Set when the turn failed, so a failure is visible rather than silent. */
    errorCode: text('error_code'),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Set for a staff reply after handoff. Null for visitor and assistant. */
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_conversation_idx').on(t.organizationId, t.conversationId, t.createdAt)],
);
