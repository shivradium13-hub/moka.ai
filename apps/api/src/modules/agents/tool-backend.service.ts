import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Database, knowledgeSources, projects } from '@moka/db';
import { ConflictError } from '@moka/core';
import type { ToolBackend, ToolCallContext } from '@moka/agents';
import { DATABASE } from '../../database/database.module.js';
import { RetrievalService } from '../knowledge/retrieval.service.js';

/**
 * Concrete implementations of the agent tools (master prompt §19).
 *
 * EVERY method runs inside `db.withTenant(...)`. That is not defensive
 * duplication of RLS — it is what BINDS RLS. A tool that opened its own
 * connection, or reused an unbound one, would be querying with no organization
 * set and would see nothing at best, or become the one path around isolation
 * at worst.
 *
 * There is deliberately no generic query tool. Every operation here is named,
 * typed, and individually authorised upstream.
 */
@Injectable()
export class ToolBackendService implements ToolBackend {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly retrieval: RetrievalService,
  ) {}

  async listProjects(context: ToolCallContext) {
    return this.db.withTenant(context.tenant, async (tx) =>
      tx
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
        })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, context.tenant.organizationId),
            isNull(projects.deletedAt),
          ),
        )
        .orderBy(desc(projects.createdAt))
        // Bounded: an unbounded list becomes model context, and a tenant with
        // 10,000 projects would blow the window and the bill.
        .limit(100),
    );
  }

  async getProject(context: ToolCallContext, projectId: string) {
    const rows = await this.db.withTenant(context.tenant, async (tx) =>
      tx
        .select({
          id: projects.id,
          name: projects.name,
          slug: projects.slug,
          description: projects.description,
        })
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.organizationId, context.tenant.organizationId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async createProject(
    context: ToolCallContext,
    input: { name: string; slug: string; description: string | null },
  ) {
    return this.db.withTenant(context.tenant, async (tx) => {
      const clash = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, context.tenant.organizationId),
            eq(projects.slug, input.slug),
          ),
        )
        .limit(1);

      if (clash.length > 0) {
        throw new ConflictError('A project with that slug already exists.');
      }

      const [row] = await tx
        .insert(projects)
        .values({
          // From the CONTEXT, never from tool arguments the model produced.
          organizationId: context.tenant.organizationId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          createdBy: context.tenant.userId,
        })
        .returning({ id: projects.id, name: projects.name, slug: projects.slug });

      if (!row) throw new ConflictError('Project could not be created.');
      return row;
    });
  }

  async deleteProject(context: ToolCallContext, projectId: string) {
    const result = await this.db.withTenant(context.tenant, async (tx) =>
      tx
        .update(projects)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.organizationId, context.tenant.organizationId),
            isNull(projects.deletedAt),
          ),
        )
        .returning({ id: projects.id }),
    );
    // Soft delete, and honest about whether anything happened: reporting
    // success for a project that did not exist would let an agent claim to
    // have deleted things it never touched.
    return { deleted: result.length > 0 };
  }

  async searchKnowledge(context: ToolCallContext, input: { query: string; limit: number }) {
    const result = await this.retrieval.search(context.tenant, {
      text: input.query,
      limit: input.limit,
    });

    return result.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      documentTitle: chunk.documentTitle,
      content: chunk.content,
      section: chunk.section,
      page: chunk.page,
    }));
  }

  async listKnowledgeSources(context: ToolCallContext) {
    return this.db.withTenant(context.tenant, async (tx) =>
      tx
        .select({
          id: knowledgeSources.id,
          name: knowledgeSources.name,
          type: knowledgeSources.type,
          documentCount: sql<number>`(
            SELECT count(*)::int FROM knowledge_documents d
             WHERE d.source_id = ${knowledgeSources.id} AND d.deleted_at IS NULL
          )`,
        })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.organizationId, context.tenant.organizationId),
            isNull(knowledgeSources.deletedAt),
          ),
        )
        .limit(100),
    );
  }
}
