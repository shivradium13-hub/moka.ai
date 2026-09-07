import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { Database, agentRuns, agentTools, agents, approvals, toolExecutions } from '@moka/db';
import {
  ConflictError,
  ForbiddenError,
  InsufficientPermissionError,
  NotFoundError,
  ValidationError,
  hasPermission,
  type TenantContext,
} from '@moka/core';
import type { RiskLevel, ToolDefinition } from '@moka/agents';
import { Feature } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';

export interface AgentDto {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  permissionLevel: string;
  tools: string[];
  maxSteps: number;
  status: string;
  createdAt: Date;
}

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(context: TenantContext): Promise<AgentDto[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.organizationId, context.organizationId), isNull(agents.deletedAt)))
        .orderBy(desc(agents.createdAt));

      const toolRows = await tx
        .select({ agentId: agentTools.agentId, toolName: agentTools.toolName })
        .from(agentTools)
        .where(eq(agentTools.organizationId, context.organizationId));

      const byAgent = new Map<string, string[]>();
      for (const row of toolRows) {
        byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row.toolName]);
      }

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        permissionLevel: row.permissionLevel,
        tools: byAgent.get(row.id) ?? [],
        maxSteps: row.maxSteps,
        status: row.status,
        createdAt: row.createdAt,
      }));
    });
  }

  async get(context: TenantContext, agentId: string): Promise<AgentDto> {
    const found = (await this.list(context)).find((agent) => agent.id === agentId);
    if (!found) throw new NotFoundError('Agent');
    return found;
  }

  /**
   * Create an agent.
   *
   * The creator may not grant an agent a tool they could not use themselves.
   * Without this, agent creation becomes a way to mint capability: a member
   * builds an agent with `delete_project`, and although the runtime would still
   * refuse at call time, the configuration itself misrepresents what the
   * platform will do. Refusing here keeps configuration honest.
   */
  async create(
    context: TenantContext,
    input: {
      name: string;
      description?: string | null;
      instructions: string;
      permissionLevel: RiskLevel;
      tools: readonly string[];
      maxSteps?: number;
    },
    registry: ReadonlyMap<string, ToolDefinition>,
    meta: { requestId?: string | undefined },
  ): Promise<AgentDto> {
    // The plan limit, counted now. Checked BEFORE the per-tool permission
    // check so a customer at their limit is told that, rather than being told
    // about a tool they cannot grant on an agent they cannot create.
    await this.entitlements.requireQuota(context, Feature.AGENTS_MAX);

    for (const toolName of input.tools) {
      const tool = registry.get(toolName);
      if (!tool) throw new ValidationError({ tools: `Unknown tool "${toolName}".` });

      if (!hasPermission(context.role, tool.permission)) {
        /*
         * Deliberately specific. The user chose this tool name themselves, so
         * naming the permission they lack leaks nothing and is the difference
         * between an actionable message and a baffling one. Contrast with a
         * cross-tenant denial, which must stay generic.
         */
        throw new InsufficientPermissionError(
          tool.permission,
          `Cannot grant tool "${toolName}": role ${context.role} lacks ${tool.permission}.`,
        );
      }
    }

    const created = await this.db.withTenant(context, async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          organizationId: context.organizationId,
          name: input.name.trim(),
          description: input.description ?? null,
          instructions: input.instructions,
          permissionLevel: input.permissionLevel,
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          createdBy: context.userId,
        })
        .returning({ id: agents.id });

      if (!agent) throw new ConflictError('Agent could not be created.');

      if (input.tools.length > 0) {
        await tx.insert(agentTools).values(
          input.tools.map((toolName) => ({
            organizationId: context.organizationId,
            agentId: agent.id,
            toolName,
          })),
        );
      }
      return agent.id;
    });

    await this.audit.record(context, {
      action: 'agent.create',
      resourceType: 'agent',
      resourceId: created,
      after: {
        name: input.name,
        permissionLevel: input.permissionLevel,
        tools: [...input.tools],
      },
      requestId: meta.requestId,
    });

    return this.get(context, created);
  }

  async remove(
    context: TenantContext,
    agentId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const before = await this.get(context, agentId);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(agents)
        .set({ deletedAt: new Date(), status: 'disabled' })
        .where(and(eq(agents.id, agentId), eq(agents.organizationId, context.organizationId)));
    });

    await this.audit.record(context, {
      action: 'agent.delete',
      resourceType: 'agent',
      resourceId: agentId,
      before: { name: before.name },
      requestId: meta.requestId,
    });
  }

  async listRuns(context: TenantContext, limit = 30) {
    return this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: agentRuns.id,
          agentId: agentRuns.agentId,
          status: agentRuns.status,
          input: agentRuns.input,
          output: agentRuns.output,
          stepsUsed: agentRuns.stepsUsed,
          errorCode: agentRuns.errorCode,
          startedAt: agentRuns.startedAt,
          finishedAt: agentRuns.finishedAt,
        })
        .from(agentRuns)
        .where(eq(agentRuns.organizationId, context.organizationId))
        .orderBy(desc(agentRuns.startedAt))
        .limit(Math.min(limit, 100)),
    );
  }

  /** The evidence trail for one run: every attempt, including refusals. */
  async listExecutions(context: TenantContext, runId: string) {
    return this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: toolExecutions.id,
          toolName: toolExecutions.toolName,
          outcome: toolExecutions.outcome,
          denialReason: toolExecutions.denialReason,
          durationMs: toolExecutions.durationMs,
          createdAt: toolExecutions.createdAt,
        })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.organizationId, context.organizationId),
            eq(toolExecutions.runId, runId),
          ),
        )
        .orderBy(toolExecutions.createdAt),
    );
  }

  async listApprovals(context: TenantContext, status = 'pending') {
    return this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: approvals.id,
          runId: approvals.runId,
          toolName: approvals.toolName,
          summary: approvals.summary,
          status: approvals.status,
          expiresAt: approvals.expiresAt,
          consumedAt: approvals.consumedAt,
          createdAt: approvals.createdAt,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.organizationId, context.organizationId),
            eq(approvals.status, status),
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(100),
    );
  }

  /**
   * Decide an approval.
   *
   * The DECIDING USER must independently hold the permission the gated tool
   * requires. An approval is an exercise of authority, not a rubber stamp: a
   * viewer must not be able to authorise a deletion merely because an agent
   * asked politely.
   */
  async decideApproval(
    context: TenantContext,
    approvalId: string,
    decision: 'approved' | 'rejected',
    registry: ReadonlyMap<string, ToolDefinition>,
    meta: { requestId?: string | undefined },
  ): Promise<{ id: string; status: string }> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select()
        .from(approvals)
        .where(
          and(eq(approvals.id, approvalId), eq(approvals.organizationId, context.organizationId)),
        )
        .limit(1),
    );

    const approval = rows[0];
    if (!approval) throw new NotFoundError('Approval');
    if (approval.status !== 'pending') {
      throw new ConflictError('That approval has already been decided.');
    }
    if (approval.expiresAt.getTime() < Date.now()) {
      throw new ConflictError('That approval has expired.');
    }

    const tool = registry.get(approval.toolName);
    if (tool && !hasPermission(context.role, tool.permission)) {
      throw new ForbiddenError('You do not hold the permission this action requires.');
    }

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(approvals)
        .set({ status: decision, decidedBy: context.userId, decidedAt: new Date() })
        .where(
          and(eq(approvals.id, approvalId), eq(approvals.organizationId, context.organizationId)),
        );
    });

    await this.audit.record(context, {
      action: `approval.${decision}`,
      resourceType: 'approval',
      resourceId: approvalId,
      before: { status: 'pending', toolName: approval.toolName },
      after: { status: decision },
      requestId: meta.requestId,
    });

    return { id: approvalId, status: decision };
  }
}
