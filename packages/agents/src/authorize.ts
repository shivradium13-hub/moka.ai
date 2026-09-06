import { hasPermission, type SystemRole } from '@moka/core';
import { needsApproval, riskWithin, type RiskLevel, type ToolDefinition } from './tool.js';

/**
 * Tool authorisation (master prompt §19, §20).
 *
 * Every tool call passes through `authorizeToolCall`. It is pure — no I/O, no
 * database, no clock — so it can be exhaustively tested, and so that reading it
 * tells you the entire authorisation model.
 *
 * THE FOUR GATES, in order:
 *
 *   1. Is the tool registered at all?
 *   2. Is it on THIS agent's allowlist?
 *   3. Is its risk within the agent's ceiling?
 *   4. Does the INVOKING USER hold the tool's permission?
 *
 * Gate 4 is the one that matters most and is easiest to omit. Without it an
 * agent becomes a privilege-escalation path: a viewer runs an agent configured
 * by an admin and deletes projects they could never have deleted by hand.
 * An agent may only ever NARROW its caller's authority.
 *
 * Gates 2 and 3 exist because a model's tool choice is attacker-influenceable.
 * Text inside a knowledge chunk can make a model *ask* to delete everything;
 * these gates are why asking is not enough.
 */

export const DenialReason = {
  UNKNOWN_TOOL: 'unknown_tool',
  NOT_ON_AGENT_ALLOWLIST: 'not_on_agent_allowlist',
  EXCEEDS_AGENT_PERMISSION_LEVEL: 'exceeds_agent_permission_level',
  USER_LACKS_PERMISSION: 'user_lacks_permission',
  AGENT_DISABLED: 'agent_disabled',
  INVALID_INPUT: 'invalid_input',
} as const;

export type DenialReason = (typeof DenialReason)[keyof typeof DenialReason];

/** Messages safe to show the invoking user. They name no other tenant's data. */
const DENIAL_MESSAGES: Record<DenialReason, string> = {
  [DenialReason.UNKNOWN_TOOL]: 'That tool does not exist.',
  [DenialReason.NOT_ON_AGENT_ALLOWLIST]: 'This agent is not permitted to use that tool.',
  [DenialReason.EXCEEDS_AGENT_PERMISSION_LEVEL]:
    "That action exceeds this agent's permission level.",
  [DenialReason.USER_LACKS_PERMISSION]: 'You do not have permission to perform that action.',
  [DenialReason.AGENT_DISABLED]: 'This agent is disabled.',
  [DenialReason.INVALID_INPUT]: 'The tool arguments were invalid.',
};

export interface AuthorizationRequest {
  readonly tool: ToolDefinition | undefined;
  readonly toolName: string;
  /** Tool names this agent is explicitly allowed to call. */
  readonly agentAllowlist: readonly string[];
  readonly agentPermissionLevel: RiskLevel;
  readonly agentEnabled: boolean;
  /** Role of the user who started the run — the ceiling on its authority. */
  readonly userRole: SystemRole;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly requiresApproval: boolean }
  | {
      readonly allowed: false;
      readonly reason: DenialReason;
      /** Safe to return to the caller and to feed back to the model. */
      readonly message: string;
    };

export function authorizeToolCall(request: AuthorizationRequest): AuthorizationDecision {
  const deny = (reason: DenialReason): AuthorizationDecision => ({
    allowed: false,
    reason,
    message: DENIAL_MESSAGES[reason],
  });

  if (!request.agentEnabled) return deny(DenialReason.AGENT_DISABLED);

  // 1. Registered?
  const tool = request.tool;
  if (!tool || tool.name !== request.toolName) return deny(DenialReason.UNKNOWN_TOOL);

  // 2. On this agent's allowlist? Deny by default — adding a tool to the
  //    platform must not silently grant it to every existing agent.
  if (!request.agentAllowlist.includes(tool.name)) {
    return deny(DenialReason.NOT_ON_AGENT_ALLOWLIST);
  }

  // 3. Within the agent's configured ceiling?
  if (!riskWithin(request.agentPermissionLevel, tool.risk)) {
    return deny(DenialReason.EXCEEDS_AGENT_PERMISSION_LEVEL);
  }

  // 4. Does the INVOKING USER hold this permission themselves?
  if (!hasPermission(request.userRole, tool.permission)) {
    return deny(DenialReason.USER_LACKS_PERMISSION);
  }

  return { allowed: true, requiresApproval: needsApproval(tool) };
}

/**
 * Tools this agent could call in principle, for advertisement to the model.
 *
 * Filtered by the SAME gates as execution, so the model is never shown a tool
 * it would be denied. That is a usability choice, not a security one — the
 * executor re-checks everything regardless, because a model may name a tool it
 * was never told about.
 */
export function callableTools(
  registry: ReadonlyMap<string, ToolDefinition>,
  params: {
    agentAllowlist: readonly string[];
    agentPermissionLevel: RiskLevel;
    userRole: SystemRole;
  },
): ToolDefinition[] {
  return params.agentAllowlist
    .map((name) => registry.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined)
    .filter((tool) => riskWithin(params.agentPermissionLevel, tool.risk))
    .filter((tool) => hasPermission(params.userRole, tool.permission));
}
