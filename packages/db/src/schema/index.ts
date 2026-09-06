export * from './identity.js';
export * from './projects.js';
export * from './audit.js';
export * from './knowledge.js';
export * from './usage.js';
export * from './credentials.js';

/**
 * Tables under Row-Level Security.
 *
 * This list is the single source of truth used by
 * `tests/security/tenant-isolation.test.ts`, which asserts that every entry
 * really has RLS enabled AND forced in the live database. Adding a tenant
 * table without adding it here fails that test.
 */
export const RLS_PROTECTED_TABLES: readonly string[] = [
  'organizations',
  'organization_members',
  'invitations',
  'projects',
  'audit_logs',
  'knowledge_sources',
  'knowledge_documents',
  'knowledge_chunks',
  'usage_records',
  'credentials',
];

/**
 * Tables deliberately NOT tenant-scoped, with the reason. Reviewed by the same
 * test, so a new global table cannot be introduced silently.
 */
export const INTENTIONALLY_GLOBAL_TABLES: Readonly<Record<string, string>> = {
  users: 'A user may belong to several organizations; identity is global.',
  sessions: 'A session belongs to a user and may span organizations.',
  roles: 'System role registry, seeded from code.',
  permissions: 'System permission registry, seeded from code.',
  role_permissions: 'System role/permission mapping, seeded from code.',
  __drizzle_migrations: 'Migration bookkeeping.',
};
