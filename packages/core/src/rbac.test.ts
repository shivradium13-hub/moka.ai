import { describe, expect, it } from 'vitest';
import {
  ALL_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  SystemRole,
  canAssignRole,
  canManageMember,
  hasAllPermissions,
  hasPermission,
  isSystemRole,
} from './rbac.js';

describe('role definitions', () => {
  it('defines permissions for every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it('recognises only known roles', () => {
    expect(isSystemRole('owner')).toBe(true);
    expect(isSystemRole('superuser')).toBe(false);
    expect(isSystemRole('')).toBe(false);
  });

  it('grants strictly increasing permissions up the hierarchy', () => {
    const counts = ALL_ROLES.map((r) => ROLE_PERMISSIONS[r].length);
    const viewer = ROLE_PERMISSIONS[SystemRole.VIEWER];
    const member = ROLE_PERMISSIONS[SystemRole.MEMBER];
    const admin = ROLE_PERMISSIONS[SystemRole.ADMIN];
    const owner = ROLE_PERMISSIONS[SystemRole.OWNER];

    expect(viewer.every((p) => member.includes(p))).toBe(true);
    expect(member.every((p) => admin.includes(p))).toBe(true);
    expect(admin.every((p) => owner.includes(p))).toBe(true);
    expect(counts.every((c) => c > 0)).toBe(true);
  });
});

describe('hasPermission', () => {
  it('lets a viewer read but not write', () => {
    expect(hasPermission(SystemRole.VIEWER, Permission.PROJECT_READ)).toBe(true);
    expect(hasPermission(SystemRole.VIEWER, Permission.PROJECT_CREATE)).toBe(false);
    expect(hasPermission(SystemRole.VIEWER, Permission.PROJECT_DELETE)).toBe(false);
  });

  it('lets a member create projects but not manage members', () => {
    expect(hasPermission(SystemRole.MEMBER, Permission.PROJECT_CREATE)).toBe(true);
    expect(hasPermission(SystemRole.MEMBER, Permission.MEMBER_INVITE)).toBe(false);
    expect(hasPermission(SystemRole.MEMBER, Permission.MEMBER_REMOVE)).toBe(false);
  });

  it('withholds organization deletion from everyone but the owner', () => {
    expect(hasPermission(SystemRole.ADMIN, Permission.ORG_DELETE)).toBe(false);
    expect(hasPermission(SystemRole.OWNER, Permission.ORG_DELETE)).toBe(true);
  });

  it('withholds the audit log from members and viewers', () => {
    expect(hasPermission(SystemRole.MEMBER, Permission.AUDIT_READ)).toBe(false);
    expect(hasPermission(SystemRole.VIEWER, Permission.AUDIT_READ)).toBe(false);
    expect(hasPermission(SystemRole.ADMIN, Permission.AUDIT_READ)).toBe(true);
  });

  it('evaluates permission sets', () => {
    expect(
      hasAllPermissions(SystemRole.ADMIN, [Permission.PROJECT_CREATE, Permission.MEMBER_INVITE]),
    ).toBe(true);
    expect(
      hasAllPermissions(SystemRole.ADMIN, [Permission.PROJECT_CREATE, Permission.ORG_DELETE]),
    ).toBe(false);
  });
});

/*
 * Security suite 4 — privilege escalation.
 * These assertions are the reason canAssignRole exists; if they relax, an
 * admin can manufacture peers or promote themselves.
 */
describe('privilege escalation', () => {
  it('forbids assigning a role at or above your own', () => {
    expect(canAssignRole(SystemRole.MEMBER, SystemRole.ADMIN)).toBe(false);
    expect(canAssignRole(SystemRole.MEMBER, SystemRole.OWNER)).toBe(false);
    expect(canAssignRole(SystemRole.MEMBER, SystemRole.MEMBER)).toBe(false);
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.OWNER)).toBe(false);
  });

  it('forbids an admin cloning another admin', () => {
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.ADMIN)).toBe(false);
  });

  it('allows assigning strictly lower roles', () => {
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.MEMBER)).toBe(true);
    expect(canAssignRole(SystemRole.ADMIN, SystemRole.VIEWER)).toBe(true);
    expect(canAssignRole(SystemRole.MEMBER, SystemRole.VIEWER)).toBe(true);
  });

  it('lets only an owner create another owner', () => {
    expect(canAssignRole(SystemRole.OWNER, SystemRole.OWNER)).toBe(true);
  });

  it('gives a viewer no assignment rights at all', () => {
    for (const role of ALL_ROLES) {
      expect(canAssignRole(SystemRole.VIEWER, role)).toBe(false);
    }
  });

  it('forbids managing a member at or above your own rank', () => {
    expect(canManageMember(SystemRole.ADMIN, SystemRole.OWNER)).toBe(false);
    expect(canManageMember(SystemRole.ADMIN, SystemRole.ADMIN)).toBe(false);
    expect(canManageMember(SystemRole.MEMBER, SystemRole.ADMIN)).toBe(false);
    expect(canManageMember(SystemRole.ADMIN, SystemRole.MEMBER)).toBe(true);
    expect(canManageMember(SystemRole.OWNER, SystemRole.OWNER)).toBe(true);
  });
});
