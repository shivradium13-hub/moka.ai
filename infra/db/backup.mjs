/**
 * Database backup (master prompt §46; docs/operations.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT `pg_dump` ACTUALLY DOES AGAINST THIS DATABASE
 *
 * Every tenant table is FORCE ROW LEVEL SECURITY, which applies to the table
 * OWNER as well as to ordinary roles. `pg_dump` reads rows as the connecting
 * role with no `app.current_org_id` bound, so every policy matches nothing.
 *
 * Measured on this installation, dumping `organizations` from the test
 * database:
 *
 *   as moka_migrator, default flags        exit 1, 0 rows
 *     "ERROR: query would be affected by row-level security policy"
 *   as moka_migrator, --enable-row-security exit 0, 0 rows, NO stderr
 *   as a superuser, default flags           exit 0, 19 rows
 *
 * The good news first: pg_dump is SAFE BY DEFAULT. It sets `row_security =
 * off` and refuses to continue when it cannot, rather than quietly writing a
 * partial backup. That is a deliberate safety feature and it works.
 *
 * There are two ways to defeat it, and both are things a person under pressure
 * would plausibly do:
 *
 *   1. `--enable-row-security`. The dump then succeeds — exit 0, empty stderr,
 *      a well-formed file, a complete schema, and ZERO ROWS. This is the
 *      catastrophic case: a nightly job with that flag reports success every
 *      night and is worthless on the one morning it matters.
 *
 *   2. Following the hint pg_dump prints on failure, which is
 *      "To disable the policy for the table's owner, use ALTER TABLE NO FORCE
 *      ROW LEVEL SECURITY." That advice is correct for PostgreSQL in general
 *      and disastrous here: it permanently removes owner-side isolation, so
 *      every migration connection afterwards can read every tenant's rows.
 *      The backup would start working and the isolation model would be gone.
 *
 * So this script requires a role that can bypass RLS, and says why in full —
 * because the person reading the failure at 3am is exactly the person the
 * hint is about to mislead.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node infra/db/backup.mjs                       write to ./local/backups
 *   node infra/db/backup.mjs --out /path/file.dump
 *   node infra/db/backup.mjs --url postgres://…    override the connection
 *
 * The connection must be a SUPERUSER or a role with BYPASSRLS. See
 * docs/operations.md for creating a dedicated `moka_backup` role, which is the
 * right answer in production — a backup job does not need to be a superuser.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import pg from 'pg';
import { config as loadDotenv } from 'dotenv';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadDotenv({ path: join(REPO_ROOT, '.env') });

/** Tables whose emptiness would mean a silently broken backup. */
const CANARY_TABLES = ['organizations', 'organization_members', 'users'];

function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;

  if (platform() === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL';
    if (existsSync(base)) {
      const versions = readdirSync(base)
        .filter((v) => /^\d+$/.test(v))
        .sort((a, b) => Number(b) - Number(a));
      for (const version of versions) {
        const bin = join(base, version, 'bin');
        if (existsSync(join(bin, 'pg_dump.exe'))) return bin;
      }
    }
  }
  for (const candidate of ['/usr/lib/postgresql/17/bin', '/usr/local/pgsql/bin', '/usr/bin']) {
    if (existsSync(join(candidate, 'pg_dump'))) return candidate;
  }
  throw new Error('Could not locate PostgreSQL binaries. Set PG_BIN.');
}

const PG_BIN = findPgBin();
const exe = (name) => join(PG_BIN, platform() === 'win32' ? `${name}.exe` : name);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * The connection used for the dump.
 *
 * `BACKUP_DATABASE_URL` is separate from `DATABASE_URL` on purpose: the
 * application must never hold a credential that can bypass RLS, and a backup
 * job must. Two URLs make that separation explicit rather than incidental.
 */
function backupUrl() {
  const url =
    arg('url') ??
    process.env.BACKUP_DATABASE_URL ??
    process.env.DATABASE_MIGRATION_URL ??
    process.env.DATABASE_URL;

  if (!url) {
    fail(
      'No connection string. Set BACKUP_DATABASE_URL to a superuser or BYPASSRLS role,\n' +
        'or pass --url. See docs/operations.md.',
    );
  }
  return url;
}

function fail(message) {
  console.error(`\nBackup ABORTED.\n\n${message}\n`);
  process.exit(1);
}

/**
 * Refuse to back up as a role that cannot see the data.
 *
 * This is the whole point of the script. Checked BEFORE the dump so the
 * failure costs a second rather than a night, and stated in full because the
 * person reading it at 3am needs the reason, not a code.
 */
async function assertCanBypassRls(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT current_user AS who, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    const role = rows[0];
    if (!role) fail('Could not determine the connecting role.');

    if (!role.rolsuper && !role.rolbypassrls) {
      fail(
        `The role "${role.who}" can neither bypass nor is exempt from row-level security.\n` +
          '\n' +
          'Every tenant table here is FORCE ROW LEVEL SECURITY, which applies to the table\n' +
          'OWNER too. pg_dump reads rows as the connecting role with no organization bound,\n' +
          'so every policy matches nothing and the dump would contain ZERO ROWS of tenant\n' +
          'data — exiting 0, with a well-formed file and a complete schema.\n' +
          '\n' +
          'That failure is silent and is only discovered at restore time.\n' +
          '\n' +
          'Fix: run as a superuser, or create a dedicated backup role:\n' +
          '\n' +
          "  CREATE ROLE moka_backup LOGIN PASSWORD '…' BYPASSRLS;\n" +
          '  GRANT pg_read_all_data TO moka_backup;\n' +
          '\n' +
          'and set BACKUP_DATABASE_URL to it. See docs/operations.md.',
      );
    }

    // Live counts, taken before the dump, to compare against afterwards.
    const counts = {};
    for (const table of CANARY_TABLES) {
      const result = await client.query(`SELECT count(*)::int AS c FROM ${table}`);
      counts[table] = result.rows[0].c;
    }
    return { role: role.who, counts };
  } finally {
    await client.end();
  }
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

async function main() {
  const url = backupUrl();
  const { role, counts } = await assertCanBypassRls(url);

  const empty = Object.entries(counts).filter(([, c]) => c === 0);
  if (empty.length === CANARY_TABLES.length) {
    /*
     * Every canary is empty even with RLS bypassed, so the database genuinely
     * has no data. Backing it up is pointless but not wrong — this is a
     * warning rather than a failure, because a fresh installation is a
     * legitimate thing to back up.
     */
    console.warn(
      'WARNING: this database appears to contain no organizations or users.\n' +
        '  The backup will be taken, but check you are pointed at the right database.',
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out =
    arg('out') ?? join(REPO_ROOT, 'local', 'backups', `moka-${stamp}.dump`);
  mkdirSync(dirname(out), { recursive: true });

  console.log(`Backing up as "${role}" (RLS bypass confirmed)…`);
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table}: ${count} rows`);
  }

  /*
   * Custom format: compressed, and restorable table-by-table with
   * `pg_restore --table`, which matters when the thing being recovered is one
   * tenant's data rather than the whole cluster.
   *
   * Deliberately NOT --no-acl or --no-owner. The grants ARE the security model
   * here — moka_app holds no UPDATE on audit_logs and no write on
   * plan_entitlements — and a restore that dropped them would silently remove
   * controls the application relies on and cannot re-establish for itself.
   */
  const dump = run(exe('pg_dump'), [
    '--dbname',
    url,
    '--format=custom',
    '--compress=6',
    '--file',
    out,
    '--no-password',
  ]);

  if (dump.status !== 0) {
    fail(`pg_dump failed:\n${dump.stderr}`);
  }

  const size = statSync(out).size;

  /*
   * Verify the dump actually contains the tables, by reading its own table of
   * contents. A zero-row dump of a populated database is exactly the failure
   * this script exists to prevent, and checking the precondition is not the
   * same as checking the result.
   */
  const toc = run(exe('pg_restore'), ['--list', out]);
  if (toc.status !== 0) fail(`The dump could not be read back:\n${toc.stderr}`);

  const tableEntries = (toc.stdout.match(/TABLE DATA/g) ?? []).length;
  if (tableEntries === 0 && !empty.length) {
    fail('The dump contains no table data despite the database being populated.');
  }

  console.log(`\nWrote ${out}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB, ${tableEntries} table-data entries`);
  console.log(
    '\nA backup is not a backup until it has been restored. Run the drill:\n' +
      '  pnpm test:drill',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
