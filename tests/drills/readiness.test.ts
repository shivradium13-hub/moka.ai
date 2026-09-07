import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ConfigurationError } from '@moka/core';
import { Database } from '@moka/db';
import { APP_URL, MIGRATION_URL, requireDatabaseUrl } from '../helpers/db.js';

/**
 * DRILL — BOOT REFUSAL AND READINESS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO CHECKS THAT GUARD AGAINST A SILENT LOSS OF ISOLATION
 *
 * Almost everything else in this system fails loudly. These two exist because
 * the failures they catch do not fail at all — the application keeps working,
 * every request succeeds, and the only symptom is one tenant seeing another's
 * data.
 *
 *   1. `assertRuntimeRoleIsConstrained()`, run at boot. Connect as a superuser
 *      or any BYPASSRLS role and every policy in the database stops applying,
 *      all at once. Nothing breaks. The process refuses to listen instead.
 *
 *   2. `probe()`, run on every readiness poll. A migration that adds an
 *      organization-scoped table and forgets its policy leaves that one table
 *      readable across tenants. Nothing breaks there either.
 *
 * A drill rather than a unit test because both need a real PostgreSQL with the
 * real roles: the whole question is what the server says about the role it is
 * actually talking to, and a mock would answer whatever it was told to.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ADMIN = process.env.DRILL_ADMIN_URL ?? 'postgresql://postgres@127.0.0.1:55432/postgres';

let app: Database;
let owner: pg.Client;

beforeAll(async () => {
  app = new Database({ connectionString: requireDatabaseUrl(), poolMax: 2 });

  if (!MIGRATION_URL) {
    throw new Error(
      'TEST_DATABASE_MIGRATION_URL is not set. This drill needs the schema owner ' +
        'in order to create — and then drop — a deliberately unprotected table.',
    );
  }
  owner = new pg.Client({ connectionString: MIGRATION_URL });
  await owner.connect();
}, 60_000);

afterAll(async () => {
  // Belt and braces: the table is dropped in the test too, but a failure
  // mid-test must not leave an unprotected table behind in a dev database.
  await owner?.query('DROP TABLE IF EXISTS drill_unprotected');
  await owner?.end();
  await app?.close();
});

/* ========================================================================== */
/* 1. Boot refuses a role that can bypass RLS                                 */
/* ========================================================================== */

describe('the process refuses to start as a role that bypasses RLS', () => {
  it('accepts the real application role', async () => {
    /*
     * The control, and the more important half. A guard that refused every
     * role would pass the test below while making the product unstartable,
     * and the pressure would then be to delete the guard.
     */
    await expect(app.assertRuntimeRoleIsConstrained()).resolves.toBeUndefined();
  });

  it('REFUSES a superuser connection', async () => {
    /*
     * The actual drill. `postgres://postgres@…` is what half the tutorials
     * print and what a hurried operator reaches for when a permission error
     * blocks a deploy, so this is a plausible mistake rather than an exotic
     * one.
     */
    const target = new URL(APP_URL);
    const superuser = new URL(ADMIN);
    // Same database, superuser credentials — precisely the misconfiguration.
    superuser.pathname = target.pathname;

    const asSuper = new Database({ connectionString: superuser.toString(), poolMax: 1 });
    try {
      await expect(asSuper.assertRuntimeRoleIsConstrained()).rejects.toThrow(ConfigurationError);
      await expect(asSuper.assertRuntimeRoleIsConstrained()).rejects.toThrow(/superuser/);
    } finally {
      await asSuper.close();
    }
  });

  it('the refusal explains the consequence, not just the rule', async () => {
    /*
     * Worth asserting. An operator who reads "must not be a superuser" at 3am
     * looks for the flag that turns the check off. One who reads that every
     * tenant would be served every other tenant's data does not.
     */
    const superuser = new URL(ADMIN);
    superuser.pathname = new URL(APP_URL).pathname;
    const asSuper = new Database({ connectionString: superuser.toString(), poolMax: 1 });

    try {
      await asSuper.assertRuntimeRoleIsConstrained();
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('every tenant');
      expect(message).toContain('moka_app');
      /*
       * And it must not print the connection string it was given. The
       * password is checked only when there IS one: `toContain('')` is true of
       * every string, so an unconditional assertion here would pass whatever
       * the message said, which is worse than not asserting it.
       */
      if (superuser.password) expect(message).not.toContain(superuser.password);
      expect(message).not.toContain('postgresql://');
    } finally {
      await asSuper.close();
    }
  });
});

/* ========================================================================== */
/* 2. Readiness notices a table that lost its policy                          */
/* ========================================================================== */

describe('readiness checks the shape of the schema, not just the connection', () => {
  it('reports a correctly migrated database as ready', async () => {
    const probe = await app.probe();
    expect(probe.reachable).toBe(true);
    expect(probe.unprotectedTables).toEqual([]);
  });

  it('NOTICES an organization-scoped table with no row-level security', async () => {
    /*
     * The mutation test, run against the live database rather than described.
     *
     * This is the failure the probe exists for: somebody adds a table in a
     * migration, gives it an `organization_id`, and forgets the two lines that
     * turn on and force RLS. Every query against it then succeeds for every
     * tenant. No error, no exception, no log line.
     *
     * Creating the table for real is the only way to know the probe would
     * catch it — a probe asserted only against a clean database has never been
     * observed to fail, and a check that cannot fail is decoration.
     */
    await owner.query(`
      CREATE TABLE drill_unprotected (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        secret text NOT NULL
      )
    `);

    try {
      const probe = await app.probe();
      expect(probe.reachable).toBe(true);
      expect(probe.unprotectedTables).toContain('drill_unprotected');
    } finally {
      await owner.query('DROP TABLE drill_unprotected');
    }

    // And the database returns to ready once the offending table is gone.
    expect((await app.probe()).unprotectedTables).toEqual([]);
  });

  it('ENABLED but not FORCED is still reported as unprotected', async () => {
    /*
     * The subtle half, and the one most likely to be got wrong by someone
     * copying an existing migration.
     *
     * `ENABLE ROW LEVEL SECURITY` alone exempts the TABLE OWNER from its own
     * policies. Every table here is owned by `moka_migrator`, so a table with
     * RLS enabled but not forced is protected against `moka_app` and wide open
     * to any code path that runs as the owner. `FORCE` is what closes that,
     * and a probe that accepted `relrowsecurity` alone would report this
     * table as fine.
     */
    await owner.query(`
      CREATE TABLE drill_unprotected (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL
      )
    `);
    await owner.query('ALTER TABLE drill_unprotected ENABLE ROW LEVEL SECURITY');

    try {
      const probe = await app.probe();
      expect(probe.unprotectedTables).toContain('drill_unprotected');

      // Forcing it is what makes the probe accept the table.
      await owner.query('ALTER TABLE drill_unprotected FORCE ROW LEVEL SECURITY');
      expect((await app.probe()).unprotectedTables).not.toContain('drill_unprotected');
    } finally {
      await owner.query('DROP TABLE drill_unprotected');
    }
  });

  it('ignores tables that are not organization-scoped', async () => {
    /*
     * `users`, `plans` and the migration ledger have no `organization_id` and
     * are not per-tenant data. Flagging them would make the probe permanently
     * red, and a permanently red probe is an ignored probe.
     */
    const probe = await app.probe();
    expect(probe.unprotectedTables).toEqual([]);

    const { rows } = await owner.query<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT c.relrowsecurity
    `);
    // There ARE such tables, so the empty result above is a real judgement
    // rather than an artefact of every table happening to have RLS.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reports "unknown" rather than "ok" when it cannot answer', async () => {
    /*
     * A probe that reported an unrunnable check as a passing check would be
     * the exact fake-success §45 forbids. Verified against a closed pool,
     * which is the cheapest way to make the query genuinely fail.
     */
    const dead = new Database({ connectionString: requireDatabaseUrl(), poolMax: 1 });
    await dead.close();

    const probe = await dead.probe();
    expect(probe.reachable).toBe(false);
    expect(probe.unprotectedTables).toBeNull();
  });
});
