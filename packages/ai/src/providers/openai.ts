import OpenAI from 'openai';
import { assertSafeUrl } from '@moka/net';
import { ProviderError, ProviderErrorCode, codeFromHttpStatus } from '../errors.js';
import {
  EMPTY_USAGE,
  FinishReason,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type StreamEvent,
  type TokenUsage,
} from '../types.js';
import type { ProviderAdapter, ProviderCredential } from './types.js';

/**
 * OpenAI adapter (Chat Completions).
 *
 * Uses the official `openai` SDK. As with Anthropic, a BYOK `baseUrl` is
 * user-supplied and validated through @moka/net first — this adapter is also
 * the path used for OpenAI-compatible self-hosted servers, which makes that
 * check load-bearing rather than theoretical.
 */

const DEFAULT_MAX_TOKENS = 4096;

function toOpenAiMessages(
  messages: readonly Message[],
  system: string | undefined,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) result.push({ role: 'system', content: system });

  for (const message of messages) {
    if (message.role === 'system') {
      result.push({
        role: 'system',
        content: typeof message.content === 'string' ? message.content : '',
      });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';

    if (typeof message.content === 'string') {
      result.push({ role, content: message.content } as OpenAI.Chat.ChatCompletionMessageParam);
      continue;
    }

    // Only user turns carry multimodal parts in the Chat Completions shape.
    if (role === 'assistant') {
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
      result.push({ role: 'assistant', content: text });
      continue;
    }

    result.push({
      role: 'user',
      content: message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text' as const, text: part.text }
          : {
              type: 'image_url' as const,
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            },
      ),
    });
  }

  return result;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'tool_calls':
    case 'function_call':
      return FinishReason.TOOL_USE;
    case 'content_filter':
      return FinishReason.REFUSAL;
    default:
      return FinishReason.STOP;
  }
}

function mapUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage {
  if (!usage) return EMPTY_USAGE;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheWriteTokens: 0,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function normaliseError(error: unknown, modelId: string): ProviderError {
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? null;
    let code = status ? codeFromHttpStatus(status) : ProviderErrorCode.UNKNOWN;

    const message = error.message.toLowerCase();
    if (message.includes('context_length') || message.includes('maximum context')) {
      code = ProviderErrorCode.CONTEXT_LENGTH;
    } else if (message.includes('content_policy') || message.includes('content filter')) {
      code = ProviderErrorCode.CONTENT_FILTERED;
    }

    return new ProviderError({
      code,
      providerId: 'openai',
      modelId,
      httpStatus: status,
      // Upstream text is internal only: OpenAI 400 bodies can echo the request.
      internalMessage: error.message,
      cause: error,
    });
  }

  return new ProviderError({
    code: ProviderErrorCode.UNKNOWN,
    providerId: 'openai',
    modelId,
    internalMessage: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function createOpenAiAdapter(credential: ProviderCredential): ProviderAdapter {
  if (credential.baseUrl) {
    assertSafeUrl(credential.baseUrl, {
      ...(credential.testOnlyAllowPrivateHosts
        ? { testOnlyAllowPrivateHosts: credential.testOnlyAllowPrivateHosts }
        : {}),
    });
  }

  const client = new OpenAI({
    apiKey: credential.apiKey,
    ...(credential.baseUrl ? { baseURL: credential.baseUrl } : {}),
    maxRetries: 2,
  });

  function systemOf(request: ChatRequest): string | undefined {
    return request.system && request.system.length > 0 ? request.system : undefined;
  }

  return {
    providerId: 'openai',

    async chat(request, modelId): Promise<ChatResponse> {
      const started = Date.now();
      try {
        const response = await client.chat.completions.create({
          model: modelId,
          messages: toOpenAiMessages(request.messages, systemOf(request)),
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: false,
        });

        const choice = response.choices[0];
        return {
          text: choice?.message.content ?? '',
          finishReason: mapFinishReason(choice?.finish_reason),
          usage: mapUsage(response.usage),
          providerId: 'openai',
          modelId: response.model ?? modelId,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        throw normaliseError(error, modelId);
      }
    },

    async *stream(request, modelId): AsyncIterable<StreamEvent> {
      let usage: TokenUsage = EMPTY_USAGE;
      let finishReason: FinishReason = FinishReason.STOP;

      try {
        const stream = await client.chat.completions.create({
          model: modelId,
          messages: toOpenAiMessages(request.messages, systemOf(request)),
          max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          stream: true,
          // Usage is omitted from streams unless asked for, which would
          // otherwise make every streamed request untracked.
          stream_options: { include_usage: true },
        });

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta?.content;
          if (delta) yield { type: 'text', text: delta };
          if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
          if (chunk.usage) usage = mapUsage(chunk.usage);
        }

        yield { type: 'done', finishReason, usage };
      } catch (error) {
        const normalised = normaliseError(error, modelId);
        yield { type: 'error', code: normalised.code, message: normalised.publicMessage };
      }
    },
  };
}
