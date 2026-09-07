import { Inject, Injectable } from '@nestjs/common';
import { Database, usageRecords } from '@moka/db';
import {
  ProviderError,
  ProviderErrorCode,
  createAnthropicAdapter,
  createOpenAiAdapter,
  estimateCostByModelId,
  planRoute,
  type ChatRequest,
  type ChatResponse,
  type ModelDescriptor,
  type ProviderAdapter,
  type StreamEvent,
  type TokenUsage,
} from '@moka/ai';
import { EMPTY_USAGE } from '@moka/ai';
import type { TenantContext } from '@moka/core';
import { Feature } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { CredentialsService } from './credentials.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { CreditsService } from '../billing/credits.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * The AI Gateway (docs/architecture.md §3, §17).
 *
 *   request → router → credential → adapter → provider
 *                ↓ on failure
 *            next model in the plan
 *
 * Every call — success or failure — writes a usage record. A failed call still
 * consumed provider quota and latency, and a ledger that only records successes
 * hides exactly the traffic worth investigating.
 */

type AdapterFactory = (credential: { apiKey: string; baseUrl?: string }) => ProviderAdapter;

const ADAPTERS: Record<string, AdapterFactory> = {
  anthropic: createAnthropicAdapter,
  openai: createOpenAiAdapter,
};

export interface GatewayResult extends ChatResponse {
  /** Micro-dollars, or null when pricing for the model is unknown. */
  readonly costMicroUsd: number | null;
  /** Models tried and rejected before this one succeeded. */
  readonly attemptedFallbacks: readonly string[];
}

@Injectable()
export class GatewayService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly credentials: CredentialsService,
    private readonly entitlements: EntitlementsService,
    private readonly credits: CreditsService,
  ) {}

  private async adapterFor(
    context: TenantContext,
    model: ModelDescriptor,
  ): Promise<ProviderAdapter> {
    const factory = ADAPTERS[model.providerId];
    if (!factory) {
      throw new ProviderError({
        code: ProviderErrorCode.INVALID_REQUEST,
        providerId: model.providerId,
        modelId: model.id,
        internalMessage: `No adapter registered for provider ${model.providerId}.`,
      });
    }

    const credential = await this.credentials.resolve(context, model.providerId);
    if (!credential) {
      throw new ProviderError({
        code: ProviderErrorCode.NO_CREDENTIAL,
        providerId: model.providerId,
        modelId: model.id,
      });
    }

    // Constructed per request so a credential never outlives its use.
    return factory(credential);
  }

  /**
   * Single-shot completion, walking the routing plan on failure.
   *
   * Only errors marked `shouldFallback` advance to the next model: retrying a
   * malformed request or an over-length context on another model just burns a
   * second provider call to get the same answer.
   */
  async chat(
    context: TenantContext,
    request: ChatRequest,
    meta: { projectId?: string | null; requestId?: string | undefined },
  ): Promise<GatewayResult> {
    /*
     * Entitlements are checked BEFORE the credential is resolved and before
     * any provider is contacted (architecture §4, step 2). Refusing early
     * means an exhausted organization never decrypts a key, never opens a
     * connection, and never spends a millisecond of somebody else's quota.
     */
    await this.credits.requireCredit(context);

    /*
     * An EXPLICITLY REQUESTED model is checked before routing.
     *
     * `planRoute` resolves credentials as part of choosing a model, and it
     * throws NO_CREDENTIAL for a model whose provider is unconfigured. If the
     * entitlement check ran only inside the fallback loop below, a caller
     * asking for a model their plan excludes would be told "no credential is
     * configured for anthropic" — which is both the wrong answer and a small
     * leak of which providers this deployment has.
     *
     * Architecture §4 puts entitlements at step 2 and credentials at step 3,
     * and this is why that order is not arbitrary.
     */
    if (request.model) {
      await this.entitlements.requireAllowed(context, Feature.AI_MODELS, request.model);
    }

    const plan = planRoute(request, {
      availableProviders: await this.credentials.availableProviders(context),
    });

    const candidates = [plan.primary, ...plan.fallbacks];
    const attempted: string[] = [];
    let lastError: ProviderError | null = null;

    for (const model of candidates) {
      try {
        /*
         * And again per candidate, because the router may FALL BACK to a model
         * the plan does not include. Checking only the requested one would
         * make the fallback path a way around the allowlist, reachable by
         * anyone who can make the first provider fail.
         *
         * Refusing here lets the loop continue to the next candidate, which is
         * the right behaviour: an unavailable model and an unlicensed one are
         * both "try the next one".
         */
        await this.entitlements.requireAllowed(context, Feature.AI_MODELS, model.id);

        const adapter = await this.adapterFor(context, model);
        const response = await adapter.chat(request, model.id);
        const cost = estimateCostByModelId(model.id, response.usage);

        const usageRecordId = await this.record(context, {
          model,
          operation: 'chat',
          usage: response.usage,
          costMicroUsd: cost.microUsd,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
          errorCode: null,
          projectId: meta.projectId ?? null,
          requestId: meta.requestId,
        });

        /*
         * Debited AFTER the call, because the cost is not known until the
         * model has chosen how many tokens to emit. `charge` never throws: the
         * user got their answer, and a failure to record the debit is our
         * problem to reconcile rather than theirs to see as a 500.
         *
         * `cost.microUsd` is null when the model's pricing is not configured.
         * That is recorded as an unpriced call rather than charged as zero —
         * see planDebit in @moka/billing for why silently free is the worst of
         * the available options.
         */
        await this.credits.charge(context, {
          costMicroUsd: cost.microUsd,
          usageRecordId,
          requestId: meta.requestId,
          reason: `chat via ${model.id}`,
        });

        return {
          ...response,
          costMicroUsd: cost.microUsd,
          attemptedFallbacks: attempted,
        };
      } catch (error) {
        const providerError =
          error instanceof ProviderError
            ? error
            : new ProviderError({
                code: ProviderErrorCode.UNKNOWN,
                providerId: model.providerId,
                modelId: model.id,
                internalMessage: error instanceof Error ? error.message : String(error),
              });

        // A failed call still cost time and provider quota; record it.
        await this.record(context, {
          model,
          operation: 'chat',
          usage: EMPTY_USAGE,
          costMicroUsd: null,
          latencyMs: 0,
          finishReason: null,
          errorCode: providerError.code,
          projectId: meta.projectId ?? null,
          requestId: meta.requestId,
        });

        getLogger().warn(
          {
            organizationId: context.organizationId,
            model: model.id,
            provider: model.providerId,
            errorCode: providerError.code,
            requestId: meta.requestId,
          },
          'provider call failed',
        );

        lastError = providerError;
        attempted.push(model.id);

        if (!providerError.shouldFallback) throw providerError;
      }
    }

    throw (
      lastError ??
      new ProviderError({ code: ProviderErrorCode.UNAVAILABLE, providerId: 'gateway' })
    );
  }

  /**
   * Streaming completion.
   *
   * No fallback once streaming has begun: bytes have already reached the
   * client, and silently restarting on another model would splice two
   * different answers together. The failure is surfaced as a stream event.
   */
  async *stream(
    context: TenantContext,
    request: ChatRequest,
    meta: { projectId?: string | null; requestId?: string | undefined },
  ): AsyncIterable<StreamEvent> {
    const started = Date.now();

    let model: ModelDescriptor | null = null;
    let usage: TokenUsage = EMPTY_USAGE;
    let finishReason: string | null = null;
    let errorCode: string | null = null;

    try {
      /*
       * Routing happens INSIDE the try. It can fail — no credential, no model
       * fits — and a failure there must reach the client as a normalised
       * error event like any other, not escape the generator and surface as a
       * generic 500 after the SSE headers have already been sent.
       */
      const plan = planRoute(request, {
        availableProviders: await this.credentials.availableProviders(context),
      });
      model = plan.primary;

      const adapter = await this.adapterFor(context, model);

      for await (const event of adapter.stream(request, model.id)) {
        if (event.type === 'done') {
          usage = event.usage;
          finishReason = event.finishReason;
        } else if (event.type === 'error') {
          errorCode = event.code;
        }
        yield event;
      }
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError({
              code: ProviderErrorCode.UNKNOWN,
              providerId: model?.providerId ?? 'gateway',
              modelId: model?.id ?? null,
              internalMessage: error instanceof Error ? error.message : String(error),
            });
      errorCode = providerError.code;
      yield { type: 'error', code: providerError.code, message: providerError.publicMessage };
    } finally {
      // Only record when a model was actually selected. A routing failure
      // consumed no provider quota, so inventing a ledger row for it would
      // misreport usage.
      if (model) {
        const cost = estimateCostByModelId(model.id, usage);
        await this.record(context, {
          model,
          operation: 'stream',
          usage,
          costMicroUsd: cost.microUsd,
          latencyMs: Date.now() - started,
          finishReason,
          errorCode,
          projectId: meta.projectId ?? null,
          requestId: meta.requestId,
        });
      }
    }
  }

  /**
   * Write one ledger row.
   *
   * Failures are logged, never thrown: losing a usage row is bad, but failing
   * a completed AI call because the ledger write failed is worse — the user
   * would be denied a response they have already been charged for upstream.
   * Phase 9 revisits this when usage gates spending.
   */
  private async record(
    context: TenantContext,
    entry: {
      model: ModelDescriptor;
      operation: 'chat' | 'stream';
      usage: TokenUsage;
      costMicroUsd: number | null;
      latencyMs: number;
      finishReason: string | null;
      errorCode: string | null;
      projectId: string | null;
      requestId: string | undefined;
    },
    /*
     * Returns the row id so a credit debit can point at the usage it paid for.
     * Null when the write failed — a lost usage row must not take a working
     * provider call down with it, and the debit simply records no link.
     */
  ): Promise<string | null> {
    try {
      return await this.db.withTenant(context, async (tx) => {
        const [row] = await tx.insert(usageRecords).values({
          organizationId: context.organizationId,
          projectId: entry.projectId,
          userId: context.userId,
          providerId: entry.model.providerId,
          modelId: entry.model.id,
          operation: entry.operation,
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          cacheWriteTokens: entry.usage.cacheWriteTokens,
          cacheReadTokens: entry.usage.cacheReadTokens,
          costMicroUsd: entry.costMicroUsd,
          latencyMs: entry.latencyMs,
          finishReason: entry.finishReason,
          errorCode: entry.errorCode,
          requestId: entry.requestId ?? null,
        }).returning({ id: usageRecords.id });
        return row?.id ?? null;
      });
    } catch (error) {
      getLogger().error(
        {
          usageWriteFailure: true,
          organizationId: context.organizationId,
          modelId: entry.model.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to write usage record',
      );
      return null;
    }
  }
}
