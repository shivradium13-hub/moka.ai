import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  ALL_ROLES,
  Permission,
  ValidationError,
  type SystemRole,
  type TenantContext,
} from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { OrganizationsService } from './organizations.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

const updateOrgSchema = z.object({ name: z.string().min(1).max(120) });
const roleSchema = z.object({
  role: z.enum(ALL_ROLES as unknown as [SystemRole, ...SystemRole[]]),
});
const idSchema = z.string().uuid();

/**
 * Validate and narrow.
 *
 * Returns `z.output<S>` rather than being generic over a single T: a schema
 * using `.default()` has different input and output types, and `z.ZodType<T>`
 * conflates them — which silently infers optional fields as `T | undefined`.
 */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/organization')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @RequirePermission(Permission.ORG_READ)
  @Get()
  async get(@CurrentTenant() tenant: TenantContext) {
    return { organization: await this.organizations.get(tenant) };
  }

  @RequirePermission(Permission.ORG_UPDATE)
  @Patch()
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(updateOrgSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return { organization: await this.organizations.update(tenant, input, { requestId }) };
  }

  @RequirePermission(Permission.MEMBER_READ)
  @Get('members')
  async listMembers(@CurrentTenant() tenant: TenantContext) {
    return { members: await this.organizations.listMembers(tenant) };
  }

  @RequirePermission(Permission.MEMBER_UPDATE_ROLE)
  @Patch('members/:id')
  async updateMemberRole(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const { role } = parse(roleSchema, body);
    return {
      member: await this.organizations.updateMemberRole(tenant, parse(idSchema, id), role, {
        requestId,
      }),
    };
  }

  @RequirePermission(Permission.MEMBER_REMOVE)
  @Delete('members/:id')
  async removeMember(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.organizations.removeMember(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  @RequirePermission(Permission.AUDIT_READ)
  @Get('audit-log')
  async auditLog(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : 100;
    return {
      entries: await this.organizations.listAuditLog(
        tenant,
        Number.isFinite(parsed) ? parsed : 100,
      ),
    };
  }
}
