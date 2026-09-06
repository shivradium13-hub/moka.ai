import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { ProjectsService } from './projects.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Slug must be lowercase alphanumeric with hyphens.');

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug,
  description: z.string().max(2000).nullish(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'At least one field must be provided.',
  });

const idSchema = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @RequirePermission(Permission.PROJECT_READ)
  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return { projects: await this.projects.list(tenant) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get(':id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { project: await this.projects.get(tenant, parse(idSchema, id)) };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    // Defence in depth: any organization id in the payload is removed before
    // validation, so it cannot reach the service even by accident.
    const cleaned = stripTenantKeys((body ?? {}) as Record<string, unknown>);
    const input = parse(createSchema, cleaned);
    return { project: await this.projects.create(tenant, input, { requestId }) };
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Patch(':id')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const cleaned = stripTenantKeys((body ?? {}) as Record<string, unknown>);
    const input = parse(updateSchema, cleaned);
    return {
      project: await this.projects.update(tenant, parse(idSchema, id), input, { requestId }),
    };
  }

  @RequirePermission(Permission.PROJECT_DELETE)
  @Delete(':id')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.projects.remove(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }
}
