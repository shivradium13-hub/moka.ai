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

/**
 * Agent runtime schema (master prompt §18–21).
 *
 * `tool_executions` is append-only: the application role holds INSERT and
 * SELECT but no UPDATE or DELETE. It is the evidence trail for what an agent
 * did, and evidence application code can rewrite is not evidence.
 */

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Operator-authored. Trusted input, unlike anything retrieved. */
    instructions: text('instructions').notNull().default(''),
    modelId: text('model_id'),
    /** Ceiling on tool risk: 'read' | 'draft' | 'execute'. */
    permissionLevel: text('permission_level').notNull().default('read'),
    maxSteps: integer('max_steps').notNull().default(8),
    maxTokens: integer('max_tokens').notNull().default(32000),
    status: text('status').notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('agents_org_created_idx').on(t.organizationId, t.createdAt)],
);

export const agentTools = pgTable(
  'agent_tools',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_tools_unique').on(t.agentId, t.toolName)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The invoking user. Their role is the ceiling on this run's authority. */
    userId: uuid('user_id'),
    status: text('status').notNull().default('running'),
    input: text('input').notNull(),
    output: text('output'),
    errorCode: text('error_code'),
    stepsUsed: integer('steps_used').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    requestId: text('request_id'),
    /**
     * The run that delegated to this one (Phase 8).
     *
     * Constrained in SQL by a COMPOSITE foreign key on
     * `(organization_id, parent_run_id)`, not by the single-column reference
     * Drizzle would generate here. Referential-integrity checks bypass RLS, so
     * a plain FK would let a run in one tenant name a parent in another and
     * the check would not notice. See 0015_mcp_delegation.sql.
     */
    parentRunId: uuid('parent_run_id'),
    /** 0 for a run a person started; bounded at 3 by a CHECK constraint. */
    delegationDepth: integer('delegation_depth').notNull().default(0),
    /** The agent that delegated, kept independently of the parent run row. */
    delegatedBy: uuid('delegated_by'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_org_started_idx').on(t.organizationId, t.startedAt)],
);

/**
 * External MCP servers an operator has registered (Phase 8).
 *
 * Stores only what the OPERATOR decided — never what a server says about
 * itself. Tool names, descriptions and schemas are fetched live and
 * re-validated on every discovery, because caching a third party's
 * self-description means trusting a snapshot of it.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Becomes part of every imported tool name: `mcp__<slug>__<tool>`. */
    slug: text('slug').notNull(),
    /** Only 'http'. A CHECK constraint refuses stdio — see the migration. */
    transport: text('transport').notNull().default('http'),
    url: text('url').notNull(),
    /** Operator-accepted ceiling for this server's tools. Never server-supplied. */
    riskCeiling: text('risk_ceiling').notNull().default('read'),
    enabled: boolean('enabled').notNull().default(true),
    credentialId: uuid('credential_id'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mcp_servers_org_idx').on(t.organizationId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    summary: text('summary').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    toolInput: jsonb('tool_input').notNull().default({}),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    status: text('status').notNull().default('pending'),
    requestedBy: uuid('requested_by'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** A pending approval is a held privilege; it must expire. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set once used, so one approval authorises exactly one execution. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('approvals_org_status_idx').on(t.organizationId, t.status, t.createdAt)],
);

export const toolExecutions = pgTable(
  'tool_executions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    /**
     * Set instead of `runId` when the caller was a chatbot visitor: a chatbot
     * turn is not an agent run. Deliberately NOT a foreign key — see
     * 0009_chat_tool_executions.sql. The record that a public bot was refused
     * a tool should survive the retention deletion of the transcript.
     */
    conversationId: uuid('conversation_id'),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    toolName: text('tool_name').notNull(),
    outcome: text('outcome').notNull(),
    denialReason: text('denial_reason'),
    toolInput: jsonb('tool_input').notNull().default({}),
    toolOutput: jsonb('tool_output'),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_executions_org_created_idx').on(t.organizationId, t.createdAt),
    index('tool_executions_run_idx').on(t.organizationId, t.runId),
    index('tool_executions_conversation_idx').on(t.organizationId, t.conversationId, t.createdAt),
  ],
);
