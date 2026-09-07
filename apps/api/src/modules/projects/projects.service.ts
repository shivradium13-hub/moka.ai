import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Database, projects } from '@moka/db';
import { ConflictError, NotFoundError, type TenantContext } from '@moka/core';
import { assertBelongsToTenant } from '@moka/tenancy';
import { Feature } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { AuditService } from '../../common/audit.service.js';

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Projects — the reference implementation of a tenant-scoped resource.
 *
 * Every method goes through `db.withTenant(context, ...)`, which binds
 * `app.current_org_id` for the transaction. Note that the explicit
 * `eq(projects.organizationId, ...)` predicates are NOT what provides
 * isolation — RLS does. They are there so the query planner uses the
 * `(organization_id, created_at)` index. Removing them would be a performance
 * bug, not a security one, and the tenant-isolation suite proves that.
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(context: TenantContext): Promise<ProjectDto[]> {
    return this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(and(eq(projects.organizationId, context.organizationId), isNull(projects.deletedAt)))
        .orderBy(desc(projects.createdAt)),
    );
  }

  async get(context: TenantContext, projectId: string): Promise<ProjectDto> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.organizationId, context.organizationId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1),
    );

    const project = rows[0];
    if (!project) throw new NotFoundError('Project');

    // Should be unreachable under RLS. Fires loudly if a policy is ever missing.
    assertBelongsToTenant(project, context, 'project');

    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      description: project.description,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  async create(
    context: TenantContext,
    input: { name: string; slug: string; description?: string | null },
    meta: { requestId?: string | undefined },
  ): Promise<ProjectDto> {
    await this.entitlements.requireQuota(context, Feature.PROJECTS_MAX);

    const created = await this.db.withTenant(context, async (tx) => {
      const clash = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.organizationId, context.organizationId), eq(projects.slug, input.slug)))
        .limit(1);

      if (clash.length > 0) {
        throw new ConflictError('A project with that slug already exists.');
      }

      const [row] = await tx
        .insert(projects)
        .values({
          // organizationId comes from the CONTEXT, never from the payload.
          organizationId: context.organizationId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          createdBy: context.userId,
        })
        .returning();

      if (!row) throw new ConflictError('Project could not be created.');
      return row;
    });

    await this.audit.record(context, {
      action: 'project.create',
      resourceType: 'project',
      resourceId: created.id,
      after: { name: created.name, slug: created.slug },
      requestId: meta.requestId,
    });

    return {
      id: created.id,
      name: created.name,
      slug: created.slug,
      description: created.description,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  }

  async update(
    context: TenantContext,
    projectId: string,
    input: { name?: string; description?: string | null },
    meta: { requestId?: string | undefined },
  ): Promise<ProjectDto> {
    const before = await this.get(context, projectId);

    const updated = await this.db.withTenant(context, async (tx) => {
      const [row] = await tx
        .update(projects)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)),
        )
        .returning();
      return row;
    });

    if (!updated) throw new NotFoundError('Project');

    await this.audit.record(context, {
      action: 'project.update',
      resourceType: 'project',
      resourceId: projectId,
      before: { name: before.name, description: before.description },
      after: { name: updated.name, description: updated.description },
      requestId: meta.requestId,
    });

    return {
      id: updated.id,
      name: updated.name,
      slug: updated.slug,
      description: updated.description,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /** Soft delete — recoverable, and keeps audit references intact. */
  async remove(
    context: TenantContext,
    projectId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const before = await this.get(context, projectId);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(projects)
        .set({ deletedAt: new Date() })
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)));
    });

    await this.audit.record(context, {
      action: 'project.delete',
      resourceType: 'project',
      resourceId: projectId,
      before: { name: before.name, slug: before.slug },
      requestId: meta.requestId,
    });
  }
}
