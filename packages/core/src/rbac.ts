/**
 * Role-based access control (docs/security.md §7).
 *
 * Evaluated SERVER-SIDE ONLY. The web app may use these helpers to decide
 * what to render, but rendering is never enforcement — every mutation is
 * re-checked in the API by PermissionGuard.
 */

export const SystemRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
  VIEWER: 'viewer',
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export const ALL_ROLES: readonly SystemRole[] = [
  SystemRole.OWNER,
  SystemRole.ADMIN,
  SystemRole.MEMBER,
  SystemRole.VIEWER,
];

/**
 * Permission keys are `resource:action`. Phase 1 scope only; the agent,
 * knowledge and billing permissions arrive with their phases.
 */
export const Permission = {
  ORG_READ: 'organization:read',
  ORG_UPDATE: 'organization:update',
  ORG_DELETE: 'organization:delete',

  MEMBER_READ: 'member:read',
  MEMBER_INVITE: 'member:invite',
  MEMBER_UPDATE_ROLE: 'member:update_role',
  MEMBER_REMOVE: 'member:remove',

  PROJECT_READ: 'project:read',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',

  AUDIT_READ: 'audit:read',

  /**
   * Run a web-research task (Phase 7).
   *
   * Its own permission rather than reusing PROJECT_READ, because research is
   * not a read of our data. It spends provider tokens on every run and sends
   * outbound requests, from our address range, to whoever is being researched.
   * Both of those are things a viewer should not be able to cause.
   */
  RESEARCH_RUN: 'research:run',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  Permission.ORG_READ,
  Permission.MEMBER_READ,
  Permission.PROJECT_READ,
];

const MEMBER_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  Permission.PROJECT_CREATE,
  Permission.PROJECT_UPDATE,
  // Deliberately not a viewer capability: research spends money and makes
  // outbound requests in the organization's name.
  Permission.RESEARCH_RUN,
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  Permission.ORG_UPDATE,
  Permission.MEMBER_INVITE,
  Permission.MEMBER_UPDATE_ROLE,
  Permission.MEMBER_REMOVE,
  Permission.PROJECT_DELETE,
  Permission.AUDIT_READ,
];

const OWNER_PERMISSIONS: readonly Permission[] = [...ADMIN_PERMISSIONS, Permission.ORG_DELETE];

export const ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  [SystemRole.VIEWER]: VIEWER_PERMISSIONS,
  [SystemRole.MEMBER]: MEMBER_PERMISSIONS,
  [SystemRole.ADMIN]: ADMIN_PERMISSIONS,
  [SystemRole.OWNER]: OWNER_PERMISSIONS,
};

/** Numeric rank, used only to prevent lateral/upward role assignment. */
const ROLE_RANK: Readonly<Record<SystemRole, number>> = {
  [SystemRole.VIEWER]: 0,
  [SystemRole.MEMBER]: 1,
  [SystemRole.ADMIN]: 2,
  [SystemRole.OWNER]: 3,
};

export function isSystemRole(value: string): value is SystemRole {
  return (ALL_ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: SystemRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAllPermissions(role: SystemRole, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Privilege-escalation guard (security suite 4).
 *
 * An actor may only assign a role strictly BELOW their own rank. This blocks
 * both upward escalation (member -> admin) and lateral cloning
 * (admin -> admin), which would otherwise let an admin manufacture peers.
 * Only an owner may create another owner.
 */
export function canAssignRole(actorRole: SystemRole, targetRole: SystemRole): boolean {
  if (actorRole === SystemRole.OWNER) return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
}

/**
 * An actor may only modify or remove a member whose rank is strictly lower
 * than their own. Owners are never removable by an admin.
 */
export function canManageMember(actorRole: SystemRole, targetRole: SystemRole): boolean {
  if (actorRole === SystemRole.OWNER) return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
}
