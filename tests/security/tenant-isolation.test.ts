import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { RLS_PROTECTED_TABLES } from '@moka/db';
import {
  appClient,
  asNoOrg,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE 1 — TENANT ISOLATION.
 *
 * This is the gate on Phase 1. It runs against a REAL PostgreSQL database as
 * the REAL application role (moka_app, NOBYPASSRLS), because testing RLS with
 * a privileged connection proves nothing.
 *
 * The suite FAILS rather than skips when it cannot reach a database: a
 * silently skipped isolation test is more dangerous than a failing one, since
 * it turns a missing guarantee into a green build.
 */

let app: pg.Client;
let migrator: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

beforeAll(async () => {
  app = await appClient();
  migrator = await migratorClient();
  tenantA = await createTenant(migrator, app, 'a');
  tenantB = await createTenant(migrator, app, 'b');
}, 60_000);

afterAll(async () => {
  if (tenantA) await cleanupTenant(migrator, tenantA);
  if (tenantB) await cleanupTenant(migrator, tenantB);
  await app?.end();
  await migrator?.end();
});

describe('RLS configuration', () => {
  it('runs as a role that cannot bypass RLS', async () => {
    const { rows } = await app.query<{ rolbypassrls: boolean; rolsuper: boolean; current_user: string }>(
      `SELECT r.rolbypassrls, r.rolsuper, current_user
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]?.rolbypassrls, 'application role must not have BYPASSRLS').toBe(false);
    expect(rows[0]?.rolsuper, 'application role must not be superuser').toBe(false);
  });

  it('is not the owner of the tables it queries', async () => {
    const { rows } = await app.query<{ count: string }>(
      `SELECT count(*) AS count FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = current_user`,
    );
    expect(Number(rows[0]?.count), 'app role must not own the tables').toBe(0);
  });

  it('has RLS both ENABLED and FORCED on every tenant table', async () => {
    for (const table of RLS_PROTECTED_TABLES) {
      const { rows } = await app.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(rows[0]?.relrowsecurity, `${table}: RLS must be ENABLED`).toBe(true);
      expect(rows[0]?.relforcerowsecurity, `${table}: RLS must be FORCED`).toBe(true);
    }
  });

  it('has a policy on every tenant table', async () => {
    for (const table of RLS_PROTECTED_TABLES) {
      const { rows } = await app.query(`SELECT policyname FROM pg_policies WHERE tablename = $1`, [
        table,
      ]);
      expect(rows.length, `${table} must have at least one RLS policy`).toBeGreaterThan(0);
    }
  });

  it('grants the app role no UPDATE or DELETE on audit_logs', async () => {
    const { rows } = await app.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'audit_logs' AND grantee = current_user`,
    );
    const granted = rows.map((r) => r.privilege_type);
    expect(granted).toContain('INSERT');
    expect(granted).toContain('SELECT');
    expect(granted, 'audit history must not be rewritable').not.toContain('UPDATE');
    expect(granted, 'audit history must not be erasable').not.toContain('DELETE');
  });
});

describe('reads are confined to the bound organization', () => {
  it('shows Tenant A only its own projects', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT id, organization_id FROM projects')).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.organization_id).toBe(tenantA.organizationId);
    }
    expect(rows.map((r) => r.id)).not.toContain(tenantB.projectId);
  });

  /*
   * The central assertion: an explicit WHERE naming Tenant B's data, executed
   * under Tenant A's context, must return nothing.
   */
  it("returns nothing when Tenant A queries Tenant B's project by id", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM projects WHERE id = $1', [tenantB.projectId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("returns nothing when Tenant A filters explicitly on Tenant B's organization id", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM projects WHERE organization_id = $1', [
        tenantB.organizationId,
      ])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  /*
   * A query with NO organization predicate at all. This is what protects
   * against a developer forgetting the WHERE clause: RLS still constrains it.
   */
  it('constrains an unfiltered SELECT to the bound organization', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT organization_id FROM projects')).rows,
    );
    const organizations = new Set(rows.map((r) => r.organization_id));
    expect(organizations.size).toBe(1);
    expect([...organizations][0]).toBe(tenantA.organizationId);
  });

  it('isolates organizations, members, invitations and audit logs the same way', async () => {
    await asOrg(app, tenantA.organizationId, async () => {
      const orgs = await app.query('SELECT id FROM organizations');
      expect(orgs.rows.map((r) => r.id)).toEqual([tenantA.organizationId]);

      const members = await app.query('SELECT organization_id FROM organization_members');
      expect(members.rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);

      const audit = await app.query('SELECT organization_id FROM audit_logs');
      expect(audit.rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
    });
  });

  it('works symmetrically for Tenant B', async () => {
    const rows = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT id, organization_id FROM projects')).rows,
    );
    expect(rows.every((r) => r.organization_id === tenantB.organizationId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(tenantA.projectId);
  });
});

describe('the system fails closed', () => {
  it('returns zero rows when NO organization is bound', async () => {
    const rows = await asNoOrg(app, async () => (await app.query('SELECT * FROM projects')).rows);
    expect(rows, 'an unbound connection must see nothing').toHaveLength(0);
  });

  it('returns zero rows for every protected table when unbound', async () => {
    await asNoOrg(app, async () => {
      for (const table of RLS_PROTECTED_TABLES) {
        const { rows } = await app.query(`SELECT * FROM ${table}`);
        expect(rows, `${table} must be empty without a bound organization`).toHaveLength(0);
      }
    });
  });

  /*
   * A blank setting must behave like an absent one. Without NULLIF in the
   * policy, ''::uuid would raise, turning a missing context into a 500 that
   * distinguishes it from an empty result.
   */
  it('treats a blank organization setting as unbound rather than erroring', async () => {
    const rows = await asOrg(app, '', async () => (await app.query('SELECT * FROM projects')).rows);
    expect(rows).toHaveLength(0);
  });

  it('returns nothing for a well-formed but unknown organization id', async () => {
    const rows = await asOrg(app, randomUUID(), async () =>
      (await app.query('SELECT * FROM projects')).rows,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('writes are confined to the bound organization', () => {
  it("refuses to INSERT a row belonging to another organization", async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query(
          `INSERT INTO projects (organization_id, name, slug) VALUES ($1, 'Injected', 'injected-x')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot UPDATE another organization's project", async () => {
    const result = await asOrg(app, tenantA.organizationId, async () =>
      app.query('UPDATE projects SET name = $1 WHERE id = $2', ['Hijacked', tenantB.projectId]),
    );
    expect(result.rowCount, 'no foreign row should be updatable').toBe(0);

    // Confirm from Tenant B's side that nothing changed.
    const after = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT name FROM projects WHERE id = $1', [tenantB.projectId])).rows,
    );
    expect(after[0]?.name).not.toBe('Hijacked');
  });

  it("cannot DELETE another organization's project", async () => {
    const result = await asOrg(app, tenantA.organizationId, async () =>
      app.query('DELETE FROM projects WHERE id = $1', [tenantB.projectId]),
    );
    expect(result.rowCount).toBe(0);

    const survives = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT id FROM projects WHERE id = $1', [tenantB.projectId])).rows,
    );
    expect(survives).toHaveLength(1);
  });

  it("cannot re-parent its own project into another organization", async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query('UPDATE projects SET organization_id = $1 WHERE id = $2', [
          tenantB.organizationId,
          tenantA.projectId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot write an audit record attributed to another organization', async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query(
          `INSERT INTO audit_logs (organization_id, actor_type, action, resource_type, outcome)
           VALUES ($1, 'user', 'forged.entry', 'project', 'success')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot modify or delete its own audit history', async () => {
    await asOrg(app, tenantA.organizationId, async () => {
      await expect(
        app.query(`UPDATE audit_logs SET action = 'tampered' WHERE organization_id = $1`, [
          tenantA.organizationId,
        ]),
      ).rejects.toThrow(/permission denied/i);
    });

    await asOrg(app, tenantA.organizationId, async () => {
      await expect(
        app.query('DELETE FROM audit_logs WHERE organization_id = $1', [tenantA.organizationId]),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

/**
 * The user-scope policy from 0002_user_scope.sql is a deliberate, narrow
 * widening of RLS. These tests pin its exact boundary, because a policy that
 * grants slightly more than intended is how tenant isolation quietly dies.
 */
describe('user scope reads memberships without widening tenant access', () => {
  async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      const result = await fn();
      await app.query('COMMIT');
      return result;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  it('lets a user read their own membership rows', async () => {
    const rows = await asUser(tenantA.userId, async () =>
      (await app.query('SELECT organization_id, user_id FROM organization_members')).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(tenantA.organizationId);
    expect(rows[0]?.user_id).toBe(tenantA.userId);
  });

  it("does not expose another user's membership rows", async () => {
    const rows = await asUser(tenantA.userId, async () =>
      (await app.query('SELECT user_id FROM organization_members')).rows,
    );
    expect(rows.map((r) => r.user_id)).not.toContain(tenantB.userId);
  });

  it('lets a user read the organizations they belong to, and no others', async () => {
    const rows = await asUser(tenantA.userId, async () =>
      (await app.query('SELECT id FROM organizations')).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([tenantA.organizationId]);
  });

  /*
   * The critical assertion. User scope must expose memberships ONLY — never
   * the tenant data those organizations contain.
   */
  it('exposes no projects or audit rows under user scope', async () => {
    await asUser(tenantA.userId, async () => {
      expect((await app.query('SELECT * FROM projects')).rows).toHaveLength(0);
      expect((await app.query('SELECT * FROM audit_logs')).rows).toHaveLength(0);
    });
  });

  /*
   * If binding an organization did NOT suppress the user branch, a
   * tenant-scoped query on organization_members would also return the user's
   * memberships in OTHER organizations — a cross-tenant leak.
   */
  it('suppresses the user branch entirely once an organization is bound', async () => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [
        tenantB.organizationId,
      ]);
      await app.query("SELECT set_config('app.current_user_id', $1, true)", [tenantA.userId]);

      const members = await app.query('SELECT organization_id FROM organization_members');
      expect(
        members.rows.every((r) => r.organization_id === tenantB.organizationId),
        'binding an organization must exclude the user-scope branch',
      ).toBe(true);

      const orgs = await app.query('SELECT id FROM organizations');
      expect(orgs.rows.map((r) => r.id)).toEqual([tenantB.organizationId]);

      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  });

  it('does not permit writes under user scope', async () => {
    await expect(
      asUser(tenantA.userId, async () =>
        app.query(
          `INSERT INTO organization_members (organization_id, user_id, role_key)
           VALUES ($1, $2, 'owner')`,
          [tenantA.organizationId, tenantB.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('context does not leak between transactions', () => {
  /*
   * SET LOCAL is transaction-scoped. If it leaked to the pooled connection,
   * a later request could inherit the previous request's organization — the
   * classic pooling bug in RLS systems.
   */
  it('does not retain the organization after the transaction ends', async () => {
    await asOrg(app, tenantA.organizationId, async () => {
      const rows = await app.query('SELECT * FROM projects');
      expect(rows.rows.length).toBeGreaterThan(0);
    });

    const afterCommit = await asNoOrg(app, async () =>
      (await app.query('SELECT * FROM projects')).rows,
    );
    expect(afterCommit, 'organization context must not survive the transaction').toHaveLength(0);
  });

  it('rebinds cleanly when switching organizations on the same connection', async () => {
    const a = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT organization_id FROM projects')).rows,
    );
    const b = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT organization_id FROM projects')).rows,
    );

    expect(a.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
    expect(b.every((r) => r.organization_id === tenantB.organizationId)).toBe(true);
  });
});
