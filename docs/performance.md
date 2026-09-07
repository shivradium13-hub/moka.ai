# Performance

Measured with `pnpm bench` (`infra/bench/benchmark.mjs`) on 2026-09-07.

---

## 1. Read this before quoting any number here

These measurements come from a **7.3 GB development machine** running PostgreSQL in a container alongside the process generating the load. Absolute latencies from such a setup do not predict production, and this document does not present them as though they do.

What it reports instead are **ratios and shapes**, which survive the move to better hardware:

- the cost of row-level security, measured as one statement against one identical statement;
- how latency scales as a tenant grows;
- whether the isolation policy can use an index — a fact about the query plan, not about the machine.

**No request-throughput figure appears anywhere in this document.** Every meaningful request in this system waits on a model provider, no provider API key has ever existed on this machine, and a requests-per-second number measured against a mock would be a fabrication with a decimal point on it (§45).

---

## 2. The number that matters: row-level security costs about 1%

The concern worth testing is commercial rather than technical. If tenant isolation were expensive, there would be pressure to weaken it for speed — and that pressure is best answered with a measurement rather than an assurance.

Same `SELECT`, same round trip, same rows. The only difference is whether a policy is applied:

| Rows in table | Rows in tenant | Policy applied (p50) | RLS bypassed (p50) | Overhead |
|---|---|---|---|---|
| 5,000 | 500 | 0.497 ms | 0.501 ms | **-0.8%** |
| 20,000 | 2,000 | 1.017 ms | 1.008 ms | **+0.9%** |
| 100,000 | 10,000 | 4.188 ms | 4.150 ms | **+0.9%** |

Under 1% at every size, and at the smallest size the measurement came out slightly *negative* — which is the clearest possible statement that the difference is inside the noise floor rather than a real cost.

This is the expected result once you look at what PostgreSQL actually does: the policy is `organization_id = current_org_id()`, and the planner folds it into the `WHERE` clause of the query it was already going to run. It is the same predicate a hand-written tenant filter would supply, applied by the database instead of by the application. The difference is that the database cannot forget to apply it.

### 2.1 The misleading number, stated so nobody derives it themselves

A naïve comparison — the whole tenant-bound path against a bare `SELECT` — gives a very different figure:

| Rows | Whole tenant path vs. bare SELECT |
|---|---|
| 5,000 | +104% |
| 20,000 | +50% |
| 100,000 | +18% |

That looks alarming and means almost nothing. The tenant path is four round trips (`BEGIN`, `set_config`, the query, `COMMIT`); the bare `SELECT` is one. The gap is three network round trips, not policy evaluation.

The proof is in the trend: a genuine per-row cost would grow with table size. This one **shrinks** — from 104% to 18% — because it is a fixed cost being amortised over a query that is itself getting slower. Measured directly, the wrapper costs about 0.26–0.35 ms regardless of how many rows exist.

This number is documented rather than omitted precisely because it is the one somebody would compute for themselves and misread.

---

## 3. Latency by operation

At 100,000 rows across 10 tenants (10,000 rows in the queried tenant), 200 iterations after a 20-iteration warm-up:

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Tenant-bound read, full path | 4.885 ms | 5.432 ms | 6.446 ms |
| The `SELECT` alone, policy applied | 4.188 ms | 4.743 ms | 5.635 ms |
| Transaction wrapper alone (`BEGIN` + `set_config` + `COMMIT`) | 0.351 ms | 0.458 ms | 0.903 ms |
| `count(*)` over the tenant (policy touches every row) | 2.864 ms | 3.065 ms | 3.478 ms |
| Insert, satisfying `WITH CHECK` | 0.571 ms | 0.665 ms | 1.975 ms |

Percentiles rather than means, because a mean hides the case worth seeing: most queries fast, some not. p99 is what a user experiences on a bad page load.

`WITH CHECK` on writes costs nothing measurable. It evaluates one comparison against one row.

---

## 4. Scaling

Reads scale approximately linearly with rows in the tenant — 0.5 ms at 500 rows, 1.0 ms at 2,000, 4.2 ms at 10,000 — which is what a `LIMIT 20` over an unsorted-by-index column should do: the sort dominates, and it grows with the tenant's row count, not with the table's.

Critically, **the tenant filter uses an index at every size tested**. `EXPLAIN` confirms an index path rather than a sequential scan.

That check exists because of a specific failure mode: a policy that is not index-sargable looks perfectly healthy in development and collapses in production, since a sequential scan over 2,000 rows is invisible and one over 20 million is an outage. The benchmark fails loudly if the plan ever stops using an index — and unlike the timings, that assertion transfers to any hardware, because a query plan is a property of PostgreSQL and the schema.

---

## 5. What is deliberately not measured

Stated plainly rather than left as an implication:

- **End-to-end request throughput.** Dominated by provider latency, which cannot be measured here.
- **Model call latency, token throughput, streaming.** No provider key has ever been present (`docs/security-audit.md` §7.2).
- **Concurrency and connection-pool saturation.** Single-connection measurements. Contention on a 7.3 GB box with the load generator on the same machine would measure the box.
- **Retrieval quality or speed at scale.** pgvector is unavailable, so retrieval is lexical.
- **Multi-instance behaviour.** The system is single-node today.
- **Sustained load and memory growth over hours.** Not run.

---

## 6. What to measure before production

1. **Re-run `pnpm bench` on the production database.** The policy-overhead ratio and the query plan are the two results that transfer; confirm both hold at production data volumes.
2. **Load-test with a real provider key in staging.** Almost all real latency lives there, and none of it is characterised.
3. **Check the plan at production scale.** At tens of millions of rows the planner may change its mind; the benchmark's `EXPLAIN` assertion is the early warning.
4. **Measure pool saturation** under realistic concurrency, on hardware where the load generator is not competing with the database.
5. **Index review once access patterns are real.** The current indexes follow the schema's intent, not observed queries.

---

## 7. Reproducing

```bash
pnpm bench
```

```bash
BENCH_ADMIN_URL=postgresql://postgres@127.0.0.1:55432/moka_ai node infra/bench/benchmark.mjs --rows 100000
```

Needs `DATABASE_URL` (the application role) and `BENCH_ADMIN_URL` (a role that bypasses RLS). Both are required, and the script refuses to run without the second — with no bypassing baseline there is nothing to compare against, and the cost of isolation could only be guessed at.

The benchmark creates and drops its own table. It touches no application data.
