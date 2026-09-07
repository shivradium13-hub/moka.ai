import { defineConfig } from 'vitest/config';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(here, '..', '.env') });

/**
 * Operational drills.
 *
 * Separate from `pnpm test:security` because these create and drop databases,
 * take tens of seconds, and need a superuser connection. Making the security
 * suites depend on all three would make them something people skip — and a
 * security suite that gets skipped is worse than one that is slow.
 *
 * They still FAIL rather than skip when their preconditions are missing. An
 * untested recovery procedure that reports a green tick is the exact thing a
 * drill exists to prevent.
 */
export default defineConfig({
  test: {
    include: ['drills/**/*.test.ts'],
    root: here,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
