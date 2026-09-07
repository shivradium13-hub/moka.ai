import { describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES, findTemplate, validateTemplates } from './templates.js';
import { buildRegistry, type ToolBackend } from './registry.js';
import { RiskLevel, type ToolDefinition } from './tool.js';
import { authorizeToolCall, customerPrincipal, userPrincipal } from './authorize.js';
import { SystemRole } from '@moka/core';

/**
 * Business agent templates.
 *
 * A template is a name, instructions, a ceiling and a tool list — nothing
 * else. These tests hold that line: a template must not become a way to reach
 * a capability the ordinary path would refuse, and it must not promise
 * something the registry cannot do.
 */

const backend: ToolBackend = {
  listProjects: async () => [],
  getProject: async () => null,
  createProject: async () => ({ id: 'x', name: 'x', slug: 'x' }),
  deleteProject: async () => ({ deleted: true }),
  searchKnowledge: async () => [],
  listKnowledgeSources: async () => [],
  webResearch: async () => ({ status: 'answered', answer: '', citations: [], skipped: [] }),
};

const REGISTRY: ReadonlyMap<string, ToolDefinition> = buildRegistry(backend);

describe('every template is coherent with the registry', () => {
  it('names only tools that exist and stays within its own ceiling', () => {
    /*
     * The failure this prevents is a bad user experience rather than a
     * breach: a template that lists a renamed tool creates an agent that says
     * "this agent is not permitted to use that tool" on its first message,
     * which looks like a bug in the runtime.
     */
    expect(validateTemplates(REGISTRY)).toEqual([]);
  });

  it('catches a tool that does not exist', () => {
    const problems = validateTemplates(REGISTRY, [
      {
        id: 'broken',
        name: 'Broken',
        summary: 'x',
        limitations: ['x'],
        instructions: 'x',
        permissionLevel: RiskLevel.READ,
        tools: ['no_such_tool'],
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('unknown tool');
  });

  it('catches a ceiling below a tool the template lists', () => {
    // An agent that can never call a tool it was configured with is
    // indistinguishable from a broken authoriser.
    const problems = validateTemplates(REGISTRY, [
      {
        id: 'mismatched',
        name: 'Mismatched',
        summary: 'x',
        limitations: ['x'],
        instructions: 'x',
        permissionLevel: RiskLevel.READ,
        tools: ['create_project'],
      },
    ]);
    expect(problems[0]!.problem).toContain('above the template ceiling');
  });

  it('catches a duplicate id', () => {
    const one = AGENT_TEMPLATES[0]!;
    expect(validateTemplates(REGISTRY, [one, one]).some((p) => p.problem.includes('duplicate'))).toBe(
      true,
    );
  });

  it('requires every template to say what it cannot do', () => {
    /*
     * A picker listing six capabilities and no limits sells a product that
     * does not exist, and the user finds out from a wrong answer instead of
     * from us.
     */
    const problems = validateTemplates(REGISTRY, [
      {
        id: 'silent',
        name: 'Silent',
        summary: 'x',
        limitations: [],
        instructions: 'x',
        permissionLevel: RiskLevel.READ,
        tools: [],
      },
    ]);
    expect(problems[0]!.problem).toContain('limitations');
  });
});

describe('templates grant no privilege', () => {
  it('a viewer running a template agent is still refused a write tool', () => {
    /*
     * §26: being an official template grants no escalation. A template is a
     * configuration, and the authoriser never learns where a configuration
     * came from.
     */
    const template = findTemplate('project-assistant')!;
    const decision = authorizeToolCall({
      tool: REGISTRY.get('create_project'),
      toolName: 'create_project',
      agentAllowlist: template.tools,
      agentPermissionLevel: template.permissionLevel,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.VIEWER),
    });
    expect(decision.allowed).toBe(false);
  });

  it('the same call succeeds for a member, so the refusal is about the role', () => {
    const template = findTemplate('project-assistant')!;
    const decision = authorizeToolCall({
      tool: REGISTRY.get('create_project'),
      toolName: 'create_project',
      agentAllowlist: template.tools,
      agentPermissionLevel: template.permissionLevel,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.MEMBER),
    });
    expect(decision.allowed).toBe(true);
  });

  it('no template can be driven by a chatbot visitor', () => {
    // Every tool in every template is refused for a customer principal,
    // because none is customerSafe. web_research is the one that matters
    // most: it would be an SSRF proxy driven by strangers.
    for (const template of AGENT_TEMPLATES) {
      for (const toolName of template.tools) {
        const decision = authorizeToolCall({
          tool: REGISTRY.get(toolName),
          toolName,
          agentAllowlist: template.tools,
          agentPermissionLevel: RiskLevel.EXECUTE,
          agentEnabled: true,
          principal: customerPrincipal(),
        });
        expect({ toolName, allowed: decision.allowed }).toEqual({ toolName, allowed: false });
      }
    }
  });

  it('no template includes a destructive tool', () => {
    /*
     * Not a rule the authoriser enforces — a user may build such an agent
     * deliberately. It is a rule about what we PRE-BUILD and put in a picker,
     * where the person choosing has not thought about the consequences yet.
     */
    for (const template of AGENT_TEMPLATES) {
      for (const toolName of template.tools) {
        expect({ template: template.id, risk: REGISTRY.get(toolName)!.risk }).not.toEqual({
          template: template.id,
          risk: RiskLevel.EXECUTE,
        });
      }
    }
  });
});

describe('what templates promise', () => {
  it('the sales template does not imply a CRM it does not have', () => {
    const template = findTemplate('sales')!;
    expect(template.limitations.join(' ')).toMatch(/not connected to a CRM/i);
    expect(template.instructions).toMatch(/no access to a CRM/i);
  });

  it('the analytics template says it is about THIS workspace', () => {
    const template = findTemplate('workspace-analyst')!;
    expect(template.limitations.join(' ')).toMatch(/not connected to Google Analytics/i);
  });

  it('the social template says plainly that it cannot publish', () => {
    // A model claiming to have posted something is the failure that would
    // embarrass a user in public.
    const template = findTemplate('social')!;
    expect(template.limitations.join(' ')).toMatch(/cannot publish/i);
    expect(template.instructions).toMatch(/never.*published/is);
  });

  it('every template instructs against claiming an action it cannot take', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.instructions).toMatch(/never claim to have done something/i);
    }
  });

  it('every template has a summary and at least one limitation', () => {
    for (const template of AGENT_TEMPLATES) {
      expect(template.summary.length).toBeGreaterThan(10);
      expect(template.limitations.length).toBeGreaterThan(0);
    }
  });
});

describe('findTemplate', () => {
  it('finds a known template and returns undefined otherwise', () => {
    expect(findTemplate('research')?.name).toBe('Research assistant');
    expect(findTemplate('nope')).toBeUndefined();
  });
});
