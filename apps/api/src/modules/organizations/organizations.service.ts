import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Database, auditLogs, organizationMembers, organizations, users } from '@moka/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  canAssignRole,
  canManageMember,
  isSystemRole,
  type SystemRole,
  type TenantContext,
} from '@moka/core';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface MemberDto {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: SystemRole;
  status: string;
  joinedAt: Date | null;
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async get(context: TenantContext): Promise<OrganizationDto> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
        })
        // dekWrapped is deliberately NOT selected. It never leaves the server.
        .from(organizations)
        .where(eq(organizations.id, context.organizationId))
        .limit(1),
    );

    const organization = rows[0];
    if (!organization) throw new NotFoundError('Organization');
    return organization;
  }

  async update(
    context: TenantContext,
    input: { name: string },
    meta: { requestId?: string | undefined },
  ): Promise<OrganizationDto> {
    const before = await this.get(context);

    const updated = await this.db.withTenant(context, async (tx) => {
      const [row] = await tx
        .update(organizations)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(organizations.id, context.organizationId))
        .returning({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          createdAt: organizations.createdAt,
        });
      return row;
    });

    if (!updated) throw new NotFoundError('Organization');

    await this.audit.record(context, {
      action: 'organization.update',
      resourceType: 'organization',
      resourceId: context.organizationId,
      before: { name: before.name },
      after: { name: updated.name },
      requestId: meta.requestId,
    });

    return updated;
  }

  async listMembers(context: TenantContext): Promise<MemberDto[]> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: organizationMembers.id,
          userId: organizationMembers.userId,
          roleKey: organizationMembers.roleKey,
          status: organizationMembers.status,
          joinedAt: organizationMembers.joinedAt,
          email: users.email,
          name: users.name,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, context.organizationId))
        .orderBy(desc(organizationMembers.createdAt)),
    );

    return rows.filter((r) => isSystemRole(r.roleKey)).map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.roleKey as SystemRole,
      status: r.status,
      joinedAt: r.joinedAt,
    }));
  }

  /**
   * Change a member's role.
   *
   * Two escalation checks, both server-side:
   *   1. The actor may only assign a role strictly below their own.
   *   2. The actor may only manage a member ranked below them.
   *
   * Without (2), an admin could demote an owner and then take the organization.
   */
  async updateMemberRole(
    context: TenantContext,
    memberId: string,
    newRole: SystemRole,
    meta: { requestId?: string | undefined },
  ): Promise<MemberDto> {
    if (!canAssignRole(context.role, newRole)) {
      throw new ForbiddenError(
        `Role ${context.role} may not assign role ${newRole} (privilege escalation).`,
      );
    }

    const members = await this.listMembers(context);
    const target = members.find((m) => m.id === memberId);
    if (!target) throw new NotFoundError('Member');

    if (!canManageMember(context.role, target.role)) {
      throw new ForbiddenError(
        `Role ${context.role} may not modify a member with role ${target.role}.`,
      );
    }

    if (target.userId === context.userId) {
      throw new ConflictError('You cannot change your own role.');
    }

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(organizationMembers)
        .set({ roleKey: newRole, updatedAt: new Date() })
        .where(
          and(
            eq(organizationMembers.id, memberId),
            eq(organizationMembers.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'member.role_update',
      resourceType: 'organization_member',
      resourceId: memberId,
      before: { role: target.role },
      after: { role: newRole },
      requestId: meta.requestId,
    });

    return { ...target, role: newRole };
  }

  async removeMember(
    context: TenantContext,
    memberId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const members = await this.listMembers(context);
    const target = members.find((m) => m.id === memberId);
    if (!target) throw new NotFoundError('Member');

    if (!canManageMember(context.role, target.role)) {
      throw new ForbiddenError(
        `Role ${context.role} may not remove a member with role ${target.role}.`,
      );
    }
    if (target.userId === context.userId) {
      throw new ConflictError('You cannot remove yourself from the organization.');
    }
    if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length <= 1) {
      throw new ConflictError('An organization must retain at least one owner.');
    }

    await this.db.withTenant(context, async (tx) => {
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.id, memberId),
            eq(organizationMembers.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'member.remove',
      resourceType: 'organization_member',
      resourceId: memberId,
      before: { userId: target.userId, role: target.role },
      requestId: meta.requestId,
    });
  }

  async listAuditLog(context: TenantContext, limit = 100) {
    return this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: auditLogs.id,
          actorType: auditLogs.actorType,
          actorId: auditLogs.actorId,
          action: auditLogs.action,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          outcome: auditLogs.outcome,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, context.organizationId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(Math.min(limit, 500)),
    );
  }
}
