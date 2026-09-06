/**
 * Provider-agnostic AI types (docs/architecture.md §3, §17).
 *
 * These are MOKA's own shapes, not any provider's. Every adapter translates
 * into and out of them, so nothing above the gateway ever sees a provider
 * wire format — that is what makes swapping or adding a provider a contained
 * change rather than a rewrite.
 */

export const Role = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImagePart {
  readonly type: 'image';
  /** base64-encoded bytes. URLs are not accepted: fetching one would be SSRF. */
  readonly data: string;
  readonly mimeType: string;
}

export type ContentPart = TextPart | ImagePart;

export interface Message {
  readonly role: Role;
  readonly content: string | readonly ContentPart[];
}

/**
 * Capabilities a request may require. The router selects a model that has all
 * of them (docs/architecture.md §17).
 */
export const Capability = {
  TEXT: 'text',
  VISION: 'vision',
  TOOLS: 'tools',
  REASONING: 'reasoning',
  LONG_CONTEXT: 'long_context',
  FAST: 'fast',
  CHEAP: 'cheap',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export interface ChatRequest {
  /** Explicit model id, or null to let the router choose. */
  readonly model: string | null;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Capabilities the chosen model must have. Used only when `model` is null. */
  readonly requiredCapabilities?: readonly Capability[];
  /**
   * Reasoning depth. Maps to Anthropic's `output_config.effort` and is
   * approximated elsewhere; adapters document their own mapping.
   */
  readonly effort?: 'low' | 'medium' | 'high';
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens written to a provider prompt cache, where reported. */
  readonly cacheWriteTokens: number;
  /** Tokens served from a provider prompt cache, where reported. */
  readonly cacheReadTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};

/**
 * Why generation stopped.
 *
 * `refusal` is modelled explicitly rather than folded into `stop`: a refusal
 * is a normal, successful HTTP response that callers must handle differently
 * from a completed answer.
 */
export const FinishReason = {
  STOP: 'stop',
  MAX_TOKENS: 'max_tokens',
  TOOL_USE: 'tool_use',
  REFUSAL: 'refusal',
  ERROR: 'error',
} as const;

export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];

export interface ChatResponse {
  readonly text: string;
  /** Reasoning summary, where the model returns one and it was requested. */
  readonly reasoning?: string;
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly providerId: string;
  readonly modelId: string;
  /** Wall-clock latency of the provider call, in milliseconds. */
  readonly latencyMs: number;
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

export interface StreamTextDelta {
  readonly type: 'text';
  readonly text: string;
}

export interface StreamReasoningDelta {
  readonly type: 'reasoning';
  readonly text: string;
}

export interface StreamDone {
  readonly type: 'done';
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
}

/**
 * A stream may end in an error AFTER content has already been emitted, so
 * failure is an event in the stream rather than only a thrown exception.
 */
export interface StreamError {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

export type StreamEvent = StreamTextDelta | StreamReasoningDelta | StreamDone | StreamError;

/* -------------------------------------------------------------------------- */
/* Model registry                                                              */
/* -------------------------------------------------------------------------- */

export interface ModelPricing {
  /** USD per million input tokens. */
  readonly inputPerMillion: number;
  /** USD per million output tokens. */
  readonly outputPerMillion: number;
  readonly cacheWritePerMillion?: number;
  readonly cacheReadPerMillion?: number;
  /** Where these figures came from, and when. Cost is money — cite the source. */
  readonly source: string;
  /** ISO date the figures were last confirmed. */
  readonly verifiedOn: string;
}

export interface ModelDescriptor {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: readonly Capability[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /**
   * NULL when authoritative pricing is not available in this build.
   * Cost is then reported as unknown rather than estimated — a fabricated
   * cost figure is worse than none (§45).
   */
  readonly pricing: ModelPricing | null;
  /** Lower is preferred when several models satisfy a request equally. */
  readonly routingPriority: number;
  readonly status: 'available' | 'deprecated';
}
