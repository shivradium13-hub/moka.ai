/**
 * Credit reconciliation (docs/operations.md §7; docs/security.md §9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A CACHED BALANCE EXISTS AT ALL, AND WHY IT NEEDS WATCHING
 *
 * `credit_transactions` is the authoritative ledger: append-only, signed, and
 * enforced by GRANT rather than by convention — `moka_app` holds INSERT and
 * SELECT and no UPDATE or DELETE, so the application physically cannot rewrite
 * its own billing history.
 *
 * `credits.balance_micro_usd` is a CACHE of `SUM(amount_micro_usd)` over that
 * ledger. It exists because a pre-flight check runs before every provider call
 * and cannot afford to sum a million rows each time.
 *
 * A cache can drift. A crash between the ledger insert and the balance update,
 * a manual correction applied to one and not the other, or a restore that
 * recovered the two tables from different points — any of these leave a
 * customer being charged against a number that no longer describes what they
 * actually spent.
 *
 * Nothing fails when this happens. Requests keep succeeding, the balance keeps
 * decrementing, and the discrepancy is invisible until somebody disputes an
 * invoice. That is exactly the class of problem that has to be looked for
 * rather than waited for.
 *
 * THIS SCRIPT ONLY REPORTS.
 *
 * It never writes. Deciding what a customer's balance should be is a business
 * judgement — a drift might be a bug, a manual grant somebody forgot to
 * ledger, or a partial restore — and an operator needs to see the divergence
 * and choose. A reconciler that silently "fixed" balances would destroy the
 * evidence of whatever caused the drift, which is the one thing you cannot
 * reconstruct afterwards.
 *
 * WHY IT NEEDS A PRIVILEGED CONNECTION
 *
 * Every tenant table is FORCE ROW LEVEL SECURITY, so `moka_app` and
 * `moka_migrator` alike see nothing without `app.current_org_id` bound. A
 * fleet-wide reconciliation is inherently cross-tenant, which is precisely the
 * thing the application is forbidden to do. So it is an operator tool run
 * against an operator connection, deliberately outside the application's
 * reach, the same way `backup.mjs` is.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node infra/billing/reconcile.mjs
 *   node infra/billing/reconcile.mjs --json     machine-readable, for alerting
 *
 * Connection: RECONCILE_ADMIN_URL, else DRILL_ADMIN_URL, else DATABASE_URL.
 *
 * Exit codes:
 *   0  every organization reconciles
 *   1  could not run (connection, permissions, missing tables)
 *   2  at least one organization diverges  ← alert on this
 */

import pg from 'pg';
import process from 'node:process';

const asJson = process.argv.includes('--json');

const url =
  process.env.RECONCILE_ADMIN_URL ?? process.env.DRILL_ADMIN_URL ?? process.env.DATABASE_URL;

if (!url) {
  fail(
    'No connection string. Set RECONCILE_ADMIN_URL to a role that can read every ' +
      "organization's ledger.",
  );
}

const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
} catch (error) {
  fail(`Could not connect: ${error instanceof Error ? error.message : String(error)}`);
}

/*
 * Check the role BEFORE reporting anything.
 *
 * A role subject to RLS with no organization bound sees zero rows in both
 * tables, so every organization "reconciles" and the script prints a
 * reassuring all-clear having examined nothing. That is the same silent-empty
 * failure mode as a non-superuser pg_dump, and it is refused for the same
 * reason: a monitoring tool that cannot see anything must say so rather than
 * report success.
 */
const { rows: roleRows } = await client.query(
  'SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
);
const role = roleRows[0];

if (!role?.rolsuper && !role?.rolbypassrls) {
  await client.end();
  fail(
    [
      `Refusing to report: connected as "${role?.who ?? 'unknown'}", which is subject to`,
      'row-level security.',
      '',
      'With no organization bound, every policy matches nothing, so both the ledger',
      'and the balances would read as empty and this script would report that all',
      'organizations reconcile — having examined none of them.',
      '',
      'Set RECONCILE_ADMIN_URL to an operator connection.',
    ].join('\n'),
  );
}

/*
 * One query rather than a loop.
 *
 * FULL OUTER JOIN, not LEFT: a ledger with no `credits` row is as much a
 * divergence as a balance that disagrees, and a LEFT JOIN from `credits` would
 * silently drop exactly that case — an organization that has spent money and
 * has no balance record at all.
 */
const { rows } = await client.query(`
  WITH ledger AS (
    SELECT organization_id, SUM(amount_micro_usd)::bigint AS total, COUNT(*)::bigint AS entries
      FROM credit_transactions
     GROUP BY organization_id
  )
  SELECT
    COALESCE(c.organization_id, l.organization_id) AS organization_id,
    c.balance_micro_usd                            AS cached,
    COALESCE(l.total, 0)                           AS ledger,
    COALESCE(l.entries, 0)                         AS entries,
    (c.organization_id IS NULL)                    AS missing_balance_row
  FROM credits c
  FULL OUTER JOIN ledger l ON l.organization_id = c.organization_id
  ORDER BY 1
`);

const report = rows.map((r) => {
  const cached = r.cached === null ? null : BigInt(r.cached);
  const ledger = BigInt(r.ledger);
  return {
    organizationId: r.organization_id,
    cachedMicroUsd: cached === null ? null : Number(cached),
    ledgerMicroUsd: Number(ledger),
    entries: Number(r.entries),
    driftMicroUsd: cached === null ? null : Number(cached - ledger),
    missingBalanceRow: r.missing_balance_row,
  };
});

const diverged = report.filter((r) => r.missingBalanceRow || r.driftMicroUsd !== 0);

await client.end();

if (asJson) {
  console.log(JSON.stringify({ checked: report.length, diverged }, null, 2));
} else if (report.length === 0) {
  console.log('No organizations hold credit records. Nothing to reconcile.');
} else if (diverged.length === 0) {
  console.log(`OK — ${report.length} organization(s) reconcile against the ledger.`);
} else {
  console.error(`DIVERGED — ${diverged.length} of ${report.length} organization(s):\n`);
  for (const r of diverged) {
    if (r.missingBalanceRow) {
      console.error(
        `  ${r.organizationId}  no credits row, but ${r.entries} ledger entries ` +
          `totalling ${money(r.ledgerMicroUsd)}`,
      );
    } else {
      console.error(
        `  ${r.organizationId}  cached ${money(r.cachedMicroUsd)} vs ledger ` +
          `${money(r.ledgerMicroUsd)}  (drift ${money(r.driftMicroUsd)}, ${r.entries} entries)`,
      );
    }
  }
  console.error(
    '\nThe LEDGER is authoritative. It is what you can show a customer who disputes' +
      '\na bill. Investigate the cause before correcting any balance — a drift is' +
      '\nevidence, and overwriting it destroys the only record of what went wrong.',
  );
}

process.exit(diverged.length > 0 ? 2 : 0);

/** Micro-dollars are an integer internally; only display converts. */
function money(microUsd) {
  if (microUsd === null) return 'n/a';
  return `$${(microUsd / 1_000_000).toFixed(6)}`;
}

function fail(message) {
  if (asJson) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exit(1);
}
