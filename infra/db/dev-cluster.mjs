/**
 * Local development database cluster.
 *
 * Creates a throwaway PostgreSQL cluster under ./local/pgdata on port 55432,
 * separate from any PostgreSQL service already installed on this machine.
 *
 * WHY THIS EXISTS
 * The PostgreSQL 17 service on :5432 uses scram-sha-256, so bootstrapping it
 * requires the superuser password. This script needs no password and touches
 * no system service or system configuration: it runs initdb into a directory
 * inside the repo (gitignored) with trust auth, bound to loopback only.
 *
 * It is a DEVELOPMENT convenience. Trust authentication is acceptable here
 * precisely because the cluster is local, loopback-only, on a non-default
 * port, and holds nothing but seed fixtures. Never use this for production —
 * for that, run infra/db/bootstrap.sql against a properly configured server.
 *
 * Usage:
 *   node infra/db/dev-cluster.mjs init     create the cluster and start it
 *   node infra/db/dev-cluster.mjs start
 *   node infra/db/dev-cluster.mjs stop
 *   node infra/db/dev-cluster.mjs status
 *   node infra/db/dev-cluster.mjs destroy  stop and delete all data
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PGDATA = join(REPO_ROOT, 'local', 'pgdata');
const LOGFILE = join(REPO_ROOT, 'local', 'pg.log');
const PORT = 55432;

const APP_PASSWORD = 'moka_dev_app';
const MIGRATOR_PASSWORD = 'moka_dev_migrator';

/** Locate the PostgreSQL binaries without assuming they are on PATH. */
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
        if (existsSync(join(bin, 'initdb.exe'))) return bin;
      }
    }
  }

  for (const candidate of ['/usr/lib/postgresql/17/bin', '/usr/local/pgsql/bin', '/usr/bin']) {
    if (existsSync(join(candidate, 'initdb'))) return candidate;
  }

  throw new Error(
    'Could not locate PostgreSQL binaries. Set PG_BIN to the directory containing initdb.',
  );
}

const PG_BIN = findPgBin();
const exe = (name) => join(PG_BIN, platform() === 'win32' ? `${name}.exe` : name);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function psql(args, database = 'postgres') {
  return run(exe('psql'), [
    '-w',
    '-h', '127.0.0.1',
    '-p', String(PORT),
    '-U', 'postgres',
    '-d', database,
    ...args,
  ]);
}

function isRunning() {
  const result = run(exe('pg_ctl'), ['-D', PGDATA, 'status']);
  return result.status === 0;
}

function waitUntilReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = run(exe('pg_isready'), ['-h', '127.0.0.1', '-p', String(PORT), '-q']);
    if (probe.status === 0) return true;
    // Busy-wait briefly; Atomics.wait is the portable synchronous sleep.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return false;
}

function start() {
  if (!existsSync(PGDATA)) throw new Error('Cluster does not exist. Run: init');
  if (isRunning()) {
    console.log(`Already running on port ${PORT}.`);
    return;
  }

  /*
   * stdio must be 'ignore', NOT piped. The postgres server inherits whatever
   * handles pg_ctl was given and holds them open for its entire lifetime, so
   * a piped spawnSync would block here until the database shut down. `-w` is
   * likewise omitted; readiness is confirmed with pg_isready below.
   */
  const result = spawnSync(
    exe('pg_ctl'),
    ['-D', PGDATA, '-l', LOGFILE, '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, 'start'],
    { stdio: 'ignore' },
  );
  if (result.error) throw result.error;

  if (!waitUntilReady()) {
    throw new Error(`Server did not become ready. See ${LOGFILE}`);
  }
  console.log(`Started on 127.0.0.1:${PORT}`);
}

function stop() {
  if (!existsSync(PGDATA) || !isRunning()) {
    console.log('Not running.');
    return;
  }
  run(exe('pg_ctl'), ['-D', PGDATA, '-m', 'fast', '-w', 'stop']);
  console.log('Stopped.');
}

/** Idempotent: safe to re-run against an existing cluster. */
function init() {
  if (!existsSync(PGDATA)) {
    mkdirSync(join(REPO_ROOT, 'local'), { recursive: true });
    console.log('Creating cluster…');

    const result = run(exe('initdb'), [
      '-D', PGDATA,
      '-U', 'postgres',
      '--auth=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    if (result.status !== 0) {
      throw new Error(`initdb failed:\n${result.stdout}\n${result.stderr}`);
    }
  } else {
    console.log('Cluster already exists.');
  }

  start();

  console.log('Bootstrapping roles and databases…');
  const bootstrap = psql([
    '-v', `app_password='${APP_PASSWORD}'`,
    '-v', `migrator_password='${MIGRATOR_PASSWORD}'`,
    '-f', join(REPO_ROOT, 'infra', 'db', 'bootstrap.sql'),
  ]);
  if (bootstrap.status !== 0) {
    throw new Error(`bootstrap failed:\n${bootstrap.stdout}\n${bootstrap.stderr}`);
  }

  console.log(`
Cluster ready on 127.0.0.1:${PORT}.

Add these to .env (they are development credentials for a loopback-only
throwaway cluster, which is why they can safely live in this file):

  DATABASE_URL=postgresql://moka_app:${APP_PASSWORD}@127.0.0.1:${PORT}/moka_ai
  DATABASE_MIGRATION_URL=postgresql://moka_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:${PORT}/moka_ai
  TEST_DATABASE_URL=postgresql://moka_app:${APP_PASSWORD}@127.0.0.1:${PORT}/moka_ai_test
  TEST_DATABASE_MIGRATION_URL=postgresql://moka_migrator:${MIGRATOR_PASSWORD}@127.0.0.1:${PORT}/moka_ai_test

Then:  pnpm db:migrate && pnpm db:seed
`);
}

function destroy() {
  stop();
  if (existsSync(PGDATA)) {
    rmSync(PGDATA, { recursive: true, force: true });
    console.log('Cluster deleted.');
  }
}

function status() {
  if (!existsSync(PGDATA)) {
    console.log('Cluster does not exist. Run: node infra/db/dev-cluster.mjs init');
    return;
  }
  console.log(isRunning() ? `Running on 127.0.0.1:${PORT}` : 'Stopped.');
}

const commands = { init, start, stop, status, destroy };
const command = process.argv[2] ?? 'status';

if (!(command in commands)) {
  console.error(`Unknown command "${command}". Use: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  commands[command]();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
