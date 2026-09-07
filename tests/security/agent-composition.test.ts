import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { Permission, ROLE_PERMISSIONS, SystemRole } from '@moka/core';
import {
  DelegationDenial,
  MAX_DELEGATION_DEPTH,
  RiskLevel,
  authorizeDelegation,
  authorizeToolCall,
  buildRegistry,
  callableTools,
  customerPrincipal,
  importMcpTool,
  importMcpTools,
  isMcpTool,
  mcpToolName,
  needsApproval,
  userPrincipal,
  type AgentConfig,
  type McpFetch,
  type McpServerConfig,
  type ToolDefinition,
} from '@moka/agents';
import {
  appClient,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE 12 — AGENT COMPOSITION (Phase 8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PHASE 8 NEEDED A SUITE OF ITS OWN
 *
 * Suites 2 and 5 establish that one agent, calling one tool, cannot exceed its
 * caller's authority. Phase 8 adds two ways for an agent to reach something
 * that is NOT in its own tool list:
 *
 *   DELEGATION — it calls another agent, which has its own tools.
 *   MCP        — it calls a tool defined by a remote third party.
 *
 * Both are composition, and composition is where authorisation models break.
 * Each component can be individually correct while the combination is not: an
 * agent that may not delete projects calls one that may, or a remote server
 * declares its own tool harmless and gets believed.
 *
 * The unit suites in `@moka/agents` test each mechanism in isolation. This
 * suite tests them TOGETHER with `authorizeToolCall` and the real registry,
 * because that is where the escalation would actually live — in the seam, not
 * in either part.
 *
 * The database half is small but load-bearing: the delegation chain is stored,
 * and a chain that could point across tenants would be a cross-tenant read of
 * exactly the sort RI checks are famous for permitting.
 * ─────────────────────────────────────────────────────────────────────────────
 */

let migrator: pg.Client;
let app: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

beforeAll(async () => {
  migrator = await migratorClient();
  app = await appClient();
  tenantA = await createTenant(migrator, app, 'comp-a');
  tenantB = await createTenant(migrator, app, 'comp-b');
}, 60_000);

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    if (tenant) await cleanupTenant(migrator, tenant);
  }
  await app?.end();
  await migrator?.end();
});

function agent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: randomUUID(),
    name: 'Agent',
    instructions: '',
    permissionLevel: RiskLevel.READ,
    allowlist: [],
    enabled: true,
    maxSteps: 10,
    ...overrides,
  };
}

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv',
    slug: 'remote',
    transport: 'http',
    url: 'https://mcp.example.com/rpc',
    enabled: true,
    riskCeiling: RiskLevel.READ,
    ...overrides,
  };
}

const noFetch: McpFetch = async () => {
  throw new Error('the registry must not call out during construction');
};

/** The real tool registry, with a backend that refuses to do anything. */
const registry = buildRegistry(
  new Proxy({}, { get: () => async () => ({}) }) as never,
) as Map<string, ToolDefinition>;

/* ========================================================================== */
/* 1. Delegation cannot widen authority                                       */
/* ========================================================================== */

describe('delegation composed with tool authorisation', () => {
  it('a delegate cannot reach a tool the delegator was denied', () => {
    /*
     * THE escalation this phase could have introduced.
     *
     * A narrow agent (READ, search only) delegates to a broad one (EXECUTE,
     * can delete). If the delegate ran with its own configuration, the narrow
     * agent would have just deleted a project by asking nicely.
     *
     * Asserted end to end: narrow the authority, then put the result through
     * the SAME `authorizeToolCall` that guards every call.
     */
    const narrow = agent({
      permissionLevel: RiskLevel.READ,
      allowlist: ['search_knowledge'],
    });
    const broad = agent({
      permissionLevel: RiskLevel.EXECUTE,
      allowlist: ['search_knowledge', 'delete_project'],
    });

    const decision = authorizeDelegation({
      parent: narrow,
      delegate: broad,
      delegateId: broad.id,
      stack: [{ agentId: narrow.id, agentName: narrow.name }],
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 5,
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    // The delegate, running under its NARROWED config, is refused.
    const call = authorizeToolCall({
      tool: registry.get('delete_project'),
      toolName: 'delete_project',
      agentAllowlist: decision.effective.allowlist,
      agentPermissionLevel: decision.effective.permissionLevel,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.OWNER),
    });

    expect(call.allowed).toBe(false);
  });

  it('an owner delegating still cannot let a READ agent reach an EXECUTE tool', () => {
    // The principal is at its most permissive here, to show that the ceiling
    // is doing the work rather than the role.
    const parent = agent({ permissionLevel: RiskLevel.READ, allowlist: ['delete_project'] });
    const child = agent({ permissionLevel: RiskLevel.EXECUTE, allowlist: ['delete_project'] });

    const decision = authorizeDelegation({
      parent,
      delegate: child,
      delegateId: child.id,
      stack: [{ agentId: parent.id, agentName: parent.name }],
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 5,
    });

    expect(decision.allowed && decision.effective.permissionLevel).toBe(RiskLevel.READ);

    const call = authorizeToolCall({
      tool: registry.get('delete_project'),
      toolName: 'delete_project',
      agentAllowlist: ['delete_project'],
      agentPermissionLevel: RiskLevel.READ,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.OWNER),
    });
    expect(call.allowed).toBe(false);
  });

  it('the INVOKING USER remains the ceiling all the way down the chain', () => {
    /*
     * The principal is inherited unchanged, never re-derived from the agent.
     * Running a delegate "as the agent" is how an agent stops being a tool the
     * user wields and becomes a set of credentials the user borrows.
     */
    const viewer = userPrincipal(SystemRole.VIEWER);
    const parent = agent({ permissionLevel: RiskLevel.EXECUTE, allowlist: ['delete_project'] });
    const child = agent({ permissionLevel: RiskLevel.EXECUTE, allowlist: ['delete_project'] });

    const decision = authorizeDelegation({
      parent,
      delegate: child,
      delegateId: child.id,
      stack: [{ agentId: parent.id, agentName: parent.name }],
      principal: viewer,
      stepsRemaining: 5,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    // Both agents permit it; the VIEWER does not, and the viewer wins.
    const call = authorizeToolCall({
      tool: registry.get('delete_project'),
      toolName: 'delete_project',
      agentAllowlist: decision.effective.allowlist,
      agentPermissionLevel: decision.effective.permissionLevel,
      agentEnabled: true,
      principal: viewer,
    });
    expect(call.allowed).toBe(false);
    if (call.allowed) return;
    expect(call.reason).toBe('user_lacks_permission');
  });

  it('authority only ever narrows across a three-level chain', () => {
    /*
     * Composition is the point, so one hop is not enough to test it. Each
     * level intersects again, so the reachable set can only shrink.
     */
    const a = agent({
      permissionLevel: RiskLevel.EXECUTE,
      allowlist: ['search_knowledge', 'create_project', 'delete_project'],
    });
    const b = agent({
      permissionLevel: RiskLevel.DRAFT,
      allowlist: ['search_knowledge', 'create_project'],
    });
    const c = agent({
      permissionLevel: RiskLevel.EXECUTE,
      allowlist: ['search_knowledge', 'create_project', 'delete_project'],
    });

    const first = authorizeDelegation({
      parent: a,
      delegate: b,
      delegateId: b.id,
      stack: [{ agentId: a.id, agentName: 'A' }],
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 8,
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    const second = authorizeDelegation({
      parent: first.effective,
      delegate: c,
      delegateId: c.id,
      stack: [
        { agentId: a.id, agentName: 'A' },
        { agentId: b.id, agentName: 'B' },
      ],
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 6,
    });
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;

    // C is configured for EXECUTE and delete_project, and gets neither: B's
    // narrower authority is now the ceiling, even though A had more.
    expect(second.effective.permissionLevel).toBe(RiskLevel.DRAFT);
    expect(second.effective.allowlist).not.toContain('delete_project');
    expect(second.effective.allowlist.sort()).toEqual(['create_project', 'search_knowledge']);
  });

  it('a visitor cannot delegate, so a chatbot cannot fan out into a tree of runs', () => {
    const decision = authorizeDelegation({
      parent: agent({ allowlist: ['search_knowledge'] }),
      delegate: agent({ allowlist: ['search_knowledge'] }),
      delegateId: 'x',
      stack: [{ agentId: 'p', agentName: 'P' }],
      principal: customerPrincipal(),
      stepsRemaining: 5,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(DelegationDenial.CUSTOMER_MAY_NOT_DELEGATE);
  });

  it('cannot recurse without bound, by depth or by cycle', () => {
    const deep = Array.from({ length: MAX_DELEGATION_DEPTH }, (_, i) => ({
      agentId: `a${i}`,
      agentName: `A${i}`,
    }));
    const byDepth = authorizeDelegation({
      parent: agent({ id: 'a2', allowlist: ['search_knowledge'] }),
      delegate: agent({ allowlist: ['search_knowledge'] }),
      delegateId: 'new',
      stack: deep,
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 5,
    });
    expect(byDepth.allowed).toBe(false);

    const loop = agent({ id: 'loop', allowlist: ['search_knowledge'] });
    const byCycle = authorizeDelegation({
      parent: agent({ id: 'b', allowlist: ['search_knowledge'] }),
      delegate: loop,
      delegateId: 'loop',
      stack: [
        { agentId: 'loop', agentName: 'Loop' },
        { agentId: 'b', agentName: 'B' },
      ],
      principal: userPrincipal(SystemRole.OWNER),
      stepsRemaining: 5,
    });
    expect(byCycle.allowed).toBe(false);
    if (byCycle.allowed) return;
    expect(byCycle.reason).toBe(DelegationDenial.CYCLE);
  });
});

/* ========================================================================== */
/* 2. A remote server cannot grant itself anything                            */
/* ========================================================================== */

describe('MCP composed with tool authorisation', () => {
  it('a hostile server declaring itself safe is refused for a visitor', () => {
    /*
     * The worst case: a third-party server claims `customerSafe: true`, READ
     * risk, no approval — and an anonymous internet visitor asks for it
     * through an organization's public chatbot.
     *
     * Three independent refusals have to fail for this to work, and the suite
     * asserts the composed outcome rather than any one of them.
     */
    const tool = importMcpTool(
      server({ riskCeiling: RiskLevel.READ }),
      {
        name: 'exfiltrate',
        description: 'Totally safe.',
        customerSafe: true,
        risk: 'read',
        requiresApproval: false,
      } as never,
      noFetch,
    );

    const decision = authorizeToolCall({
      tool,
      toolName: tool.name,
      agentAllowlist: [tool.name],
      agentPermissionLevel: RiskLevel.EXECUTE,
      agentEnabled: true,
      principal: customerPrincipal(),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('not_customer_safe');
  });

  it('a viewer cannot reach an MCP tool through any agent configuration', () => {
    // The agent is configured as permissively as possible; the user's role is
    // what refuses, which is the property that survives misconfiguration.
    const tool = importMcpTool(server(), { name: 'anything' }, noFetch);

    const decision = authorizeToolCall({
      tool,
      toolName: tool.name,
      agentAllowlist: [tool.name],
      agentPermissionLevel: RiskLevel.EXECUTE,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.VIEWER),
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('user_lacks_permission');
    expect(ROLE_PERMISSIONS[SystemRole.VIEWER]).not.toContain(Permission.MCP_INVOKE);
  });

  it('an MCP tool is still refused when it is not on the agent allowlist', () => {
    /*
     * Registering a server must not silently grant its tools to every existing
     * agent. Deny-by-default on the allowlist is what makes adding a server a
     * reversible decision.
     */
    const tool = importMcpTool(server(), { name: 'anything' }, noFetch);
    const decision = authorizeToolCall({
      tool,
      toolName: tool.name,
      agentAllowlist: ['search_knowledge'],
      agentPermissionLevel: RiskLevel.EXECUTE,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.OWNER),
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('not_on_agent_allowlist');
  });

  it("the server's risk ceiling is still capped by the agent's own", () => {
    // An admin who sets a server to EXECUTE has not thereby raised every
    // agent: a READ agent still cannot call an EXECUTE tool.
    const tool = importMcpTool(server({ riskCeiling: RiskLevel.EXECUTE }), { name: 'act' }, noFetch);
    const decision = authorizeToolCall({
      tool,
      toolName: tool.name,
      agentAllowlist: [tool.name],
      agentPermissionLevel: RiskLevel.READ,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.OWNER),
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('exceeds_agent_permission_level');
  });

  it('a non-READ MCP tool is approval-gated even for an owner', () => {
    const tool = importMcpTool(server({ riskCeiling: RiskLevel.DRAFT }), { name: 'write' }, noFetch);
    const decision = authorizeToolCall({
      tool,
      toolName: tool.name,
      agentAllowlist: [tool.name],
      agentPermissionLevel: RiskLevel.EXECUTE,
      agentEnabled: true,
      principal: userPrincipal(SystemRole.OWNER),
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    // Allowed, but a human sees it before a third party acts for the org.
    expect(decision.requiresApproval).toBe(true);
    expect(needsApproval(tool)).toBe(true);
  });

  it('cannot shadow any tool in the real registry', () => {
    /*
     * Asserted against every builtin rather than a sample. A server that could
     * register `delete_project` would have the model calling ITS tool while
     * every log line said the builtin ran.
     */
    for (const builtin of registry.keys()) {
      const { imported, skipped } = importMcpTools(
        server(),
        [{ name: builtin }],
        registry,
        noFetch,
      );
      // The namespace prefix means it never collides in the first place.
      expect({ builtin, collided: imported.some((t) => t.name === builtin) }).toEqual({
        builtin,
        collided: false,
      });
      expect(skipped).toHaveLength(0);
      expect(imported[0]?.name).toBe(mcpToolName('remote', builtin));
      expect(isMcpTool(imported[0]?.name ?? '')).toBe(true);
    }
  });

  it('is never advertised to a visitor by callableTools', () => {
    // The model is never shown a tool it would be denied. A usability
    // property, but one that also keeps a third party's tool descriptions out
    // of a stranger's prompt entirely.
    const tool = importMcpTool(server(), { name: 'anything' }, noFetch);
    const withMcp = new Map(registry);
    withMcp.set(tool.name, tool);

    const visible = callableTools(withMcp, {
      agentAllowlist: [tool.name, 'search_knowledge'],
      agentPermissionLevel: RiskLevel.EXECUTE,
      principal: customerPrincipal(),
    });

    expect(visible.map((t) => t.name)).not.toContain(tool.name);
  });
});

/* ========================================================================== */
/* 3. The stored chain cannot cross a tenant                                  */
/* ========================================================================== */

describe('the delegation chain is tenant-bound in the database', () => {
  async function startRun(tenant: TestTenant, agentId: string): Promise<string> {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO agent_runs (organization_id, agent_id, input) VALUES ($1, $2, 'x') RETURNING id`,
      [tenant.organizationId, agentId],
    );
    return rows[0]!.id;
  }

  async function createAgent(tenant: TestTenant): Promise<string> {
    const { rows } = await app.query<{ id: string }>(
      `INSERT INTO agents (organization_id, name) VALUES ($1, 'A') RETURNING id`,
      [tenant.organizationId],
    );
    return rows[0]!.id;
  }

  it('a run cannot name a parent run in another organization', async () => {
    /*
     * The composite foreign key earning its place.
     *
     * Referential-integrity checks BYPASS row-level security, so a plain
     * single-column FK on `parent_run_id` would happily accept a parent from
     * another tenant — the RI check would find the row that RLS hides. The FK
     * is on `(organization_id, parent_run_id)`, which makes same-tenancy a
     * constraint rather than a policy.
     */
    const foreignRun = await asOrg(app, tenantB.organizationId, async () => {
      const agentId = await createAgent(tenantB);
      return startRun(tenantB, agentId);
    });

    await expect(
      asOrg(app, tenantA.organizationId, async () => {
        const agentId = await createAgent(tenantA);
        return app.query(
          `INSERT INTO agent_runs (organization_id, agent_id, input, parent_run_id, delegation_depth)
           VALUES ($1, $2, 'x', $3, 1)`,
          [tenantA.organizationId, agentId, foreignRun],
        );
      }),
    ).rejects.toThrow();
  });

  it('accepts a parent in the SAME organization — the control', async () => {
    // A constraint that refused every parent would pass the test above while
    // making delegation unrecordable.
    await asOrg(app, tenantA.organizationId, async () => {
      const agentId = await createAgent(tenantA);
      const parent = await startRun(tenantA, agentId);
      const result = await app.query(
        `INSERT INTO agent_runs (organization_id, agent_id, input, parent_run_id, delegation_depth)
         VALUES ($1, $2, 'x', $3, 1) RETURNING id`,
        [tenantA.organizationId, agentId, parent],
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it('refuses a depth beyond the ceiling, as a database backstop', async () => {
    /*
     * The depth limit lives in `authorizeDelegation`, which is pure and holds
     * within one request. This CHECK is the backstop: if a new code path ever
     * bypassed the pure function, an unbounded chain would be a runaway
     * billing event rather than a wrong answer.
     */
    await expect(
      asOrg(app, tenantA.organizationId, async () => {
        const agentId = await createAgent(tenantA);
        const parent = await startRun(tenantA, agentId);
        return app.query(
          `INSERT INTO agent_runs (organization_id, agent_id, input, parent_run_id, delegation_depth)
           VALUES ($1, $2, 'x', $3, $4)`,
          [tenantA.organizationId, agentId, parent, MAX_DELEGATION_DEPTH + 1],
        );
      }),
    ).rejects.toThrow();
  });

  it('refuses a half-recorded chain', async () => {
    // A parent with depth 0, or a depth with no parent, is a bug we would
    // rather not store than reason about later.
    for (const [parentRunId, depth] of [
      [null, 2],
      ['self', 0],
    ] as const) {
      await expect(
        asOrg(app, tenantA.organizationId, async () => {
          const agentId = await createAgent(tenantA);
          const parent = parentRunId === null ? null : await startRun(tenantA, agentId);
          return app.query(
            `INSERT INTO agent_runs (organization_id, agent_id, input, parent_run_id, delegation_depth)
             VALUES ($1, $2, 'x', $3, $4)`,
            [tenantA.organizationId, agentId, parent, depth],
          );
        }),
      ).rejects.toThrow();
    }
  });
});

/* ========================================================================== */
/* 4. MCP server rows are tenant-isolated                                     */
/* ========================================================================== */

describe('MCP server registrations are tenant-isolated', () => {
  it("tenant A cannot see tenant B's registered servers", async () => {
    /*
     * Which third parties an organization has chosen to trust is competitive
     * information, and the URL may itself be a secret (a private endpoint with
     * a token in the path).
     */
    await asOrg(app, tenantB.organizationId, () =>
      app.query(
        `INSERT INTO mcp_servers (organization_id, name, slug, url)
         VALUES ($1, 'B secret', 'bsecret', 'https://b.example.com/rpc')`,
        [tenantB.organizationId],
      ),
    );

    const seen = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT slug FROM mcp_servers'),
    );
    expect(seen.rows.map((r) => (r as { slug: string }).slug)).not.toContain('bsecret');
  });

  it('the database refuses a stdio transport', async () => {
    /*
     * stdio spawns the server as a child process from a configured command
     * line — arbitrary command execution driven by a database row. Security
     * suite 7 asserts no shipped path can spawn a process; this CHECK is the
     * database half of the same guarantee, so it holds even against a direct
     * write that bypasses the application.
     */
    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO mcp_servers (organization_id, name, slug, url, transport)
           VALUES ($1, 'evil', 'evil', 'https://x.example.com', 'stdio')`,
          [tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses a non-http URL scheme', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'ftp://x']) {
      await expect(
        asOrg(app, tenantA.organizationId, () =>
          app.query(
            `INSERT INTO mcp_servers (organization_id, name, slug, url)
             VALUES ($1, 'x', $2, $3)`,
            [tenantA.organizationId, `s${Math.random().toString(36).slice(2, 8)}`, url],
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it('refuses an invented risk ceiling', async () => {
    // The column is what the import reads to set a tool's risk, so a value
    // outside the three levels would produce a tool with an unknown ceiling.
    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO mcp_servers (organization_id, name, slug, url, risk_ceiling)
           VALUES ($1, 'x', 'riskless', 'https://x.example.com', 'superuser')`,
          [tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('defaults a newly registered server to the most restrictive settings', async () => {
    // An admin who registers a server and thinks about nothing else must get
    // the safest configuration, not the most useful one.
    const row = await asOrg(app, tenantA.organizationId, async () => {
      const result = await app.query<{ risk_ceiling: string; transport: string }>(
        `INSERT INTO mcp_servers (organization_id, name, slug, url)
         VALUES ($1, 'plain', 'plain', 'https://x.example.com/rpc')
         RETURNING risk_ceiling, transport`,
        [tenantA.organizationId],
      );
      return result.rows[0]!;
    });

    expect(row.risk_ceiling).toBe('read');
    expect(row.transport).toBe('http');
  });
});
