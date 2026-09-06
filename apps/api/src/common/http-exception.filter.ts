import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCode, toAppError, redactValue } from '@moka/core';
import { ProviderError, ProviderErrorCode } from '@moka/ai';
import { getLogger } from './logger.js';

/**
 * Centralised error handling (docs/architecture.md §38).
 *
 * Guarantees:
 *   - No stack trace, SQL, connection string or provider detail ever reaches
 *     the client. Only `AppError.toPublicJSON()` is serialised.
 *   - Every response carries the request id, so a user can quote it and an
 *     operator can find the full detail in the logs.
 *   - 5xx is logged at error level with the internal cause; 4xx at warn
 *     without it, so client mistakes do not drown out real failures.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = (request as FastifyRequest & { requestId?: string }).requestId;

    const appError = this.normalise(exception);
    const logger = getLogger();

    const logPayload = {
      requestId,
      method: request.method,
      url: request.url,
      statusCode: appError.httpStatus,
      errorCode: appError.code,
    };

    if (appError.httpStatus >= 500) {
      logger.error(
        {
          ...logPayload,
          // Redacted, and only ever written to the log — never to the response.
          internalMessage: appError.message,
          cause: redactValue(appError.internalCause),
          stack: appError.stack,
        },
        'request failed',
      );
    } else {
      logger.warn(logPayload, 'request rejected');
    }

    void reply
      .status(appError.httpStatus)
      .header('cache-control', 'no-store')
      .send(appError.toPublicJSON(requestId));
  }

  /**
   * Map anything thrown into an AppError.
   *
   * Nest's own HttpException messages are framework-generated and safe, so
   * their status and text are preserved. Everything else collapses to a
   * generic INTERNAL error rather than risking a leak.
   */
  private normalise(exception: unknown): AppError {
    if (exception instanceof AppError) return exception;
    if (exception instanceof ProviderError) return this.fromProviderError(exception);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);

      return new AppError({
        code: status >= 500 ? ErrorCode.INTERNAL : this.codeForStatus(status),
        httpStatus: status,
        publicMessage: Array.isArray(message) ? message.join('; ') : message,
        internalMessage: exception.message,
        cause: exception,
      });
    }

    return toAppError(exception);
  }

  /**
   * Map a normalised provider failure onto an HTTP response.
   *
   * Only `publicMessage` crosses the boundary — a provider's own error text
   * can quote the request that caused it. The status distinguishes the three
   * cases a caller can act on: their request is wrong (4xx), they are being
   * throttled (429), or the platform's provider configuration is at fault
   * (5xx), which is not something retrying differently will fix.
   */
  private fromProviderError(error: ProviderError): AppError {
    const STATUS: Record<string, number> = {
      [ProviderErrorCode.INVALID_REQUEST]: 400,
      [ProviderErrorCode.CONTEXT_LENGTH]: 400,
      [ProviderErrorCode.CONTENT_FILTERED]: 422,
      [ProviderErrorCode.RATE_LIMITED]: 429,
      [ProviderErrorCode.AUTHENTICATION]: 502,
      [ProviderErrorCode.UNKNOWN]: 502,
      [ProviderErrorCode.NO_CREDENTIAL]: 503,
      [ProviderErrorCode.UNAVAILABLE]: 503,
    };

    const httpStatus = STATUS[error.code] ?? 502;

    // A throttled provider is reported as RATE_LIMITED so clients with generic
    // 429 retry handling react correctly without special-casing providers.
    const code =
      error.code === ProviderErrorCode.RATE_LIMITED
        ? ErrorCode.RATE_LIMITED
        : ErrorCode.PROVIDER_ERROR;

    return new AppError({
      code,
      httpStatus,
      publicMessage: error.publicMessage,
      details: {
        providerCode: error.code,
        provider: error.providerId,
        retryable: error.retryable,
        ...(error.modelId ? { model: error.modelId } : {}),
        ...(error.retryAfterMs ? { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) } : {}),
      },
      internalMessage: error.message,
      cause: error,
    });
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ErrorCode.VALIDATION_FAILED;
      case 401:
        return ErrorCode.UNAUTHENTICATED;
      case 403:
        return ErrorCode.FORBIDDEN;
      case 404:
        return ErrorCode.NOT_FOUND;
      case 409:
        return ErrorCode.CONFLICT;
      case 429:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL;
    }
  }
}
