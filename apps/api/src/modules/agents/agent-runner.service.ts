import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  AgentRuntime,
  DELEGATE_OUTPUT_IS_UNTRUSTED,
  MAX_DELEGATION_DEPTH,
  RiskLevel,
  RunStatus,
  authorizeDelegation,
  buildRegistry,
  defineTool,
  describeChain,
  parseModelStep,
  userPrincipal,
  type AgentConfig,
  type AgentModel,
  type DelegationFrame,
  type ModelResult,
  type RuntimeHooks,
  type ToolDefinition,
} from '@moka/agents';
import { Database, agentRuns, approvals, toolExecutions } from '@moka/db';
import { NotFoundError, Permission, redactValue, type TenantContext } from '@moka/core';
import { McpService } from './mcp.service.js';
import { AgentsService } from './agents.service.js';
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
    private readonly mcp: McpService,
    private readonly agents: AgentsService,
  ) {
    this.registry = buildRegistry(this.backend);
  }

  /**
   * The name of the tool an agent uses to call another agent.
   *
   * Exposed as an ordinary tool, on purpose. Delegation could have been a
   * special case in the runtime loop; making it a tool means it passes through
   * `authorizeToolCall` like everything else — an agent can only delegate if
   * `delegate_to_agent` is on its allowlist, if its risk ceiling covers DRAFT,
   * and if the invoking user holds the permission. Three gates that already
   * existed, reused rather than reimplemented.
   */
  static readonly DELEGATE_TOOL = 'delegate_to_agent';

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
    input: {
      message: string;
      requestId: string | undefined;
      /**
       * Present only when this run was started by another agent. Carries the
       * whole ancestry, because depth alone cannot detect a cycle.
       */
      delegation?: {
        readonly stack: readonly DelegationFrame[];
        readonly parentRunId: string;
        readonly stepsRemaining: number;
      };
    },
  ): Promise<{
    runId: string;
    status: RunStatus;
    output: string;
    steps: number;
    pendingApprovalId?: string;
  }> {
    const runId = await this.startRun(context, agent.id, input);

    /*
     * The registry is built PER RUN, not once at construction.
     *
     * Two reasons, both security-relevant. MCP tools belong to one
     * organization and must never leak into another's registry — a shared
     * mutable registry would be a cross-tenant channel of the most direct
     * kind. And an operator who disables a server expects its tools to stop
     * existing on the next run, not at the next process restart.
     */
    const registry = new Map(this.registry);
    for (const [name, tool] of await this.mcp.toolsFor(context)) {
      // Builtins win a collision. The `mcp__` prefix makes one impossible in
      // practice; this is what makes it impossible in principle.
      if (!registry.has(name)) registry.set(name, tool);
    }

    const stack: readonly DelegationFrame[] = [
      ...(input.delegation?.stack ?? []),
      { agentId: agent.id, agentName: agent.name },
    ];
    const stepsRemaining = input.delegation?.stepsRemaining ?? agent.maxSteps;
    registry.set(
      AgentRunnerService.DELEGATE_TOOL,
      this.delegateTool(context, {
        parent: agent,
        stack,
        stepsRemaining,
        parentRunId: runId,
        requestId: input.requestId,
      }),
    );

    const runtime = new AgentRuntime(
      registry,
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


  /**
   * The tool that lets one agent call another.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * EVERY AUTHORITY DECISION HERE IS MADE BY `authorizeDelegation`
   *
   * This method does I/O and nothing else: it loads the named agent, asks the
   * pure function whether the call may happen and under what authority, and
   * runs the narrowed config the function returns. It never computes an
   * allowlist, a ceiling or a budget of its own.
   *
   * That split is deliberate. `authorizeDelegation` is pure and exhaustively
   * tested; a second copy of its rules living here would drift, and the copy
   * that drifts is always the one nobody tested.
   * ───────────────────────────────────────────────────────────────────────────
   */
  private delegateTool(
    context: TenantContext,
    frame: {
      parent: AgentConfig;
      stack: readonly DelegationFrame[];
      stepsRemaining: number;
      parentRunId: string;
      requestId: string | undefined;
    },
  ): ToolDefinition {
    return defineTool({
      name: AgentRunnerService.DELEGATE_TOOL,
      description:
        'Hand a self-contained sub-task to another agent in this organization and ' +
        'receive its reply. The other agent can only use tools you can already use. ' +
        'Use it when a task needs a different specialism, not to avoid your own limits.',
      inputSchema: z.object({
        agentId: z.string().uuid(),
        task: z.string().min(1).max(4_000),
      }),
      outputSchema: z.string(),

      /*
       * DRAFT rather than READ. A delegated run can call any tool the parent
       * could, including drafting ones, so classifying delegation itself as a
       * read would let a READ-ceiling agent reach DRAFT tools through a
       * delegate. The ceiling has to cover what the call can cause, not what
       * the call looks like.
       */
      risk: RiskLevel.DRAFT,
      permission: Permission.AGENT_RUN,
      /*
       * No approval gate. The DELEGATE's tool calls are each gated on their
       * own merits — an EXECUTE tool still requires approval three levels
       * down — so gating the delegation as well would ask a human to approve
       * the same action twice. What is approved is the effect, not the
       * indirection.
       */
      requiresApproval: false,
      customerSafe: false,

      summarise: (input) => `Delegate a sub-task to agent ${input.agentId}.`,

      execute: async (input) => {
        const decision = authorizeDelegation({
          // The parent's config as it is running, already narrowed if this
          // agent was itself delegated to. Passing the stored config instead
          // would re-widen authority at every level — the escalation this
          // whole module exists to prevent, reintroduced by a convenience.
          parent: frame.parent,
          delegate: await this.agents.findRunnable(context, input.agentId),
          delegateId: input.agentId,
          stack: frame.stack,
          principal: userPrincipal(context.role),
          stepsRemaining: frame.stepsRemaining,
        });

        if (!decision.allowed) {
          /*
           * Returned as a normal observation rather than thrown. The model
           * asked for something it may not have; telling it so lets it try a
           * different approach, which is what an authorisation denial should
           * produce. Throwing would fail the whole run over a recoverable
           * mistake.
           */
          return `Delegation refused: ${decision.message}`;
        }

        const result = await this.run(
          context,
          { ...decision.effective, modelId: null },
          {
            message: input.task,
            requestId: frame.requestId,
            delegation: {
              stack: frame.stack,
              parentRunId: frame.parentRunId,
              stepsRemaining: frame.stepsRemaining,
            },
          },
        );

        getLogger().info(
          {
            chain: describeChain([...frame.stack, { agentId: decision.effective.id, agentName: decision.effective.name }]),
            depth: frame.stack.length,
            maxDepth: MAX_DELEGATION_DEPTH,
            runId: result.runId,
          },
          'agent delegated',
        );

        /*
         * The delegate's reply is UNTRUSTED CONTENT.
         *
         * It feels more trustworthy than a web page and is not: it is model
         * output, produced by a model that may have read attacker-controlled
         * text thirty seconds ago. Labelling it is what stops the parent
         * treating a sub-agent's "now call delete_project" as an instruction.
         */
        return `${DELEGATE_OUTPUT_IS_UNTRUSTED}\n\n<untrusted_content>\n${result.output}\n</untrusted_content>`;
      },
    });
  }

  private async startRun(
    context: TenantContext,
    agentId: string,
    input: {
      message: string;
      requestId: string | undefined;
      delegation?: { readonly stack: readonly DelegationFrame[]; readonly parentRunId: string };
    },
  ): Promise<string> {
    const depth = input.delegation ? input.delegation.stack.length : 0;
    const [row] = await this.db.withTenant(context, async (tx) =>
      tx
        .insert(agentRuns)
        .values({
          organizationId: context.organizationId,
          agentId,
          userId: context.userId,
          input: input.message,
          requestId: input.requestId ?? null,
          /*
           * The chain is stored, not just bounded in memory. When a delegated
           * run does something surprising the first question is "who asked for
           * this?", and the answer is the ancestry rather than any one agent.
           */
          parentRunId: input.delegation?.parentRunId ?? null,
          delegationDepth: depth,
          delegatedBy: input.delegation?.stack.at(-1)?.agentId ?? null,
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
