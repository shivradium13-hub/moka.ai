import { Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Database, usageRecords } from '@moka/db';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { formatMicroUsd, listModels, type ChatRequest } from '@moka/ai';
import { GatewayService } from './gateway.service.js';
import { CredentialsService } from './credentials.service.js';
import { DATABASE } from '../../database/database.module.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';
import { RATE_LIMITER, enforceRateLimit, type RateLimiter } from '../../common/rate-limit.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([
    z.string().min(1).max(200_000),
    z
      .array(
        z.union([
          z.object({ type: z.literal('text'), text: z.string().max(200_000) }),
          z.object({
            type: z.literal('image'),
            // base64 only. A URL here would be an SSRF vector: the server
            // would fetch an attacker-chosen address to build the request.
            data: z.string().max(10_000_000),
            mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
          }),
        ]),
      )
      .max(20),
  ]),
});

const chatSchema = z.object({
  model: z.string().max(100).nullish(),
  messages: z.array(messageSchema).min(1).max(200),
  system: z.string().max(100_000).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  projectId: z.string().uuid().nullish(),
});

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

function toChatRequest(input: z.output<typeof chatSchema>): ChatRequest {
  return {
    model: input.model ?? null,
    messages: input.messages as ChatRequest['messages'],
    ...(input.system ? { system: input.system } : {}),
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  };
}

@Controller('v1/ai')
export class AiController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly credentials: CredentialsService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  /**
   * Model catalogue.
   *
   * `available` reflects whether this instance actually holds a credential for
   * the provider, so the UI can show a model as unusable instead of letting a
   * user select it and hit an error.
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('models')
  async models(@CurrentTenant() tenant: TenantContext) {
    const providers = this.credentials.availableProviders(tenant);

    return {
      providers,
      models: listModels().map((model) => ({
        id: model.id,
        providerId: model.providerId,
        displayName: model.displayName,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        available: providers.includes(model.providerId),
        // Null pricing is reported as such — never as zero.
        pricing: model.pricing
          ? {
              inputPerMillion: model.pricing.inputPerMillion,
              outputPerMillion: model.pricing.outputPerMillion,
              source: model.pricing.source,
              verifiedOn: model.pricing.verifiedOn,
            }
          : null,
      })),
    };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('chat')
  async chat(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(chatSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    await enforceRateLimit(this.rateLimiter, `ai:chat:${tenant.organizationId}`, 60, 60);

    const result = await this.gateway.chat(tenant, toChatRequest(input), {
      projectId: input.projectId ?? null,
      requestId,
    });

    return {
      text: result.text,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      finishReason: result.finishReason,
      model: result.modelId,
      provider: result.providerId,
      usage: result.usage,
      cost: {
        microUsd: result.costMicroUsd,
        display: formatMicroUsd(result.costMicroUsd),
        known: result.costMicroUsd !== null,
      },
      latencyMs: result.latencyMs,
      ...(result.attemptedFallbacks.length > 0
        ? { attemptedFallbacks: result.attemptedFallbacks }
        : {}),
    };
  }

  /**
   * Streaming chat over Server-Sent Events.
   *
   * SSE rather than WebSockets: the traffic is one-directional, it survives
   * proxies that mangle upgrades, and it reconnects natively in the browser.
   *
   * `X-Accel-Buffering: no` matters — without it nginx buffers the whole
   * response and the stream arrives as one lump at the end, which looks
   * exactly like a hang.
   */
  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('chat/stream')
  async chatStream(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
    @RequestId() requestId: string,
  ): Promise<void> {
    const input = parse(chatSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    await enforceRateLimit(this.rateLimiter, `ai:stream:${tenant.organizationId}`, 30, 60);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const event of this.gateway.stream(tenant, toChatRequest(input), {
        projectId: input.projectId ?? null,
        requestId,
      })) {
        switch (event.type) {
          case 'text':
            send('text', { text: event.text });
            break;
          case 'reasoning':
            send('reasoning', { text: event.text });
            break;
          case 'done':
            send('done', { finishReason: event.finishReason, usage: event.usage });
            break;
          case 'error':
            // Already normalised and safe; adapters never put upstream text here.
            send('error', { code: event.code, message: event.message });
            break;
        }
      }
    } catch (error) {
      // Headers are already sent, so this cannot become an HTTP error status.
      send('error', {
        code: 'INTERNAL',
        message: 'The request could not be completed.',
      });
      throw error;
    } finally {
      reply.raw.end();
    }
  }

  /** Usage summary for the current organization (§35). */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('usage')
  async usage(@CurrentTenant() tenant: TenantContext) {
    const [totals, recent] = await Promise.all([
      this.db.withTenant(tenant, async (tx) =>
        tx
          .select({
            modelId: usageRecords.modelId,
            providerId: usageRecords.providerId,
            calls: sql<number>`count(*)::int`,
            inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::int`,
            outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::int`,
            // NULL costs are excluded from the sum, and counted separately so
            // the UI can say "cost unknown for N calls" rather than under-report.
            costMicroUsd: sql<number | null>`sum(${usageRecords.costMicroUsd})`,
            unpricedCalls: sql<number>`count(*) filter (where ${usageRecords.costMicroUsd} is null)::int`,
          })
          .from(usageRecords)
          .where(eq(usageRecords.organizationId, tenant.organizationId))
          .groupBy(usageRecords.modelId, usageRecords.providerId),
      ),
      this.db.withTenant(tenant, async (tx) =>
        tx
          .select({
            id: usageRecords.id,
            modelId: usageRecords.modelId,
            operation: usageRecords.operation,
            inputTokens: usageRecords.inputTokens,
            outputTokens: usageRecords.outputTokens,
            costMicroUsd: usageRecords.costMicroUsd,
            latencyMs: usageRecords.latencyMs,
            errorCode: usageRecords.errorCode,
            createdAt: usageRecords.createdAt,
          })
          .from(usageRecords)
          .where(and(eq(usageRecords.organizationId, tenant.organizationId)))
          .orderBy(desc(usageRecords.createdAt))
          .limit(50),
      ),
    ]);

    return {
      byModel: totals.map((row) => ({
        ...row,
        costDisplay: formatMicroUsd(row.costMicroUsd ?? null),
      })),
      recent: recent.map((row) => ({
        ...row,
        costDisplay: formatMicroUsd(row.costMicroUsd),
      })),
    };
  }
}
