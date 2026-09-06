import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity.js';

/**
 * Moka Credentials (docs/security.md §3.1, master prompt §4).
 *
 * `id` has no `.defaultRandom()`: the ciphertext's AAD binds it to
 * (organizationId, id, providerId), so the id must be generated before the
 * secret is encrypted.
 *
 * NOTHING in this table is safe to return to a client except `fingerprint`,
 * `lastFour`, `name`, `providerId` and the status fields. `ciphertext`, `iv`
 * and `authTag` must never appear in a DTO.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    name: text('name').notNull(),

    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    authTag: text('auth_tag').notNull(),

    fingerprint: text('fingerprint').notNull(),
    lastFour: text('last_four').notNull(),
    baseUrl: text('base_url'),

    status: text('status').notNull().default('active'),
    isDefault: boolean('is_default').notNull().default(false),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credentials_org_created_idx').on(t.organizationId, t.createdAt),
    index('credentials_org_provider_idx').on(t.organizationId, t.providerId),
    uniqueIndex('credentials_org_provider_fingerprint_unique').on(
      t.organizationId,
      t.providerId,
      t.fingerprint,
    ),
  ],
);

export const CredentialStatus = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
  REVOKED: 'revoked',
} as const;

export type CredentialStatus = (typeof CredentialStatus)[keyof typeof CredentialStatus];

/**
 * Columns that may be selected into anything a client can see.
 * Referenced by tests/security/credential-exposure.test.ts.
 */
export const CREDENTIAL_PUBLIC_COLUMNS: readonly string[] = [
  'id',
  'organization_id',
  'provider_id',
  'name',
  'fingerprint',
  'last_four',
  'base_url',
  'status',
  'is_default',
  'last_used_at',
  'last_tested_at',
  'last_test_ok',
  'rotated_at',
  'revoked_at',
  'created_by',
  'created_at',
  'updated_at',
];

/** Columns that must NEVER leave the server. */
export const CREDENTIAL_SECRET_COLUMNS: readonly string[] = ['ciphertext', 'iv', 'auth_tag'];
