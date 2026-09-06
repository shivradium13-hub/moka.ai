import Anthropic from '@anthropic-ai/sdk';
import { assertSafeUrl } from '@moka/net';
import { ProviderError, ProviderErrorCode, codeFromHttpStatus } from '../errors.js';
import {
  EMPTY_USAGE,
  FinishReason,
  type ChatRequest,
  type Message,
  type TokenUsage,
} from '../types.js';
import type { ProviderAdapter, ProviderCredential } from './types.js';

/**
 * Anthropic adapter.
 *
 * Uses the official `@anthropic-ai/sdk` rather than hand-rolled HTTP: it
 * handles the streaming protocol, retries and typed errors correctly, and
 * reimplementing that is how subtle bugs get introduced.
 *
 * The SSRF guard still applies to the one attacker-reachable input here — a
 * BYOK `baseUrl`. The default endpoint is a fixed Anthropic host and is not a
 * user-controlled destination.
 *
 * API SHAPE (from the bundled claude-api reference, 2026-06-24):
 *  - Adaptive thinking: `thinking: {type: 'adaptive'}`. `budget_tokens` is
 *    REJECTED with a 400 on Opus 5 / Sonnet 5 / Fable 5.1 / Opus 4.7+.
 *  - Reasoning depth is `output_config.effort`, not a token budget.
 *  - Assistant prefill is rejected on these models.
 *  - `stop_reason: 'refusal'` is a 200 response, not an error.
 */

const DEFAULT_MAX_TOKENS = 16_000;
const STREAM_MAX_TOKENS = 64_000;

/** Models that reject `budget_tokens` and take adaptive thinking instead. */
function usesAdaptiveThinking(modelId: string): boolean {
  return !modelId.startsWith('claude-haiku-4-5') && !modelId.startsWith('claude-sonnet-4-5');
}

function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user';

      if (typeof message.content === 'string') {
        return { role, content: message.content } satisfies Anthropic.MessageParam;
      }

      const blocks: Anthropic.ContentBlockParam[] = message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.mimeType as 'image/png',
                data: part.data,
              },
            },
      );
      return { role, content: blocks } satisfies Anthropic.MessageParam;
    });
}

/** System text may arrive as a role or as an explicit field; both are honoured. */
function extractSystem(request: ChatRequest): string | undefined {
  const fromRole = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter(Boolean)
    .join('\n\n');

  const combined = [request.system, fromRole].filter(Boolean).join('\n\n');
  return combined.length > 0 ? combined : undefined;
}

function mapFinishReason(stopReason: string | null): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return FinishReason.STOP;
    case 'max_tokens':
      return FinishReason.MAX_TOKENS;
    case 'tool_use':
      return FinishReason.TOOL_USE;
    case 'refusal':
      return FinishReason.REFUSAL;
    default:
      return FinishReason.STOP;
  }
}

function mapUsage(usage: Anthropic.Usage | undefined): TokenUsage {
  if (!usage) return EMPTY_USAGE;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Translate an SDK error into a normalised ProviderError.
 *
 * The upstream message is kept as the INTERNAL message only. Anthropic's 400
 * bodies can quote the offending request content, which would mean echoing a
 * tenant's prompt back through an error channel.
 */
function normaliseError(error: unknown, modelId: string): ProviderError {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? null;

    let code = status ? codeFromHttpStatus(status) : ProviderErrorCode.UNKNOWN;
    const message = error.message.toLowerCase();
    if (status === 400 && (message.includes('context') || message.includes('too long'))) {
      code = ProviderErrorCode.CONTEXT_LENGTH;
    }

    const retryAfterHeader =
      (error.headers as Record<string, string> | undefined)?.['retry-after'] ?? null;

    return new ProviderError({
      code,
      providerId: 'anthropic',
      modelId,
      httpStatus: status,
      retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : null,
      internalMessage: error.message,
      cause: error,
    });
  }

  return new ProviderError({
    code: ProviderErrorCode.UNKNOWN,
    providerId: 'anthropic',
    modelId,
    internalMessage: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function createAnthropicAdapter(credential: ProviderCredential): ProviderAdapter {
  // A BYOK base URL is user-supplied and therefore an SSRF vector; the
  // default Anthropic endpoint is not.
  if (credential.baseUrl) {
    assertSafeUrl(credential.baseUrl, {
      ...(credential.testOnlyAllowPrivateHosts
        ? { testOnlyAllowPrivateHosts: credential.testOnlyAllowPrivateHosts }
        : {}),
    });
  }

  const client = new Anthropic({
    apiKey: credential.apiKey,
    ...(credential.baseUrl ? { baseURL: credential.baseUrl } : {}),
    maxRetries: 2,
  });

  function buildParams(
    request: ChatRequest,
    modelId: string,
    maxTokensDefault: number,
  ): Anthropic.MessageCreateParams {
    const system = extractSystem(request);

    const params: Anthropic.MessageCreateParams = {
      model: modelId,
      max_tokens: request.maxTokens ?? maxTokensDefault,
      messages: toAnthropicMessages(request.messages),
      ...(system ? { system } : {}),
    };

    if (usesAdaptiveThinking(modelId)) {
      // `display: 'summarized'` is opt-in; the default returns empty thinking
      // text, which would look like a stall to a streaming client.
      return {
        ...params,
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
      };
    }

    // Older models: temperature is accepted, adaptive thinking is not.
    return {
      ...params,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }

  return {
    providerId: 'anthropic',

    async chat(request, modelId) {
      const started = Date.now();
      try {
        const response = await client.messages.create({
          ...buildParams(request, modelId, DEFAULT_MAX_TOKENS),
          stream: false,
        });

        let text = '';
        let reasoning = '';
        for (const block of response.content) {
          if (block.type === 'text') text += block.text;
          else if (block.type === 'thinking') reasoning += block.thinking;
        }

        return {
          text,
          ...(reasoning ? { reasoning } : {}),
          finishReason: mapFinishReason(response.stop_reason),
          usage: mapUsage(response.usage),
          providerId: 'anthropic',
          modelId: response.model ?? modelId,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        throw normaliseError(error, modelId);
      }
    },

    async *stream(request, modelId) {
      let usage: TokenUsage = EMPTY_USAGE;
      let finishReason: FinishReason = FinishReason.STOP;

      try {
        const stream = client.messages.stream(
          buildParams(request, modelId, STREAM_MAX_TOKENS) as Anthropic.MessageStreamParams,
        );

        for await (const event of stream) {
          switch (event.type) {
            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                yield { type: 'text', text: event.delta.text };
              } else if (event.delta.type === 'thinking_delta') {
                yield { type: 'reasoning', text: event.delta.thinking };
              }
              break;

            case 'message_delta':
              finishReason = mapFinishReason(event.delta.stop_reason ?? null);
              if (event.usage) {
                usage = { ...usage, outputTokens: event.usage.output_tokens ?? 0 };
              }
              break;

            case 'message_start':
              usage = mapUsage(event.message.usage);
              break;

            default:
              break;
          }
        }

        yield { type: 'done', finishReason, usage };
      } catch (error) {
        // The stream may already have emitted text, so failure is reported as
        // an event rather than only thrown.
        const normalised = normaliseError(error, modelId);
        yield { type: 'error', code: normalised.code, message: normalised.publicMessage };
      }
    },
  };
}
