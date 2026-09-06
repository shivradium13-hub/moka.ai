import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ALL_ROLES, Permission, ROLE_PERMISSIONS } from '@moka/core';
import { appClient, migratorClient } from '../helpers/db.js';

/**
 * SECURITY SUITE 4 (part) — code/database RBAC drift.
 *
 * Permissions are EVALUATED in code (ROLE_PERMISSIONS) but MIRRORED into the
 * database so member roles have referential integrity and an admin UI has
 * something to read. Two representations of the same rule can drift, and a
 * drifted permission table is exactly the sort of thing that looks correct in
 * a UI while the real check says otherwise.
 *
 * This suite is what makes keeping both representations defensible.
 */

let app: pg.Client;
let migrator: pg.Client;

beforeAll(async () => {
  app = await appClient();
  migrator = await migratorClient();
}, 60_000);

afterAll(async () => {
  await app?.end();
  await migrator?.end();
});

describe('roles', () => {
  it('has every code-defined role seeded in the database', async () => {
    const { rows } = await app.query<{ key: string }>('SELECT key FROM roles WHERE is_system');
    const seeded = rows.map((r) => r.key).sort();
    expect(seeded).toEqual([...ALL_ROLES].sort());
  });
});

describe('permissions', () => {
  it('has every code-defined permission seeded', async () => {
    const { rows } = await app.query<{ key: string }>('SELECT key FROM permissions');
    const seeded = new Set(rows.map((r) => r.key));
    for (const permission of Object.values(Permission)) {
      expect(seeded.has(permission), `permission ${permission} is missing from the database`).toBe(
        true,
      );
    }
  });

  it('has no permission in the database that code does not define', async () => {
    const { rows } = await app.query<{ key: string }>('SELECT key FROM permissions');
    const known = new Set<string>(Object.values(Permission));
    for (const row of rows) {
      expect(known.has(row.key), `database defines unknown permission ${row.key}`).toBe(true);
    }
  });
});

describe('role/permission mapping', () => {
  it('matches ROLE_PERMISSIONS exactly for every role', async () => {
    for (const role of ALL_ROLES) {
      const { rows } = await app.query<{ permission_key: string }>(
        'SELECT permission_key FROM role_permissions WHERE role_key = $1',
        [role],
      );
      const inDatabase = rows.map((r) => r.permission_key).sort();
      const inCode = [...ROLE_PERMISSIONS[role]].sort();
      expect(inDatabase, `role_permissions drifted from code for role "${role}"`).toEqual(inCode);
    }
  });

  it('grants organization deletion to the owner alone', async () => {
    const { rows } = await app.query<{ role_key: string }>(
      'SELECT role_key FROM role_permissions WHERE permission_key = $1',
      [Permission.ORG_DELETE],
    );
    expect(rows.map((r) => r.role_key)).toEqual(['owner']);
  });

  it('withholds audit access from members and viewers in the database too', async () => {
    const { rows } = await app.query<{ role_key: string }>(
      'SELECT role_key FROM role_permissions WHERE permission_key = $1',
      [Permission.AUDIT_READ],
    );
    const roles = rows.map((r) => r.role_key).sort();
    expect(roles).toEqual(['admin', 'owner']);
  });
});

describe('role integrity', () => {
  it('constrains organization_members.role_key by foreign key', async () => {
    const { rows } = await migrator.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM information_schema.table_constraints
        WHERE table_name = 'organization_members' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('rejects an unknown role on a member row', async () => {
    await expect(
      migrator.query(
        `INSERT INTO organization_members (organization_id, user_id, role_key)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'superadmin')`,
      ),
    ).rejects.toThrow();
  });
});
