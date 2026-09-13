import Link from 'next/link';
import { Wordmark } from './icons';

/**
 * Footer link columns.
 *
 * Every entry points at something that exists. A marketing footer full of
 * dead links to a careers page and a blog nobody has written is the first
 * thing that tells a visitor the rest of the page may be aspirational too.
 */
const COLUMNS = [
  {
    heading: 'Product',
    links: [
      { href: '/product#knowledge', label: 'Knowledge engine' },
      { href: '/product#agents', label: 'Agents' },
      { href: '/product#research', label: 'Research' },
      { href: '/product#chatbots', label: 'Chatbots' },
    ],
  },
  {
    heading: 'Platform',
    links: [
      { href: '/product#gateway', label: 'AI gateway' },
      { href: '/security#vault', label: 'Credential vault' },
      { href: '/security#isolation', label: 'Tenant isolation' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { href: '/security', label: 'Security' },
      { href: '/pricing#faq', label: 'FAQ' },
      { href: '/login', label: 'Sign in' },
      { href: '/signup', label: 'Create an account' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-white">
      <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="max-w-xs">
            <Link href="/" className="flex items-center gap-2.5" aria-label="MOKA AI home">
              <Wordmark className="h-7 w-7" />
              <span className="text-[15px] font-semibold tracking-tight">MOKA AI</span>
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              One workspace for your documents, your agents and your models — with the audit trail
              that makes it usable at work.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-xs font-semibold tracking-[0.12em] text-ink uppercase">
                {column.heading}
              </h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link href={link.href} className="text-sm text-muted transition hover:text-ink">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-line pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} MOKA AI. All rights reserved.</p>
          <p>Built to be auditable: every model call, retrieval and approval is on the record.</p>
        </div>
      </div>
    </footer>
  );
}
