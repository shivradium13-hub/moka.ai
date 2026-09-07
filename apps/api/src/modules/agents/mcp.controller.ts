import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { RiskLevel } from '@moka/agents';
import { McpService } from './mcp.service.js';
import { CurrentTenant, RequirePermission } from '../../common/decorators.js';

/**
 * MCP server administration (Phase 8).
 *
 * Every route here is gated on `ORG_UPDATE` — an ADMIN capability — rather
 * than on the `MCP_INVOKE` that members hold. Two different questions:
 *
 *   "may I USE a registered server?"      → mcp:invoke, members and above
 *   "may I DECIDE which third parties     → organization:update, admins only
 *    this organization talks to?"
 *
 * Registering an MCP server points an organization's agents at a remote party
 * that gets to put text in front of a model holding this organization's
 * authority, and can raise its own tools' ceiling as far as an operator lets
 * it. That is an administrative decision about who to trust, not a working
 * capability, and collapsing the two would let any member add a server.
 */

const idSchema = z.string().uuid();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  /*
   * Constrained to match the database CHECK. The slug becomes part of every
   * imported tool name (`mcp__<slug>__<tool>`), which a model must reproduce
   * verbatim, so it has to be a plain identifier rather than free text.
   */
  slug: z
    .string()
    .min(1)
    .max(31)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters, digits, dashes or underscores'),
  url: z
    .string()
    .url()
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
      message: 'must be an http:// or https:// URL',
    }),
  /*
   * Optional, and its absence means READ — the most restrictive setting.
   *
   * An admin who registers a server and thinks about nothing else gets the
   * safest configuration rather than the most useful one. Raising it is a
   * deliberate act with an audit record.
   */
  riskCeiling: z.enum([RiskLevel.READ, RiskLevel.DRAFT, RiskLevel.EXECUTE]).optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/mcp/servers')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get()
  @RequirePermission(Permission.ORG_READ)
  async list(@CurrentTenant() tenant: TenantContext) {
    const rows = await this.mcp.list(tenant);
    return {
      servers: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        url: row.url,
        transport: row.transport,
        riskCeiling: row.riskCeiling,
        enabled: row.enabled,
        createdAt: row.createdAt,
      })),
    };
  }

  @Post()
  @RequirePermission(Permission.ORG_UPDATE)
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    const row = await this.mcp.create(tenant, input);
    return { id: row.id, slug: row.slug, riskCeiling: row.riskCeiling, enabled: row.enabled };
  }

  /**
   * Ask the server what it offers.
   *
   * A POST rather than a GET, because it is not a read of our data: it makes
   * an outbound request to a third party. A GET would be cacheable and
   * prefetchable, and something a browser might issue on its own.
   */
  @Post(':id/discover')
  @RequirePermission(Permission.ORG_UPDATE)
  async discover(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.mcp.discover(tenant, parse(idSchema, id));
  }

  @Patch(':id')
  @RequirePermission(Permission.ORG_UPDATE)
  async setEnabled(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { enabled } = parse(enabledSchema, body);
    const row = await this.mcp.setEnabled(tenant, parse(idSchema, id), enabled);
    return { id: row.id, enabled: row.enabled };
  }

  @Delete(':id')
  @RequirePermission(Permission.ORG_UPDATE)
  async remove(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    await this.mcp.remove(tenant, parse(idSchema, id));
    return { deleted: true };
  }
}
