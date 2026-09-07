import { findLeakyPublicVars } from '@moka/config';

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * BUILD-TIME SECRET GUARD
 *
 * `@moka/config` refuses to start the API if a `NEXT_PUBLIC_` variable looks
 * like a secret. That guard runs in `loadConfig()` — which the WEB app never
 * calls, because it has no server config of its own.
 *
 * That left a real gap, and hosting makes it worse rather than better. On a
 * platform like Vercel, environment variables are set in a dashboard by
 * whoever has access, and anything prefixed `NEXT_PUBLIC_` is inlined into the
 * JavaScript bundle served to every visitor. A `NEXT_PUBLIC_ENCRYPTION_KEY`
 * added by someone in a hurry would be published to the internet by the next
 * deploy, with nothing anywhere refusing.
 *
 * So the same check runs here, at build time, using the same function — one
 * definition of "looks like a secret", not two that drift.
 *
 * It throws rather than warns. A warning in build output is a line nobody
 * reads in a log nobody opens; a failed deploy is a conversation.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const leaky = findLeakyPublicVars(process.env);
if (leaky.length > 0) {
  throw new Error(
    `Refusing to build: these NEXT_PUBLIC_ variables look like secrets and would be ` +
      `inlined into the browser bundle, where every visitor can read them: ${leaky.join(', ')}.\n\n` +
      `Rename them without the NEXT_PUBLIC_ prefix and read them on the server, or — if the ` +
      `value really is public — rename it so it does not read as a secret.`,
  );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript-aware dual builds; Next compiles them
  // in-process rather than requiring a separate watch build during dev.
  transpilePackages: ['@moka/core'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
