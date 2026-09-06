import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

/**
 * Projects — tenant-scoped (docs/database.md §3).
 *
 * Every tenant table carries `organization_id NOT NULL` and leads with the
 * `(organization_id, created_at DESC)` index required by the conventions.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    settings: text('settings').notNull().default('{}'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('projects_org_created_idx').on(t.organizationId, t.createdAt),
    uniqueIndex('projects_org_slug_unique').on(t.organizationId, t.slug),
  ],
);
