import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  appClient,
  asNoOrg,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';
import {
  authorizeToolCall,
  customerPrincipal,
  userPrincipal,
  DenialReason,
  RiskLevel,
  buildRegistry,
  type ToolBackend,
  type ToolDefinition,
} from '@moka/agents';
import { SystemRole } from '@moka/core';
import {
  generateDeploymentKey,
  generateVisitorToken,
  hashVisitorToken,
  isDeploymentKeyFormat,
} from '@moka/chat';

/**
 * SECURITY SUITE 8 — THE CUSTOMER BOUNDARY.
 *
 * Phases 1–5 had exactly one kind of principal: an authenticated member of an
 * organization. Phase 6 introduces a second one that is structurally different
 * — an anonymous member of the public, standing on somebody else's website —
 * and this suite exists to hold the line between them.
 *
 * THE CLAIM UNDER TEST
 *   A chatbot visitor can reach exactly one conversation, in exactly one
 *   organization, and can read exactly the knowledge that organization
 *   deliberately published. They hold no role, so there is nothing for them to
 *   escalate FROM.
 *
 * These run against a real PostgreSQL database as the runtime role `moka_app`,
 * so RLS is genuinely in force. Testing as the owner would prove nothing.
 */

let migrator: pg.Client;
let app: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

interface Fixture {
  chatbotId: string;
  deploymentId: string;
  publicKey: string;
  sourceId: string;
  documentId: string;
  chunkId: string;
  conversationId: string;
  visitorToken: string;
}

const fixtures = new Map<string, Fixture>();

/** Bind only the deployment key, exactly as Database.withDeploymentKey does. */
async function asDeploymentKey<T>(
  client: pg.Client,
  publicKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_deployment_key', $1, true)", [publicKey]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedChatbot(tenant: TestTenant, label: string): Promise<Fixture> {
  const publicKey = generateDeploymentKey();
  const visitorToken = generateVisitorToken();

  return asOrg(app, tenant.organizationId, async () => {
    const bot = await app.query<{ id: string }>(
      `INSERT INTO chatbots (organization_id, name, status, instructions)
       VALUES ($1, $2, 'active', $3) RETURNING id`,
      [tenant.organizationId, `Bot ${label}`, `Assistant for ${label}`],
    );
    const chatbotId = bot.rows[0]!.id;

    // Two sources: one PUBLISHED to the chatbot, one deliberately not.
    const published = await app.query<{ id: string }>(
      `INSERT INTO knowledge_sources (organization_id, type, name, status)
       VALUES ($1, 'UPLOAD', $2, 'READY') RETURNING id`,
      [tenant.organizationId, `Public help ${label}`],
    );
    const secret = await app.query<{ id: string }>(
      `INSERT INTO knowledge_sources (organization_id, type, name, status)
       VALUES ($1, 'UPLOAD', $2, 'READY') RETURNING id`,
      [tenant.organizationId, `Internal salaries ${label}`],
    );
    const sourceId = published.rows[0]!.id;
    const secretSourceId = secret.rows[0]!.id;

    for (const [source, title, body] of [
      [sourceId, `Refund policy ${label}`, `Refunds within thirty days for tenant ${label}.`],
      [secretSourceId, `Salary bands ${label}`, `Engineering salary bands for tenant ${label}.`],
    ] as const) {
      const document = await app.query<{ id: string }>(
        `INSERT INTO knowledge_documents
           (organization_id, source_id, title, status, mime_type, checksum)
         VALUES ($1, $2, $3, 'READY', 'text/plain', $4) RETURNING id`,
        [tenant.organizationId, source, title, randomUUID()],
      );
      await app.query(
        `INSERT INTO knowledge_chunks
           (organization_id, document_id, source_id, chunk_index, content, token_count)
         VALUES ($1, $2, $3, 0, $4, 20)`,
        [tenant.organizationId, document.rows[0]!.id, source, body],
      );
    }

    const firstDocument = await app.query<{ id: string; chunk: string }>(
      `SELECT d.id, c.id AS chunk FROM knowledge_documents d
         JOIN knowledge_chunks c ON c.document_id = d.id
        WHERE d.source_id = $1 LIMIT 1`,
      [sourceId],
    );

    await app.query(
      `INSERT INTO chatbot_sources (organization_id, chatbot_id, source_id) VALUES ($1, $2, $3)`,
      [tenant.organizationId, chatbotId, sourceId],
    );

    const deployment = await app.query<{ id: string }>(
      `INSERT INTO chatbot_deployments (organization_id, chatbot_id, name, public_key, allowed_origins)
       VALUES ($1, $2, 'Site', $3, $4) RETURNING id`,
      [tenant.organizationId, chatbotId, publicKey, [`https://${label}.example.com`]],
    );
    const deploymentId = deployment.rows[0]!.id;

    const conversation = await app.query<{ id: string }>(
      `INSERT INTO chat_conversations
         (organization_id, chatbot_id, deployment_id, visitor_token_hash, origin, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day') RETURNING id`,
      [
        tenant.organizationId,
        chatbotId,
        deploymentId,
        hashVisitorToken(visitorToken),
        `https://${label}.example.com`,
      ],
    );
    const conversationId = conversation.rows[0]!.id;

    await app.query(
      `INSERT INTO chat_messages (organization_id, conversation_id, role, content)
       VALUES ($1, $2, 'visitor', $3)`,
      [tenant.organizationId, conversationId, `Private question from tenant ${label}`],
    );

    return {
      chatbotId,
      deploymentId,
      publicKey,
      sourceId,
      documentId: firstDocument.rows[0]!.id,
      chunkId: firstDocument.rows[0]!.chunk,
      conversationId,
      visitorToken,
    };
  });
}

beforeAll(async () => {
  migrator = await migratorClient();
  app = await appClient();
  tenantA = await createTenant(migrator, app, 'cust-a');
  tenantB = await createTenant(migrator, app, 'cust-b');
  fixtures.set('A', await seedChatbot(tenantA, 'A'));
  fixtures.set('B', await seedChatbot(tenantB, 'B'));
}, 60_000);

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await migrator.query('BEGIN');
    try {
      await migrator.query("SELECT set_config('app.current_org_id', $1, true)", [
        tenant.organizationId,
      ]);
      for (const table of [
        'chat_messages',
        'chat_conversations',
        'chatbot_deployments',
        'chatbot_sources',
        'chatbots',
        'knowledge_chunks',
        'knowledge_documents',
        'knowledge_sources',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE organization_id = $1`, [
          tenant.organizationId,
        ]);
      }
      await migrator.query('COMMIT');
    } catch {
      await migrator.query('ROLLBACK');
    }
    await cleanupTenant(migrator, tenant);
  }
  await app.end();
  await migrator.end();
});

/* ========================================================================== */
/* 1. The public key resolves ONE deployment and nothing more                 */
/* ========================================================================== */

describe('resolving a deployment from a public key', () => {
  it('sees nothing at all with no key and no organization bound', async () => {
    // The baseline that makes every other test in this file meaningful: the
    // table is invisible by default, and the policy is what opens one row.
    const rows = await asNoOrg(app, () =>
      app.query('SELECT id FROM chatbot_deployments'),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('makes exactly one deployment visible when a key is bound', async () => {
    const fixture = fixtures.get('A')!;
    const rows = await asDeploymentKey(app, fixture.publicKey, () =>
      app.query<{ id: string; organization_id: string }>(
        'SELECT id, organization_id FROM chatbot_deployments',
      ),
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.id).toBe(fixture.deploymentId);
    expect(rows.rows[0]!.organization_id).toBe(tenantA.organizationId);
  });

  it('a key does NOT open any other table', async () => {
    /*
     * The policy grants a single narrow read on one table. If binding a key
     * also made projects, members or knowledge visible, the public surface
     * would be a hole through the whole isolation model.
     */
    const fixture = fixtures.get('A')!;
    await asDeploymentKey(app, fixture.publicKey, async () => {
      for (const table of [
        'projects',
        'organization_members',
        'knowledge_chunks',
        'chat_conversations',
        'chat_messages',
        'credentials',
        'chatbots',
      ]) {
        const rows = await app.query(`SELECT count(*)::int AS c FROM ${table}`);
        expect({ table, count: rows.rows[0].c }).toEqual({ table, count: 0 });
      }
    });
  });

  it('an unknown key resolves nothing', async () => {
    const rows = await asDeploymentKey(app, generateDeploymentKey(), () =>
      app.query('SELECT id FROM chatbot_deployments'),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('a revoked key stops resolving immediately', async () => {
    // Revocation must be effective, not eventual: no cache to wait out and
    // nothing to expire.
    const fixture = fixtures.get('B')!;
    await asOrg(app, tenantB.organizationId, () =>
      app.query(
        `UPDATE chatbot_deployments SET status='revoked', revoked_at=now() WHERE id=$1`,
        [fixture.deploymentId],
      ),
    );

    const rows = await asDeploymentKey(app, fixture.publicKey, () =>
      app.query('SELECT id FROM chatbot_deployments'),
    );
    expect(rows.rowCount).toBe(0);

    await asOrg(app, tenantB.organizationId, () =>
      app.query(
        `UPDATE chatbot_deployments SET status='active', revoked_at=NULL WHERE id=$1`,
        [fixture.deploymentId],
      ),
    );
  });

  it('THE GUARD: binding an organization suppresses the public branch entirely', async () => {
    /*
     * The property that keeps this policy from widening every tenant query.
     * Tenant B binds their own organization AND presents tenant A's key. The
     * `current_org_id() IS NULL` guard must make the public branch
     * unreachable, so B sees only B's own deployments.
     *
     * Without that guard, any tenant-scoped request could smuggle a foreign
     * key into a session variable and read another tenant's row.
     */
    const foreignKey = fixtures.get('A')!.publicKey;

    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_org_id', $1, true)", [
      tenantB.organizationId,
    ]);
    await app.query("SELECT set_config('app.current_deployment_key', $1, true)", [foreignKey]);
    const rows = await app.query<{ organization_id: string }>(
      'SELECT organization_id FROM chatbot_deployments',
    );
    await app.query('COMMIT');

    expect(rows.rowCount).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.organization_id === tenantB.organizationId)).toBe(true);
  });

  it('the public path cannot write anything, even to the row it can read', async () => {
    const fixture = fixtures.get('A')!;
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.current_deployment_key', $1, true)", [
      fixture.publicKey,
    ]);

    await expect(
      app.query(`UPDATE chatbot_deployments SET allowed_origins = '{https://evil.test}'`),
    ).rejects.toThrow();

    await app.query('ROLLBACK');
  });
});

/* ========================================================================== */
/* 2. A visitor token reaches one conversation, in one tenant                 */
/* ========================================================================== */

describe('visitor tokens', () => {
  it('finds its own conversation inside its own organization', async () => {
    const fixture = fixtures.get('A')!;
    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ id: string }>(
        'SELECT id FROM chat_conversations WHERE visitor_token_hash = $1',
        [hashVisitorToken(fixture.visitorToken)],
      ),
    );
    expect(rows.rows[0]?.id).toBe(fixture.conversationId);
  });

  it("CROSS-TENANT: tenant A's key with tenant B's token finds nothing", async () => {
    /*
     * The exact attack the resolution ORDER defends against. An attacker holds
     * a public key from a site they can see (it is in the page source) and a
     * visitor token stolen from somewhere else. Because the conversation
     * lookup is scoped to the organization the KEY resolved to, the foreign
     * token is not found — rather than found and then checked.
     */
    const keyOwner = fixtures.get('A')!;
    const foreignToken = fixtures.get('B')!.visitorToken;

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT id FROM chat_conversations WHERE visitor_token_hash = $1', [
        hashVisitorToken(foreignToken),
      ]),
    );

    expect(rows.rowCount).toBe(0);
    expect(keyOwner.visitorToken).not.toBe(foreignToken);
  });

  it('tenant A cannot read tenant B messages even knowing the conversation id', async () => {
    const foreign = fixtures.get('B')!;
    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT content FROM chat_messages WHERE conversation_id = $1', [
        foreign.conversationId,
      ]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('tenant A cannot write a message into tenant B conversation', async () => {
    const foreign = fixtures.get('B')!;
    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO chat_messages (organization_id, conversation_id, role, content)
           VALUES ($1, $2, 'visitor', 'injected')`,
          [tenantB.organizationId, foreign.conversationId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('a token is stored hashed and never in the clear', async () => {
    const fixture = fixtures.get('A')!;
    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ visitor_token_hash: string }>(
        'SELECT visitor_token_hash FROM chat_conversations WHERE id = $1',
        [fixture.conversationId],
      ),
    );
    expect(rows.rows[0]!.visitor_token_hash).not.toContain(fixture.visitorToken);
    expect(rows.rows[0]!.visitor_token_hash).toBe(hashVisitorToken(fixture.visitorToken));
  });

  it('a public key is NOT a visitor token and vice versa', async () => {
    const fixture = fixtures.get('A')!;
    expect(isDeploymentKeyFormat(fixture.visitorToken)).toBe(false);
    expect(isDeploymentKeyFormat(fixture.publicKey)).toBe(true);
  });
});

/* ========================================================================== */
/* 3. The publication boundary                                                */
/* ========================================================================== */

describe('published knowledge', () => {
  it('a chatbot is attached only to the sources someone published', async () => {
    const fixture = fixtures.get('A')!;
    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ source_id: string }>(
        'SELECT source_id FROM chatbot_sources WHERE chatbot_id = $1',
        [fixture.chatbotId],
      ),
    );
    expect(rows.rows.map((row) => row.source_id)).toEqual([fixture.sourceId]);
  });

  it('the unpublished source exists and is NOT reachable through the chatbot', async () => {
    /*
     * The organization has an internal document about salary bands. It is in
     * the same knowledge base, in the same tenant, fully retrievable by staff.
     * It must not be reachable by a chatbot that was never given it.
     */
    const fixture = fixtures.get('A')!;

    const all = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM knowledge_chunks WHERE content ILIKE '%salary%'`,
      ),
    );
    expect(all.rows[0]!.c).toBeGreaterThan(0);

    // The same query, restricted the way the public path restricts it.
    const viaChatbot = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM knowledge_chunks c
          WHERE c.content ILIKE '%salary%'
            AND c.source_id IN (SELECT source_id FROM chatbot_sources WHERE chatbot_id = $1)`,
        [fixture.chatbotId],
      ),
    );
    expect(viaChatbot.rows[0]!.c).toBe(0);
  });

  it('a chatbot cannot be attached to another tenant knowledge source', async () => {
    const mine = fixtures.get('A')!;
    const theirs = fixtures.get('B')!;

    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO chatbot_sources (organization_id, chatbot_id, source_id) VALUES ($1, $2, $3)`,
          [tenantA.organizationId, mine.chatbotId, theirs.sourceId],
        ),
      ),
    ).rejects.toThrow();
  });

  it("a chatbot with no published sources retrieves nothing at all", async () => {
    // Fails CLOSED. The dangerous alternative would be treating an empty
    // allowlist as "no restriction", which is what an unguarded IN () does.
    const emptyBot = await asOrg(app, tenantA.organizationId, async () => {
      const created = await app.query<{ id: string }>(
        `INSERT INTO chatbots (organization_id, name, status) VALUES ($1, 'Empty', 'active')
         RETURNING id`,
        [tenantA.organizationId],
      );
      return created.rows[0]!.id;
    });

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int AS c
           FROM knowledge_chunks c
          WHERE c.source_id IN (SELECT source_id FROM chatbot_sources WHERE chatbot_id = $1)`,
        [emptyBot],
      ),
    );
    expect(rows.rows[0]!.c).toBe(0);

    await asOrg(app, tenantA.organizationId, () =>
      app.query('DELETE FROM chatbots WHERE id = $1', [emptyBot]),
    );
  });
});

/* ========================================================================== */
/* 4. The principal itself: a visitor holds no authority                      */
/* ========================================================================== */

describe('the customer principal against the real staff tool registry', () => {
  /*
   * Not a hand-made fixture: the ACTUAL registry the platform ships, wired to
   * a backend that records what it was asked to do. If any staff tool ever
   * became reachable by a visitor, this fails.
   */
  const calls: string[] = [];
  const backend: ToolBackend = {
    listProjects: async () => {
      calls.push('listProjects');
      return [];
    },
    getProject: async () => {
      calls.push('getProject');
      return null;
    },
    createProject: async () => {
      calls.push('createProject');
      return { id: 'x', name: 'x', slug: 'x' };
    },
    deleteProject: async () => {
      calls.push('deleteProject');
      return { deleted: true };
    },
    searchKnowledge: async () => {
      calls.push('searchKnowledge');
      return [];
    },
    listKnowledgeSources: async () => {
      calls.push('listKnowledgeSources');
      return [];
    },
  };

  const registry: ReadonlyMap<string, ToolDefinition> = buildRegistry(backend);

  it('refuses EVERY shipped staff tool for a customer', () => {
    // Including read-only ones. `list_projects` is harmless to a colleague and
    // is a directory of the organization's work to a stranger.
    for (const [name, tool] of registry) {
      const decision = authorizeToolCall({
        tool,
        toolName: name,
        // Deliberately maximally permissive everywhere else, so the ONLY
        // thing refusing the call is the principal.
        agentAllowlist: [...registry.keys()],
        agentPermissionLevel: RiskLevel.EXECUTE,
        agentEnabled: true,
        principal: customerPrincipal(),
      });

      expect({ name, allowed: decision.allowed }).toEqual({ name, allowed: false });
      if (!decision.allowed) {
        expect(decision.reason).toBe(DenialReason.NOT_CUSTOMER_SAFE);
      }
    }

    // And nothing was executed along the way.
    expect(calls).toEqual([]);
  });

  it('an owner IS permitted the same tools, so the refusal is about the principal', () => {
    /*
     * The control. Without this, the test above would also pass if the
     * registry were simply broken.
     */
    const permitted = [...registry.entries()].filter(
      ([name, tool]) =>
        authorizeToolCall({
          tool,
          toolName: name,
          agentAllowlist: [...registry.keys()],
          agentPermissionLevel: RiskLevel.EXECUTE,
          agentEnabled: true,
          principal: userPrincipal(SystemRole.OWNER),
        }).allowed,
    );

    expect(permitted.length).toBe(registry.size);
  });

  it('a VIEWER outranks a visitor: absence of a role is not a low role', () => {
    // The regression this whole design turns on. Modelling a visitor as
    // `role: viewer` would make these two identical.
    const readTool = registry.get('list_projects')!;
    const shared = {
      tool: readTool,
      toolName: 'list_projects',
      agentAllowlist: ['list_projects'],
      agentPermissionLevel: RiskLevel.READ,
      agentEnabled: true,
    };

    expect(authorizeToolCall({ ...shared, principal: userPrincipal(SystemRole.VIEWER) }).allowed).toBe(
      true,
    );
    expect(authorizeToolCall({ ...shared, principal: customerPrincipal() }).allowed).toBe(false);
  });

  it('no shipped staff tool is marked customerSafe', () => {
    /*
     * A belt-and-braces check on the registry itself rather than on the
     * authoriser. If someone later adds `customerSafe: true` to a staff tool,
     * this fails in review rather than in production.
     */
    for (const [name, tool] of registry) {
      expect({ name, customerSafe: tool.customerSafe === true }).toEqual({
        name,
        customerSafe: false,
      });
    }
  });
});

/* ========================================================================== */
/* 5. Audit and evidence                                                      */
/* ========================================================================== */

describe('the public path leaves a trail', () => {
  it('accepts a customer-actor audit row', async () => {
    // 0008 widened the constraint precisely so the one surface reachable by
    // strangers is not the one without an audit trail.
    const fixture = fixtures.get('A')!;
    await asOrg(app, tenantA.organizationId, () =>
      app.query(
        `INSERT INTO audit_logs (organization_id, actor_type, actor_id, action, resource_type, resource_id, outcome)
         VALUES ($1, 'customer', NULL, 'chat.conversation.open', 'chat_conversation', $2, 'success')`,
        [tenantA.organizationId, fixture.conversationId],
      ),
    );

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM audit_logs WHERE actor_type = 'customer'`,
      ),
    );
    expect(rows.rows[0]!.c).toBeGreaterThan(0);
  });

  it('a tool execution can be attributed to a conversation', async () => {
    const fixture = fixtures.get('A')!;
    await asOrg(app, tenantA.organizationId, () =>
      app.query(
        `INSERT INTO tool_executions
           (organization_id, run_id, conversation_id, tool_name, outcome, denial_reason)
         VALUES ($1, NULL, $2, 'delete_project', 'denied', 'not_customer_safe')`,
        [tenantA.organizationId, fixture.conversationId],
      ),
    );

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM tool_executions WHERE conversation_id = $1`,
        [fixture.conversationId],
      ),
    );
    expect(rows.rows[0]!.c).toBe(1);
  });

  it('a transcript cannot be rewritten, only erased', async () => {
    /*
     * Two different properties. UPDATE is refused, so what was said to a
     * member of the public in the organization's name cannot be quietly
     * altered. DELETE is permitted, because retention has to be able to
     * destroy a stranger's data.
     */
    const fixture = fixtures.get('A')!;

    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(`UPDATE chat_messages SET content = 'rewritten' WHERE conversation_id = $1`, [
          fixture.conversationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);

    const still = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ content: string }>(
        `SELECT content FROM chat_messages WHERE conversation_id = $1 AND role = 'visitor'`,
        [fixture.conversationId],
      ),
    );
    expect(still.rows[0]!.content).toContain('Private question from tenant A');
  });

  it('retention deletion removes a conversation and its messages together', async () => {
    const scratch = await asOrg(app, tenantA.organizationId, async () => {
      const fixture = fixtures.get('A')!;
      const conversation = await app.query<{ id: string }>(
        `INSERT INTO chat_conversations
           (organization_id, chatbot_id, deployment_id, visitor_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING id`,
        [
          tenantA.organizationId,
          fixture.chatbotId,
          fixture.deploymentId,
          hashVisitorToken(generateVisitorToken()),
        ],
      );
      const id = conversation.rows[0]!.id;
      await app.query(
        `INSERT INTO chat_messages (organization_id, conversation_id, role, content)
         VALUES ($1, $2, 'visitor', 'to be erased')`,
        [tenantA.organizationId, id],
      );
      return id;
    });

    await asOrg(app, tenantA.organizationId, () =>
      app.query('DELETE FROM chat_conversations WHERE id = $1', [scratch]),
    );

    const remaining = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM chat_messages WHERE conversation_id = $1',
        [scratch],
      ),
    );
    // The cascade is what makes the retention endpoint actually erase data
    // rather than orphan it.
    expect(remaining.rows[0]!.c).toBe(0);
  });
});
