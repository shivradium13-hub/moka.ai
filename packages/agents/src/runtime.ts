import type { z } from 'zod';
import type { OrganizationScoped } from '@moka/core';
import { authorizeToolCall, callableTools, DenialReason, type Principal } from './authorize.js';
import { advertise, type RiskLevel, type ToolDefinition } from './tool.js';
import { assemblePrompt, neutraliseUntrusted, type ContextBlock } from './prompt.js';

/**
 * Agent runtime (master prompt §18).
 *
 *   input → prompt → model → tool proposal → AUTHORISE → execute → observe
 *                       ↑                                            │
 *                       └────────────── loop, bounded ───────────────┘
 *
 * The loop is bounded by construction: `maxSteps` is a column on the agent, not
 * a constant, because a non-terminating loop is an agent's default failure mode
 * and the ceiling belongs with the configuration a human set.
 *
 * The model is injected as `AgentModel`. That keeps the runtime testable
 * without a provider — a scripted model returns predetermined tool proposals,
 * which is how the authorisation and approval paths below are verified.
 */

/** What the model may return at each step. */
export type ModelStep =
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly toolName: string;
      readonly input: unknown;
      /** The model's own words about why, shown on an approval card. */
      readonly rationale?: string;
    };

export interface ModelRequest {
  readonly system: string;
  readonly user: string;
  readonly tools: ReadonlyArray<ReturnType<typeof advertise>>;
  /** Prior steps of this run, oldest first. */
  readonly history: readonly ObservedStep[];
}

export interface ModelResult {
  readonly step: ModelStep;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The runtime's view of a model. Implemented by the gateway, or by a test. */
export interface AgentModel {
  next(request: ModelRequest): Promise<ModelResult>;
}

/** A completed step, fed back to the model as an observation. */
export interface ObservedStep {
  readonly toolName: string;
  readonly outcome: 'ok' | 'denied' | 'failed' | 'awaiting_approval';
  /** Result, denial message, or error — always safe to show the model. */
  readonly observation: string;
}

export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly permissionLevel: RiskLevel;
  readonly allowlist: readonly string[];
  readonly enabled: boolean;
  readonly maxSteps: number;
}

export interface RunRequest {
  /** The organization this run is bound to. Never from client input. */
  readonly scope: OrganizationScoped;
  /**
   * WHO the run acts as. For a staff run this carries the invoking user's
   * role, which is the ceiling on the run's authority. For a chatbot visitor
   * it carries no role at all, because a visitor has none.
   */
  readonly principal: Principal;
  readonly message: string;
  readonly context: readonly ContextBlock[];
  readonly runId: string | null;
  readonly requestId: string | undefined;
}

/** Side-effecting collaborators, injected so the runtime itself stays pure-ish. */
export interface RuntimeHooks {
  /** Record an execution attempt — including denials. Append-only downstream. */
  recordExecution(entry: {
    toolName: string;
    outcome: 'ok' | 'denied' | 'failed' | 'awaiting_approval';
    denialReason?: DenialReason | undefined;
    input: unknown;
    output?: unknown;
    durationMs: number;
    approvalId?: string | null;
  }): Promise<void>;

  /**
   * Create a pending approval and return its id. The tool does NOT run.
   * A human decides, and the run resumes later.
   */
  requestApproval(entry: {
    toolName: string;
    summary: string;
    input: unknown;
  }): Promise<string>;

  /**
   * Whether an approved, unconsumed approval exists for this exact call.
   * Returns its id so it can be marked consumed — one approval authorises
   * exactly one execution.
   */
  findApproval(toolName: string, input: unknown): Promise<string | null>;

  consumeApproval(approvalId: string): Promise<void>;
}

export const RunStatus = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  AWAITING_APPROVAL: 'awaiting_approval',
  MAX_STEPS: 'max_steps',
} as const;

export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export interface RunResult {
  readonly status: RunStatus;
  readonly output: string;
  readonly steps: readonly ObservedStep[];
  readonly stepsUsed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Set when the run paused for approval. */
  readonly pendingApprovalId?: string;
}

/** Longest tool observation fed back to the model, in characters. */
const MAX_OBSERVATION_CHARS = 8_000;

export class AgentRuntime {
  constructor(
    private readonly registry: ReadonlyMap<string, ToolDefinition>,
    private readonly model: AgentModel,
    private readonly hooks: RuntimeHooks,
  ) {}

  async run(agent: AgentConfig, request: RunRequest): Promise<RunResult> {
    const steps: ObservedStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    // Advertised tools are pre-filtered by the same gates the executor applies,
    // so the model is not shown options it would be refused.
    const available = callableTools(this.registry, {
      agentAllowlist: agent.allowlist,
      agentPermissionLevel: agent.permissionLevel,
      principal: request.principal,
    });

    const prompt = assemblePrompt({
      agentInstructions: agent.instructions,
      userMessage: request.message,
      context: request.context,
      toolNames: available.map((tool) => tool.name),
    });

    for (let step = 0; step < agent.maxSteps; step += 1) {
      const result = await this.model.next({
        system: prompt.system,
        user: prompt.user,
        tools: available.map(advertise),
        history: steps,
      });

      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;

      if (result.step.type === 'message') {
        return {
          status: RunStatus.SUCCEEDED,
          output: result.step.text,
          steps,
          stepsUsed: step + 1,
          inputTokens,
          outputTokens,
        };
      }

      const outcome = await this.executeToolCall(agent, request, result.step);
      steps.push(outcome.observed);

      if (outcome.pausedApprovalId) {
        return {
          status: RunStatus.AWAITING_APPROVAL,
          output:
            `This action needs your approval before it can run: ` +
            `${outcome.observed.observation}`,
          steps,
          stepsUsed: step + 1,
          inputTokens,
          outputTokens,
          pendingApprovalId: outcome.pausedApprovalId,
        };
      }
    }

    /*
     * Step budget exhausted. Reported as its own status rather than as a
     * failure: the run did not error, it ran out of room, and the two need
     * different responses from a human.
     */
    return {
      status: RunStatus.MAX_STEPS,
      output: `The agent reached its ${agent.maxSteps}-step limit without finishing.`,
      steps,
      stepsUsed: agent.maxSteps,
      inputTokens,
      outputTokens,
    };
  }

  /**
   * Authorise, then maybe execute, one proposed tool call.
   *
   * Every path through this method records an execution row — including
   * denials. A denied call is exactly the event worth reviewing later, so
   * recording only successes would hide the interesting half.
   */
  private async executeToolCall(
    agent: AgentConfig,
    request: RunRequest,
    call: Extract<ModelStep, { type: 'tool_call' }>,
  ): Promise<{ observed: ObservedStep; pausedApprovalId?: string }> {
    const started = Date.now();
    const tool = this.registry.get(call.toolName);

    const decision = authorizeToolCall({
      tool,
      toolName: call.toolName,
      agentAllowlist: agent.allowlist,
      agentPermissionLevel: agent.permissionLevel,
      agentEnabled: agent.enabled,
      principal: request.principal,
    });

    if (!decision.allowed) {
      await this.hooks.recordExecution({
        toolName: call.toolName,
        outcome: 'denied',
        denialReason: decision.reason,
        input: call.input,
        durationMs: Date.now() - started,
      });
      return {
        observed: {
          toolName: call.toolName,
          outcome: 'denied',
          // Fed back so the model can explain itself, and deliberately
          // uninformative about WHY beyond the category.
          observation: decision.message,
        },
      };
    }

    // `tool` is defined here: authorizeToolCall rejects an unknown tool.
    const definition = tool as ToolDefinition;

    // Validate arguments BEFORE any approval is requested. Asking a human to
    // approve a call that would fail validation wastes their attention.
    const parsed = definition.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      await this.hooks.recordExecution({
        toolName: call.toolName,
        outcome: 'denied',
        denialReason: DenialReason.INVALID_INPUT,
        input: call.input,
        durationMs: Date.now() - started,
      });
      return {
        observed: {
          toolName: call.toolName,
          outcome: 'denied',
          observation: `Invalid arguments: ${describeIssues(parsed.error)}`,
        },
      };
    }

    let approvalId: string | null = null;
    if (decision.requiresApproval) {
      approvalId = await this.hooks.findApproval(call.toolName, parsed.data);

      if (!approvalId) {
        const summary = definition.summarise
          ? definition.summarise(parsed.data)
          : `Run ${definition.name}`;

        const pendingId = await this.hooks.requestApproval({
          toolName: call.toolName,
          summary,
          input: parsed.data,
        });

        await this.hooks.recordExecution({
          toolName: call.toolName,
          outcome: 'awaiting_approval',
          input: parsed.data,
          durationMs: Date.now() - started,
          approvalId: pendingId,
        });

        return {
          observed: {
            toolName: call.toolName,
            outcome: 'awaiting_approval',
            observation: summary,
          },
          pausedApprovalId: pendingId,
        };
      }
    }

    try {
      const output = await definition.execute(parsed.data, {
        scope: request.scope,
        runId: request.runId,
        requestId: request.requestId,
      });

      /*
       * Validate the OUTPUT too. A tool result goes straight back into the
       * model's context, so an unexpected shape is both a correctness problem
       * and an injection surface.
       */
      const validated = definition.outputSchema.safeParse(output);
      if (!validated.success) {
        await this.hooks.recordExecution({
          toolName: call.toolName,
          outcome: 'failed',
          input: parsed.data,
          durationMs: Date.now() - started,
        });
        return {
          observed: {
            toolName: call.toolName,
            outcome: 'failed',
            observation: 'The tool returned an unexpected result and was discarded.',
          },
        };
      }

      if (approvalId) await this.hooks.consumeApproval(approvalId);

      await this.hooks.recordExecution({
        toolName: call.toolName,
        outcome: 'ok',
        input: parsed.data,
        output: validated.data,
        durationMs: Date.now() - started,
        approvalId,
      });

      return {
        observed: {
          toolName: call.toolName,
          outcome: 'ok',
          observation: observe(validated.data),
        },
      };
    } catch (error) {
      await this.hooks.recordExecution({
        toolName: call.toolName,
        outcome: 'failed',
        input: parsed.data,
        durationMs: Date.now() - started,
      });
      return {
        observed: {
          toolName: call.toolName,
          outcome: 'failed',
          // The raw error is not shown: it can carry SQL, paths or identifiers
          // from other rows, and it is about to become model context.
          observation: `The tool failed. ${error instanceof Error && error.name === 'ValidationError' ? 'The arguments were rejected.' : 'Try a different approach.'}`,
        },
      };
    }
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
    .join('; ');
}

/**
 * Turn a validated tool result into an observation for the model.
 *
 * A tool result is the main way third-party text enters the loop: a knowledge
 * search returns passages from documents anyone in the organization uploaded,
 * and a chatbot visitor's own question decides which ones. So the same
 * delimiter neutralisation applied to retrieved context is applied here.
 *
 * As always (see prompt.ts), this RAISES THE COST of an injection and is not
 * the control that stops one. The control is that `authorizeToolCall` does not
 * consult anything reachable from this string.
 */
function observe(value: unknown): string {
  const text = neutraliseUntrusted(JSON.stringify(value));
  return text.length <= MAX_OBSERVATION_CHARS
    ? text
    : `${text.slice(0, MAX_OBSERVATION_CHARS)}…[truncated]`;
}
