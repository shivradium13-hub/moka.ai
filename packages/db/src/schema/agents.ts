import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_org_started_idx').on(t.organizationId, t.startedAt)],
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
  ],
);
