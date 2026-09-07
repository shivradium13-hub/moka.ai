import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  ALL_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  SystemRole,
  canAssignRole,
  canManageMember,
  hasPermission,
} from '@moka/core';
import {
  appClient,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE 4 — PRIVILEGE ESCALATION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY THIS SUITE EXISTS TO MAKE EXPLICIT
 *
 * Row-level security is TENANT isolation. It is not, and was never, INTRA-tenant
 * authorization.
 *
 * The policy on `organization_members` is
 * `organization_id = current_org_id()` for both USING and WITH CHECK. Inside a
 * transaction bound to organization A, that permits reading AND WRITING any
 * member row belonging to A — including one that promotes a member to owner.
 * RLS is working exactly as designed and does not care.
 *
 * What stops that is the application: `PermissionGuard` for the route, and
 * `canAssignRole` / `canManageMember` for the specific change. Two layers, and
 * only one of them is in the database.
 *
 * This is worth asserting rather than assuming, because the rest of this
 * codebase leans on RLS so heavily that "the database will catch it" becomes a
 * reflex. Here it will not, and the tests below say so out loud — including
 * one that deliberately demonstrates the gap, so nobody discovers it by
 * removing an application check and finding everything still passes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

let migrator: pg.Client;
let app: pg.Client;
let tenant: TestTenant;

beforeAll(async () => {
  migrator = await migratorClient();
  app = await appClient();
  tenant = await createTenant(migrator, app, 'esc');
}, 60_000);

afterAll(async () => {
  if (tenant) await cleanupTenant(migrator, tenant);
  await app?.end();
  await migrator?.end();
});

/* ========================================================================== */
/* 1. The role lattice                                                        */
/* ========================================================================== */

describe('role assignment', () => {
  it('an owner may assign any role', () => {
    for (const target of ALL_ROLES) {
      expect(canAssignRole(SystemRole.OWNER, target)).toBe(true);
    }
  });

  it('nobody below owner may create an owner', () => {
    /*
     * The escalation that ends the game. An admin who can mint an owner has
     * given themselves an owner account, and organization deletion with it.
     */
    for (const actor of [SystemRole.ADMIN, SystemRole.MEMBER, SystemRole.VIEWER]) {
      expect(canAssignRole(actor, SystemRole.OWNER)).toBe(false);
    }
  });

  it('an admin may not assign admin — no lateral cloning', () => {
    /*
     * Subtler and more often missed than upward escalation. If an admin can
     * create another admin, one compromised admin account becomes as many as
     * the attacker wants, and removing the original changes nothing.
     */
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.ADMIN)).toBe(false);
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.MEMBER)).toBe(true);
  });

  it('a member is stopped by the PERMISSION, not by the lattice', () => {
    /*
     * Worth being precise about, because reading `canAssignRole` alone is
     * misleading here. It implements one rule — strictly below your own rank —
     * so `canAssignRole(member, viewer)` is TRUE: a member does outrank a
     * viewer.
     *
     * What stops a member changing anyone's role is the FIRST gate. They hold
     * no `member:update_role`, so `PermissionGuard` refuses the route and the
     * lattice is never consulted. Two gates in series, and asserting only the
     * second would misdescribe which one is load-bearing for this case.
     */
    expect(hasPermission(SystemRole.MEMBER, Permission.MEMBER_UPDATE_ROLE)).toBe(false);
    expect(hasPermission(SystemRole.VIEWER, Permission.MEMBER_UPDATE_ROLE)).toBe(false);

    // And the lattice by itself would not have stopped them.
    expect(canAssignRole(SystemRole.MEMBER, SystemRole.VIEWER)).toBe(true);
  });

  it('only admins and owners hold the permission the lattice guards', () => {
    // So the pair of gates covers every role: the permission excludes members
    // and viewers, the lattice constrains admins.
    expect(hasPermission(SystemRole.ADMIN, Permission.MEMBER_UPDATE_ROLE)).toBe(true);
    expect(hasPermission(SystemRole.OWNER, Permission.MEMBER_UPDATE_ROLE)).toBe(true);
  });

  it('the whole 4×4 matrix is strictly below-rank, except for owners', () => {
    // Exhaustive rather than sampled: sixteen pairs is small enough that
    // there is no excuse for testing four of them.
    const rank: Record<SystemRole, number> = {
      [SystemRole.VIEWER]: 0,
      [SystemRole.MEMBER]: 1,
      [SystemRole.ADMIN]: 2,
      [SystemRole.OWNER]: 3,
    };

    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        const expected = actor === SystemRole.OWNER || rank[target] < rank[actor];
        expect({ actor, target, allowed: canAssignRole(actor, target) }).toEqual({
          actor,
          target,
          allowed: expected,
        });
      }
    }
  });
});

describe('member management', () => {
  it('an admin cannot remove or modify an owner', () => {
    expect(canManageMember(SystemRole.ADMIN, SystemRole.OWNER)).toBe(false);
  });

  it('an admin cannot remove another admin', () => {
    // Otherwise two admins can remove each other, and whoever moves first
    // owns the organization.
    expect(canManageMember(SystemRole.ADMIN, SystemRole.ADMIN)).toBe(false);
  });

  it('an admin can manage members and viewers', () => {
    expect(canManageMember(SystemRole.ADMIN, SystemRole.MEMBER)).toBe(true);
    expect(canManageMember(SystemRole.ADMIN, SystemRole.VIEWER)).toBe(true);
  });

  it('an owner can manage anyone, including another owner', () => {
    for (const target of ALL_ROLES) {
      expect(canManageMember(SystemRole.OWNER, target)).toBe(true);
    }
  });
});

/* ========================================================================== */
/* 2. The permission lattice is monotonic                                     */
/* ========================================================================== */

describe('permissions increase with rank', () => {
  it('every role holds a superset of the one below it', () => {
    /*
     * A permission a member has and an admin lacks would be an escalation in
     * the other direction: the way to gain a capability would be to be
     * demoted. That sounds absurd and is exactly the kind of thing a hand-
     * maintained permission table grows.
     */
    const ladder = [SystemRole.VIEWER, SystemRole.MEMBER, SystemRole.ADMIN, SystemRole.OWNER];

    for (let i = 1; i < ladder.length; i += 1) {
      const lower = new Set(ROLE_PERMISSIONS[ladder[i - 1]!]);
      const higher = new Set(ROLE_PERMISSIONS[ladder[i]!]);

      for (const permission of lower) {
        expect({
          permission,
          lower: ladder[i - 1],
          higher: ladder[i],
          held: higher.has(permission),
        }).toEqual({ permission, lower: ladder[i - 1], higher: ladder[i], held: true });
      }
    }
  });

  it('a viewer holds no permission that writes anything', () => {
    const writes = [
      Permission.ORG_UPDATE,
      Permission.ORG_DELETE,
      Permission.MEMBER_INVITE,
      Permission.MEMBER_UPDATE_ROLE,
      Permission.MEMBER_REMOVE,
      Permission.PROJECT_CREATE,
      Permission.PROJECT_UPDATE,
      Permission.PROJECT_DELETE,
      Permission.RESEARCH_RUN,
    ];
    for (const permission of writes) {
      expect({ permission, held: hasPermission(SystemRole.VIEWER, permission) }).toEqual({
        permission,
        held: false,
      });
    }
  });

  it('only an owner may delete the organization', () => {
    for (const role of [SystemRole.ADMIN, SystemRole.MEMBER, SystemRole.VIEWER]) {
      expect(hasPermission(role, Permission.ORG_DELETE)).toBe(false);
    }
    expect(hasPermission(SystemRole.OWNER, Permission.ORG_DELETE)).toBe(true);
  });
});

/* ========================================================================== */
/* 3. What the database does NOT protect                                      */
/* ========================================================================== */

describe('RLS is tenant isolation, not intra-tenant authorization', () => {
  it('CANNOT stop a role change within a tenant, and this is by design', async () => {
    /*
     * Deliberately asserting the GAP.
     *
     * A connection bound to an organization can write any member row in that
     * organization, including promoting somebody to owner. The policy checks
     * the tenant and nothing else, which is exactly what a tenant-isolation
     * policy should do.
     *
     * Written down here so that:
     *   - nobody assumes the database is a second line of defence for this;
     *   - anyone who deletes `canAssignRole` from the service and finds the
     *     suites still green learns why from a test rather than from an
     *     incident.
     *
     * The control is `PermissionGuard` plus `canAssignRole`, tested above and
     * enforced in `OrganizationsService.updateMemberRole`.
     */
    const promoted = await asOrg(app, tenant.organizationId, async () => {
      await app.query(
        `UPDATE organization_members SET role_key = 'owner'
          WHERE organization_id = $1 AND user_id = $2`,
        [tenant.organizationId, tenant.userId],
      );
      const { rows } = await app.query<{ role_key: string }>(
        'SELECT role_key FROM organization_members WHERE user_id = $1',
        [tenant.userId],
      );
      return rows[0]!.role_key;
    });

    expect(promoted).toBe('owner');
  });

  it('DOES stop the same write against another tenant', async () => {
    // The half the database genuinely owns, and the reason the gap above is
    // acceptable: an escalation is confined to the tenant it happens in.
    const other = await createTenant(migrator, app, 'esc-other');
    try {
      const changed = await asOrg(app, tenant.organizationId, async () => {
        const result = await app.query(
          `UPDATE organization_members SET role_key = 'owner'
            WHERE user_id = $1`,
          [other.userId],
        );
        return result.rowCount;
      });
      expect(changed).toBe(0);
    } finally {
      await cleanupTenant(migrator, other);
    }
  });

  it('refuses a role_key the system does not define', async () => {
    /*
     * The foreign key to `roles` is what stops an invented role name — and an
     * invented role has no row in `role_permissions`, so it would resolve to
     * no permissions rather than to all of them. Failing at the constraint is
     * still better than relying on that.
     */
    await expect(
      asOrg(app, tenant.organizationId, () =>
        app.query(
          `UPDATE organization_members SET role_key = 'superuser'
            WHERE organization_id = $1 AND user_id = $2`,
          [tenant.organizationId, tenant.userId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('cannot invent a membership in another organization', async () => {
    const foreignOrg = randomUUID();
    await expect(
      asOrg(app, tenant.organizationId, () =>
        app.query(
          `INSERT INTO organization_members (organization_id, user_id, role_key, joined_at)
           VALUES ($1, $2, 'owner', now())`,
          [foreignOrg, tenant.userId],
        ),
      ),
    ).rejects.toThrow();
  });
});
