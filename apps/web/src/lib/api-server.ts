import 'server-only';
import { cookies } from 'next/headers';
import { buildUrl, isUnavailable, parseResponse } from './api-shared';

/**
 * SERVER-side API access.
 *
 * `import 'server-only'` makes it a build error for a client component to
 * import this module, rather than a runtime surprise — the mistake is caught
 * by the compiler instead of by a broken bundle.
 */

/** Forwards the incoming session cookie so server components render as the signed-in user. */
export async function serverApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const response = await fetch(buildUrl(path), {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  });

  return parseResponse<T>(response);
}

/**
 * Returns null instead of throwing when a resource is unavailable to the
 * caller, so a page can degrade gracefully or render its own 404.
 *
 * See `isUnavailable` for which statuses count, and why 404 is one of them.
 */
export async function serverApiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await serverApi<T>(path);
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  }
}
