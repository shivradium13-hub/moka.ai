import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Permission, SystemRole } from '@moka/core';
import {
  authorizeToolCall,
  callableTools,
  customerPrincipal,
  DenialReason,
  userPrincipal,
} from './authorize.js';
import { RiskLevel, defineTool, needsApproval, riskWithin, type ToolDefinition } from './tool.js';

/**
 * SECURITY SUITE 2 — UNAUTHORIZED TOOL EXECUTION.
 *
 * `authorizeToolCall` is the single decision point between "the model asked"
 * and "it happened". These tests enumerate every way that decision could be
 * wrong, because a gap here is not a bug in one feature — it is a way for a
 * manipulated model to act with someone else's authority.
 */

const readTool = defineTool({
  name: 'read_thing',
  description: 'Reads.',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  permission: Permission.PROJECT_READ,
  risk: RiskLevel.READ,
  execute: async () => ({}),
});

const draftTool = defineTool({
  name: 'draft_thing',
  description: 'Creates.',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  permission: Permission.PROJECT_CREATE,
  risk: RiskLevel.DRAFT,
  execute: async () => ({}),
});

const executeTool = defineTool({
  name: 'destroy_thing',
  description: 'Deletes.',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  permission: Permission.PROJECT_DELETE,
  risk: RiskLevel.EXECUTE,
  execute: async () => ({}),
});

const REGISTRY = new Map<string, ToolDefinition>([
  [readTool.name, readTool],
  [draftTool.name, draftTool],
  [executeTool.name, executeTool],
]);

function ask(overrides: {
  tool?: ToolDefinition;
  toolName?: string;
  allowlist?: string[];
  level?: RiskLevel;
  role?: SystemRole;
  enabled?: boolean;
}) {
  const tool = overrides.tool ?? readTool;
  return authorizeToolCall({
    tool,
    toolName: overrides.toolName ?? tool.name,
    agentAllowlist: overrides.allowlist ?? [tool.name],
    agentPermissionLevel: overrides.level ?? RiskLevel.EXECUTE,
    agentEnabled: overrides.enabled ?? true,
    principal: userPrincipal(overrides.role ?? SystemRole.OWNER),
  });
}

describe('risk ordering', () => {
  it('permits risk at or below the agent ceiling', () => {
    expect(riskWithin(RiskLevel.EXECUTE, RiskLevel.READ)).toBe(true);
    expect(riskWithin(RiskLevel.EXECUTE, RiskLevel.EXECUTE)).toBe(true);
    expect(riskWithin(RiskLevel.DRAFT, RiskLevel.DRAFT)).toBe(true);
    expect(riskWithin(RiskLevel.READ, RiskLevel.READ)).toBe(true);
  });

  it('refuses risk above the ceiling', () => {
    expect(riskWithin(RiskLevel.READ, RiskLevel.DRAFT)).toBe(false);
    expect(riskWithin(RiskLevel.READ, RiskLevel.EXECUTE)).toBe(false);
    expect(riskWithin(RiskLevel.DRAFT, RiskLevel.EXECUTE)).toBe(false);
  });
});

describe('gate 1 — the tool must exist', () => {
  it('denies an unregistered tool', () => {
    const decision = ask({ tool: undefined, toolName: 'run_sql' });
    expect(decision).toMatchObject({ allowed: false, reason: DenialReason.UNKNOWN_TOOL });
  });

  /*
   * A model can return any string. If the name it asked for is not the tool we
   * looked up, that mismatch must not be papered over.
   */
  it('denies when the requested name does not match the resolved tool', () => {
    const decision = ask({ tool: readTool, toolName: 'destroy_thing' });
    expect(decision).toMatchObject({ allowed: false, reason: DenialReason.UNKNOWN_TOOL });
  });
});

describe('gate 2 — the agent allowlist', () => {
  it('denies a tool absent from the allowlist', () => {
    const decision = ask({ tool: executeTool, allowlist: ['read_thing'] });
    expect(decision).toMatchObject({
      allowed: false,
      reason: DenialReason.NOT_ON_AGENT_ALLOWLIST,
    });
  });

  // Adding a tool to the platform must not grant it to every existing agent.
  it('denies everything for an empty allowlist', () => {
    for (const tool of [readTool, draftTool, executeTool]) {
      expect(ask({ tool, allowlist: [] }), tool.name).toMatchObject({ allowed: false });
    }
  });

  it('allows a tool that is on the allowlist', () => {
    expect(ask({ tool: readTool, allowlist: ['read_thing'] }).allowed).toBe(true);
  });
});

describe('gate 3 — the agent permission ceiling', () => {
  it('denies a destructive tool to a read-level agent', () => {
    const decision = ask({
      tool: executeTool,
      allowlist: ['destroy_thing'],
      level: RiskLevel.READ,
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: DenialReason.EXCEEDS_AGENT_PERMISSION_LEVEL,
    });
  });

  it('denies a draft tool to a read-level agent', () => {
    expect(
      ask({ tool: draftTool, allowlist: ['draft_thing'], level: RiskLevel.READ }),
    ).toMatchObject({ allowed: false, reason: DenialReason.EXCEEDS_AGENT_PERMISSION_LEVEL });
  });

  /*
   * The ceiling binds even when the tool IS allowlisted. Someone adding a
   * powerful tool to a read-only agent must not thereby make it powerful.
   */
  it('the allowlist cannot override the ceiling', () => {
    expect(
      ask({ tool: executeTool, allowlist: ['destroy_thing'], level: RiskLevel.DRAFT }),
    ).toMatchObject({ allowed: false });
  });
});

/**
 * Gate 4 — the one that stops an agent becoming a privilege-escalation path.
 * An agent may only ever NARROW what its caller could do by hand.
 */
describe('gate 4 — the invoking user must hold the permission', () => {
  it("denies a destructive tool to a VIEWER, however the agent is configured", () => {
    const decision = ask({
      tool: executeTool,
      allowlist: ['destroy_thing'],
      level: RiskLevel.EXECUTE,
      role: SystemRole.VIEWER,
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: DenialReason.USER_LACKS_PERMISSION,
    });
  });

  it('denies project creation to a viewer', () => {
    expect(
      ask({ tool: draftTool, allowlist: ['draft_thing'], role: SystemRole.VIEWER }),
    ).toMatchObject({ allowed: false, reason: DenialReason.USER_LACKS_PERMISSION });
  });

  it('denies deletion to a MEMBER, who cannot delete projects by hand either', () => {
    expect(
      ask({ tool: executeTool, allowlist: ['destroy_thing'], role: SystemRole.MEMBER }),
    ).toMatchObject({ allowed: false, reason: DenialReason.USER_LACKS_PERMISSION });
  });

  it('allows a viewer to use a read tool', () => {
    expect(ask({ tool: readTool, role: SystemRole.VIEWER }).allowed).toBe(true);
  });

  it('allows an admin to use a destructive tool', () => {
    expect(
      ask({ tool: executeTool, allowlist: ['destroy_thing'], role: SystemRole.ADMIN }).allowed,
    ).toBe(true);
  });

  /*
   * The exhaustive statement of the escalation property: for every role and
   * every tool, the agent's answer matches what that role could do directly.
   */
  it('never grants a role more than it holds directly', () => {
    const roles = [SystemRole.VIEWER, SystemRole.MEMBER, SystemRole.ADMIN, SystemRole.OWNER];
    const expectations: Record<string, SystemRole[]> = {
      read_thing: roles,
      draft_thing: [SystemRole.MEMBER, SystemRole.ADMIN, SystemRole.OWNER],
      destroy_thing: [SystemRole.ADMIN, SystemRole.OWNER],
    };

    for (const tool of [readTool, draftTool, executeTool]) {
      for (const role of roles) {
        const decision = ask({
          tool,
          allowlist: [tool.name],
          level: RiskLevel.EXECUTE,
          role,
        });
        const shouldAllow = expectations[tool.name]!.includes(role);
        expect(decision.allowed, `${tool.name} for ${role}`).toBe(shouldAllow);
      }
    }
  });
});

describe('disabled agents', () => {
  it('denies every tool when the agent is disabled', () => {
    for (const tool of [readTool, draftTool, executeTool]) {
      expect(ask({ tool, allowlist: [tool.name], enabled: false }), tool.name).toMatchObject({
        allowed: false,
        reason: DenialReason.AGENT_DISABLED,
      });
    }
  });
});

describe('approval requirements', () => {
  it('gates EXECUTE-risk tools by default', () => {
    expect(needsApproval(executeTool)).toBe(true);
    const decision = ask({ tool: executeTool, allowlist: ['destroy_thing'] });
    expect(decision).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it('does not gate read or draft tools by default', () => {
    expect(needsApproval(readTool)).toBe(false);
    expect(needsApproval(draftTool)).toBe(false);
    expect(ask({ tool: draftTool, allowlist: ['draft_thing'] })).toMatchObject({
      allowed: true,
      requiresApproval: false,
    });
  });

  it('lets a lower-risk tool opt in to approval', () => {
    const gated = defineTool({
      name: 'gated_read',
      description: 'Sensitive read.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      permission: Permission.PROJECT_READ,
      risk: RiskLevel.READ,
      requiresApproval: true,
      execute: async () => ({}),
    });
    expect(needsApproval(gated)).toBe(true);
  });
});

describe('denial messages', () => {
  it('explains the category without naming other tenants or resources', () => {
    const decision = ask({ tool: executeTool, allowlist: [], role: SystemRole.VIEWER });
    if (decision.allowed) throw new Error('expected denial');

    expect(decision.message.length).toBeGreaterThan(0);
    expect(decision.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no ids
    expect(decision.message).not.toContain('SELECT');
  });
});

describe('callableTools', () => {
  it('advertises only what would actually be permitted', () => {
    const names = callableTools(REGISTRY, {
      agentAllowlist: ['read_thing', 'draft_thing', 'destroy_thing'],
      agentPermissionLevel: RiskLevel.EXECUTE,
      principal: userPrincipal(SystemRole.VIEWER),
    }).map((tool) => tool.name);

    expect(names).toEqual(['read_thing']);
  });

  it('respects the agent ceiling', () => {
    const names = callableTools(REGISTRY, {
      agentAllowlist: ['read_thing', 'draft_thing', 'destroy_thing'],
      agentPermissionLevel: RiskLevel.DRAFT,
      principal: userPrincipal(SystemRole.OWNER),
    }).map((tool) => tool.name);

    expect(names).toEqual(['read_thing', 'draft_thing']);
  });

  it('ignores allowlisted names that are not registered', () => {
    const names = callableTools(REGISTRY, {
      agentAllowlist: ['read_thing', 'no_such_tool'],
      agentPermissionLevel: RiskLevel.EXECUTE,
      principal: userPrincipal(SystemRole.OWNER),
    }).map((tool) => tool.name);

    expect(names).toEqual(['read_thing']);
  });
});

/* ========================================================================== */
/* SECURITY SUITE 8 (part 1) — the customer boundary                          */
/*                                                                            */
/* A chatbot visitor is an anonymous member of the public standing on someone  */
/* else's website. These tests pin the claim that such a caller holds no       */
/* authority — not "little authority", none — and that publishing a tool to    */
/* them is an explicit act that cannot happen by omission.                     */
/* ========================================================================== */

/** A tool an organization has deliberately published to the public. */
const publicTool = defineTool({
  name: 'public_read_thing',
  description: 'Reads something the organization chose to publish.',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  permission: Permission.PROJECT_READ,
  risk: RiskLevel.READ,
  customerSafe: true,
  execute: async () => ({}),
});

function askAsCustomer(overrides: {
  tool?: ToolDefinition;
  toolName?: string;
  allowlist?: string[];
  level?: RiskLevel;
} = {}) {
  const tool = overrides.tool ?? publicTool;
  return authorizeToolCall({
    tool,
    toolName: overrides.toolName ?? tool.name,
    agentAllowlist: overrides.allowlist ?? [tool.name],
    agentPermissionLevel: overrides.level ?? RiskLevel.EXECUTE,
    agentEnabled: true,
    principal: customerPrincipal(),
  });
}

describe('a customer holds no role', () => {
  it('permits a tool explicitly published to the public', () => {
    const decision = askAsCustomer();
    expect(decision.allowed).toBe(true);
  });

  it('never gates a customer call on human approval', () => {
    const decision = askAsCustomer();
    if (!decision.allowed) throw new Error('expected permission');
    /*
     * An approval requested by an anonymous stranger is a denial of service
     * against human attention: the deciding member has no way to judge who
     * asked or why. Customer calls are permitted outright or refused outright.
     */
    expect(decision.requiresApproval).toBe(false);
  });

  it('refuses a read tool that was never marked customerSafe', () => {
    // `read_thing` is harmless, allowlisted, read-only, and within the
    // ceiling. It is refused solely because nobody published it.
    const decision = askAsCustomer({ tool: readTool });
    if (decision.allowed) throw new Error('expected denial');
    expect(decision.reason).toBe(DenialReason.NOT_CUSTOMER_SAFE);
  });

  it('refuses a destructive tool even when the agent ceiling allows it', () => {
    const decision = askAsCustomer({ tool: executeTool });
    if (decision.allowed) throw new Error('expected denial');
    expect(decision.reason).toBe(DenialReason.NOT_CUSTOMER_SAFE);
  });

  it('refuses a customerSafe tool that is not read-only', () => {
    /*
     * A registry mistake, caught at call time rather than at review time.
     * The flag says yes and the risk says no; the risk wins, because
     * publishability is derived from what the tool DOES, not from what its
     * author remembered to annotate.
     */
    const misdeclared = defineTool({
      name: 'misdeclared_thing',
      description: 'Writes, but was wrongly published.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      permission: Permission.PROJECT_CREATE,
      risk: RiskLevel.DRAFT,
      customerSafe: true,
      execute: async () => ({}),
    });

    const decision = askAsCustomer({ tool: misdeclared });
    if (decision.allowed) throw new Error('expected denial');
    expect(decision.reason).toBe(DenialReason.NOT_CUSTOMER_SAFE);
  });

  it('refuses a customerSafe read tool that opted into approval', () => {
    const gated = defineTool({
      name: 'gated_public_thing',
      description: 'Read-only but deliberately gated.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      permission: Permission.PROJECT_READ,
      risk: RiskLevel.READ,
      customerSafe: true,
      requiresApproval: true,
      execute: async () => ({}),
    });

    const decision = askAsCustomer({ tool: gated });
    if (decision.allowed) throw new Error('expected denial');
    expect(decision.reason).toBe(DenialReason.NOT_CUSTOMER_SAFE);
  });

  it('still applies the allowlist and the agent ceiling to customers', () => {
    expect(askAsCustomer({ allowlist: ['something_else'] })).toMatchObject({
      allowed: false,
      reason: DenialReason.NOT_ON_AGENT_ALLOWLIST,
    });
  });

  it('does not leak which tools exist when refusing a stranger', () => {
    const decision = askAsCustomer({ tool: executeTool });
    if (decision.allowed) throw new Error('expected denial');
    // The visitor learns that it is unavailable "in this conversation" —
    // not that a delete tool exists and they were not permitted to use it.
    expect(decision.message).not.toContain('destroy_thing');
    expect(decision.message).not.toContain('permission');
  });

  it('a viewer outranks a customer: role absence is not a low role', () => {
    /*
     * The regression this pins. Modelling a visitor as `role: viewer` would
     * make this pair identical. They must not be: a viewer may read projects,
     * a stranger on the internet may not.
     */
    const asViewer = authorizeToolCall({
      tool: readTool,
      toolName: readTool.name,
      agentAllowlist: [readTool.name],
      agentPermissionLevel: RiskLevel.READ,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.VIEWER),
    });
    const asCustomer = askAsCustomer({ tool: readTool, level: RiskLevel.READ });

    expect(asViewer.allowed).toBe(true);
    expect(asCustomer.allowed).toBe(false);
  });
});

describe('callableTools for a customer', () => {
  it('advertises only published tools, whatever the allowlist says', () => {
    const registry = new Map<string, ToolDefinition>([
      ...REGISTRY,
      [publicTool.name, publicTool],
    ]);

    const names = callableTools(registry, {
      agentAllowlist: ['read_thing', 'draft_thing', 'destroy_thing', 'public_read_thing'],
      agentPermissionLevel: RiskLevel.EXECUTE,
      principal: customerPrincipal(),
    }).map((tool) => tool.name);

    expect(names).toEqual(['public_read_thing']);
  });
});
