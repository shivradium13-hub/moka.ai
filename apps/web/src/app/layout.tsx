import type { Metadata, Viewport } from 'next';
import { SITE_URL } from '@/lib/site';
import './globals.css';

/**
 * `template` appends the product name to every page title except those that
 * set an absolute one, so a browser tab or a search result is identifiable
 * without each page repeating the brand by hand.
 */
export const metadata: Metadata = {
  // Without this, Next emits Open Graph urls relative to the page, which no
  // crawler or link unfurler can resolve. See `lib/site.ts` for how the origin
  // is derived on Vercel when no domain is configured yet.
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'MOKA AI — the AI workspace your compliance team can sign off on',
    template: '%s · MOKA AI',
  },
  description:
    'Documents, agents, research and customer chatbots in one multi-tenant AI workspace — with the audit trail that makes it usable at work.',
  applicationName: 'MOKA AI',
  openGraph: {
    type: 'website',
    siteName: 'MOKA AI',
    title: 'MOKA AI — the AI workspace your compliance team can sign off on',
    description:
      'Every model call metered, every citation traced to a page actually fetched, every consequential action approved by a human.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'MOKA AI',
    description:
      'One workspace for your documents, your agents and your models — with the audit trail that makes it usable at work.',
  },
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
