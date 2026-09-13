'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Wordmark } from './icons';

const LINKS = [
  { href: '/product', label: 'Product' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/security', label: 'Security' },
];

/**
 * Public site header.
 *
 * A client component only because of the mobile disclosure and the active-link
 * highlight; everything else on the marketing site stays a server component.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Navigating with the menu open would otherwise leave it covering the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5" aria-label="MOKA AI home">
          <Wordmark className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight">MOKA AI</span>
        </Link>

        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(link.href) ? 'page' : undefined}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition hover:bg-chalk ${
                isActive(link.href) ? 'text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-9 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-white transition hover:bg-accent"
          >
            Start free
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line md:hidden"
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            aria-hidden="true"
            className="h-5 w-5"
          >
            {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {open ? (
        <div id="mobile-nav" className="border-t border-line bg-white px-5 py-4 md:hidden">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(link.href) ? 'page' : undefined}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-ink hover:bg-chalk"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            <Link
              href="/login"
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-ink hover:bg-chalk"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-ink px-4 text-sm font-semibold text-white"
            >
              Start free
            </Link>
          </div>
        </div>
      ) : null}
    </header>
  );
}
