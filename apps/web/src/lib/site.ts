/**
 * The canonical public origin of this deployment.
 *
 * Needed the moment a marketing site exists: `robots.txt`, `sitemap.xml` and
 * Open Graph tags all have to emit ABSOLUTE urls, and a crawler cannot resolve
 * a relative one. The application shell never needed this, which is why it did
 * not exist before.
 *
 * Resolution order, most specific first:
 *
 * 1. `NEXT_PUBLIC_SITE_URL` — set this once a real domain is attached. It is
 *    the only value that survives a domain change, so it wins.
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` — supplied by Vercel at build time as a
 *    bare hostname (no scheme). Using it means a fresh deploy emits correct
 *    absolute urls with nothing configured, instead of advertising localhost
 *    to Google. It is deliberately the PRODUCTION url rather than `VERCEL_URL`:
 *    `VERCEL_URL` is the per-deployment hostname, so canonicals built from it
 *    would point at a preview that stops existing.
 * 3. localhost, for development.
 *
 * No trailing slash, so callers can concatenate a path that starts with one.
 */
function resolveSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, '');

  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelHost) return `https://${vercelHost.replace(/\/+$/, '')}`;

  return 'http://localhost:3000';
}

export const SITE_URL = resolveSiteUrl();

/** Absolute url for a site-relative path. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The public, indexable pages.
 *
 * One list, read by both the sitemap and the crawl rules, so a page cannot end
 * up in the sitemap while being disallowed — an inconsistency that Search
 * Console reports as an error and that nobody notices for a month.
 */
export const PUBLIC_ROUTES = ['/', '/product', '/pricing', '/security'] as const;

/**
 * Paths no crawler should follow.
 *
 * `/dashboard` and the rest answer a redirect to `/login` for an anonymous
 * request, so they are not a data-leak risk — but they are also not content,
 * and letting a crawler spend its budget on them is pure waste.
 */
export const DISALLOWED_ROUTES = [
  '/dashboard',
  '/projects',
  '/knowledge',
  '/agents',
  '/research',
  '/chatbots',
  '/inbox',
  '/credentials',
  '/usage',
  '/members',
  '/settings',
  '/login',
  '/signup',
] as const;
