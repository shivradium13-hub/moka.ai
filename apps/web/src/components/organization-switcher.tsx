'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { browserApi } from '@/lib/api-browser';

interface Organization {
  organizationId: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Organization switcher.
 *
 * Note that switching sends an organization id to the API. That is safe
 * because the API re-verifies membership server-side before writing it to the
 * session — the list rendered here is a convenience, never the authority.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
}: {
  organizations: Organization[];
  activeOrganizationId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function switchTo(organizationId: string) {
    if (organizationId === activeOrganizationId) return;
    setBusy(true);
    try {
      await browserApi('/v1/auth/switch-organization', {
        method: 'POST',
        body: { organizationId },
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await browserApi('/v1/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Active organization"
        disabled={busy || organizations.length === 0}
        value={activeOrganizationId ?? ''}
        onChange={(e) => void switchTo(e.target.value)}
        className="h-8 rounded-lg border border-[--color-line] bg-white px-2 text-xs outline-none focus:border-[--color-accent] disabled:opacity-50"
      >
        {organizations.length === 0 ? <option value="">No organizations</option> : null}
        {organizations.map((org) => (
          <option key={org.organizationId} value={org.organizationId}>
            {org.name} · {org.role}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => void signOut()}
        disabled={busy}
        className="h-8 rounded-lg border border-[--color-line] bg-white px-2.5 text-xs font-medium transition hover:bg-gray-50 disabled:opacity-50"
      >
        Sign out
      </button>
    </div>
  );
}
