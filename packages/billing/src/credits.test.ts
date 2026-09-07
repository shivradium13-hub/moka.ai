import { describe, expect, it } from 'vitest';
import {
  CreditVerdict,
  TransactionKind,
  checkCredit,
  formatCredit,
  periodEnd,
  periodKey,
  periodStart,
  planDebit,
  reconcile,
  signIsValid,
  type CreditTransaction,
} from './credits.js';
import { DEFAULT_PLANS, DEFAULT_PLAN_KEY, findPlanDefinition } from './plans.js';
import { ALL_FEATURES, Feature, resolveEntitlement } from './entitlements.js';

/**
 * The credit ledger.
 *
 * This is the number a customer is charged, so the tests are about arithmetic
 * being right rather than about features working: sign discipline, integer
 * money, and the reconciliation that makes the ledger — not the cached
 * balance — authoritative.
 */

const AT = new Date('2026-09-07T12:00:00Z');

function tx(kind: TransactionKind, amountMicroUsd: number): CreditTransaction {
  return { kind, amountMicroUsd, createdAt: AT };
}

/* ========================================================================== */
/* Sign discipline                                                            */
/* ========================================================================== */

describe('sign discipline', () => {
  it('requires grants and refunds to be positive', () => {
    expect(signIsValid(TransactionKind.GRANT, 1_000)).toBe(true);
    expect(signIsValid(TransactionKind.GRANT, -1_000)).toBe(false);
    expect(signIsValid(TransactionKind.REFUND, 500)).toBe(true);
    expect(signIsValid(TransactionKind.REFUND, -500)).toBe(false);
  });

  it('requires debits and expiries to be negative', () => {
    /*
     * A debit of +500 would silently ADD credit — and would reconcile
     * perfectly, because the ledger and the cached balance would agree on the
     * wrong number. Obvious in review, invisible in production.
     */
    expect(signIsValid(TransactionKind.DEBIT, -500)).toBe(true);
    expect(signIsValid(TransactionKind.DEBIT, 500)).toBe(false);
    expect(signIsValid(TransactionKind.EXPIRY, -500)).toBe(true);
    expect(signIsValid(TransactionKind.EXPIRY, 500)).toBe(false);
  });

  it('lets an adjustment go either way, but not to zero', () => {
    expect(signIsValid(TransactionKind.ADJUSTMENT, 100)).toBe(true);
    expect(signIsValid(TransactionKind.ADJUSTMENT, -100)).toBe(true);
    // A zero-value ledger entry records nothing and cannot be explained later.
    expect(signIsValid(TransactionKind.ADJUSTMENT, 0)).toBe(false);
  });

  it('refuses a zero-value grant or debit', () => {
    expect(signIsValid(TransactionKind.GRANT, 0)).toBe(false);
    expect(signIsValid(TransactionKind.DEBIT, 0)).toBe(false);
  });
});

/* ========================================================================== */
/* Reconciliation                                                             */
/* ========================================================================== */

describe('reconciliation', () => {
  it('derives the balance from the ledger', () => {
    const ledger = [
      tx(TransactionKind.GRANT, 2_000_000),
      tx(TransactionKind.DEBIT, -150_000),
      tx(TransactionKind.DEBIT, -250_000),
      tx(TransactionKind.REFUND, 50_000),
    ];
    expect(reconcile(ledger)).toBe(1_650_000);
  });

  it('is zero for an empty ledger', () => {
    expect(reconcile([])).toBe(0);
  });

  it('can go negative, and does not clamp', () => {
    /*
     * A clamped balance would HIDE an overspend. Because cost is only known
     * after a call returns, a burst of concurrent requests can each pass the
     * pre-check and then each debit — the ledger has to be able to say so.
     */
    expect(reconcile([tx(TransactionKind.GRANT, 100), tx(TransactionKind.DEBIT, -500)])).toBe(-400);
  });

  it('stays exact across many small amounts', () => {
    // Integer micro-dollars, never floats. Drift is invisible per request and
    // material across millions of them, and this is a billing figure.
    const ledger = Array.from({ length: 10_000 }, () => tx(TransactionKind.DEBIT, -1));
    expect(reconcile([tx(TransactionKind.GRANT, 10_000), ...ledger])).toBe(0);
  });
});

/* ========================================================================== */
/* Pre-flight                                                                 */
/* ========================================================================== */

describe('the credit pre-check', () => {
  it('permits a positive balance', () => {
    expect(checkCredit({ balanceMicroUsd: 1, metered: true }).verdict).toBe(CreditVerdict.OK);
  });

  it('refuses at zero', () => {
    expect(checkCredit({ balanceMicroUsd: 0, metered: true }).verdict).toBe(
      CreditVerdict.EXHAUSTED,
    );
  });

  it('refuses when already negative', () => {
    // The overspend case. Having gone under once, do not go under further.
    expect(checkCredit({ balanceMicroUsd: -100, metered: true }).verdict).toBe(
      CreditVerdict.EXHAUSTED,
    );
  });

  it('reports UNMETERED rather than OK when the plan does not meter spend', () => {
    /*
     * A distinct verdict, not a permissive OK. "Unlimited credit" and "no
     * credit system" produce the same decision and want different words in a
     * usage dashboard.
     */
    const check = checkCredit({ balanceMicroUsd: null, metered: false });
    expect(check.verdict).toBe(CreditVerdict.UNMETERED);
  });

  it('treats a null balance on a metered plan as zero', () => {
    // Missing is not the same as unlimited. Failing open here would hand out
    // free usage to any organization whose credit row was never created.
    expect(checkCredit({ balanceMicroUsd: null, metered: true }).verdict).toBe(
      CreditVerdict.EXHAUSTED,
    );
  });
});

/* ========================================================================== */
/* Unpriced usage                                                             */
/* ========================================================================== */

describe('planDebit', () => {
  it('charges a known cost', () => {
    expect(planDebit(1_234)).toEqual({ amountMicroUsd: 1_234, unpriced: false });
  });

  it('charges nothing for an unpriced call, and SAYS SO', () => {
    /*
     * The alternative failure modes are both worse. Charging a guess invents a
     * figure people budget against; charging zero silently makes the unpriced
     * model free and unlimited, which is the cheapest possible exploit — use
     * whichever model nobody has priced.
     *
     * So: charge nothing, flag it loudly. The balance pre-check still requires
     * positive credit, so this cannot be used from zero, and the gap surfaces
     * as the registry bug it is.
     */
    const debit = planDebit(null);
    expect(debit.amountMicroUsd).toBe(0);
    expect(debit.unpriced).toBe(true);
    expect(debit.reason).toMatch(/not configured/i);
  });

  it('distinguishes "cost zero" from "cost unknown"', () => {
    expect(planDebit(0).unpriced).toBe(false);
    expect(planDebit(null).unpriced).toBe(true);
  });

  it('never produces a negative debit from a negative cost', () => {
    // A negative cost is nonsense from the estimator; treating it as a refund
    // would let a pricing bug mint credit.
    expect(planDebit(-500).amountMicroUsd).toBe(0);
  });
});

/* ========================================================================== */
/* Periods                                                                    */
/* ========================================================================== */

describe('periods', () => {
  it('keys by UTC month', () => {
    expect(periodKey(new Date('2026-09-07T12:00:00Z'))).toBe('2026-09');
    expect(periodKey(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01');
  });

  it('uses UTC, so a tenant cannot get a second allowance by moving timezone', () => {
    // Also so two servers in different regions agree on which month a call
    // belongs to.
    expect(periodKey(new Date('2026-09-30T23:30:00Z'))).toBe('2026-09');
    expect(periodKey(new Date('2026-10-01T00:30:00Z'))).toBe('2026-10');
  });

  it('brackets the month exactly', () => {
    const at = new Date('2026-09-07T12:00:00Z');
    expect(periodStart(at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(periodEnd(at).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rolls over the year end', () => {
    expect(periodEnd(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('formatting', () => {
  it('shows enough digits that a real cost never renders as zero', () => {
    expect(formatCredit(1)).toBe('$0.000001');
    expect(formatCredit(2_000_000)).toBe('$2.00');
  });

  it('renders an unknown amount as a dash rather than zero', () => {
    expect(formatCredit(null)).toBe('—');
  });

  it('shows a negative balance as negative', () => {
    expect(formatCredit(-1_500_000)).toBe('$-1.50');
  });
});

/* ========================================================================== */
/* The plan catalogue is data, not code                                       */
/* ========================================================================== */

describe('the default plan catalogue', () => {
  it('defines every feature on every plan', () => {
    /*
     * A plan missing a feature row denies it — correct as a default, and
     * confusing as an accident. Being exhaustive means a plan's coverage can
     * be read off the table rather than inferred from what is absent.
     */
    for (const plan of DEFAULT_PLANS) {
      const keys = new Set(plan.entitlements.map((e) => e.featureKey));
      for (const feature of ALL_FEATURES) {
        expect({ plan: plan.key, feature, present: keys.has(feature) }).toEqual({
          plan: plan.key,
          feature,
          present: true,
        });
      }
    }
  });

  it('has a free plan that new organizations land on', () => {
    expect(findPlanDefinition(DEFAULT_PLAN_KEY)).toBeDefined();
    expect(findPlanDefinition(DEFAULT_PLAN_KEY)!.priceMonthlyCents).toBe(0);
  });

  it('gives the enterprise plan unlimited everything, expressed as null', () => {
    const enterprise = findPlanDefinition('enterprise')!;
    for (const entitlement of enterprise.entitlements) {
      expect({ key: entitlement.featureKey, limit: entitlement.limitValue }).toEqual({
        key: entitlement.featureKey,
        limit: null,
      });
    }
  });

  it('prices the enterprise plan as null rather than inventing a figure', () => {
    // It is negotiated. A number here would be a claim about a commercial
    // arrangement nobody has made.
    expect(findPlanDefinition('enterprise')!.priceMonthlyCents).toBeNull();
  });

  it('restricts the free plan to specific models', () => {
    const free = findPlanDefinition('free')!;
    const models = free.entitlements.find((e) => e.featureKey === Feature.AI_MODELS)!;
    expect(models.allowedValues?.length ?? 0).toBeGreaterThan(0);

    const entitlement = resolveEntitlement(Feature.AI_MODELS, {
      overrides: [],
      plan: free.entitlements,
    });
    expect(entitlement.kind).toBe('allowlist');
  });

  it('has unique plan keys', () => {
    const keys = DEFAULT_PLANS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses integer money throughout', () => {
    for (const plan of DEFAULT_PLANS) {
      if (plan.priceMonthlyCents !== null) {
        expect(Number.isInteger(plan.priceMonthlyCents)).toBe(true);
      }
      for (const entitlement of plan.entitlements) {
        if (entitlement.limitValue !== null) {
          expect(Number.isInteger(entitlement.limitValue)).toBe(true);
        }
      }
    }
  });
});
