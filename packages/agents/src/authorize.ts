import { hasPermission, type SystemRole } from '@moka/core';
import { needsApproval, riskWithin, RiskLevel, type ToolDefinition } from './tool.js';

/**
 * Tool authorisation (master prompt §19, §20, §23).
 *
 * Every tool call — from a staff member's agent or from a stranger's chatbot
 * session — passes through `authorizeToolCall`. It is pure: no I/O, no
 * database, no clock. So it can be exhaustively tested, and so that reading
 * this one function tells you the entire authorisation model.
 *
 * THE SHARED GATES, in order:
 *
 *   1. Is the agent enabled?
 *   2. Is the tool registered at all?
 *   3. Is it on THIS agent's allowlist?
 *   4. Is its risk within the agent's ceiling?
 *
 * Then the principal branch, which is where the two kinds of caller diverge.
 *
 * FOR A USER: does the INVOKING USER hold the tool's permission?
 *   The gate that matters most and is easiest to omit. Without it an agent
 *   becomes a privilege-escalation path: a viewer runs an agent configured by
 *   an admin and deletes projects they could never have deleted by hand. An
 *   agent may only ever NARROW its caller's authority.
 *
 * FOR A CUSTOMER: is the tool explicitly published to the public?
 *   A visitor holds no role, so there is no permission to check — and that is
 *   deliberate (see CustomerContext in @moka/core). Instead the tool must have
 *   opted in with `customerSafe`, must be read-only, and must not be gated on
 *   approval. All three default to refusing, so a tool added to the platform
 *   is never reachable by the public until somebody says so in writing.
 *
 * Gates 3 and 4 exist because a model's tool choice is attacker-influenceable.
 * Text inside a knowledge chunk — or typed straight into a chat widget by the
 * attacker — can make a model *ask* to delete everything; these gates are why
 * asking is not enough.
 */

export const DenialReason = {
  UNKNOWN_TOOL: 'unknown_tool',
  NOT_ON_AGENT_ALLOWLIST: 'not_on_agent_allowlist',
  EXCEEDS_AGENT_PERMISSION_LEVEL: 'exceeds_agent_permission_level',
  USER_LACKS_PERMISSION: 'user_lacks_permission',
  AGENT_DISABLED: 'agent_disabled',
  INVALID_INPUT: 'invalid_input',
  /** A visitor asked for a tool that was never published to the public. */
  NOT_CUSTOMER_SAFE: 'not_customer_safe',
} as const;

export type DenialReason = (typeof DenialReason)[keyof typeof DenialReason];

/**
 * Messages safe to show the caller. They name no other tenant's data — and for
 * the customer path they are also safe to show a STRANGER, so they reveal
 * nothing about which tools exist or why one was refused.
 */
const DENIAL_MESSAGES: Record<DenialReason, string> = {
  [DenialReason.UNKNOWN_TOOL]: 'That tool does not exist.',
  [DenialReason.NOT_ON_AGENT_ALLOWLIST]: 'This agent is not permitted to use that tool.',
  [DenialReason.EXCEEDS_AGENT_PERMISSION_LEVEL]:
    "That action exceeds this agent's permission level.",
  [DenialReason.USER_LACKS_PERMISSION]: 'You do not have permission to perform that action.',
  [DenialReason.AGENT_DISABLED]: 'This agent is disabled.',
  [DenialReason.INVALID_INPUT]: 'The tool arguments were invalid.',
  [DenialReason.NOT_CUSTOMER_SAFE]: 'That action is not available in this conversation.',
};

/**
 * Who is making the call.
 *
 * A discriminated union rather than "a user with a low role". The customer
 * variant has no `role` field at all, so `hasPermission` cannot be reached from
 * it — not "is not called", but does not typecheck. That is the difference
 * between an authorisation model and an authorisation habit.
 */
export type Principal =
  | { readonly kind: 'user'; readonly role: SystemRole }
  | { readonly kind: 'customer' };

export const userPrincipal = (role: SystemRole): Principal => ({ kind: 'user', role });
export const customerPrincipal = (): Principal => ({ kind: 'customer' });

export interface AuthorizationRequest {
  readonly tool: ToolDefinition | undefined;
  readonly toolName: string;
  /** Tool names this agent is explicitly allowed to call. */
  readonly agentAllowlist: readonly string[];
  readonly agentPermissionLevel: RiskLevel;
  readonly agentEnabled: boolean;
  /** The caller. For a user run, their role is the ceiling on its authority. */
  readonly principal: Principal;
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

  // 4. The principal branch.
  if (request.principal.kind === 'customer') {
    /*
     * Three independent conditions, each of which alone would be enough, and
     * every one of which defaults to refusing:
     *
     *  - `customerSafe` is opt-in. A new tool is unreachable by the public
     *    until an author writes `customerSafe: true` and a reviewer sees it.
     *  - The risk check re-derives publishability from the tool's own risk
     *    rather than trusting the flag. A `customerSafe` tool that also
     *    mutates data is a mistake in the registry, and this catches it at
     *    call time instead of shipping it.
     *  - An approval-gated tool is refused outright rather than queued.
     *    Letting a stranger fill an organization's approval inbox is a denial
     *    of service against human attention, and a person asked to approve an
     *    action requested by an anonymous visitor has no way to judge it.
     */
    if (tool.customerSafe !== true) return deny(DenialReason.NOT_CUSTOMER_SAFE);
    if (tool.risk !== RiskLevel.READ) return deny(DenialReason.NOT_CUSTOMER_SAFE);
    if (needsApproval(tool)) return deny(DenialReason.NOT_CUSTOMER_SAFE);

    return { allowed: true, requiresApproval: false };
  }

  // 5. Does the INVOKING USER hold this permission themselves?
  if (!hasPermission(request.principal.role, tool.permission)) {
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
 *
 * Implemented by asking `authorizeToolCall` rather than by re-listing the
 * conditions. Two copies of an authorisation rule drift, and the copy that
 * drifts is always the one nobody tested.
 */
export function callableTools(
  registry: ReadonlyMap<string, ToolDefinition>,
  params: {
    agentAllowlist: readonly string[];
    agentPermissionLevel: RiskLevel;
    principal: Principal;
  },
): ToolDefinition[] {
  return params.agentAllowlist
    .map((name) => registry.get(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined)
    .filter(
      (tool) =>
        authorizeToolCall({
          tool,
          toolName: tool.name,
          agentAllowlist: params.agentAllowlist,
          agentPermissionLevel: params.agentPermissionLevel,
          agentEnabled: true,
          principal: params.principal,
        }).allowed,
    );
}
