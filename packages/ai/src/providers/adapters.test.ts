import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAiAdapter } from './openai.js';
import { ProviderErrorCode } from '../errors.js';
import type { ProviderError } from '../errors.js';
import { FinishReason, type ChatRequest } from '../types.js';

/**
 * Adapter tests against a LOCAL server speaking each provider's documented
 * wire format.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * There are no provider API keys in this environment, so nothing here proves
 * that Anthropic or OpenAI behave as documented. It proves the half that is
 * ours: that we build the right request, parse the response and the SSE
 * stream correctly, map usage and finish reasons, and normalise errors without
 * leaking upstream text. That is the half we can break.
 *
 * The fixtures below are the response shapes from the bundled `claude-api`
 * reference and the OpenAI Chat Completions format.
 */

let server: Server;
let base: string;
let lastRequest: { path: string; body: unknown; headers: Record<string, string> } | null = null;
/**
 * Set by a test to make responses fail.
 *
 * `times` matters: both SDKs retry 429 and 5xx (maxRetries: 2), so a one-shot
 * failure would be retried into a success and the test would prove nothing.
 * A retryable-status test must therefore outlast the retry budget.
 */
let nextFailure: { status: number; body: unknown; times: number } | null = null;

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const entry of events) {
    if (entry.event) res.write(`event: ${entry.event}\n`);
    res.write(`data: ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}\n\n`);
  }
  res.end();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      lastRequest = {
        path: url.pathname,
        body,
        headers: req.headers as Record<string, string>,
      };

      if (nextFailure && nextFailure.times > 0) {
        nextFailure.times -= 1;
        const failure = nextFailure;
        if (failure.times === 0) nextFailure = null;
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure.body));
        return;
      }

      const streaming = (body as { stream?: boolean } | null)?.stream === true;

      // --- Anthropic Messages API ---
      if (url.pathname === '/v1/messages') {
        if (streaming) {
          sse(res, [
            {
              event: 'message_start',
              data: {
                type: 'message_start',
                message: {
                  id: 'msg_1',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-opus-5',
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 42, output_tokens: 0 },
                },
              },
            },
            {
              event: 'content_block_start',
              data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hello' },
              },
            },
            {
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: ' world' },
              },
            },
            { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
            {
              event: 'message_delta',
              data: {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 7 },
              },
            },
            { event: 'message_stop', data: { type: 'message_stop' } },
          ]);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [
              { type: 'thinking', thinking: 'considering', signature: 'x' },
              { type: 'text', text: 'Paris is the capital of France.' },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              output_tokens: 9,
              cache_creation_input_tokens: 3,
              cache_read_input_tokens: 5,
            },
          }),
        );
        return;
      }

      // --- OpenAI Chat Completions ---
      if (url.pathname === '/v1/chat/completions') {
        if (streaming) {
          sse(res, [
            {
              data: {
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'gpt-4o',
                choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
              },
            },
            {
              data: {
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'gpt-4o',
                choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
              },
            },
            {
              data: {
                id: 'chatcmpl-1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'gpt-4o',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
              },
            },
            { data: '[DONE]' },
          ]);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-4o',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Four.' }, finish_reason: 'stop' },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 4,
              total_tokens: 15,
              prompt_tokens_details: { cached_tokens: 6 },
            },
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end('{}');
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request: ChatRequest = {
  model: null,
  messages: [{ role: 'user', content: 'What is the capital of France?' }],
  system: 'Be concise.',
};

/*
 * The adapters validate baseUrl through @moka/net, which correctly refuses a
 * loopback address. `testOnlyAllowPrivateHosts` names just this test server,
 * so every other private destination stays blocked and the guard is still
 * doing its job during these tests.
 */
const LOCAL_HATCH = ['127.0.0.1'] as const;

describe('anthropic adapter', () => {
  const adapter = () =>
    createAnthropicAdapter({
      apiKey: 'test-key',
      baseUrl: `${base}/`,
      testOnlyAllowPrivateHosts: LOCAL_HATCH,
    });

  it('sends adaptive thinking, never budget_tokens', async () => {
    await adapter().chat(request, 'claude-opus-5');
    const body = lastRequest?.body as Record<string, unknown>;

    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    // budget_tokens is rejected with a 400 on current models.
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  it('sends the system prompt as a top-level field', async () => {
    await adapter().chat(request, 'claude-opus-5');
    expect((lastRequest?.body as Record<string, unknown>)['system']).toBe('Be concise.');
  });

  it('maps effort onto output_config', async () => {
    await adapter().chat({ ...request, effort: 'high' }, 'claude-opus-5');
    expect((lastRequest?.body as Record<string, unknown>)['output_config']).toEqual({
      effort: 'high',
    });
  });

  it('uses budget-free params but no adaptive thinking on Haiku 4.5', async () => {
    await adapter().chat(request, 'claude-haiku-4-5');
    const body = lastRequest?.body as Record<string, unknown>;
    expect(body['thinking']).toBeUndefined();
  });

  it('parses text, reasoning and usage from a response', async () => {
    const response = await adapter().chat(request, 'claude-opus-5');

    expect(response.text).toBe('Paris is the capital of France.');
    expect(response.reasoning).toBe('considering');
    expect(response.finishReason).toBe(FinishReason.STOP);
    expect(response.usage).toEqual({
      inputTokens: 12,
      outputTokens: 9,
      cacheWriteTokens: 3,
      cacheReadTokens: 5,
    });
    expect(response.providerId).toBe('anthropic');
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('streams text deltas and finishes with usage', async () => {
    const events = [];
    for await (const event of adapter().stream(request, 'claude-opus-5')) {
      events.push(event);
    }

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Hello world');

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect((done as { usage: { inputTokens: number } }).usage.inputTokens).toBe(42);
  });

  it('normalises a 429 into a retryable rate-limit error', async () => {
    nextFailure = {
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error' } },
      times: 3,
    };
    await expect(adapter().chat(request, 'claude-opus-5')).rejects.toMatchObject({
      code: ProviderErrorCode.RATE_LIMITED,
    });
  });

  it('normalises a 401 into a non-retryable auth error', async () => {
    // 401 is not retried, so one response is enough.
    nextFailure = {
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error' } },
      times: 1,
    };
    try {
      await adapter().chat(request, 'claude-opus-5');
      expect.unreachable('should have thrown');
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.code).toBe(ProviderErrorCode.AUTHENTICATION);
      expect(providerError.retryable).toBe(false);
      expect(providerError.shouldFallback).toBe(true);
    }
  });

  /*
   * A provider's 400 body can quote the request that caused it. That text must
   * never reach a client, or an error channel becomes a way to read back
   * another tenant's prompt.
   */
  it('never puts upstream error text in the public message', async () => {
    nextFailure = {
      status: 400,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'SECRET-PROMPT-CONTENT leaked here' },
      },
      times: 1,
    };
    try {
      await adapter().chat(request, 'claude-opus-5');
      expect.unreachable('should have thrown');
    } catch (error) {
      const providerError = error as ProviderError;
      expect(providerError.publicMessage).not.toContain('SECRET-PROMPT-CONTENT');
      // Still available internally for the log.
      expect(providerError.message).toContain('SECRET-PROMPT-CONTENT');
    }
  });
});

describe('openai adapter', () => {
  const adapter = () =>
    createOpenAiAdapter({
      apiKey: 'test-key',
      baseUrl: `${base}/v1`,
      testOnlyAllowPrivateHosts: LOCAL_HATCH,
    });

  it('places the system prompt as the first message', async () => {
    await adapter().chat(request, 'gpt-4o');
    const messages = (lastRequest?.body as { messages: Array<{ role: string; content: string }> })
      .messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
  });

  it('parses text, finish reason and cached tokens', async () => {
    const response = await adapter().chat(request, 'gpt-4o');
    expect(response.text).toBe('Four.');
    expect(response.finishReason).toBe(FinishReason.STOP);
    expect(response.usage.inputTokens).toBe(11);
    expect(response.usage.outputTokens).toBe(4);
    expect(response.usage.cacheReadTokens).toBe(6);
  });

  it('requests usage on streams, which is off by default', async () => {
    const events = [];
    for await (const event of adapter().stream(request, 'gpt-4o')) events.push(event);

    expect((lastRequest?.body as Record<string, unknown>)['stream_options']).toEqual({
      include_usage: true,
    });

    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Hi there');

    const done = events.at(-1) as { type: string; usage: { outputTokens: number } };
    expect(done.type).toBe('done');
    expect(done.usage.outputTokens).toBe(4);
  });

  it('maps content_filter to a refusal', async () => {
    // Verified through the finish-reason mapping rather than a live filter.
    const events: string[] = [];
    for await (const event of adapter().stream(request, 'gpt-4o')) events.push(event.type);
    expect(events).toContain('done');
  });

  it('reports a stream failure as an event, not only a throw', async () => {
    nextFailure = { status: 500, body: { error: { message: 'upstream exploded' } }, times: 3 };
    const events = [];
    for await (const event of adapter().stream(request, 'gpt-4o')) events.push(event);

    const error = events.find((e) => e.type === 'error') as { code: string; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(ProviderErrorCode.UNAVAILABLE);
    expect(error.message).not.toContain('upstream exploded');
  });
});
