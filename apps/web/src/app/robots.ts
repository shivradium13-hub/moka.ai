import type { MetadataRoute } from 'next';
import { DISALLOWED_ROUTES, PUBLIC_ROUTES, absoluteUrl } from '@/lib/site';

/**
 * Served at /robots.txt.
 *
 * Generated rather than written by hand so it cannot drift from the route
 * list in `lib/site.ts` — a sitemap advertising a path that robots.txt
 * disallows is a Search Console error nobody sees for a month.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: [...PUBLIC_ROUTES],
      disallow: [...DISALLOWED_ROUTES],
    },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
