import { redirect } from 'next/navigation';
import { serverApiOrNull } from '@/lib/api-server';

interface MeResponse {
  user: { id: string };
  activeOrganizationId: string | null;
}

/**
 * Entry point. Routing is decided from the SERVER's view of the session, not
 * from client state, so an unauthenticated visitor never briefly renders the
 * application shell.
 */
export default async function Home() {
  const me = await serverApiOrNull<MeResponse>('/v1/auth/me');
  redirect(me ? '/dashboard' : '/login');
}
