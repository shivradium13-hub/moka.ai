import { z } from 'zod';
import type { Permission, TenantContext } from '@moka/core';

/**
 * Tool contract (master prompt §19, §20).
 *
 * THE CENTRAL RULE
 * An agent never touches the database. It proposes a NAMED tool call with
 * typed arguments; the executor decides whether that call happens. Every tool
 * therefore declares what it needs, and the executor — not the model — enforces
 * it.
 *
 * This is also the real defence against prompt injection. Injected text can
 * make a model *ask* for anything; it cannot make the executor agree. Which is
 * why authorisation lives here rather than in the prompt.
 */

/**
 * How consequential a tool is.
 *
 * Distinct from `permission`: permission asks "may this user do it at all?",
 * risk asks "how bad is it if the model was manipulated into asking?".
 * A tool needs to clear both.
 */
export const RiskLevel = {
  /** Reads data. Reversible by definition. */
  READ: 'read',
  /** Creates or changes something reversible — a draft, an unpublished record. */
  DRAFT: 'draft',
  /** Consequential and hard to undo: deletion, publication, spending, sending. */
  EXECUTE: 'execute',
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/** Ordering used to compare an agent's ceiling against a tool's risk. */
const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  [RiskLevel.READ]: 0,
  [RiskLevel.DRAFT]: 1,
  [RiskLevel.EXECUTE]: 2,
};

export function riskWithin(agentLevel: RiskLevel, toolRisk: RiskLevel): boolean {
  return RISK_RANK[toolRisk] <= RISK_RANK[agentLevel];
}

export interface ToolContext {
  readonly tenant: TenantContext;
  /** Correlates every side effect of one agent run. */
  readonly runId: string | null;
  readonly requestId: string | undefined;
}

/**
 * A tool definition.
 *
 * `inputSchema` and `outputSchema` are both required. Validating the OUTPUT
 * matters as much as the input: a tool result is fed straight back into the
 * model's context, so a malformed or oversized result is an injection surface
 * in its own right.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  /** Shown to the model. Written for a reader who will act on it literally. */
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  /** The RBAC permission the INVOKING USER must hold. */
  readonly permission: Permission;
  readonly risk: RiskLevel;
  /**
   * When true, an approved `approvals` row must exist before this runs.
   * Defaults to true for EXECUTE-risk tools; a tool may opt in at lower risk.
   */
  readonly requiresApproval?: boolean;
  /**
   * Human-readable summary of a proposed call, shown on the approval card.
   * Must describe the effect in the user's terms, not the tool's.
   */
  readonly summarise?: (input: TInput) => string;
  readonly execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

/**
 * Define a tool with its input and output types fully checked.
 *
 * The returned type is erased to `ToolDefinition<unknown, unknown>` so tools of
 * different shapes can live in one registry. The cast is confined to this
 * function and is sound because of a runtime invariant the executor upholds:
 * `execute` is only ever called with a value that has already been parsed by
 * this tool's own `inputSchema` (see AgentRuntime.executeToolCall). Nothing
 * else may call `execute` directly.
 */
export function defineTool<S extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: {
  name: string;
  description: string;
  inputSchema: S;
  outputSchema: O;
  permission: Permission;
  risk: RiskLevel;
  requiresApproval?: boolean;
  summarise?: (input: z.output<S>) => string;
  execute: (input: z.output<S>, context: ToolContext) => Promise<z.output<O>>;
}): ToolDefinition {
  // `z.output<S>` rather than a bare generic: a schema using `.default()` has
  // different input and output types, and conflating them would type an
  // defaulted argument as possibly-undefined inside `execute`, where it never is.
  return definition as unknown as ToolDefinition;
}

/** Whether a call to this tool must be gated on human approval. */
export function needsApproval(tool: ToolDefinition): boolean {
  return tool.requiresApproval ?? tool.risk === RiskLevel.EXECUTE;
}

/**
 * The shape handed to a model.
 *
 * Deliberately excludes `permission`, `risk` and `execute`. The model has no
 * use for our authorisation model, and telling it which tools are privileged
 * only helps an injected instruction pick a target.
 */
export interface ToolAdvertisement {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export function advertise(tool: ToolDefinition): ToolAdvertisement {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  };
}

/**
 * Minimal Zod → JSON Schema conversion.
 *
 * Deliberately small and local rather than another dependency: it only has to
 * describe the flat argument objects our tools accept, and a general converter
 * would be far more surface than that is worth.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const definition = schema._def as { typeName?: string };

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToJsonSchema(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema._def.innerType as z.ZodType);
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element as z.ZodType) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };

  // Unknown constructs degrade to an untyped value rather than throwing:
  // a tool must never become uncallable because of a description detail.
  return { type: 'object', description: String(definition.typeName ?? 'unknown') };
}
