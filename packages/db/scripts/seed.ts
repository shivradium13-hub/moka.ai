/**
 * Seed script.
 *
 * Two responsibilities:
 *   1. Mirror the code-defined roles and permissions into the database, so
 *      `organization_members.role_key` has referential integrity.
 *   2. Create two fully-populated organizations with NO overlap, which the
 *      tenant-isolation security suite uses as its fixtures.
 *
 * Idempotent: safe to re-run.
 *
 * Note on RLS: the tables are FORCE ROW LEVEL SECURITY, so even moka_migrator
 * is constrained. Every tenant insert below therefore runs inside a bound
 * transaction, exactly like application code.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import { ALL_ROLES, Permission, ROLE_PERMISSIONS, SystemRole } from '@moka/core';
import { hashPassword, generateDek, loadRootKey, wrapDek } from '@moka/crypto';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, '..', '..', '..', '.env') });

const ROLE_RANK: Record<SystemRole, string> = {
  [SystemRole.VIEWER]: '0',
  [SystemRole.MEMBER]: '1',
  [SystemRole.ADMIN]: '2',
  [SystemRole.OWNER]: '3',
};

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  [Permission.ORG_READ]: 'View organization details',
  [Permission.ORG_UPDATE]: 'Update organization settings',
  [Permission.ORG_DELETE]: 'Delete the organization',
  [Permission.MEMBER_READ]: 'View organization members',
  [Permission.MEMBER_INVITE]: 'Invite new members',
  [Permission.MEMBER_UPDATE_ROLE]: 'Change a member role',
  [Permission.MEMBER_REMOVE]: 'Remove a member',
  [Permission.PROJECT_READ]: 'View projects',
  [Permission.PROJECT_CREATE]: 'Create projects',
  [Permission.PROJECT_UPDATE]: 'Update projects',
  [Permission.PROJECT_DELETE]: 'Delete projects',
  [Permission.AUDIT_READ]: 'Read the audit log',
};

interface SeededOrg {
  organizationId: string;
  ownerUserId: string;
  ownerEmail: string;
  projectId: string;
}

async function seedRolesAndPermissions(client: pg.Client): Promise<void> {
  for (const role of ALL_ROLES) {
    await client.query(
      `INSERT INTO roles (key, name, rank, is_system)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank`,
      [role, role.charAt(0).toUpperCase() + role.slice(1), ROLE_RANK[role]],
    );
  }

  for (const [key, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
    await client.query(
      `INSERT INTO permissions (key, description)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [key, description],
    );
  }

  // Rebuild the mapping so removals in code propagate.
  await client.query('DELETE FROM role_permissions');
  for (const role of ALL_ROLES) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      await client.query(
        'INSERT INTO role_permissions (role_key, permission_key) VALUES ($1, $2)',
        [role, permission],
      );
    }
  }
  console.warn(`  roles: ${ALL_ROLES.length}, permissions: ${Object.keys(PERMISSION_DESCRIPTIONS).length}`);
}

async function seedOrganization(
  client: pg.Client,
  rootKey: Buffer,
  params: { slug: string; name: string; ownerEmail: string; ownerName: string; projectSlug: string },
): Promise<SeededOrg> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM organizations WHERE slug = $1',
    [params.slug],
  );

  // The owner user is global, so it is created outside the tenant transaction.
  const passwordHash = await hashPassword('CorrectHorseBattery1!');
  const userResult = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, email_verified_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [params.ownerEmail, params.ownerName, passwordHash],
  );
  const ownerUserId = userResult.rows[0]!.id;

  if (existing.rows.length > 0) {
    const organizationId = existing.rows[0]!.id;
    const project = await bindOrg(client, organizationId, async () => {
      const r = await client.query<{ id: string }>(
        'SELECT id FROM projects WHERE organization_id = $1 AND slug = $2',
        [organizationId, params.projectSlug],
      );
      return r.rows[0]?.id ?? null;
    });
    if (project) {
      return { organizationId, ownerUserId, ownerEmail: params.ownerEmail, projectId: project };
    }
  }

  // Pre-generate the id: the organizations RLS policy checks the row's own id
  // against the bound context, so the context must be set before the INSERT.
  const organizationId = existing.rows[0]?.id ?? randomUUID();
  const dekWrapped = wrapDek(rootKey, generateDek(), organizationId).toString('base64');

  const projectId = await bindOrg(client, organizationId, async () => {
    await client.query(
      `INSERT INTO organizations (id, name, slug, dek_wrapped)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, params.name, params.slug, dekWrapped],
    );

    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role_key, joined_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [organizationId, ownerUserId, SystemRole.OWNER],
    );

    const p = await client.query<{ id: string }>(
      `INSERT INTO projects (organization_id, name, slug, description, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [
        organizationId,
        `${params.name} Workspace`,
        params.projectSlug,
        `Seed project belonging exclusively to ${params.name}.`,
        ownerUserId,
      ],
    );

    await client.query(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, resource_type, resource_id, outcome)
       VALUES ($1, 'system', NULL, 'organization.seed', 'organization', $2, 'success')`,
      [organizationId, organizationId],
    );

    return p.rows[0]!.id;
  });

  return { organizationId, ownerUserId, ownerEmail: params.ownerEmail, projectId };
}

/** Run a callback with app.current_org_id bound, mirroring Database.withTenant. */
async function bindOrg<T>(client: pg.Client, organizationId: string, fn: () => Promise<T>): Promise<T> {
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_MIGRATION_URL (or DATABASE_URL) is not set.');
    process.exit(1);
  }
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('ENCRYPTION_KEY is not set. See .env.example for how to generate one.');
    process.exit(1);
  }
  const rootKey = loadRootKey(encryptionKey);

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    console.warn('Seeding roles and permissions…');
    await seedRolesAndPermissions(client);

    console.warn('Seeding tenant fixtures…');
    const tenantA = await seedOrganization(client, rootKey, {
      slug: 'tenant-a',
      name: 'Tenant A',
      ownerEmail: 'owner-a@example.test',
      ownerName: 'Owner A',
      projectSlug: 'alpha-project',
    });
    const tenantB = await seedOrganization(client, rootKey, {
      slug: 'tenant-b',
      name: 'Tenant B',
      ownerEmail: 'owner-b@example.test',
      ownerName: 'Owner B',
      projectSlug: 'beta-project',
    });

    console.warn('');
    console.warn('Seed complete.');
    console.warn(`  Tenant A org=${tenantA.organizationId} owner=${tenantA.ownerEmail}`);
    console.warn(`  Tenant B org=${tenantB.organizationId} owner=${tenantB.ownerEmail}`);
    console.warn('  Both owners share the development password: CorrectHorseBattery1!');
    console.warn('  (Development fixture only — never seeded outside NODE_ENV=development/test.)');
  } finally {
    await client.end();
  }
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
