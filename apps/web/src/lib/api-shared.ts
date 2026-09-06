/**
 * Shared API-client primitives, safe in both server and client bundles.
 *
 * Deliberately free of `next/headers` (or any other server-only import), so
 * that a client component importing `browserApi` does not drag server-only
 * modules into the browser bundle.
 */

/**
 * The API origin. Genuinely public — it is an origin, not a secret. No
 * credential is ever exposed to the client; the session travels as an
 * httpOnly cookie that JavaScript cannot read.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Build a request URL.
 *
 * Only relative paths are accepted, so a caller can never redirect this client
 * at another origin — the host always comes from configuration.
 */
export function buildUrl(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`API path must start with "/": ${path}`);
  }
  return `${API_URL}${path}`;
}

export async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const errorBody = body as ApiErrorBody;
    throw new ApiError(
      response.status,
      errorBody.error?.code ?? 'UNKNOWN',
      errorBody.error?.message ?? 'Request failed.',
      errorBody.error?.requestId,
    );
  }
  return body as T;
}
