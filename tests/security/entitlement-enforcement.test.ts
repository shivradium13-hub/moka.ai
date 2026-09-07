import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  appClient,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';
import {
  ALL_FEATURES,
  DEFAULT_PLANS,
  Feature,
  SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS,
  TransactionKind,
  checkQuota,
  reconcile,
  resolveEntitlement,
  signIsValid,
  type CreditTransaction,
} from '@moka/billing';

/**
 * SECURITY SUITE 11 — ENTITLEMENT ENFORCEMENT.
 *
 * The Phase 9 gate: enforcement works, and no limit is hard-coded.
 *
 * Two things are being pinned, and the second is the one an implementation
 * usually gets wrong:
 *
 *   1. Limits resolve from DATA — override, then plan, then denial — with no
 *      code constant anywhere in the chain.
 *
 *   2. The application CANNOT EDIT THE LIMITS IT IS CHECKED AGAINST. That is
 *      a GRANT, not a convention: `moka_app` holds SELECT and nothing else on
 *      `plans`, `plan_entitlements` and `entitlement_overrides`. The one
 *      escalation an entitlement system has to rule out is the one where the
 *      thing being limited gets to raise its own limit.
 *
 * Runs as `moka_app`, the runtime role, so the grants under test are the real
 * ones. Testing as the owner would prove nothing.
 */

let migrator: pg.Client;
let app: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

const MICRO = 1_000_000;

async function planId(key: string): Promise<string> {
  const { rows } = await app.query<{ id: string }>('SELECT id FROM plans WHERE key = $1', [key]);
  if (!rows[0]) throw new Error(`plan ${key} is not seeded; run pnpm db:seed`);
  return rows[0].id;
}

/** Give a tenant a subscription, the way registration does. */
async function subscribe(tenant: TestTenant, key: string): Promise<void> {
  const id = await planId(key);
  await asOrg(app, tenant.organizationId, async () => {
    await app.query(
      `INSERT INTO subscriptions (organization_id, plan_id, status, current_period_end)
       VALUES ($1, $2, 'active', now() + interval '30 days')
       ON CONFLICT (organization_id)
       DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
      [tenant.organizationId, id],
    );
  });
}

beforeAll(async () => {
  migrator = await migratorClient();
  app = await appClient();
  tenantA = await createTenant(migrator, app, 'ent-a');
  tenantB = await createTenant(migrator, app, 'ent-b');
  await subscribe(tenantA, 'free');
  await subscribe(tenantB, 'team');
}, 60_000);

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await migrator.query('BEGIN');
    try {
      await migrator.query("SELECT set_config('app.current_org_id', $1, true)", [
        tenant.organizationId,
      ]);
      for (const table of [
        'credit_transactions',
        'credits',
        'entitlement_overrides',
        'subscriptions',
      ]) {
        await migrator.query(`DELETE FROM ${table} WHERE organization_id = $1`, [
          tenant.organizationId,
        ]);
      }
      await migrator.query('COMMIT');
    } catch {
      await migrator.query('ROLLBACK');
    }
    await cleanupTenant(migrator, tenant);
  }
  await app.end();
  await migrator.end();
});

/* ========================================================================== */
/* 1. The application cannot raise its own limits                             */
/* ========================================================================== */

describe('the application cannot edit the limits it is checked against', () => {
  it('can READ the plan catalogue', async () => {
    const { rows } = await app.query('SELECT key FROM plans');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('CANNOT update a plan entitlement', async () => {
    /*
     * The escalation that matters. A bug — or a compromised request path —
     * able to UPDATE this table would not be a limit bypass in one place; it
     * would be every limit at once, silently, with the enforcement code still
     * passing its own tests.
     */
    await expect(
      app.query('UPDATE plan_entitlements SET limit_value = 999999'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT insert a plan entitlement', async () => {
    const id = await planId('free');
    await expect(
      app.query(
        `INSERT INTO plan_entitlements (plan_id, feature_key, limit_value) VALUES ($1, $2, NULL)`,
        [id, 'agents.max'],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT create a plan of its own', async () => {
    await expect(
      app.query(
        `INSERT INTO plans (key, name, price_monthly_cents) VALUES ('free-unlimited', 'x', 0)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT grant itself an entitlement override', async () => {
    // An override is a commercial exception. There is deliberately no
    // self-service path to raising your own limit, and the grant enforces it
    // rather than the absence of an endpoint.
    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO entitlement_overrides (organization_id, feature_key, limit_value, reason)
           VALUES ($1, 'agents.max', NULL, 'self-granted')`,
          [tenantA.organizationId],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('CANNOT delete a plan to escape its limits', async () => {
    await expect(app.query(`DELETE FROM plans WHERE key = 'free'`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

/* ========================================================================== */
/* 2. Resolution against real rows                                            */
/* ========================================================================== */

describe('resolution against the seeded catalogue', () => {
  async function entitlementRows(tenant: TestTenant) {
    return asOrg(app, tenant.organizationId, async () => {
      const plan = await app.query<{
        feature_key: string;
        limit_value: string | null;
        allowed_values: string[] | null;
      }>(
        `SELECT pe.feature_key, pe.limit_value, pe.allowed_values
           FROM subscriptions s
           JOIN plan_entitlements pe ON pe.plan_id = s.plan_id
          WHERE s.organization_id = $1`,
        [tenant.organizationId],
      );

      const overrides = await app.query<{
        feature_key: string;
        limit_value: string | null;
        allowed_values: string[] | null;
      }>(
        `SELECT feature_key, limit_value, allowed_values FROM entitlement_overrides
          WHERE organization_id = $1`,
        [tenant.organizationId],
      );

      const shape = (r: { feature_key: string; limit_value: string | null; allowed_values: string[] | null }) => ({
        featureKey: r.feature_key,
        limitValue: r.limit_value === null ? null : Number(r.limit_value),
        ...(r.allowed_values ? { allowedValues: r.allowed_values } : {}),
      });

      return { plan: plan.rows.map(shape), overrides: overrides.rows.map(shape) };
    });
  }

  it('gives the free plan its seeded agent limit', async () => {
    const sources = await entitlementRows(tenantA);
    const entitlement = resolveEntitlement(Feature.AGENTS_MAX, sources);
    expect(entitlement).toEqual({ kind: 'limited', limit: 2 });
  });

  it('gives a different plan a different limit, from the same code path', async () => {
    // The proof that the number comes from data: same function, same feature,
    // two answers, and no branch in the code that knows about plans.
    const sources = await entitlementRows(tenantB);
    expect(resolveEntitlement(Feature.AGENTS_MAX, sources)).toEqual({ kind: 'limited', limit: 25 });
  });

  it('restricts the free plan to a model allowlist', async () => {
    const sources = await entitlementRows(tenantA);
    const entitlement = resolveEntitlement(Feature.AI_MODELS, sources);
    expect(entitlement.kind).toBe('allowlist');
  });

  it('leaves the team plan unrestricted on models', async () => {
    expect(resolveEntitlement(Feature.AI_MODELS, await entitlementRows(tenantB)).kind).toBe(
      'unlimited',
    );
  });

  it('an operator-inserted override beats the plan', async () => {
    /*
     * Written by the MIGRATOR, because the application cannot. That is the
     * design: an override is granted out of band by someone with database
     * access, and the running service can only read it.
     */
    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.current_org_id', $1, true)", [
      tenantA.organizationId,
    ]);
    await migrator.query(
      `INSERT INTO entitlement_overrides (organization_id, feature_key, limit_value, reason)
       VALUES ($1, 'agents.max', 500, 'negotiated in the security suite')
       ON CONFLICT (organization_id, feature_key) DO UPDATE SET limit_value = 500`,
      [tenantA.organizationId],
    );
    await migrator.query('COMMIT');

    const sources = await entitlementRows(tenantA);
    expect(resolveEntitlement(Feature.AGENTS_MAX, sources)).toEqual({ kind: 'limited', limit: 500 });

    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.current_org_id', $1, true)", [
      tenantA.organizationId,
    ]);
    await migrator.query('DELETE FROM entitlement_overrides WHERE organization_id = $1', [
      tenantA.organizationId,
    ]);
    await migrator.query('COMMIT');
  });

  it('an organization with NO subscription is entitled to nothing', async () => {
    // Fails closed. The alternative — treating an unsubscribed organization as
    // unlimited — gives the product away to anyone whose subscription row was
    // never created.
    const decision = checkQuota(Feature.AGENTS_MAX, { kind: 'not_included' }, 0);
    expect(decision.allowed).toBe(false);
  });
});

/* ========================================================================== */
/* 3. Tenant isolation of billing data                                        */
/* ========================================================================== */

describe('billing data is tenant-isolated like everything else', () => {
  it('tenant A cannot see tenant B subscription', async () => {
    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT id FROM subscriptions WHERE organization_id = $1', [
        tenantB.organizationId,
      ]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('tenant A cannot see tenant B credit ledger', async () => {
    await asOrg(app, tenantB.organizationId, () =>
      app.query(
        `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key, reason)
         VALUES ($1, 'grant', 1000000, '2026-09', 'tenant B allowance')`,
        [tenantB.organizationId],
      ),
    );

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query('SELECT id FROM credit_transactions'),
    );
    // A only ever sees its own rows, which at this point are none.
    expect(rows.rowCount).toBe(0);
  });

  it('tenant A cannot write a ledger entry into tenant B', async () => {
    await expect(
      asOrg(app, tenantA.organizationId, () =>
        app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, 'grant', 999999999, '2026-09')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('the subscription table permits only one row per organization', async () => {
    // Two would make "which plan am I on?" a question with two answers, and
    // enforcement would pick one arbitrarily.
    await expect(
      asOrg(app, tenantA.organizationId, async () => {
        const id = await planId('team');
        return app.query(
          `INSERT INTO subscriptions (organization_id, plan_id, current_period_end)
           VALUES ($1, $2, now() + interval '30 days')`,
          [tenantA.organizationId, id],
        );
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

/* ========================================================================== */
/* 4. The ledger                                                              */
/* ========================================================================== */

describe('the credit ledger', () => {
  it('is append-only: no UPDATE', async () => {
    /*
     * This is what a customer is charged from. A record the application can
     * rewrite is not a record, and a disputed invoice is exactly when that
     * matters.
     */
    await expect(
      asOrg(app, tenantB.organizationId, () =>
        app.query(`UPDATE credit_transactions SET amount_micro_usd = 0`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is append-only: no DELETE', async () => {
    await expect(
      asOrg(app, tenantB.organizationId, () => app.query(`DELETE FROM credit_transactions`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('REFUSES a debit with the wrong sign', async () => {
    /*
     * A `debit` of +500 would silently ADD credit — and would reconcile
     * perfectly, because the ledger and the cached balance would agree on the
     * wrong number. Obvious in review, invisible in production, so it is a
     * database constraint rather than a convention.
     */
    await expect(
      asOrg(app, tenantB.organizationId, () =>
        app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, 'debit', 500, '2026-09')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/sign_matches_kind/i);
  });

  it('REFUSES a negative grant', async () => {
    await expect(
      asOrg(app, tenantB.organizationId, () =>
        app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, 'grant', -500, '2026-09')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/sign_matches_kind/i);
  });

  it('REFUSES an adjustment with no reason', async () => {
    // An unexplained adjustment is indistinguishable from a mistake six months
    // later, and this table is where "why is this balance different?" has to
    // be answerable.
    await expect(
      asOrg(app, tenantB.organizationId, () =>
        app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, 'adjustment', -500, '2026-09')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/adjustment_explained/i);
  });

  it('ACCEPTS a zero-amount debit flagged unpriced', async () => {
    /*
     * A call completed that we could not price. Neither a charge nor a
     * non-event: charging a guess invents a figure people budget against, and
     * recording nothing makes the unpriced model free and unlimited — the
     * cheapest possible exploit.
     */
    await asOrg(app, tenantB.organizationId, () =>
      app.query(
        `INSERT INTO credit_transactions
           (organization_id, kind, amount_micro_usd, period_key, unpriced, reason)
         VALUES ($1, 'debit', 0, '2026-09', true, 'pricing not configured')`,
        [tenantB.organizationId],
      ),
    );

    const rows = await asOrg(app, tenantB.organizationId, () =>
      app.query<{ c: number }>(
        `SELECT count(*)::int c FROM credit_transactions WHERE unpriced`,
      ),
    );
    expect(rows.rows[0]!.c).toBe(1);
  });

  it('REFUSES a zero-amount debit that is NOT unpriced', async () => {
    // Otherwise the exception above would become a way to record charges of
    // nothing for calls that were priceable.
    await expect(
      asOrg(app, tenantB.organizationId, () =>
        app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, 'debit', 0, '2026-09')`,
          [tenantB.organizationId],
        ),
      ),
    ).rejects.toThrow(/sign_matches_kind/i);
  });

  it('RECONCILES: the cached balance equals the sum of the ledger', async () => {
    /*
     * The invariant the whole design rests on. `credits.balance_micro_usd`
     * exists so a pre-flight check need not sum a million rows; it is a cache,
     * and when it disagrees with the ledger the ledger wins, because a ledger
     * is what you can show a customer who disputes a bill.
     */
    await asOrg(app, tenantB.organizationId, async () => {
      /*
       * Seed the cache from the ledger that already exists, rather than from
       * zero. The cache is maintained INCREMENTALLY in production — every
       * debit adjusts it — so a test that reset it to zero and then added a
       * few rows would be reconciling a partial cache against a full ledger,
       * and would fail for a reason that says nothing about the system.
       */
      const existing = await app.query<{ total: string }>(
        `SELECT coalesce(sum(amount_micro_usd), 0)::bigint AS total
           FROM credit_transactions WHERE organization_id = $1`,
        [tenantB.organizationId],
      );

      await app.query(
        `INSERT INTO credits (organization_id, balance_micro_usd, period_key)
         VALUES ($1, $2, '2026-09')
         ON CONFLICT (organization_id) DO UPDATE SET balance_micro_usd = $2`,
        [tenantB.organizationId, Number(existing.rows[0]!.total)],
      );

      for (const [kind, amount] of [
        ['grant', 5 * MICRO],
        ['debit', -1 * MICRO],
        ['debit', -250_000],
        ['refund', 100_000],
      ] as const) {
        await app.query(
          `INSERT INTO credit_transactions (organization_id, kind, amount_micro_usd, period_key)
           VALUES ($1, $2, $3, '2026-09')`,
          [tenantB.organizationId, kind, amount],
        );
        await app.query(
          `UPDATE credits SET balance_micro_usd = balance_micro_usd + $2
            WHERE organization_id = $1`,
          [tenantB.organizationId, amount],
        );
      }
    });

    const { cached, ledger } = await asOrg(app, tenantB.organizationId, async () => {
      const c = await app.query<{ balance_micro_usd: string }>(
        'SELECT balance_micro_usd FROM credits WHERE organization_id = $1',
        [tenantB.organizationId],
      );
      const l = await app.query<{ kind: string; amount_micro_usd: string }>(
        'SELECT kind, amount_micro_usd FROM credit_transactions WHERE organization_id = $1',
        [tenantB.organizationId],
      );
      return {
        cached: Number(c.rows[0]!.balance_micro_usd),
        ledger: l.rows.map(
          (r): CreditTransaction => ({
            kind: r.kind as TransactionKind,
            amountMicroUsd: Number(r.amount_micro_usd),
            createdAt: new Date(),
          }),
        ),
      };
    });

    expect(cached).toBe(reconcile(ledger));
  });

  it('every ledger row has a sign consistent with its kind', async () => {
    // The same rule the database enforces, checked from the other side — so a
    // future migration that relaxed the constraint would be caught here.
    const rows = await asOrg(app, tenantB.organizationId, () =>
      app.query<{ kind: string; amount_micro_usd: string; unpriced: boolean }>(
        'SELECT kind, amount_micro_usd, unpriced FROM credit_transactions',
      ),
    );

    for (const row of rows.rows) {
      const amount = Number(row.amount_micro_usd);
      const ok = row.unpriced && amount === 0
        ? true
        : signIsValid(row.kind as TransactionKind, amount);
      expect({ kind: row.kind, amount, ok }).toMatchObject({ ok: true });
    }
  });

  it('lets the balance go negative rather than clamping it', async () => {
    /*
     * Cost is only known after a call returns, so the pre-check is a balance
     * check and a burst of concurrent requests can each pass it before any
     * debits. Clamping at zero would HIDE that overspend; the negative balance
     * records it, and the next pre-check refuses.
     */
    await asOrg(app, tenantA.organizationId, async () => {
      await app.query(
        `INSERT INTO credits (organization_id, balance_micro_usd, period_key)
         VALUES ($1, 100, '2026-09')
         ON CONFLICT (organization_id) DO UPDATE SET balance_micro_usd = 100`,
        [tenantA.organizationId],
      );
      await app.query(
        `UPDATE credits SET balance_micro_usd = balance_micro_usd - 500 WHERE organization_id = $1`,
        [tenantA.organizationId],
      );
    });

    const rows = await asOrg(app, tenantA.organizationId, () =>
      app.query<{ balance_micro_usd: string }>(
        'SELECT balance_micro_usd FROM credits WHERE organization_id = $1',
        [tenantA.organizationId],
      ),
    );
    expect(Number(rows.rows[0]!.balance_micro_usd)).toBe(-400);
  });
});

/* ========================================================================== */
/* 5. No hard-coded limits                                                    */
/* ========================================================================== */

describe('no hard-coded limits', () => {
  it('every feature the code knows about exists in the seeded catalogue', async () => {
    /*
     * A feature the code enforces but no plan defines is denied to everyone —
     * a safe default, and a silent one. This catches the drift where a feature
     * is added to the enum and never to the plans.
     */
    const { rows } = await app.query<{ feature_key: string }>(
      'SELECT DISTINCT feature_key FROM plan_entitlements',
    );
    const seeded = new Set(rows.map((r) => r.feature_key));

    for (const feature of ALL_FEATURES) {
      expect({ feature, seeded: seeded.has(feature) }).toEqual({ feature, seeded: true });
    }
  });

  it('the database defines no feature the code does not know about', async () => {
    // The other direction: a stale row silently enforcing something nobody
    // designed, or worse, silently enforcing nothing.
    const { rows } = await app.query<{ feature_key: string }>(
      'SELECT DISTINCT feature_key FROM plan_entitlements',
    );
    const known = new Set<string>(ALL_FEATURES);
    for (const row of rows) {
      expect({ key: row.feature_key, known: known.has(row.feature_key) }).toEqual({
        key: row.feature_key,
        known: true,
      });
    }
  });

  it('no safety ceiling was smuggled in as a purchasable feature', async () => {
    /*
     * The distinction this gate is easiest to misread into breaking. A public
     * chatbot's step budget, the crawler's page ceiling and the SSRF blocked
     * ranges are abuse controls, not plan features. Selling them would mean
     * selling a weaker security posture to whoever pays most.
     */
    const { rows } = await app.query<{ feature_key: string }>(
      'SELECT DISTINCT feature_key FROM plan_entitlements',
    );
    const seeded = new Set(rows.map((r) => r.feature_key));

    for (const ceiling of SAFETY_CEILINGS_ARE_NOT_ENTITLEMENTS) {
      expect({ ceiling, sold: seeded.has(ceiling) }).toEqual({ ceiling, sold: false });
    }
  });

  it('the seeded plans match the definitions they came from', async () => {
    // Not that they must stay matched — an operator is free to edit them, and
    // the seed deliberately does not clobber that. This asserts the SEED did
    // what it claimed on a fresh database.
    for (const plan of DEFAULT_PLANS) {
      const { rows } = await app.query<{ price_monthly_cents: number | null }>(
        'SELECT price_monthly_cents FROM plans WHERE key = $1',
        [plan.key],
      );
      expect({ key: plan.key, found: rows.length }).toEqual({ key: plan.key, found: 1 });
      expect(rows[0]!.price_monthly_cents).toBe(plan.priceMonthlyCents);
    }
  });
});
