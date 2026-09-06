import { describe, expect, it } from 'vitest';
import { ApiError, buildUrl, isUnavailable, parseResponse } from './api-shared';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildUrl', () => {
  it('prefixes the configured API origin', () => {
    expect(buildUrl('/v1/projects')).toMatch(/\/v1\/projects$/);
  });

  /*
   * SECURITY: this client must only ever reach the configured API origin.
   * Rejecting non-relative paths means a value that reached a call site from
   * user input or another service cannot redirect the request elsewhere.
   */
  describe('rejects anything that is not a relative path', () => {
    const hostile = [
      'https://evil.test/steal',
      'http://evil.test',
      '//evil.test/protocol-relative',
      'evil.test/v1',
      '\\\\evil.test\\share',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '',
      ' /v1/projects',
    ];

    for (const path of hostile) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => buildUrl(path)).toThrow(/must start with/);
      });
    }
  });

  it('accepts ordinary relative paths', () => {
    for (const path of ['/v1/auth/me', '/v1/knowledge/sources', '/health']) {
      expect(() => buildUrl(path)).not.toThrow();
    }
  });
});

describe('parseResponse', () => {
  it('returns the parsed body on success', async () => {
    await expect(parseResponse(jsonResponse(200, { ok: true }))).resolves.toEqual({ ok: true });
  });

  it('tolerates an empty body', async () => {
    await expect(parseResponse(new Response('', { status: 200 }))).resolves.toEqual({});
  });

  it('throws ApiError carrying status, code and requestId', async () => {
    const response = jsonResponse(403, {
      error: { code: 'FORBIDDEN', message: 'You do not have access.', requestId: 'req-7' },
    });

    await expect(parseResponse(response)).rejects.toThrow(ApiError);
    try {
      await parseResponse(jsonResponse(403, {
        error: { code: 'FORBIDDEN', message: 'You do not have access.', requestId: 'req-7' },
      }));
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.status).toBe(403);
      expect(apiError.code).toBe('FORBIDDEN');
      expect(apiError.requestId).toBe('req-7');
    }
  });

  it('carries field-level details, where the actionable message lives', async () => {
    try {
      await parseResponse(
        jsonResponse(400, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request payload is invalid.',
            details: { file: 'Unsupported file type.' },
          },
        }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).details).toEqual({ file: 'Unsupported file type.' });
    }
  });

  it('falls back sensibly on a malformed error body', async () => {
    try {
      await parseResponse(jsonResponse(500, {}));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('UNKNOWN');
      expect((error as ApiError).message).toBe('Request failed.');
    }
  });
});

/**
 * Regression guard.
 *
 * 404 was originally missing here, so a user opening another organization's
 * resource got an unhandled 500 instead of a clean "not found" page. Under RLS
 * a foreign resource is genuinely invisible, so 404 is the API's correct answer
 * and the web tier must treat it as "unavailable", not as a server fault.
 */
describe('isUnavailable', () => {
  it('treats 401, 403 and 404 as unavailable', () => {
    for (const status of [401, 403, 404]) {
      expect(isUnavailable(new ApiError(status, 'X', 'msg')), String(status)).toBe(true);
    }
  });

  it('does NOT swallow real failures', () => {
    for (const status of [400, 409, 429, 500, 502, 503]) {
      expect(isUnavailable(new ApiError(status, 'X', 'msg')), String(status)).toBe(false);
    }
  });

  it('ignores non-ApiError values', () => {
    expect(isUnavailable(new Error('network down'))).toBe(false);
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
    expect(isUnavailable('404')).toBe(false);
  });
});
