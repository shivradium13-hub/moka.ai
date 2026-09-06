import { buildUrl, parseResponse } from './api-shared';

/**
 * BROWSER-side API access.
 *
 * `credentials: 'include'` sends the httpOnly session cookie; the API's CORS
 * policy names the permitted origins explicitly, so this cannot be exercised
 * from an arbitrary site.
 */
export async function browserApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(buildUrl(path), {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return parseResponse<T>(response);
}
