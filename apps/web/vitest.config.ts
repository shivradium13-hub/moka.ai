import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Unit tests for the web app's pure modules only.
 *
 * Server-only modules (api-server.ts imports `server-only` and `next/headers`)
 * are deliberately not tested here — their logic lives in api-shared.ts
 * precisely so it can be tested without a Next.js runtime.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': join(here, 'src') },
  },
});
