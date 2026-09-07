/**
 * Performance benchmark (master prompt §39; docs/performance.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND WHY IT IS DELIBERATELY NARROW
 *
 * The honest constraint first: this runs on a 7.3 GB development machine with
 * PostgreSQL in a container alongside the thing generating the load. Absolute
 * numbers from such a setup do not predict production, and reporting them as
 * throughput figures would be a fabrication dressed up as data.
 *
 * So this benchmark measures RATIOS and SHAPES, which do survive the move to
 * better hardware:
 *
 *   1. THE COST OF ISOLATION. Every tenant query runs inside a transaction
 *      that first calls `set_config('app.current_org_id', …)`, and every row
 *      it touches is filtered by a policy. If that overhead were large, there
 *      would be commercial pressure to weaken isolation for speed — so the
 *      number is worth knowing precisely, and it is measured against the same
 *      query run by a role that bypasses RLS entirely.
 *
 *   2. HOW LATENCY SCALES WITH TENANT SIZE. A policy that forces a sequential
 *      scan looks fine at a thousand rows and falls over at a million. The
 *      shape of the curve is informative even when the constant is not.
 *
 *   3. WHETHER THE POLICY IS INDEX-SARGABLE. `EXPLAIN` output is a fact about
 *      the plan, not about the machine, and transfers completely.
 *
 * WHAT IT DOES NOT MEASURE
 *
 * End-to-end request throughput, model latency, or anything involving a
 * provider. No provider API key has ever existed on this machine, so any
 * "requests per second" figure would be measuring a mock. It is not reported
 * rather than reported with an asterisk.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node infra/bench/benchmark.mjs               default sizes
 *   node infra/bench/benchmark.mjs --rows 50000
 *   node infra/bench/benchmark.mjs --json
 *
 * Connection: BENCH_ADMIN_URL (needs superuser, for the bypass comparison),
 * else DRILL_ADMIN_URL. The tenant-bound side connects as DATABASE_URL.
 */

import pg from 'pg';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rowsArg = args.indexOf('--rows');
const TOTAL_ROWS = rowsArg === -1 ? 20_000 : Number(args[rowsArg + 1]);
const TENANTS = 10;
const ITERATIONS = 200;

const adminUrl = process.env.BENCH_ADMIN_URL ?? process.env.DRILL_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;

if (!adminUrl || !appUrl) {
  console.error(
    'Set DATABASE_URL (the application role) and BENCH_ADMIN_URL (a superuser).\n' +
      'Both are needed: the whole point is to compare the same query with and\n' +
      'without row-level security applied.',
  );
  process.exit(1);
}

const admin = new pg.Client({ connectionString: adminUrl });
const app = new pg.Client({ connectionString: appUrl });
await admin.connect();
await app.connect();

const { rows: roleRows } = await admin.query(
  'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
);
if (!roleRows[0]?.rolsuper && !roleRows[0]?.rolbypassrls) {
  console.error(
    'BENCH_ADMIN_URL must be a role that bypasses RLS. Without one there is no\n' +
      'baseline to compare against, and the isolation overhead cannot be measured\n' +
      'at all — only guessed at.',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const BENCH_TABLE = 'bench_rows';
const tenantIds = Array.from({ length: TENANTS }, () => randomUUID());

/*
 * A purpose-built table rather than a real one.
 *
 * Benchmarking `projects` would mean creating and destroying tens of thousands
 * of rows in a table with foreign keys, audit triggers and cascade rules —
 * measuring those as much as measuring isolation. This table carries the one
 * property under test: an `organization_id`, an index on it, and the same
 * ENABLE + FORCE + policy shape every tenant table uses.
 */
await admin.query(`DROP TABLE IF EXISTS ${BENCH_TABLE}`);
await admin.query(`
  CREATE TABLE ${BENCH_TABLE} (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    payload         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
  )
`);
await admin.query(`CREATE INDEX ${BENCH_TABLE}_org ON ${BENCH_TABLE} (organization_id)`);

log(`Seeding ${TOTAL_ROWS.toLocaleString()} rows across ${TENANTS} tenants…`);
await admin.query(
  `INSERT INTO ${BENCH_TABLE} (organization_id, payload)
   SELECT ($1::uuid[])[1 + (i % $2)], repeat('x', 200)
     FROM generate_series(1, $3) AS i`,
  [tenantIds, TENANTS, TOTAL_ROWS],
);
await admin.query(`ANALYZE ${BENCH_TABLE}`);

// The policy is applied AFTER seeding, so the fixture cost is not measured.
await admin.query(`ALTER TABLE ${BENCH_TABLE} ENABLE ROW LEVEL SECURITY`);
await admin.query(`ALTER TABLE ${BENCH_TABLE} FORCE ROW LEVEL SECURITY`);
await admin.query(
  `CREATE POLICY tenant_isolation ON ${BENCH_TABLE}
     USING (organization_id = current_org_id())
     WITH CHECK (organization_id = current_org_id())`,
);
await admin.query(`GRANT SELECT, INSERT ON ${BENCH_TABLE} TO moka_app`);

const target = tenantIds[0];
const perTenant = Math.floor(TOTAL_ROWS / TENANTS);

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Percentiles, not a mean.
 *
 * A mean hides exactly the thing worth seeing: a bimodal distribution where
 * most queries are fast and some are not. p99 is what a user actually
 * experiences on a bad page load.
 */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

async function timeIt(fn, iterations = ITERATIONS) {
  // Warm up: the first executions pay for plan caching and page faults, and
  // including them would measure the warm-up rather than the steady state.
  for (let i = 0; i < 20; i += 1) await fn();

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return stats(samples);
}

const results = {};

/* --- 1. The full tenant-bound path, exactly as the application runs it --- */
results.tenantBound = await timeIt(async () => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
  await app.query(`SELECT id, payload FROM ${BENCH_TABLE} ORDER BY created_at DESC LIMIT 20`);
  await app.query('COMMIT');
});

/* --- 2. The same query with RLS bypassed and the tenant filter written by hand --- */
results.bypassed = await timeIt(async () => {
  await admin.query(
    `SELECT id, payload FROM ${BENCH_TABLE}
      WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [target],
  );
});

/*
 * --- 2b. THE ONLY FAIR COMPARISON: one statement against one statement ---
 *
 * `tenantBound` above is four round trips (BEGIN, set_config, SELECT, COMMIT)
 * and `bypassed` is one, so the difference between them is mostly network and
 * says almost nothing about the policy. Reporting that as "the cost of RLS"
 * would be wrong in the specific direction that matters: it is the number
 * somebody would quote when arguing to weaken isolation for speed.
 *
 * So the transaction is opened ONCE and only the SELECT is timed, against the
 * identical SELECT run by a bypassing role. Same statement, same round-trip
 * count, same rows — the only difference is whether a policy is applied.
 */
await app.query('BEGIN');
await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
results.policyOnly = await timeIt(async () => {
  await app.query(`SELECT id, payload FROM ${BENCH_TABLE} ORDER BY created_at DESC LIMIT 20`);
});
await app.query('COMMIT');

/* --- 3. The transaction wrapper alone, to separate it from the policy --- */
results.transactionOverhead = await timeIt(async () => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
  await app.query('COMMIT');
});

/* --- 4. A counting query, where the policy touches every row --- */
results.tenantCount = await timeIt(async () => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
  await app.query(`SELECT count(*) FROM ${BENCH_TABLE}`);
  await app.query('COMMIT');
}, 50);

/* --- 5. A write, which must satisfy WITH CHECK --- */
results.tenantInsert = await timeIt(async () => {
  await app.query('BEGIN');
  await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
  await app.query(`INSERT INTO ${BENCH_TABLE} (organization_id, payload) VALUES ($1, 'bench')`, [
    target,
  ]);
  await app.query('ROLLBACK'); // Measure the cost, keep the fixture stable.
}, 100);

/* -------------------------------------------------------------------------- */
/* The plan — a fact about PostgreSQL, not about this machine                  */
/* -------------------------------------------------------------------------- */

await app.query('BEGIN');
await app.query("SELECT set_config('app.current_org_id', $1, true)", [target]);
const explained = await app.query(
  `EXPLAIN (FORMAT JSON) SELECT id FROM ${BENCH_TABLE} WHERE organization_id = $1`,
  [target],
);
await app.query('COMMIT');

const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
const scanType = plan['Node Type'];
const usesIndex = JSON.stringify(plan).includes('Index');

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const policyOverheadPct = round(
  ((results.policyOnly.p50 - results.bypassed.p50) / results.bypassed.p50) * 100,
);
const wholePathPct = round(
  ((results.tenantBound.p50 - results.bypassed.p50) / results.bypassed.p50) * 100,
);

const report = {
  fixture: { totalRows: TOTAL_ROWS, tenants: TENANTS, rowsPerTenant: perTenant },
  iterations: ITERATIONS,
  latencyMs: results,
  policyOverheadPercentAtP50: policyOverheadPct,
  wholeTenantPathOverheadPercentAtP50: wholePathPct,
  plan: { nodeType: scanType, usesIndex },
};

await admin.query(`DROP TABLE IF EXISTS ${BENCH_TABLE}`);
await admin.end();
await app.end();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('');
  console.log(`Fixture: ${TOTAL_ROWS.toLocaleString()} rows, ${TENANTS} tenants ` +
    `(${perTenant.toLocaleString()} each), ${ITERATIONS} iterations\n`);
  console.log('Latency (ms)                       p50      p95      p99');
  for (const [name, s] of Object.entries(results)) {
    console.log(`  ${name.padEnd(30)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.p99)}`);
  }
  console.log('');
  console.log(`Policy overhead at p50:          ${policyOverheadPct}%`);
  console.log('  Same SELECT, same round trip, with and without the policy applied.');
  console.log('  THIS is the cost of row-level security.');
  console.log('');
  console.log(`Whole tenant path at p50:       ${wholePathPct}%`);
  console.log('  BEGIN + set_config + SELECT + COMMIT versus a bare SELECT. Mostly the');
  console.log('  three extra round trips, NOT the policy. Quoted here only so nobody');
  console.log('  computes it themselves and mistakes it for the line above.');
  console.log('');
  console.log(`Plan for a tenant-scoped read: ${scanType}${usesIndex ? ' (index used)' : ''}`);
  if (!usesIndex) {
    console.log('  WARNING: the policy is not index-sargable at this size. That is the');
    console.log('  failure mode that looks fine in development and does not scale.');
  }
  console.log('');
}

function log(message) {
  if (!asJson) console.log(message);
}

function fmt(n) {
  return String(n).padStart(8);
}
