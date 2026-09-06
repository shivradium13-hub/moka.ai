import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Identity and tenancy schema (docs/database.md §3).
 *
 * `users` is intentionally NOT tenant-scoped: one person may belong to several
 * organizations. Everything below `organizations` is tenant-scoped and carries
 * `organization_id`, protected by RLS (see drizzle/0001_rls.sql).
 */

/* -------------------------------------------------------------------------- */
/* users — global, not tenant-scoped                                           */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /**
     * Stored lower-cased and trimmed by the application layer. A unique index
     * on the normalised value is used instead of the citext extension, to keep
     * the schema portable and the comparison explicit.
     */
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Argon2id encoded hash. Never selected into a DTO. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    /** Envelope-encrypted TOTP secret. Null until MFA is enrolled. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
);

/* -------------------------------------------------------------------------- */
/* organizations — the tenant root                                             */
/* -------------------------------------------------------------------------- */

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /**
     * Per-organization data encryption key, wrapped under the root KEK.
     * Layout: iv || authTag || ciphertext. See @moka/crypto wrapDek().
     * Never leaves the server; excluded from every DTO.
     */
    dekWrapped: text('dek_wrapped').notNull(),
    status: text('status').notNull().default('active'),
    settings: text('settings').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('organizations_slug_unique').on(t.slug)],
);

/* -------------------------------------------------------------------------- */
/* roles / permissions — mirrored from code, kept in sync by test              */
/* -------------------------------------------------------------------------- */

/**
 * System roles. Seeded from `SystemRole` in @moka/core so that the database
 * can enforce referential integrity on member roles. Permission EVALUATION
 * happens in code (ROLE_PERMISSIONS); these tables exist so an admin UI and
 * future custom roles have something to reference.
 *
 * `tests/security/rbac-sync.test.ts` asserts the two never drift.
 */
export const roles = pgTable('roles', {
  key: text('key').primaryKey(),
  /** Null for system roles; set when organizations define custom roles. */
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  rank: text('rank').notNull(),
  isSystem: boolean('is_system').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('role_permissions_unique').on(t.roleKey, t.permissionKey)],
);

/* -------------------------------------------------------------------------- */
/* organization_members — tenant-scoped                                        */
/* -------------------------------------------------------------------------- */

export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    status: text('status').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('organization_members_org_user_unique').on(t.organizationId, t.userId),
    index('organization_members_org_created_idx').on(t.organizationId, t.createdAt),
    index('organization_members_user_idx').on(t.userId),
  ],
);

/* -------------------------------------------------------------------------- */
/* invitations — tenant-scoped                                                 */
/* -------------------------------------------------------------------------- */

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    /** SHA-256 of the invitation token. The plaintext is emailed, never stored. */
    tokenHash: text('token_hash').notNull(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_unique').on(t.tokenHash),
    index('invitations_org_created_idx').on(t.organizationId, t.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* sessions — user-owned, NOT tenant-scoped                                    */
/* -------------------------------------------------------------------------- */

/**
 * A session belongs to a user and may span organizations, so it is deliberately
 * not under RLS. `activeOrganizationId` records which organization the session
 * is currently acting in; the TenantGuard re-verifies membership on every
 * request rather than trusting this column.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of a 256-bit random token. The plaintext exists only in the cookie. */
    tokenHash: text('token_hash').notNull(),
    activeOrganizationId: uuid('active_organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);
