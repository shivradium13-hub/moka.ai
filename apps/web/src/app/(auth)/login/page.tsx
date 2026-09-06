'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, ErrorNote, Field } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      await browserApi('/v1/auth/login', {
        method: 'POST',
        body: {
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
        },
      });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      // Show the API's message verbatim. It is deliberately identical for
      // "no such account" and "wrong password", so this cannot be used to
      // enumerate users.
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">MOKA AI</h1>
          <p className="mt-1 text-xs text-[--color-muted]">Sign in to your workspace</p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4 p-5">
            <Field label="Email" name="email" type="email" required placeholder="you@company.com" />
            <Field label="Password" name="password" type="password" required />
            <ErrorNote message={error} />
            <Button type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-[--color-muted]">
          No account?{' '}
          <Link href="/signup" className="font-medium text-[--color-accent]">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
