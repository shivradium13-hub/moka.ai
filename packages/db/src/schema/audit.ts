import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './identity.js';

/**
 * Audit log (docs/security.md §11).
 *
 * APPEND-ONLY. The migration grants the application role INSERT and SELECT but
 * deliberately withholds UPDATE and DELETE, so history cannot be rewritten even
 * by application code that tries.
 *
 * No foreign key on `actorId` / `resourceId`: audit records must survive the
 * deletion of their subject, so they store identifiers rather than references.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** 'user' | 'api_key' | 'agent' | 'system' */
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Dotted action name, e.g. 'project.create', 'member.role_update'. */
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    /** Redacted before write. Never contains secrets. */
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** 'success' | 'failure' */
    outcome: text('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt),
    index('audit_logs_org_action_idx').on(t.organizationId, t.action),
    index('audit_logs_resource_idx').on(t.organizationId, t.resourceType, t.resourceId),
  ],
);
