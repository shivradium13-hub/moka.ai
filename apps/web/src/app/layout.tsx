import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MOKA AI',
  description: 'Multi-tenant AI workspace and AI workforce platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
