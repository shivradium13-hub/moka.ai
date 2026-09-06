import { redirect } from 'next/navigation';
import Link from 'next/link';
import { serverApiOrNull } from '@/lib/api-server';
import { OrganizationSwitcher } from '@/components/organization-switcher';

interface MeResponse {
  user: { id: string };
  organizations: Array<{ organizationId: string; name: string; slug: string; role: string }>;
  activeOrganizationId: string | null;
}

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/projects', label: 'Projects' },
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/agents', label: 'Agents' },
  { href: '/credentials', label: 'Credentials' },
  { href: '/members', label: 'Members' },
  { href: '/settings', label: 'Settings' },
];

/**
 * Authenticated shell.
 *
 * The session is checked on the SERVER before any of this renders. There is no
 * client-side "redirect if not logged in" flash, and no protected content is
 * ever sent to an unauthenticated browser.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await serverApiOrNull<MeResponse>('/v1/auth/me');
  if (!me) redirect('/login');

  const active = me.organizations.find((o) => o.organizationId === me.activeOrganizationId);

  return (
    <div className="min-h-screen">
      <header className="border-b border-[--color-line] bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            MOKA AI
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-2.5 py-1.5 text-sm text-[--color-muted] transition hover:bg-gray-50 hover:text-[--color-ink]"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto">
            <OrganizationSwitcher
              organizations={me.organizations}
              activeOrganizationId={me.activeOrganizationId}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {active ? null : (
          <div className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-900">
            No organization is selected for this session.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
