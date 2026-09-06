/**
 * Migration runner (docs/database.md §13).
 *
 * Deliberately hand-rolled rather than drizzle-kit's runner. This schema is
 * RLS-heavy: policies, GRANTs and role ownership have to land in the same
 * transaction as the tables they protect, and a generated diff cannot express
 * that ordering. drizzle-kit is still useful for REVIEWING a diff, but the
 * committed migration is the hand-written SQL in ./drizzle.
 *
 * Properties:
 *   - Each file runs inside a single transaction (PostgreSQL DDL is transactional).
 *   - Applied files are recorded with a checksum; editing an applied migration
 *     is detected and refused rather than silently ignored.
 *   - Destructive statements are reported before they run.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');

loadDotenv({ path: join(here, '..', '..', '..', '.env') });

const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+COLUMN\b.*\bTYPE\b/i,
];

function checksum(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'DATABASE_MIGRATION_URL (or DATABASE_URL) is not set.\n' +
        'Copy .env.example to .env and fill it in, then run infra/db/bootstrap.sql first.',
    );
    process.exit(1);
  }

  // Redact credentials before echoing the target.
  const safeTarget = url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  console.warn(`Migrating: ${safeTarget}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _moka_migrations (
        name        text PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _moka_migrations',
    );
    for (const row of rows) applied.set(row.name, row.checksum);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    if (files.length === 0) {
      console.warn('No migration files found.');
      return;
    }

    let ran = 0;
    for (const file of files) {
      const sqlText = await readFile(join(migrationsDir, file), 'utf8');
      const sum = checksum(sqlText);
      const previous = applied.get(file);

      if (previous) {
        if (previous !== sum) {
          throw new Error(
            `Migration ${file} has been modified after being applied.\n` +
              `Applied migrations are immutable — add a new migration instead.`,
          );
        }
        continue;
      }

      const destructive = DESTRUCTIVE.filter((p) => p.test(sqlText));
      if (destructive.length > 0) {
        console.warn(`  ! ${file} contains destructive statements — review before production use.`);
      }

      console.warn(`  → applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO _moka_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          sum,
        ]);
        await client.query('COMMIT');
        ran += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed and was rolled back: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    console.warn(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
