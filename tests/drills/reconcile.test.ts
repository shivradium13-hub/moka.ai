import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  appClient,
  cleanupTenant,
  createTenant,
  migratorClient,
  requireDatabaseUrl,
  type TestTenant,
} from '../helpers/db.js';

/**
 * DRILL — CREDIT RECONCILIATION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TESTING THE MONITORING, NOT THE THING MONITORED
 *
 * `infra/billing/reconcile.mjs` is an alerting tool: it compares the cached
 * balance against the authoritative ledger and exits 2 when they disagree. Its
 * whole value is that it fires on a real divergence, and nothing about running
 * it against a healthy database establishes that. A monitor asserted only in
 * the good case has never been observed to fire, and there is no evidence it
 * can.
 *
 * There is a second, sharper failure this drill exists for. The tool needs a
 * connection that can see every organization's ledger. Run it as a role that
 * is subject to row-level security and — with no `app.current_org_id` bound —
 * both tables read as empty, every organization trivially reconciles, and the
 * tool prints a confident all-clear having examined nothing at all.
 *
 * That is the same silent-empty shape as a non-superuser `pg_dump`, and it is
 * worse here: a backup that is empty is discovered at restore time, whereas a
 * monitor that is empty is never discovered, because its output is exactly
 * what you were hoping to see.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const run = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'infra', 'billing', 'reconcile.mjs');

const ADMIN_BASE = process.env.DRILL_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';

/** The operator connection: superuser credentials against the TEST database. */
function adminUrl(): string {
  const url = new URL(ADMIN_BASE);
  url.pathname = new URL(requireDatabaseUrl()).pathname;
  return url.toString();
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function reconcile(env: Record<string, string>, args: string[] = []): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let owner: pg.Client;
let app: pg.Client;
let tenant: TestTenant;
let organizationId: string;

beforeAll(async () => {
  owner = await migratorClient();
  app = await appClient();

  /*
   * A dedicated tenant, so the drill neither depends on nor disturbs whatever
   * else is in the test database. Built with the shared helper rather than a
   * hand-rolled INSERT: an organization has required columns (a wrapped DEK
   * among them) that a drill has no business knowing about, and a fixture that
   * drifts from a real tenant is a fixture that stops testing the real thing.
   */
  tenant = await createTenant(owner, app, 'reconcile');
  organizationId = tenant.organizationId;
}, 60_000);

afterAll(async () => {
  if (owner && organizationId) {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    await owner.query('DELETE FROM credit_transactions WHERE organization_id = $1', [
      organizationId,
    ]);
    await owner.query('DELETE FROM credits WHERE organization_id = $1', [organizationId]);
    await owner.query('COMMIT');
  }
  if (tenant) await cleanupTenant(owner, tenant);
  await app?.end();
  await owner?.end();
});

/** Write a balance and a ledger that may or may not agree, as the owner. */
async function seedCredits(cachedMicroUsd: number, ledgerMicroUsd: number): Promise<void> {
  await owner.query('BEGIN');
  await owner.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
  await owner.query('DELETE FROM credit_transactions WHERE organization_id = $1', [organizationId]);
  await owner.query('DELETE FROM credits WHERE organization_id = $1', [organizationId]);
  await owner.query(
    `INSERT INTO credits (organization_id, balance_micro_usd, period_key)
     VALUES ($1, $2, '2026-09')`,
    [organizationId, cachedMicroUsd],
  );
  if (ledgerMicroUsd !== 0) {
    await owner.query(
      `INSERT INTO credit_transactions
         (organization_id, kind, amount_micro_usd, reason, period_key, unpriced)
       VALUES ($1, 'grant', $2, 'drill', '2026-09', false)`,
      [organizationId, ledgerMicroUsd],
    );
  }
  await owner.query('COMMIT');
}

/* ========================================================================== */
/* 1. It refuses a connection that would see nothing                          */
/* ========================================================================== */

describe('the reconciler refuses to report on data it cannot see', () => {
  it('REFUSES a role subject to row-level security', async () => {
    /*
     * The failure this guard exists for. `moka_app` with no organization bound
     * reads zero rows from both tables. Without the guard the tool would exit
     * 0 and print an all-clear, and a nightly alert built on it would be
     * permanently, silently green.
     */
    await seedCredits(0, 2_000_000); // A real divergence it must not miss.

    const result = await reconcile({ RECONCILE_ADMIN_URL: requireDatabaseUrl() });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('row-level security');
    // And it must not have reported success while blind.
    expect(result.stdout).not.toContain('OK');
  });

  it('explains WHY the empty result would be misleading', async () => {
    const result = await reconcile({ RECONCILE_ADMIN_URL: requireDatabaseUrl() });
    expect(result.stderr).toContain('having examined none of them');
  });
});

/* ========================================================================== */
/* 2. It fires on a real divergence                                           */
/* ========================================================================== */

describe('the reconciler detects a cache that has drifted from the ledger', () => {
  it('exits 2 and names the organization when the balance disagrees', async () => {
    // The exact shape found in the development database: a grant reached the
    // ledger and the cached balance stayed behind.
    await seedCredits(0, 2_000_000);

    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('DIVERGED');
    expect(result.stderr).toContain(organizationId);
  });

  it('reports the drift with its sign, so the direction is unambiguous', async () => {
    await seedCredits(0, 2_000_000);
    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() });
    // Cache below ledger: the customer has been under-credited by $2.
    expect(result.stderr).toContain('-2.000000');
  });

  it('says the ledger is authoritative rather than offering to "fix" the cache', async () => {
    /*
     * Deliberate product behaviour, asserted so it is not quietly changed into
     * an auto-repair. Overwriting the balance destroys the evidence of
     * whatever caused the drift, which is the one thing that cannot be
     * reconstructed afterwards.
     */
    await seedCredits(0, 2_000_000);
    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() });
    expect(result.stderr).toContain('LEDGER is authoritative');
  });

  it('detects a ledger with no balance row at all', async () => {
    /*
     * The case a LEFT JOIN from `credits` would silently drop: an organization
     * that has spent money and has no balance record. The tool uses a FULL
     * OUTER JOIN precisely for this.
     */
    await seedCredits(0, 2_000_000);
    // Bound, because the migrator is subject to FORCE RLS too: an unbound
    // DELETE here matches no rows and silently leaves the fixture unchanged.
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
    await owner.query('DELETE FROM credits WHERE organization_id = $1', [organizationId]);
    await owner.query('COMMIT');

    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no credits row');
  });
});

/* ========================================================================== */
/* 3. It stays quiet when there is nothing to say                             */
/* ========================================================================== */

describe('the reconciler passes a database that agrees with itself', () => {
  it('exits 0 when the cache matches the ledger', async () => {
    /*
     * The control. A tool that reported a divergence unconditionally would
     * pass every test above while being useless, and the first person paged by
     * it at 3am would switch it off.
     */
    await seedCredits(2_000_000, 2_000_000);

    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK');
    expect(result.stdout).not.toContain(organizationId);
  });

  it('emits machine-readable output for an alerting pipeline', async () => {
    await seedCredits(0, 2_000_000);

    const result = await reconcile({ RECONCILE_ADMIN_URL: adminUrl() }, ['--json']);
    const parsed = JSON.parse(result.stdout) as {
      checked: number;
      diverged: Array<{ organizationId: string; driftMicroUsd: number }>;
    };

    expect(result.code).toBe(2);
    const mine = parsed.diverged.find((d) => d.organizationId === organizationId);
    expect(mine).toBeDefined();
    expect(mine?.driftMicroUsd).toBe(-2_000_000);
  });
});
