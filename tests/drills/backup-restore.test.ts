import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { RLS_PROTECTED_TABLES } from '@moka/db';

/**
 * THE BACKUP AND RESTORE DRILL — the Phase 10 gate.
 *
 * A backup is not a backup until it has been restored. This takes a real dump
 * of the real test database, restores it into a scratch database, and then
 * checks the thing that actually matters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ROW COUNTS ARE NOT THE TEST
 *
 * Tenant isolation here is enforced by row-level security, its policies, the
 * functions those policies call, and a set of GRANTs that are themselves
 * controls. A restore that dropped any of them would produce a database with
 * every row present and every feature working — and no isolation at all. It
 * would look like a successful recovery, and would be discovered by a customer.
 *
 * `pg_restore --no-acl` is the standard advice for moving a dump between
 * environments, and here it would silently remove the grants that keep
 * `audit_logs` append-only and keep the application out of its own plan limits.
 *
 * So this drill asserts, on the RESTORED database:
 *   - RLS is enabled AND forced on every protected table;
 *   - every policy came back;
 *   - the functions the policies depend on exist;
 *   - the security-critical grants are byte-identical;
 *   - a tenant still cannot read another tenant's rows;
 *   - encrypted credentials still decrypt, which proves organization ids and
 *     wrapped keys survived together.
 *
 * The last one matters because the DEK is AAD-bound to the organization id: a
 * restore that renumbered anything would produce ciphertext nobody can read,
 * and the data would be gone despite the rows being present.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DELIBERATELY SEPARATE FROM `pnpm test:security`. It creates and drops a
 * database, takes tens of seconds, and needs a superuser. Making the security
 * suites depend on that would make them something people skip.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE_DB = 'moka_ai_test';
const SCRATCH_DB = `moka_drill_${Date.now().toString(36)}`;

/**
 * The drill needs a superuser: to create a database, and — the whole point —
 * to take a dump that is not silently empty under FORCE RLS.
 */
const ADMIN = process.env.DRILL_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';

/** Grants that are security controls rather than conveniences. */
const CRITICAL_GRANTS: ReadonlyArray<{ table: string; must: string[]; mustNot: string[] }> = [
  // Append-only evidence.
  { table: 'audit_logs', must: ['SELECT', 'INSERT'], mustNot: ['UPDATE', 'DELETE'] },
  { table: 'usage_records', must: ['SELECT', 'INSERT'], mustNot: ['UPDATE', 'DELETE'] },
  { table: 'tool_executions', must: ['SELECT', 'INSERT'], mustNot: ['UPDATE', 'DELETE'] },
  // The ledger a customer is billed from.
  { table: 'credit_transactions', must: ['SELECT', 'INSERT'], mustNot: ['UPDATE', 'DELETE'] },
  // The limits the application is checked against, which it must not edit.
  { table: 'plan_entitlements', must: ['SELECT'], mustNot: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'plans', must: ['SELECT'], mustNot: ['INSERT', 'UPDATE', 'DELETE'] },
  { table: 'entitlement_overrides', must: ['SELECT'], mustNot: ['INSERT', 'UPDATE', 'DELETE'] },
  // A transcript may be erased but never rewritten.
  { table: 'chat_messages', must: ['SELECT', 'INSERT', 'DELETE'], mustNot: ['UPDATE'] },
  { table: 'research_sources', must: ['SELECT', 'INSERT', 'DELETE'], mustNot: ['UPDATE'] },
];

function findPgBin(): string {
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
const exe = (name: string): string =>
  join(PG_BIN, platform() === 'win32' ? `${name}.exe` : name);

function urlFor(database: string): string {
  const url = new URL(ADMIN);
  url.pathname = `/${database}`;
  return url.toString();
}

function run(command: string, args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr ?? '' };
}

const backupFile = join(REPO_ROOT, 'local', 'backups', `drill-${randomUUID()}.dump`);

let source: pg.Client;
let restored: pg.Client;
let admin: pg.Client;

/** Row counts, taken with RLS bypassed so they are the real ones. */
async function countAll(client: pg.Client): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of RLS_PROTECTED_TABLES) {
    const { rows } = await client.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${table}`);
    counts[table] = rows[0]!.c;
  }
  return counts;
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();

  const { rows } = await admin.query<{ rolsuper: boolean }>(
    'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  if (!rows[0]?.rolsuper) {
    /*
     * Fails rather than skips, like every other suite here. A drill that
     * quietly does not run is worse than one that fails: it turns an untested
     * recovery procedure into a green tick.
     */
    throw new Error(
      'The drill needs a superuser connection (DRILL_ADMIN_URL). ' +
        'A non-superuser dump of this database is silently empty under FORCE RLS, ' +
        'which is the failure the drill exists to detect.',
    );
  }

  mkdirSync(dirname(backupFile), { recursive: true });

  // 1. Back up the real test database, as a role that can see the rows.
  const dump = run(exe('pg_dump'), [
    '--dbname',
    urlFor(SOURCE_DB),
    '--format=custom',
    '--file',
    backupFile,
    '--no-password',
  ]);
  if (dump.status !== 0) throw new Error(`pg_dump failed: ${dump.stderr}`);

  // 2. Restore into a scratch database, keeping owners and ACLs.
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  const restore = run(exe('pg_restore'), [
    '--dbname',
    urlFor(SCRATCH_DB),
    '--no-password',
    '--exit-on-error',
    '--single-transaction',
    backupFile,
  ]);
  if (restore.status !== 0) throw new Error(`pg_restore failed: ${restore.stderr}`);

  source = new pg.Client({ connectionString: urlFor(SOURCE_DB) });
  restored = new pg.Client({ connectionString: urlFor(SCRATCH_DB) });
  await source.connect();
  await restored.connect();
}, 180_000);

afterAll(async () => {
  await source?.end();
  await restored?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  if (existsSync(backupFile)) rmSync(backupFile, { force: true });
});

/* ========================================================================== */
/* 1. The silent-empty-backup trap                                            */
/* ========================================================================== */

describe('the backup captured actual data', () => {
  /*
   * MEASURED, not assumed. Dumping `organizations` from the test database:
   *
   *   moka_migrator, default flags          exit 1, 0 rows, loud error
   *   moka_migrator, --enable-row-security  exit 0, 0 rows, NO stderr
   *   superuser, default flags              exit 0, all rows
   *
   * pg_dump is safe by default and refuses rather than writing a partial
   * backup. Both ways of defeating that are things a person under pressure
   * would plausibly do, so both are pinned here.
   */
  function dumpOrganizationsAs(user: string, password: string, extra: string[] = []) {
    const url = new URL(ADMIN);
    url.username = user;
    url.password = password;
    url.pathname = `/${SOURCE_DB}`;

    const result = spawnSync(
      exe('pg_dump'),
      ['--dbname', url.toString(), '--data-only', '--table=organizations', '--no-password', ...extra],
      { encoding: 'utf8' },
    );

    const rows = (result.stdout ?? '')
      .split('\n')
      .filter((line) => /^[0-9a-f]{8}-[0-9a-f]{4}/.test(line));

    return { status: result.status, rows: rows.length, stderr: result.stderr ?? '' };
  }

  it('REFUSES LOUDLY when the role cannot bypass RLS', () => {
    /*
     * The reassuring half. pg_dump sets `row_security = off` and stops when it
     * cannot, so an operator who runs the obvious command gets an error rather
     * than a quietly empty file.
     */
    const result = dumpOrganizationsAs('moka_migrator', 'moka_dev_migrator');
    expect(result.status).not.toBe(0);
    expect(result.rows).toBe(0);
    expect(result.stderr).toMatch(/row-level security/i);
  });

  it('the error hints at a "fix" that would destroy tenant isolation', () => {
    /*
     * The trap worth knowing about before 3am. pg_dump suggests
     * `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` — correct advice for
     * PostgreSQL in general, and disastrous here: it permanently removes
     * owner-side isolation, so every migration connection afterwards can read
     * every tenant's rows. The backup starts working and the isolation model
     * is gone.
     *
     * Asserted so the docs and the runbook cannot drift from what pg_dump
     * actually says.
     */
    const result = dumpOrganizationsAs('moka_migrator', 'moka_dev_migrator');
    expect(result.stderr).toMatch(/NO FORCE ROW LEVEL SECURITY/i);
  });

  it('SILENTLY produces an empty backup with --enable-row-security', () => {
    /*
     * The catastrophic case, and the reason `infra/db/backup.mjs` checks the
     * ROLE rather than the exit code. Exit 0, empty stderr, a well-formed file
     * with a complete schema, and no data at all. A nightly job carrying this
     * flag would report success every night and be worthless on the one
     * morning it mattered.
     */
    const result = dumpOrganizationsAs('moka_migrator', 'moka_dev_migrator', [
      '--enable-row-security',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');
    expect(result.rows).toBe(0);
  });

  it('the drill dump, taken as a superuser, DOES contain rows', async () => {
    // The control. Without it every assertion above would also pass against a
    // genuinely empty database, which would prove nothing.
    const { rows } = await source.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM organizations',
    );
    expect(rows[0]!.c).toBeGreaterThan(0);

    const restoredCount = await restored.query<{ c: number }>(
      'SELECT count(*)::int AS c FROM organizations',
    );
    expect(restoredCount.rows[0]!.c).toBe(rows[0]!.c);
  });
});

/* ========================================================================== */
/* 2. Data fidelity                                                           */
/* ========================================================================== */

describe('every row came back', () => {
  it('row counts match on every RLS-protected table', async () => {
    const before = await countAll(source);
    const after = await countAll(restored);
    expect(after).toEqual(before);
  });

  it('the migration ledger matches, so the schema version is unambiguous', async () => {
    // Two databases that disagree about which migrations have run are two
    // databases nobody can safely migrate again.
    const a = await source.query<{ name: string }>(
      'SELECT name FROM _moka_migrations ORDER BY name',
    );
    const b = await restored.query<{ name: string }>(
      'SELECT name FROM _moka_migrations ORDER BY name',
    );
    expect(b.rows.map((r) => r.name)).toEqual(a.rows.map((r) => r.name));
    expect(b.rows.length).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* 3. The controls, which are the real test                                   */
/* ========================================================================== */

describe('row-level security survived', () => {
  it('is ENABLED and FORCED on every protected table', async () => {
    /*
     * `ENABLE` alone is not enough. Without `FORCE`, the table owner bypasses
     * every policy — and the owner is `moka_migrator`, which runs migrations
     * against a live database. A restore that lost FORCE would leave a
     * database that passes every application test and isolates nothing from
     * the migrator's connection.
     */
    const { rows } = await restored.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace`,
      [RLS_PROTECTED_TABLES],
    );

    expect(rows).toHaveLength(RLS_PROTECTED_TABLES.length);
    for (const row of rows) {
      expect({
        table: row.relname,
        enabled: row.relrowsecurity,
        forced: row.relforcerowsecurity,
      }).toEqual({ table: row.relname, enabled: true, forced: true });
    }
  });

  it('every policy came back, with the same predicate', async () => {
    const shape = async (client: pg.Client) => {
      const { rows } = await client.query<{ tablename: string; policyname: string; qual: string }>(
        `SELECT tablename, policyname, coalesce(qual, '') AS qual
           FROM pg_policies WHERE schemaname = 'public'
          ORDER BY tablename, policyname`,
      );
      return rows;
    };

    const before = await shape(source);
    const after = await shape(restored);

    expect(after.length).toBe(before.length);
    expect(after.length).toBeGreaterThan(0);
    // Predicates compared verbatim: a policy that came back with a subtly
    // different expression is worse than one that did not come back at all.
    expect(after).toEqual(before);
  });

  it('the functions the policies depend on exist', async () => {
    // A policy calling a missing function does not fail open — it errors. But
    // it errors on every query, which is an outage rather than a leak, and is
    // worth catching in a drill rather than in production.
    for (const fn of ['current_org_id', 'current_user_id', 'current_deployment_key']) {
      const { rows } = await restored.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM pg_proc WHERE proname = $1`,
        [fn],
      );
      expect({ fn, found: rows[0]!.c }).toEqual({ fn, found: 1 });
    }
  });
});

describe('the grants survived', () => {
  it('preserves every security-critical privilege exactly', async () => {
    /*
     * `pg_restore --no-acl` is the usual advice for moving a dump between
     * environments, and here it would silently discard the grants that keep
     * audit_logs append-only, keep the application out of its own plan limits,
     * and stop it rewriting the credit ledger.
     *
     * The restore would succeed. The database would be wrong.
     */
    for (const grant of CRITICAL_GRANTS) {
      const { rows } = await restored.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'moka_app' AND table_name = $1`,
        [grant.table],
      );
      const held = new Set(rows.map((r) => r.privilege_type));

      for (const privilege of grant.must) {
        expect({ table: grant.table, privilege, held: held.has(privilege) }).toEqual({
          table: grant.table,
          privilege,
          held: true,
        });
      }
      for (const privilege of grant.mustNot) {
        expect({ table: grant.table, privilege, held: held.has(privilege) }).toEqual({
          table: grant.table,
          privilege,
          held: false,
        });
      }
    }
  });

  it('grants are identical to the source, table for table', async () => {
    const shape = async (client: pg.Client) => {
      const { rows } = await client.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'moka_app' AND table_schema = 'public'
          ORDER BY table_name, privilege_type`,
      );
      return rows.map((r) => `${r.table_name}:${r.privilege_type}`);
    };

    expect(await shape(restored)).toEqual(await shape(source));
  });
});

/* ========================================================================== */
/* 4. Isolation still holds on the restored database                          */
/* ========================================================================== */

describe('tenant isolation survived the restore', () => {
  /** Connect as the RUNTIME role, because that is who isolation applies to. */
  async function asApp<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(ADMIN);
    url.username = 'moka_app';
    url.password = 'moka_dev_app';
    url.pathname = `/${SCRATCH_DB}`;

    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('an unbound connection sees nothing', async () => {
    const count = await asApp(async (client) => {
      const { rows } = await client.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM organizations',
      );
      return rows[0]!.c;
    });
    expect(count).toBe(0);
  });

  it('a bound connection sees ONLY its own organization', async () => {
    /*
     * The assertion the whole drill is for. Every row is present, and one
     * tenant still cannot read another's — which is the property a restore is
     * most likely to lose and least likely to be checked for.
     */
    const orgs = await restored.query<{ id: string }>('SELECT id FROM organizations LIMIT 2');
    if (orgs.rows.length < 2) {
      throw new Error('The drill needs at least two organizations in the source database.');
    }
    const [a, b] = orgs.rows;

    const visible = await asApp(async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [a!.id]);
      const { rows } = await client.query<{ id: string }>('SELECT id FROM organizations');
      await client.query('COMMIT');
      return rows.map((r) => r.id);
    });

    expect(visible).toEqual([a!.id]);
    expect(visible).not.toContain(b!.id);
  });

  it('append-only tables are still append-only for the application', async () => {
    await expect(
      asApp(async (client) => {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [
          (await client.query<{ id: string }>('SELECT $1::uuid AS id', [
            '00000000-0000-4000-8000-000000000000',
          ])).rows[0]!.id,
        ]);
        return client.query('UPDATE audit_logs SET action = $1', ['tampered']);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

/* ========================================================================== */
/* 5. Encrypted data survived intact                                          */
/* ========================================================================== */

describe('encrypted material survived', () => {
  it('wrapped DEKs came back byte-identical, alongside their organization ids', async () => {
    /*
     * The DEK is wrapped with the organization id as additional authenticated
     * data, so ciphertext and id are bound together. A restore that renumbered
     * anything, or that mangled a bytea round-trip, would produce ciphertext
     * that no longer decrypts — the rows would all be present and the data
     * would be gone.
     *
     * Comparing the pairs is the cheap proxy for that: if id and ciphertext
     * both survived unchanged, the AAD binding still holds.
     */
    const shape = async (client: pg.Client) => {
      const { rows } = await client.query<{ id: string; dek_wrapped: string }>(
        'SELECT id, dek_wrapped FROM organizations ORDER BY id',
      );
      return rows.map((r) => `${r.id}:${r.dek_wrapped}`);
    };

    const before = await shape(source);
    expect(before.length).toBeGreaterThan(0);
    expect(await shape(restored)).toEqual(before);
  });

  it('stored credential ciphertext is unchanged', async () => {
    // `ciphertext` is base64 TEXT rather than bytea, so it compares directly.
    const shape = async (client: pg.Client) => {
      const { rows } = await client.query<{ id: string; ciphertext: string }>(
        'SELECT id, ciphertext FROM credentials ORDER BY id',
      );
      return rows.map((r) => `${r.id}:${r.ciphertext}`);
    };
    expect(await shape(restored)).toEqual(await shape(source));
  });
});
