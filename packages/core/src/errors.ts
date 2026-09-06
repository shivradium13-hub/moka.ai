/**
 * Typed error taxonomy (docs/architecture.md §38).
 *
 * Invariants enforced here:
 *   - Every error carries a stable machine-readable `code`.
 *   - `publicMessage` is the ONLY text that may reach a client. It never
 *     contains provider detail, SQL, connection strings, or secrets.
 *   - `cause` and stack traces are for logs only and are never serialised
 *     by `toPublicJSON()`.
 */

export const ErrorCode = {
  // --- Authentication ---
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',

  // --- Authorization ---
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  TENANT_CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // --- Validation ---
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // --- Resources ---
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // --- Limits ---
  RATE_LIMITED: 'RATE_LIMITED',

  /**
   * An upstream AI provider failed. The precise, normalised cause is carried
   * in `details.providerCode` so a client can branch on it without this
   * enum having to mirror every provider condition.
   */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',

  // --- Configuration / crypto ---
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  DECRYPTION_FAILED: 'DECRYPTION_FAILED',

  // --- Catch-all ---
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured detail safe to return to a client (never contains secrets). */
export type PublicDetails = Record<string, string | number | boolean | string[]>;

export interface PublicErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: PublicDetails;
    requestId?: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  readonly details: PublicDetails | undefined;
  /** Internal only. Never serialised to a response. */
  readonly internalCause: unknown;

  constructor(params: {
    code: ErrorCode;
    httpStatus: number;
    publicMessage: string;
    details?: PublicDetails;
    /** Internal diagnostic message for logs. Defaults to publicMessage. */
    internalMessage?: string;
    cause?: unknown;
  }) {
    super(params.internalMessage ?? params.publicMessage);
    this.name = new.target.name;
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.publicMessage = params.publicMessage;
    this.details = params.details;
    this.internalCause = params.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * The only serialisation permitted on an outbound response.
   * Deliberately omits `message` (internal), `stack`, and `internalCause`.
   */
  toPublicJSON(requestId?: string): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(this.details ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete errors                                                             */
/* -------------------------------------------------------------------------- */

export class UnauthenticatedError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.UNAUTHENTICATED,
      httpStatus: 401,
      publicMessage: 'Authentication required.',
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class InvalidCredentialsError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.INVALID_CREDENTIALS,
      httpStatus: 401,
      // Deliberately identical whether the account exists or not,
      // to avoid user enumeration.
      publicMessage: 'Invalid email or password.',
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.FORBIDDEN,
      httpStatus: 403,
      publicMessage: 'You do not have access to this resource.',
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class InsufficientPermissionError extends AppError {
  constructor(required: string, internalMessage?: string) {
    super({
      code: ErrorCode.INSUFFICIENT_PERMISSION,
      httpStatus: 403,
      publicMessage: 'You do not have permission to perform this action.',
      details: { required },
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

/**
 * Raised when a request reaches tenant-scoped code without a resolved
 * organization. The system fails closed rather than querying unscoped.
 */
export class TenantContextMissingError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.TENANT_CONTEXT_MISSING,
      httpStatus: 500,
      publicMessage: 'Request could not be processed.',
      internalMessage:
        internalMessage ?? 'Tenant-scoped operation attempted without a TenantContext.',
    });
  }
}

/**
 * Raised when a client supplies an organization identifier that does not
 * match the authenticated context. Always a security event.
 */
export class TenantMismatchError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.TENANT_MISMATCH,
      httpStatus: 403,
      // Identical to a plain 404/403 so it leaks no existence information.
      publicMessage: 'You do not have access to this resource.',
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class ValidationError extends AppError {
  constructor(details?: PublicDetails, internalMessage?: string) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      httpStatus: 400,
      publicMessage: 'The request payload is invalid.',
      ...(details ? { details } : {}),
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, internalMessage?: string) {
    super({
      code: ErrorCode.NOT_FOUND,
      httpStatus: 404,
      publicMessage: `${resource} not found.`,
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class ConflictError extends AppError {
  constructor(publicMessage: string, internalMessage?: string) {
    super({
      code: ErrorCode.CONFLICT,
      httpStatus: 409,
      publicMessage,
      ...(internalMessage ? { internalMessage } : {}),
    });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super({
      code: ErrorCode.RATE_LIMITED,
      httpStatus: 429,
      publicMessage: 'Too many requests. Please retry shortly.',
      details: { retryAfterSeconds },
    });
  }
}

export class ConfigurationError extends AppError {
  constructor(internalMessage: string) {
    super({
      code: ErrorCode.CONFIGURATION_ERROR,
      httpStatus: 500,
      publicMessage: 'Server configuration error.',
      internalMessage,
    });
  }
}

export class DecryptionFailedError extends AppError {
  constructor(internalMessage?: string) {
    super({
      code: ErrorCode.DECRYPTION_FAILED,
      httpStatus: 500,
      publicMessage: 'Stored data could not be read.',
      internalMessage: internalMessage ?? 'AES-GCM authentication failed.',
    });
  }
}

export class InternalError extends AppError {
  constructor(internalMessage: string, cause?: unknown) {
    super({
      code: ErrorCode.INTERNAL,
      httpStatus: 500,
      publicMessage: 'An unexpected error occurred.',
      internalMessage,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** Narrow an unknown thrown value to AppError. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Convert any thrown value into an AppError without leaking its content.
 * Unknown errors collapse to a generic INTERNAL error; the original is
 * preserved on `internalCause` for structured logging only.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  const message = value instanceof Error ? value.message : 'Non-Error value thrown';
  return new InternalError(message, value);
}
