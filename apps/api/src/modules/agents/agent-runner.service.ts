import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  AgentRuntime,
  RunStatus,
  buildRegistry,
  parseModelStep,
  userPrincipal,
  type AgentConfig,
  type AgentModel,
  type ModelResult,
  type RuntimeHooks,
  type ToolDefinition,
} from '@moka/agents';
import { Database, agentRuns, approvals, toolExecutions } from '@moka/db';
import { NotFoundError, redactValue, type TenantContext } from '@moka/core';
import { DATABASE } from '../../database/database.module.js';
import { ToolBackendService } from './tool-backend.service.js';
import { GatewayService } from '../ai/gateway.service.js';
import { AuditService } from '../../common/audit.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * Wires the pure agent runtime to the database and the AI gateway.
 *
 * The runtime itself knows nothing about Postgres or providers; this service
 * supplies both. That separation is what let the authorisation and injection
 * suites be written against a scripted model, with no provider and no
 * database — the parts most worth testing are the parts with no I/O.
 */

/** How long a pending approval stays valid. A held privilege must expire. */
const APPROVAL_TTL_MINUTES = 60;

@Injectable()
export class AgentRunnerService {
  private readonly registry: Map<string, ToolDefinition>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly backend: ToolBackendService,
    private readonly gateway: GatewayService,
    private readonly audit: AuditService,
  ) {
    this.registry = buildRegistry(this.backend);
  }

  tools(): ReadonlyMap<string, ToolDefinition> {
    return this.registry;
  }

  /**
   * A model backed by the AI gateway.
   *
   * NOT VERIFIED against a live provider: no API key exists in this
   * environment. The tool-call parsing below follows the documented contract
   * but has only ever run against scripted input.
   *
   * Tool calling is expressed as a JSON convention rather than native
   * provider tool-use because the gateway's `chat` is deliberately
   * provider-agnostic. Native tool-use per provider is Phase 5b.
   */
  private gatewayModel(context: TenantContext, requestId: string | undefined): AgentModel {
    const gateway = this.gateway;
    return {
      async next(request): Promise<ModelResult> {
        const instruction =
          request.tools.length > 0
            ? '\n\nTo call a tool, reply with ONLY a JSON object of the form ' +
              '{"tool":"<name>","input":{...}}. To answer the user, reply with plain text.\n' +
              `Available tools: ${JSON.stringify(request.tools)}`
            : '';

        const history = request.history
          .map((step) => `[${step.toolName} → ${step.outcome}] ${step.observation}`)
          .join('\n');

        const response = await gateway.chat(
          context,
          {
            model: null,
            system: request.system + instruction,
            messages: [
              {
                role: 'user',
                content: history ? `${request.user}\n\n### Previous steps\n${history}` : request.user,
              },
            ],
          },
          { requestId },
        );

        return {
          step: parseModelStep(response.text),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        };
      },
    };
  }

  async run(
    context: TenantContext,
    agent: AgentConfig & { modelId: string | null },
    input: { message: string; requestId: string | undefined },
  ): Promise<{
    runId: string;
    status: RunStatus;
    output: string;
    steps: number;
    pendingApprovalId?: string;
  }> {
    const runId = await this.startRun(context, agent.id, input);

    const runtime = new AgentRuntime(
      this.registry,
      this.gatewayModel(context, input.requestId),
      this.hooksFor(context, runId),
    );

    try {
      const result = await runtime.run(agent, {
        scope: context,
        // The INVOKING USER's role, not the agent's. This is the ceiling.
        principal: userPrincipal(context.role),
        message: input.message,
        // Knowledge retrieval is a TOOL rather than pre-loaded context, so
        // retrieved text enters as an explicitly untrusted observation.
        context: [],
        runId,
        requestId: input.requestId,
      });

      await this.finishRun(context, runId, result);

      await this.audit.record(context, {
        action: 'agent.run',
        resourceType: 'agent',
        resourceId: agent.id,
        after: { runId, status: result.status, steps: result.stepsUsed },
        outcome: result.status === RunStatus.FAILED ? 'failure' : 'success',
        requestId: input.requestId,
      });

      return {
        runId,
        status: result.status,
        output: result.output,
        steps: result.stepsUsed,
        ...(result.pendingApprovalId ? { pendingApprovalId: result.pendingApprovalId } : {}),
      };
    } catch (error) {
      await this.failRun(context, runId, error);
      throw error;
    }
  }

  /** Database-backed implementation of the runtime's side effects. */
  private hooksFor(context: TenantContext, runId: string): RuntimeHooks {
    return {
      recordExecution: async (entry) => {
        await this.db.withTenant(context, async (tx) => {
          await tx.insert(toolExecutions).values({
            organizationId: context.organizationId,
            runId,
            approvalId: entry.approvalId ?? null,
            toolName: entry.toolName,
            outcome: entry.outcome,
            denialReason: entry.denialReason ?? null,
            // Tool arguments came from a model influenced by untrusted text.
            // Redact before storing, like every other JSON payload we keep.
            toolInput: redactValue(entry.input) as Record<string, unknown>,
            toolOutput: entry.output === undefined ? null : redactValue(entry.output),
            durationMs: entry.durationMs,
          });
        });
      },

      requestApproval: async (entry) => {
        const [row] = await this.db.withTenant(context, async (tx) =>
          tx
            .insert(approvals)
            .values({
              organizationId: context.organizationId,
              runId,
              toolName: entry.toolName,
              summary: entry.summary,
              toolInput: redactValue(entry.input) as Record<string, unknown>,
              requestedBy: context.userId,
              expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000),
            })
            .returning({ id: approvals.id }),
        );

        getLogger().info(
          {
            organizationId: context.organizationId,
            runId,
            toolName: entry.toolName,
            approvalId: row?.id,
          },
          'agent paused awaiting human approval',
        );

        return row!.id;
      },

      /**
       * Find an approved, unexpired, UNCONSUMED approval for this exact tool.
       *
       * All three conditions matter: `consumedAt IS NULL` is what stops one
       * approval authorising a second execution, and `expiresAt > now()` is
       * what stops a stale approval being redeemed days later.
       */
      findApproval: async (toolName) => {
        const rows = await this.db.withTenant(context, async (tx) =>
          tx
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                eq(approvals.organizationId, context.organizationId),
                eq(approvals.runId, runId),
                eq(approvals.toolName, toolName),
                eq(approvals.status, 'approved'),
                isNull(approvals.consumedAt),
                gt(approvals.expiresAt, new Date()),
              ),
            )
            .limit(1),
        );
        return rows[0]?.id ?? null;
      },

      consumeApproval: async (approvalId) => {
        await this.db.withTenant(context, async (tx) => {
          await tx
            .update(approvals)
            .set({ consumedAt: new Date() })
            .where(
              and(
                eq(approvals.id, approvalId),
                eq(approvals.organizationId, context.organizationId),
              ),
            );
        });
      },
    };
  }

  private async startRun(
    context: TenantContext,
    agentId: string,
    input: { message: string; requestId: string | undefined },
  ): Promise<string> {
    const [row] = await this.db.withTenant(context, async (tx) =>
      tx
        .insert(agentRuns)
        .values({
          organizationId: context.organizationId,
          agentId,
          userId: context.userId,
          input: input.message,
          requestId: input.requestId ?? null,
        })
        .returning({ id: agentRuns.id }),
    );
    if (!row) throw new NotFoundError('Agent run');
    return row.id;
  }

  private async finishRun(
    context: TenantContext,
    runId: string,
    result: { status: RunStatus; output: string; stepsUsed: number; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(agentRuns)
        .set({
          status: result.status === RunStatus.MAX_STEPS ? 'failed' : result.status,
          output: result.output,
          stepsUsed: result.stepsUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          finishedAt: new Date(),
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.organizationId, context.organizationId)));
    });
  }

  private async failRun(context: TenantContext, runId: string, error: unknown): Promise<void> {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'INTERNAL';

    await this.db
      .withTenant(context, async (tx) => {
        await tx
          .update(agentRuns)
          .set({ status: 'failed', errorCode: code, finishedAt: new Date() })
          .where(
            and(eq(agentRuns.id, runId), eq(agentRuns.organizationId, context.organizationId)),
          );
      })
      .catch(() => undefined);
  }
}
