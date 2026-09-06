'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, ErrorNote, Field } from '@/components/ui';

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      await browserApi('/v1/auth/register', {
        method: 'POST',
        body: {
          name: String(form.get('name') ?? ''),
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          organizationName: String(form.get('organizationName') ?? ''),
        },
      });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-up failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1 text-xs text-[--color-muted]">
            You become the owner of a new organization.
          </p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4 p-5">
            <Field label="Your name" name="name" required />
            <Field label="Work email" name="email" type="email" required />
            <Field
              label="Password"
              name="password"
              type="password"
              required
              hint="At least 12 characters."
            />
            <Field label="Organization name" name="organizationName" required />
            <ErrorNote message={error} />
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create workspace'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-[--color-muted]">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-[--color-accent]">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
