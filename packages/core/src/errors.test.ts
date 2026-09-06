import { describe, expect, it } from 'vitest';
import {
  AppError,
  ErrorCode,
  InternalError,
  InvalidCredentialsError,
  NotFoundError,
  TenantMismatchError,
  ValidationError,
  isAppError,
  toAppError,
} from './errors.js';

describe('AppError serialisation', () => {
  /*
   * §38: internal detail must never cross the response boundary.
   */
  it('omits the internal message, stack and cause from toPublicJSON', () => {
    const error = new AppError({
      code: ErrorCode.INTERNAL,
      httpStatus: 500,
      publicMessage: 'An unexpected error occurred.',
      internalMessage: 'connection to postgresql://moka_app:hunter2@localhost failed',
      cause: new Error('ECONNREFUSED 127.0.0.1:5432'),
    });

    const body = error.toPublicJSON('req-123');
    const serialised = JSON.stringify(body);

    expect(body.error.message).toBe('An unexpected error occurred.');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('postgresql://');
    expect(serialised).not.toContain('ECONNREFUSED');
    expect(serialised).not.toContain('stack');
  });

  it('includes the request id when supplied', () => {
    expect(new NotFoundError('Project').toPublicJSON('req-9').error.requestId).toBe('req-9');
    expect(new NotFoundError('Project').toPublicJSON().error.requestId).toBeUndefined();
  });

  it('carries a stable machine-readable code', () => {
    expect(new NotFoundError('Project').toPublicJSON().error.code).toBe(ErrorCode.NOT_FOUND);
    expect(new ValidationError().toPublicJSON().error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('keeps the internal message available for logging', () => {
    const error = new InternalError('detailed diagnostic for the log');
    expect(error.message).toBe('detailed diagnostic for the log');
    expect(error.publicMessage).toBe('An unexpected error occurred.');
  });
});

describe('user-enumeration resistance', () => {
  it('returns an identical message whether or not the account exists', () => {
    const missingAccount = new InvalidCredentialsError('no user row for that email');
    const wrongPassword = new InvalidCredentialsError('argon2 verify returned false');
    expect(missingAccount.publicMessage).toBe(wrongPassword.publicMessage);
    expect(missingAccount.httpStatus).toBe(wrongPassword.httpStatus);
  });

  it('makes a tenant mismatch indistinguishable from ordinary denial', () => {
    expect(new TenantMismatchError().publicMessage).toBe(
      'You do not have access to this resource.',
    );
  });
});

describe('toAppError', () => {
  it('passes AppErrors through unchanged', () => {
    const original = new NotFoundError('Project');
    expect(toAppError(original)).toBe(original);
  });

  it('collapses unknown errors to INTERNAL without leaking their content', () => {
    const converted = toAppError(new Error('secret internal detail'));
    expect(converted.code).toBe(ErrorCode.INTERNAL);
    expect(converted.publicMessage).toBe('An unexpected error occurred.');
    expect(JSON.stringify(converted.toPublicJSON())).not.toContain('secret internal detail');
  });

  it('handles non-Error thrown values', () => {
    expect(toAppError('a thrown string').code).toBe(ErrorCode.INTERNAL);
    expect(toAppError(null).code).toBe(ErrorCode.INTERNAL);
    expect(toAppError({ weird: true }).code).toBe(ErrorCode.INTERNAL);
  });

  it('narrows correctly', () => {
    expect(isAppError(new NotFoundError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});

describe('http status mapping', () => {
  it('maps each error to the expected status', () => {
    expect(new ValidationError().httpStatus).toBe(400);
    expect(new InvalidCredentialsError().httpStatus).toBe(401);
    expect(new TenantMismatchError().httpStatus).toBe(403);
    expect(new NotFoundError('Project').httpStatus).toBe(404);
    expect(new InternalError('x').httpStatus).toBe(500);
  });
});
