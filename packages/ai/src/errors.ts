/**
 * Normalised provider errors (docs/architecture.md §47).
 *
 * Providers report the same conditions in different shapes. Everything above
 * the gateway sees these types instead, so retry, fallback and user-facing
 * messaging are written once rather than per provider.
 *
 * A provider error must NEVER carry the raw upstream body to a client: it can
 * echo request content, quote an organization's prompt, or name internal
 * infrastructure. `publicMessage` is the only field intended for a response.
 */

export const ProviderErrorCode = {
  /** Credentials rejected. Not retryable; the tenant must fix the key. */
  AUTHENTICATION: 'PROVIDER_AUTHENTICATION',
  /** Provider-side rate limit. Retryable after a delay. */
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  /** Request rejected as malformed or unsupported. Not retryable. */
  INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  /** Input exceeded the model's context window. Not retryable as-is. */
  CONTEXT_LENGTH: 'PROVIDER_CONTEXT_LENGTH',
  /** Provider is down or timed out. Retryable, and a fallback may apply. */
  UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Content declined by provider safety systems. Not retryable. */
  CONTENT_FILTERED: 'PROVIDER_CONTENT_FILTERED',
  /** Tenant has no usable credential for this provider. */
  NO_CREDENTIAL: 'PROVIDER_NO_CREDENTIAL',
  /** Anything unrecognised. */
  UNKNOWN: 'PROVIDER_UNKNOWN',
} as const;

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode];

const PUBLIC_MESSAGES: Record<ProviderErrorCode, string> = {
  [ProviderErrorCode.AUTHENTICATION]:
    'The AI provider rejected the configured credentials. Check the credential for this provider.',
  [ProviderErrorCode.RATE_LIMITED]:
    'The AI provider is rate limiting requests. Please retry shortly.',
  [ProviderErrorCode.INVALID_REQUEST]: 'The AI provider rejected this request.',
  [ProviderErrorCode.CONTEXT_LENGTH]:
    'This conversation is too long for the selected model. Shorten it or choose a model with a larger context window.',
  [ProviderErrorCode.UNAVAILABLE]: 'The AI provider is temporarily unavailable.',
  [ProviderErrorCode.CONTENT_FILTERED]:
    'The AI provider declined to respond to this request.',
  [ProviderErrorCode.NO_CREDENTIAL]:
    'No credential is configured for this AI provider.',
  [ProviderErrorCode.UNKNOWN]: 'The AI provider returned an unexpected error.',
};

/** Codes worth retrying, on the same provider, after a delay. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  ProviderErrorCode.RATE_LIMITED,
  ProviderErrorCode.UNAVAILABLE,
]);

/** Codes where trying a DIFFERENT provider or model may succeed. */
const FALLBACKABLE: ReadonlySet<ProviderErrorCode> = new Set([
  ProviderErrorCode.RATE_LIMITED,
  ProviderErrorCode.UNAVAILABLE,
  ProviderErrorCode.AUTHENTICATION,
  ProviderErrorCode.NO_CREDENTIAL,
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly publicMessage: string;

  constructor(params: {
    code: ProviderErrorCode;
    providerId: string;
    modelId?: string | null;
    httpStatus?: number | null;
    retryAfterMs?: number | null;
    /** Diagnostic text for logs only. Never returned to a client. */
    internalMessage?: string;
    cause?: unknown;
  }) {
    super(params.internalMessage ?? PUBLIC_MESSAGES[params.code]);
    this.name = 'ProviderError';
    this.code = params.code;
    this.providerId = params.providerId;
    this.modelId = params.modelId ?? null;
    this.httpStatus = params.httpStatus ?? null;
    this.retryAfterMs = params.retryAfterMs ?? null;
    this.publicMessage = PUBLIC_MESSAGES[params.code];
    if (params.cause !== undefined) this.cause = params.cause;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get shouldFallback(): boolean {
    return FALLBACKABLE.has(this.code);
  }
}

/**
 * Map an HTTP status to a normalised code.
 *
 * Shared by every adapter so the same status means the same thing regardless
 * of provider. Adapters refine this with provider-specific error bodies.
 */
export function codeFromHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return ProviderErrorCode.AUTHENTICATION;
  if (status === 429) return ProviderErrorCode.RATE_LIMITED;
  if (status === 400 || status === 422) return ProviderErrorCode.INVALID_REQUEST;
  if (status === 404) return ProviderErrorCode.INVALID_REQUEST;
  if (status === 408 || status === 504) return ProviderErrorCode.UNAVAILABLE;
  if (status >= 500) return ProviderErrorCode.UNAVAILABLE;
  return ProviderErrorCode.UNKNOWN;
}

/** Parse a Retry-After header (seconds, or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}
