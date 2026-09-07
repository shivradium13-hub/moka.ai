import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { ChatbotsService } from './chatbots.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

/**
 * Staff-facing chatbot administration.
 *
 * Ordinary tenant-scoped routes with declared permissions, unlike the public
 * controller next door. Two permission choices are worth stating:
 *
 *   PUBLISHING NEEDS PROJECT_UPDATE, not PROJECT_READ. Attaching a knowledge
 *   source to a chatbot, or creating a deployment, makes internal material
 *   readable by the public. That is a write to the outside world even though
 *   it reads as configuration, so a viewer cannot do it.
 *
 *   REPLYING TO A VISITOR NEEDS PROJECT_UPDATE for the same reason: it puts
 *   words in the organization's name in front of a member of the public.
 */

const idSchema = z.string().uuid();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  instructions: z.string().max(20_000).default(''),
  greeting: z.string().max(500).nullish(),
  requireGrounding: z.boolean().default(true),
  handoffEnabled: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(30),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    instructions: z.string().max(20_000),
    greeting: z.string().max(500).nullable(),
    modelId: z.string().max(120).nullable(),
    requireGrounding: z.boolean(),
    handoffEnabled: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    status: z.enum(['draft', 'active', 'disabled']),
  })
  .partial();

const sourcesSchema = z.object({ sourceIds: z.array(z.string().uuid()).max(50) });

const deploymentSchema = z.object({
  name: z.string().min(1).max(120),
  // Bounded: this list is compiled into a CSP directive, and an unbounded one
  // would make a header no browser will accept.
  allowedOrigins: z.array(z.string().min(1).max(255)).min(1).max(20),
});

const replySchema = z.object({ message: z.string().min(1).max(8_000) });

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/chatbots')
export class ChatbotsController {
  constructor(private readonly chatbots: ChatbotsService) {}

  @RequirePermission(Permission.PROJECT_READ)
  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return { chatbots: await this.chatbots.list(tenant) };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(createSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return { chatbot: await this.chatbots.create(tenant, input, { requestId }) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get(':id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { chatbot: await this.chatbots.get(tenant, parse(idSchema, id)) };
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Patch(':id')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(updateSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return {
      chatbot: await this.chatbots.update(tenant, parse(idSchema, id), input, { requestId }),
    };
  }

  @RequirePermission(Permission.PROJECT_DELETE)
  @Delete(':id')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.chatbots.remove(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  /**
   * Choose which knowledge sources this chatbot may quote.
   *
   * PROJECT_UPDATE, because this is publication: after this call, anything in
   * those sources can be read aloud to any visitor on any page the chatbot is
   * embedded on.
   */
  @RequirePermission(Permission.PROJECT_UPDATE)
  @Post(':id/sources')
  async setSources(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(sourcesSchema, body);
    return {
      chatbot: await this.chatbots.setSources(tenant, parse(idSchema, id), input.sourceIds, {
        requestId,
      }),
    };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get(':id/deployments')
  async deployments(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { deployments: await this.chatbots.listDeployments(tenant, parse(idSchema, id)) };
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Post(':id/deployments')
  async createDeployment(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(deploymentSchema, body);
    return {
      deployment: await this.chatbots.createDeployment(tenant, parse(idSchema, id), input, {
        requestId,
      }),
    };
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Delete('deployments/:deploymentId')
  async revokeDeployment(
    @CurrentTenant() tenant: TenantContext,
    @Param('deploymentId') deploymentId: string,
    @RequestId() requestId: string,
  ) {
    await this.chatbots.revokeDeployment(tenant, parse(idSchema, deploymentId), { requestId });
    return { ok: true };
  }
}

/**
 * Conversations live on their own path rather than under a chatbot, because
 * the inbox is read across chatbots: a person answering handoffs wants
 * everything waiting, not one bot at a time.
 */
@Controller('v1/chat')
export class ChatInboxController {
  constructor(private readonly chatbots: ChatbotsService) {}

  @RequirePermission(Permission.PROJECT_READ)
  @Get('conversations')
  async conversations(@CurrentTenant() tenant: TenantContext, @Query('status') status?: string) {
    const allowed = ['open', 'awaiting_human', 'with_human', 'closed'];
    return {
      conversations: await this.chatbots.listConversations(
        tenant,
        status && allowed.includes(status) ? { status } : {},
      ),
    };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('conversations/:id')
  async transcript(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.chatbots.getTranscript(tenant, parse(idSchema, id));
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Post('conversations/:id/reply')
  async reply(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(replySchema, body);
    await this.chatbots.replyAsHuman(tenant, parse(idSchema, id), input.message, { requestId });
    return { ok: true };
  }

  @RequirePermission(Permission.PROJECT_UPDATE)
  @Post('conversations/:id/close')
  async close(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.chatbots.closeConversation(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  /**
   * Apply the retention policy now.
   *
   * Explicitly triggered, because there is no scheduler: the job queue needs
   * Valkey, which needs Docker, which is unavailable here (roadmap §B2).
   * Shipping a timer that quietly dies with the process — while an operator
   * believes their retention policy is running — would be worse than an
   * honest button (§45).
   *
   * PROJECT_DELETE: it destroys data, permanently.
   */
  @RequirePermission(Permission.PROJECT_DELETE)
  @Post('retention/purge')
  async purge(@CurrentTenant() tenant: TenantContext, @RequestId() requestId: string) {
    return this.chatbots.purgeExpiredConversations(tenant, { requestId });
  }
}
