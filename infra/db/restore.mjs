/**
 * Database restore (master prompt §46; docs/operations.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT HAS TO SURVIVE A RESTORE, AND WHY IT IS NOT OBVIOUS
 *
 * In most systems a restore is judged on row counts. Here it is not enough.
 * Tenant isolation in this database is enforced by:
 *
 *   - ROW LEVEL SECURITY being ENABLED *and* FORCED on 26 tables;
 *   - 26 policies whose predicates read `current_org_id()`;
 *   - the `current_org_id()` / `current_user_id()` / `current_deployment_key()`
 *     functions those predicates call;
 *   - 37 GRANTs that are themselves controls — `moka_app` holds no UPDATE on
 *     `audit_logs`, no write at all on `plan_entitlements`, no UPDATE or DELETE
 *     on `credit_transactions`.
 *
 * A restore that dropped any of those would produce a database with every row
 * present, every application feature working, and NO TENANT ISOLATION. It
 * would look like a successful recovery.
 *
 * `pg_restore --no-acl` or `--no-owner` does exactly that to the grants. So
 * neither is used here, and `tests/drills/backup-restore.test.ts` verifies the
 * result rather than trusting the flags.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ROLES ARE NOT IN THE DUMP. `pg_dump` of one database does not carry
 * `moka_app` or `moka_migrator`; they are cluster-level objects. Restoring into
 * a fresh cluster therefore needs `infra/db/bootstrap.sql` run first, or every
 * GRANT in the dump fails. The script checks for them and says so, because
 * "role does not exist" repeated 37 times is not a diagnosis.
 *
 * Usage:
 *   node infra/db/restore.mjs --file local/backups/moka-….dump --into moka_ai_restored
 *   node infra/db/restore.mjs --file … --into … --create
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import pg from 'pg';
import { config as loadDotenv } from 'dotenv';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadDotenv({ path: join(REPO_ROOT, '.env') });

const REQUIRED_ROLES = ['moka_app', 'moka_migrator'];

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
        if (existsSync(join(bin, 'pg_restore.exe'))) return bin;
      }
    }
  }
  for (const candidate of ['/usr/lib/postgresql/17/bin', '/usr/local/pgsql/bin', '/usr/bin']) {
    if (existsSync(join(candidate, 'pg_restore'))) return candidate;
  }
  throw new Error('Could not locate PostgreSQL binaries. Set PG_BIN.');
}

const PG_BIN = findPgBin();
const exe = (name) => join(PG_BIN, platform() === 'win32' ? `${name}.exe` : name);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

function fail(message) {
  console.error(`\nRestore ABORTED.\n\n${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

/** The admin connection, used to create the target database and check roles. */
function adminUrl() {
  return (
    arg('admin-url') ??
    process.env.RESTORE_ADMIN_URL ??
    process.env.BACKUP_DATABASE_URL ??
    process.env.DATABASE_MIGRATION_URL
  );
}

async function main() {
  const file = arg('file');
  const target = arg('into');

  if (!file || !target) {
    fail('Both --file and --into are required.\n\nSee docs/operations.md.');
  }
  if (!existsSync(file)) fail(`No such backup file: ${file}`);

  const admin = adminUrl();
  if (!admin) fail('No admin connection. Set RESTORE_ADMIN_URL or pass --admin-url.');

  /*
   * PRODUCTION GUARD (§46).
   *
   * Restoring INTO a database is destructive, and the target of a restore is
   * the one place a typo is unrecoverable. Overwriting a live database
   * requires saying so, out loud, in an environment variable — an argument is
   * too easy to leave in a shell history and re-run.
   */
  if (process.env.NODE_ENV === 'production' && !process.env.MOKA_ALLOW_PRODUCTION_RESTORE) {
    fail(
      'NODE_ENV is production and MOKA_ALLOW_PRODUCTION_RESTORE is not set.\n' +
        '\n' +
        'A restore overwrites the target database. Set that variable deliberately,\n' +
        'in the shell where you are running this, once you are certain of --into.',
    );
  }

  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();

  try {
    const { rows } = await adminClient.query(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)',
      [REQUIRED_ROLES],
    );
    const present = new Set(rows.map((r) => r.rolname));
    const missing = REQUIRED_ROLES.filter((role) => !present.has(role));

    if (missing.length > 0) {
      /*
       * Roles are cluster-level and are NOT in a single-database dump. Without
       * them every GRANT in the restore fails — and those grants are security
       * controls, not conveniences. Better to stop than to produce a database
       * whose privileges are quietly wrong.
       */
      fail(
        `These roles do not exist in the target cluster: ${missing.join(', ')}.\n` +
          '\n' +
          'Roles are cluster-level objects and are not carried in a database dump.\n' +
          'Every GRANT in the restore would fail, leaving a database with the right\n' +
          'rows and the wrong privileges — and those grants are how audit_logs stays\n' +
          'append-only and how the application is stopped from editing its own plan\n' +
          'limits.\n' +
          '\n' +
          'Run infra/db/bootstrap.sql against the target cluster first.',
      );
    }

    if (flag('create')) {
      const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        target,
      ]);
      if (exists.rowCount === 0) {
        // Identifier, not a value, so it cannot be parameterised. Restricted
        // to a conservative character set instead of escaped.
        if (!/^[a-z0-9_]{1,63}$/.test(target)) {
          fail(`Refusing to create a database named "${target}": use [a-z0-9_] only.`);
        }
        await adminClient.query(`CREATE DATABASE ${target}`);
        console.log(`Created database ${target}.`);
      }
    }
  } finally {
    await adminClient.end();
  }

  const targetUrl = new URL(admin);
  targetUrl.pathname = `/${target}`;

  console.log(`Restoring ${file} into ${target}…`);

  /*
   * Deliberately NOT --no-acl and NOT --no-owner.
   *
   * Both are the usual advice for moving a dump between environments, and both
   * would silently discard the GRANTs that make audit_logs append-only, keep
   * the application out of plan_entitlements, and stop it rewriting the credit
   * ledger. The restore would succeed and the database would be wrong.
   *
   * --exit-on-error is on so a failed GRANT stops the restore rather than
   * leaving a half-privileged database that looks fine.
   */
  const restore = run(exe('pg_restore'), [
    '--dbname',
    targetUrl.toString(),
    '--no-password',
    '--exit-on-error',
    '--single-transaction',
    file,
  ]);

  if (restore.status !== 0) {
    fail(`pg_restore failed:\n${restore.stderr}`);
  }

  console.log('\nRestore complete.');
  console.log(
    'Verify it before trusting it — row counts alone do not prove a restore here:\n' +
      '  pnpm test:drill\n' +
      '\n' +
      'RLS, its policies and the grants all have to survive, and a restore that\n' +
      'lost them would look exactly like a successful one.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
