import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * MOKA AI lint configuration.
 *
 * Two rules here are SECURITY CONTROLS, not style preferences:
 *
 *  1. Raw HTTP clients are banned outside `packages/net`. All outbound
 *     traffic must pass through `safeFetch`, the single SSRF-guarded
 *     egress point (docs/security.md §5).
 *
 *  2. Raw database pool/client access is banned outside `packages/db`.
 *     Every tenant query must go through the scoped repository so that
 *     `SET LOCAL app.current_org_id` is always applied
 *     (docs/security.md §2.3).
 *
 * Removing either rule requires a security review.
 */

const RESTRICTED_HTTP = [
  { name: 'axios', message: 'Use safeFetch from @moka/net. Raw HTTP clients bypass SSRF protection.' },
  { name: 'node-fetch', message: 'Use safeFetch from @moka/net. Raw HTTP clients bypass SSRF protection.' },
  { name: 'got', message: 'Use safeFetch from @moka/net. Raw HTTP clients bypass SSRF protection.' },
  { name: 'undici', message: 'Use safeFetch from @moka/net. Raw HTTP clients bypass SSRF protection.' },
  { name: 'request', message: 'Use safeFetch from @moka/net. Raw HTTP clients bypass SSRF protection.' },
];

const RESTRICTED_DB = [
  { name: 'pg', message: 'Use the scoped repository from @moka/db. Raw pool access bypasses RLS binding.' },
  { name: 'postgres', message: 'Use the scoped repository from @moka/db. Raw pool access bypasses RLS binding.' },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.config.*', '**/drizzle/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // SECURITY: outbound HTTP is confined to packages/net
  //
  // apps/web/src/lib/api-{server,browser}.ts are the documented exceptions.
  // Both build URLs only from the configured API origin, via buildUrl(), which
  // rejects any path that is not relative — so neither can be pointed at an
  // attacker-chosen host.
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ignores: ['packages/net/**', 'apps/web/src/lib/api-server.ts', 'apps/web/src/lib/api-browser.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use safeFetch from @moka/net (SSRF protection).' },
      ],
      'no-restricted-imports': ['error', { paths: RESTRICTED_HTTP }],
    },
  },

  // SECURITY: raw database access is confined to packages/db
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [...RESTRICTED_HTTP, ...RESTRICTED_DB] }],
    },
  },

  // NestJS resolves constructor dependencies from `design:paramtypes`, which
  // only exists for VALUE imports. Mechanically rewriting a constructor
  // parameter's import to `import type` erases that metadata and breaks
  // injection at runtime with no compile-time signal. The rule is therefore
  // off for the API rather than left as noise that invites a bad --fix.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // Tests may use raw clients to assert on the layers below.
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
