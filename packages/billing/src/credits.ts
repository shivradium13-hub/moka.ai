/**
 * The credit ledger (master prompt §35).
 *
 * THE INVARIANT: the balance is not the truth. The ledger is.
 *
 * `credits.balance_micro_usd` exists because a pre-flight check on every
 * provider call cannot afford to sum a million rows. It is a cache of
 * `SUM(credit_transactions.amount_micro_usd)`, and a test reconciles the two.
 * When they disagree the ledger wins, because a ledger is what you can show a
 * customer who disputes a bill.
 *
 * Everything here is integer MICRO-DOLLARS, never a float. Floating-point
 * drift is invisible per request and material across millions of them, and
 * this is the number a customer is charged.
 */

export const TransactionKind = {
  /** Credit added: a plan's monthly allowance, a top-up, a goodwill grant. */
  GRANT: 'grant',
  /** Credit consumed by a provider call. Always negative. */
  DEBIT: 'debit',
  /** Credit returned — a failed call that was charged, say. Always positive. */
  REFUND: 'refund',
  /** An allowance that lapsed at period end. Always negative. */
  EXPIRY: 'expiry',
  /** An operator correcting the ledger by hand, with a reason. */
  ADJUSTMENT: 'adjustment',
} as const;

export type TransactionKind = (typeof TransactionKind)[keyof typeof TransactionKind];

export interface CreditTransaction {
  readonly kind: TransactionKind;
  /** Signed. Positive adds credit, negative consumes it. */
  readonly amountMicroUsd: number;
  readonly createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Sign discipline                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether a transaction's sign matches its kind.
 *
 * A `debit` of +500 would silently ADD credit — an off-by-one-sign bug that
 * hands out free usage and reconciles perfectly, because the ledger and the
 * balance would agree on the wrong number. Checked here and, in the database,
 * by a CHECK constraint, because this is the kind of mistake that is obvious
 * in review and invisible in production.
 */
export function signIsValid(kind: TransactionKind, amountMicroUsd: number): boolean {
  switch (kind) {
    case TransactionKind.GRANT:
    case TransactionKind.REFUND:
      return amountMicroUsd > 0;
    case TransactionKind.DEBIT:
    case TransactionKind.EXPIRY:
      return amountMicroUsd < 0;
    case TransactionKind.ADJUSTMENT:
      // An adjustment may go either way; that is what makes it an adjustment.
      // Zero is refused because a zero-value ledger entry records nothing.
      return amountMicroUsd !== 0;
  }
}

/** The balance implied by a ledger. The authoritative figure. */
export function reconcile(transactions: readonly CreditTransaction[]): number {
  return transactions.reduce((sum, t) => sum + t.amountMicroUsd, 0);
}

/* -------------------------------------------------------------------------- */
/* Pre-flight                                                                  */
/* -------------------------------------------------------------------------- */

export const CreditVerdict = {
  OK: 'ok',
  EXHAUSTED: 'exhausted',
  /** Credit is not metered for this organization at all. */
  UNMETERED: 'unmetered',
} as const;

export type CreditVerdict = (typeof CreditVerdict)[keyof typeof CreditVerdict];

export interface CreditCheck {
  readonly verdict: CreditVerdict;
  readonly balanceMicroUsd: number | null;
  readonly message?: string;
}

/**
 * Whether a provider call may proceed.
 *
 * DELIBERATELY A BALANCE CHECK, NOT A PRICE CHECK, and the reason is worth
 * being explicit about: the cost of a call is not known until it returns,
 * because it depends on how many tokens the model chooses to emit. There is
 * no honest way to pre-authorise an exact amount.
 *
 * The consequence is a REAL, BOUNDED LIMITATION: a burst of concurrent
 * requests can each pass this check and then each debit, taking the balance
 * negative by at most one call per concurrent request. That is why the debit
 * itself is atomic, why the balance may go negative rather than being clamped
 * at zero (a clamped balance would hide the overspend), and why this is
 * documented rather than papered over.
 *
 * The alternative — reserving a pessimistic maximum before every call — would
 * make a customer's usable credit a fraction of what they bought.
 */
export function checkCredit(params: {
  balanceMicroUsd: number | null;
  /** False when this organization's plan does not meter AI spend. */
  metered: boolean;
}): CreditCheck {
  if (!params.metered) {
    return { verdict: CreditVerdict.UNMETERED, balanceMicroUsd: params.balanceMicroUsd };
  }

  const balance = params.balanceMicroUsd ?? 0;
  if (balance <= 0) {
    return {
      verdict: CreditVerdict.EXHAUSTED,
      balanceMicroUsd: balance,
      message: 'This organization has no AI credit remaining.',
    };
  }

  return { verdict: CreditVerdict.OK, balanceMicroUsd: balance };
}

/* -------------------------------------------------------------------------- */
/* Unpriced usage                                                              */
/* -------------------------------------------------------------------------- */

export interface DebitPlan {
  /** Micro-dollars to remove. Zero when the call could not be priced. */
  readonly amountMicroUsd: number;
  /**
   * True when a call happened that we could not price.
   *
   * NOT the same as a free call, and the distinction is the whole point. An
   * unpriced model must never quietly become an unlimited one.
   */
  readonly unpriced: boolean;
  readonly reason?: string;
}

/**
 * Turn a cost estimate into a ledger movement.
 *
 * `costMicroUsd: null` means the model's pricing is not configured — see
 * `estimateCost` in @moka/ai, which refuses to invent a number rather than
 * falling back to an average. Billing has to make a decision about that, and
 * the honest options are narrow:
 *
 *   Charge a guess          → invents a figure people will budget against.
 *   Charge zero, silently   → an unpriced model becomes free and unlimited,
 *                             which is the cheapest possible exploit: use the
 *                             model nobody has priced.
 *   Refuse the call         → correct, and blocks a working model over a
 *                             missing pricing row in OUR registry.
 *
 * So: charge nothing, and RECORD THE GAP loudly. The balance pre-check still
 * requires positive credit, so an unpriced model cannot be used from a zero
 * balance, and the dashboard reports how many calls could not be priced. The
 * gap is a bug in our model registry, and it is surfaced as one rather than
 * absorbed as revenue or given away as a feature.
 */
export function planDebit(costMicroUsd: number | null): DebitPlan {
  if (costMicroUsd === null) {
    return {
      amountMicroUsd: 0,
      unpriced: true,
      reason: 'Pricing for this model is not configured, so the call was not charged.',
    };
  }
  if (costMicroUsd <= 0) {
    return { amountMicroUsd: 0, unpriced: false };
  }
  return { amountMicroUsd: costMicroUsd, unpriced: false };
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The UTC month a timestamp falls in, as `YYYY-MM`.
 *
 * Per-month entitlements are counted against this. UTC rather than the
 * organization's local time because a tenant that moves timezone must not get
 * a second allowance, and because two servers in different regions must agree
 * on which month a call belongs to.
 */
export function periodKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Start of the UTC month containing `at`. */
export function periodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** Start of the following UTC month — the exclusive end of the period. */
export function periodEnd(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** Micro-dollars for display. Mirrors formatMicroUsd in @moka/ai. */
export function formatCredit(microUsd: number | null): string {
  if (microUsd === null) return '—';
  const dollars = microUsd / 1_000_000;
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(6)}`;
  return `$${dollars.toFixed(2)}`;
}
