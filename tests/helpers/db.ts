import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Test database helpers.
 *
 * IMPORTANT: these connect as `moka_app` — the runtime role, NOT the schema
 * owner. Testing RLS as the owner would be meaningless, because the owner can
 * bypass policies unless FORCE is set. Using the real application role is what
 * makes the isolation suite a genuine test of production behaviour.
 */

export const APP_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
export const MIGRATION_URL =
  process.env.TEST_DATABASE_MIGRATION_URL ?? process.env.DATABASE_MIGRATION_URL ?? '';

export function requireDatabaseUrl(): string {
  if (!APP_URL) {
    throw new Error(
      'TEST_DATABASE_URL (or DATABASE_URL) is not set.\n' +
        'The security suites deliberately FAIL rather than skip when they cannot\n' +
        'establish their preconditions — a silently skipped isolation test is worse\n' +
        'than a failing one. Run infra/db/bootstrap.sql and configure .env.',
    );
  }
  return APP_URL;
}

export async function appClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  return client;
}

export async function migratorClient(): Promise<pg.Client> {
  if (!MIGRATION_URL) throw new Error('TEST_DATABASE_MIGRATION_URL is not set.');
  const client = new pg.Client({ connectionString: MIGRATION_URL });
  await client.connect();
  return client;
}

/** Run a callback with app.current_org_id bound, exactly as Database.withTenant does. */
export async function asOrg<T>(
  client: pg.Client,
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Run a callback with NO organization bound. Should see nothing. */
export async function asNoOrg<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export interface TestTenant {
  organizationId: string;
  userId: string;
  projectId: string;
  slug: string;
}

/**
 * Create an isolated tenant with a project and an audit row.
 * Uses the migrator only to insert the global `users` row; everything
 * tenant-scoped goes through the app role under a bound context.
 */
export async function createTenant(
  migrator: pg.Client,
  app: pg.Client,
  label: string,
): Promise<TestTenant> {
  const organizationId = randomUUID();
  const slug = `${label}-${organizationId.slice(0, 8)}`;
  const email = `${label}-${organizationId.slice(0, 8)}@example.test`;

  const user = await migrator.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, '$argon2id$placeholder') RETURNING id`,
    [email, `User ${label}`],
  );
  const userId = user.rows[0]!.id;

  const projectId = await asOrg(app, organizationId, async () => {
    await app.query(
      `INSERT INTO organizations (id, name, slug, dek_wrapped) VALUES ($1, $2, $3, 'dGVzdA==')`,
      [organizationId, `Org ${label}`, slug],
    );
    await app.query(
      `INSERT INTO organization_members (organization_id, user_id, role_key, joined_at)
       VALUES ($1, $2, 'owner', now())`,
      [organizationId, userId],
    );
    const project = await app.query<{ id: string }>(
      `INSERT INTO projects (organization_id, name, slug, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [organizationId, `Project ${label}`, `proj-${organizationId.slice(0, 8)}`, `secret-${label}`, userId],
    );
    await app.query(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, resource_type, resource_id, outcome)
       VALUES ($1, 'user', $2, 'test.setup', 'project', $3, 'success')`,
      [organizationId, userId, project.rows[0]!.id],
    );
    return project.rows[0]!.id;
  });

  return { organizationId, userId, projectId, slug };
}

export async function cleanupTenant(
  migrator: pg.Client,
  tenant: TestTenant,
): Promise<void> {
  // The migrator is also subject to FORCE RLS, so cleanup binds the context too.
  await migrator.query('BEGIN');
  try {
    await migrator.query("SELECT set_config('app.current_org_id', $1, true)", [
      tenant.organizationId,
    ]);
    await migrator.query('DELETE FROM audit_logs WHERE organization_id = $1', [
      tenant.organizationId,
    ]);
    await migrator.query('DELETE FROM projects WHERE organization_id = $1', [tenant.organizationId]);
    await migrator.query('DELETE FROM organization_members WHERE organization_id = $1', [
      tenant.organizationId,
    ]);
    await migrator.query('DELETE FROM organizations WHERE id = $1', [tenant.organizationId]);
    await migrator.query('COMMIT');
  } catch {
    await migrator.query('ROLLBACK');
  }
  await migrator.query('DELETE FROM users WHERE id = $1', [tenant.userId]);
}
