import type { MetadataRoute } from 'next';
import { PUBLIC_ROUTES, absoluteUrl } from '@/lib/site';

/**
 * Served at /sitemap.xml.
 *
 * `lastModified` is the build time, which is honest here: these pages are
 * static and change only when the site is rebuilt. Writing a hand-maintained
 * date per page would go stale the first time somebody edited copy without
 * remembering to touch it.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: absoluteUrl(route),
    lastModified,
    changeFrequency: 'monthly' as const,
    // The home page is the entry point; the rest are equal to each other.
    priority: route === '/' ? 1 : 0.8,
  }));
}
