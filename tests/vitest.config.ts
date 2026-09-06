import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, '..', '.env') });

/**
 * Security suites run against a REAL PostgreSQL database.
 *
 * They are a separate vitest project from the unit tests so that `pnpm test`
 * stays fast and hermetic, while `pnpm test:security` exercises the database
 * layer. Both must pass before Phase 1 is complete.
 */
export default defineConfig({
  test: {
    include: ['security/**/*.test.ts'],
    root: here,
    // Suites share tenant fixtures and a single database; running them
    // sequentially keeps failures readable and avoids cross-suite contention.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
