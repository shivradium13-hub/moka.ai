import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './identity.js';
import { projects } from './projects.js';

/**
 * AI usage ledger (docs/architecture.md §35).
 *
 * Append-only: the application role holds no UPDATE or DELETE grant, because
 * this table will decide what customers are billed.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** No FK: usage outlives the user who incurred it. */
    userId: uuid('user_id'),

    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    operation: text('operation').notNull(),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),

    /**
     * Integer micro-dollars. NULL means pricing is unknown for this model —
     * NOT that the call was free. Token counts remain authoritative so cost
     * can be backfilled.
     */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }),

    latencyMs: integer('latency_ms').notNull().default(0),
    finishReason: text('finish_reason'),
    errorCode: text('error_code'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_records_org_created_idx').on(t.organizationId, t.createdAt),
    index('usage_records_org_model_idx').on(t.organizationId, t.modelId),
    index('usage_records_org_project_idx').on(t.organizationId, t.projectId),
  ],
);
