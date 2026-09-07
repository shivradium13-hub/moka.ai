import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { NotFoundError, ValidationError, type TenantContext } from '@moka/core';
import { Database, schema } from '@moka/db';
import { SsrfBlockedError, safeFetch } from '@moka/net';
import {
  McpError,
  McpTransport,
  RiskLevel,
  importMcpTools,
  listRemoteTools,
  type McpFetch,
  type McpServerConfig,
  type ToolDefinition,
} from '@moka/agents';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';

const { mcpServers } = schema;

/**
 * MCP server registry and transport (Phase 8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS SERVICE EXISTS TO BE THE ONLY PLACE MCP TALKS TO THE NETWORK
 *
 * `@moka/agents/mcp` is deliberately pure — it takes an `McpFetch` and has no
 * idea what the network is. This service is where that function comes from,
 * and the function it supplies is `safeFetch`.
 *
 * That matters because an MCP server URL is operator-supplied configuration,
 * which makes it an SSRF surface indistinguishable from a crawl seed. An
 * operator who can write an `mcp_servers` row — or anyone who can trick one
 * into it — would otherwise be choosing an address for this server to make
 * authenticated-looking requests to. `http://169.254.169.254/` is a valid URL.
 *
 * `safeFetch` resolves DNS and checks the address it is ACTUALLY connecting to,
 * re-validating on every redirect hop, so a server that resolves to a private
 * address is refused at connect time rather than at validation time. There is
 * no rebinding window to race.
 *
 * NOTE: no `configuredInternalHosts` exception is passed. `SEARXNG_URL` gets
 * one because a self-hosted search instance genuinely lives on a private
 * network and the exception derives from a single config value an operator set
 * deliberately. MCP servers are a LIST that grows, and an escape hatch on a
 * growing list is not an exception — it is a policy. A self-hosted MCP server
 * on a private network is a real use case; it is not supported today, and it
 * is refused with a reason rather than quietly enabled.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class McpService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * The one function permitted to reach an MCP server.
   *
   * Timeouts and size caps are deliberately tighter than the crawler's: an MCP
   * call sits inside an agent step, which sits inside a request, and a server
   * that hangs would hold a connection and a model context open. A slow tool
   * is a failed tool.
   */
  private fetcher(): McpFetch {
    return async (url, init) => {
      const response = await safeFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        timeoutMs: 15_000,
        maxBytes: 1_048_576, // 1 MiB. A tool result larger than this is not a result.
        /*
         * Redirects disabled entirely. A JSON-RPC endpoint has no legitimate
         * reason to redirect, and following one means re-POSTing the request
         * body — including any credential — to wherever the first host pointed.
         * safeFetch would re-validate the destination, but the body would still
         * have moved.
         */
        maxRedirects: 0,
      });

      return { status: response.status, text: () => response.text() };
    };
  }

  private toConfig(row: typeof mcpServers.$inferSelect): McpServerConfig {
    return {
      id: row.id,
      slug: row.slug,
      transport: row.transport as McpTransport,
      url: row.url,
      enabled: row.enabled,
      /*
       * Read from the OPERATOR's column, never from anything a server sent.
       * The cast is safe because a CHECK constraint restricts the column to
       * the three risk levels.
       */
      riskCeiling: row.riskCeiling as RiskLevel,
    };
  }

  async list(context: TenantContext): Promise<Array<typeof mcpServers.$inferSelect>> {
    return this.db.withTenant(context, (tx) => tx.select().from(mcpServers));
  }

  async get(context: TenantContext, id: string): Promise<typeof mcpServers.$inferSelect> {
    const [row] = await this.db.withTenant(context, (tx) =>
      tx.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1),
    );
    // Under RLS a row in another tenant simply is not there, so "not found" and
    // "not yours" are the same answer — which is the answer we want to give.
    if (!row) throw new NotFoundError('MCP server', id);
    return row;
  }

  async create(
    context: TenantContext,
    input: { name: string; slug: string; url: string; riskCeiling?: string },
  ): Promise<typeof mcpServers.$inferSelect> {
    /*
     * Reachability is NOT verified here, and that is deliberate.
     *
     * Fetching a URL at registration time would make this endpoint a
     * request-forgery primitive with a nicer name: "register a server" would
     * become "make my server fetch this address and tell me what happened".
     * safeFetch would block private addresses, but timing and error shape
     * still leak. Discovery is a separate, explicit action.
     */
    const [row] = await this.db.withTenant(context, (tx) =>
      tx
        .insert(mcpServers)
        .values({
          organizationId: context.organizationId,
          name: input.name,
          slug: input.slug,
          url: input.url,
          transport: McpTransport.HTTP,
          riskCeiling: input.riskCeiling ?? RiskLevel.READ,
          createdBy: context.userId,
        })
        .returning(),
    );

    if (!row) throw new ValidationError(undefined, 'The MCP server insert returned no row.');

    await this.audit.record(context, {
      action: 'mcp.server.register',
      resourceType: 'mcp_server',
      resourceId: row.id,
      // The URL is recorded: which third party an organization pointed itself
      // at is exactly the sort of thing an auditor needs afterwards.
      after: { slug: row.slug, url: row.url, riskCeiling: row.riskCeiling },
      outcome: 'success',
    });

    return row;
  }

  async setEnabled(
    context: TenantContext,
    id: string,
    enabled: boolean,
  ): Promise<typeof mcpServers.$inferSelect> {
    await this.get(context, id);
    const [row] = await this.db.withTenant(context, (tx) =>
      tx
        .update(mcpServers)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning(),
    );
    if (!row) throw new NotFoundError('MCP server', id);

    await this.audit.record(context, {
      action: enabled ? 'mcp.server.enable' : 'mcp.server.disable',
      resourceType: 'mcp_server',
      resourceId: id,
      outcome: 'success',
    });
    return row;
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    await this.get(context, id);
    await this.db.withTenant(context, (tx) => tx.delete(mcpServers).where(eq(mcpServers.id, id)));
    await this.audit.record(context, {
      action: 'mcp.server.remove',
      resourceType: 'mcp_server',
      resourceId: id,
      outcome: 'success',
    });
  }

  /**
   * Ask a server what it offers.
   *
   * Explicit rather than automatic. Discovery makes an outbound request to a
   * third party, so it is an action a person takes and an auditor can see, not
   * a side effect of listing a page.
   */
  async discover(
    context: TenantContext,
    id: string,
  ): Promise<{ tools: Array<{ name: string; description: string }>; error?: string }> {
    const server = this.toConfig(await this.get(context, id));

    try {
      const descriptors = await listRemoteTools(this.fetcher(), server);
      const { imported } = importMcpTools(server, descriptors, new Map(), this.fetcher());

      await this.audit.record(context, {
        action: 'mcp.server.discover',
        resourceType: 'mcp_server',
        resourceId: id,
        after: { toolCount: imported.length },
        outcome: 'success',
      });

      return {
        tools: imported.map((tool) => ({ name: tool.name, description: tool.description })),
      };
    } catch (error) {
      /*
       * An SSRF refusal must NOT be flattened into "the server is unreachable".
       *
       * The same lesson as the research pipeline in Phase 7: an operator who
       * is told their server is down goes looking for a network problem, when
       * what actually happened is that this system refused to connect to a
       * private address on purpose. Telling them which it was is the
       * difference between a five-minute fix and an afternoon.
       */
      if (error instanceof SsrfBlockedError) {
        return {
          tools: [],
          error:
            'That address is not one we are permitted to fetch. MCP servers must be ' +
            'reachable on a public address; private and loopback addresses are refused.',
        };
      }
      if (error instanceof McpError) {
        return { tools: [], error: error.message };
      }
      throw error;
    }
  }

  /**
   * Every tool available from this organization's enabled MCP servers.
   *
   * Built fresh per run rather than cached. A cached tool set is a snapshot of
   * a third party's self-description, and the moment an operator disables a
   * server the cached tools must stop existing — not at the next eviction.
   */
  async toolsFor(context: TenantContext): Promise<Map<string, ToolDefinition>> {
    const rows = await this.list(context);
    const tools = new Map<string, ToolDefinition>();
    const fetcher = this.fetcher();

    for (const row of rows) {
      if (!row.enabled) continue;
      const server = this.toConfig(row);

      let descriptors;
      try {
        descriptors = await listRemoteTools(fetcher, server);
      } catch {
        /*
         * A server that is down or misbehaving contributes no tools, and the
         * run continues without them.
         *
         * The alternative — failing the whole run — would let any registered
         * third party take an organization's agents offline by going down,
         * which hands a remote party a denial-of-service switch. The agent
         * simply has fewer tools, which it is built to handle: `callableTools`
         * already advertises only what exists.
         */
        continue;
      }

      const { imported } = importMcpTools(server, descriptors, tools, fetcher);
      for (const tool of imported) tools.set(tool.name, tool);
    }

    return tools;
  }
}
