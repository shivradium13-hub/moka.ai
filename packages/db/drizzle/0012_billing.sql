-- =============================================================================
-- 0012_billing — plans, entitlements, subscriptions and credits
--
-- Run as: moka_migrator
--
-- Master prompt §34, §35. The gate this phase is measured on is "entitlement
-- enforcement; no hard-coded limits", and the shape below is what makes that
-- checkable rather than asserted:
--
--     plans ──< plan_entitlements
--                   │
--     organizations ─┴─< subscriptions ──< entitlement_overrides
--                                              │
--                                         usage / counts ──▶ enforcement
--
-- Application code asks "what is this organization entitled to?" and gets a
-- row. Changing what a plan includes is an UPDATE, not a deployment.
--
-- THE GRANT THAT MATTERS MOST IS AT THE BOTTOM OF THIS FILE.
--
-- `moka_app` can SELECT the plan catalogue and the overrides. It cannot write
-- either. The one escalation an entitlement system has to rule out is the one
-- where the thing being limited gets to edit the limit, and a GRANT is a
-- stronger way to rule it out than a code review.
-- =============================================================================

-- =============================================================================
-- plans — GLOBAL, like roles and permissions
-- =============================================================================

CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text        NOT NULL,
  name                text        NOT NULL,
  description         text,
  /*
   * Integer cents, never a float, and NULL rather than a made-up number for a
   * negotiated tier. A price is a commercial claim; inventing one for
   * "enterprise" would be a statement about an arrangement nobody has made.
   */
  price_monthly_cents integer,
  currency            text        NOT NULL DEFAULT 'USD',
  sort_order          integer     NOT NULL DEFAULT 0,
  status              text        NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plans_status_valid CHECK (status IN ('active', 'retired')),
  CONSTRAINT plans_price_sane CHECK (price_monthly_cents IS NULL OR price_monthly_cents >= 0)
);

CREATE UNIQUE INDEX plans_key_unique ON plans (key);

-- =============================================================================
-- plan_entitlements — GLOBAL
-- =============================================================================

CREATE TABLE plan_entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  feature_key  text NOT NULL,
  /*
   * THREE STATES, and conflating any two of them is a real bug:
   *
   *   a number  — that many, and no more.
   *   NULL      — UNLIMITED. Not zero, not "unset".
   *   no row    — NOT INCLUDED. The plan does not offer this feature.
   *
   * `limit ?? 0` breaks every customer on an unlimited plan. `limit ??
   * Infinity` gives the product away the moment a plan is unseeded. The
   * application models all three explicitly (see @moka/billing entitlements.ts).
   */
  limit_value  bigint,
  -- For allowlist features, e.g. which models a plan may call.
  allowed_values text[],
  unit         text NOT NULL DEFAULT 'count',

  CONSTRAINT plan_entitlements_limit_sane CHECK (limit_value IS NULL OR limit_value >= 0),
  CONSTRAINT plan_entitlements_unit_valid CHECK (unit IN ('count', 'bytes', 'micro_usd', 'allowlist'))
);

CREATE UNIQUE INDEX plan_entitlements_unique ON plan_entitlements (plan_id, feature_key);

-- =============================================================================
-- subscriptions
-- =============================================================================

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting a plan that organizations are on should
  -- fail loudly rather than silently unsubscribing them.
  plan_id              uuid        NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,

  status               text        NOT NULL DEFAULT 'active',
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end   timestamptz NOT NULL,
  cancel_at            timestamptz,

  /*
   * The payment processor's identifier, when one was involved.
   *
   * NULL for every subscription this build creates: no processor is
   * integrated, and §45 forbids faking a payment confirmation. A manually
   * recorded subscription carries the operator's own reference instead.
   */
  external_ref         text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_status_valid CHECK (
    status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')
  ),
  CONSTRAINT subscriptions_period_ordered CHECK (current_period_end > current_period_start)
);

-- One live subscription per organization. Two would make "which plan am I on?"
-- a question with two answers, and enforcement would pick one arbitrarily.
CREATE UNIQUE INDEX subscriptions_org_unique ON subscriptions (organization_id);

-- =============================================================================
-- entitlement_overrides — a negotiated exception without cloning a plan
-- =============================================================================

CREATE TABLE entitlement_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  feature_key     text        NOT NULL,
  limit_value     bigint,
  allowed_values  text[],
  -- Required. An override with no stated reason is indistinguishable from a
  -- mistake six months later, and this table is where "why does this customer
  -- have 10x the limit?" has to be answerable.
  reason          text        NOT NULL,
  expires_at      timestamptz,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entitlement_overrides_limit_sane CHECK (limit_value IS NULL OR limit_value >= 0),
  CONSTRAINT entitlement_overrides_reason_present CHECK (length(trim(reason)) > 0)
);

CREATE UNIQUE INDEX entitlement_overrides_unique
  ON entitlement_overrides (organization_id, feature_key);

-- =============================================================================
-- credits — a CACHE of the ledger below
-- =============================================================================

CREATE TABLE credits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  /*
   * Integer micro-dollars. Deliberately NOT constrained to be non-negative.
   *
   * The cost of a provider call is not known until it returns, so the
   * pre-flight check is a balance check rather than a price check. A burst of
   * concurrent requests can each pass it and then each debit, taking the
   * balance under by at most one call per concurrent request. Clamping at zero
   * would HIDE that overspend; letting it go negative records it, and the next
   * pre-check refuses.
   */
  balance_micro_usd  bigint      NOT NULL DEFAULT 0,
  -- `YYYY-MM` in UTC. UTC so a tenant cannot get a second monthly allowance by
  -- moving timezone, and so two servers in different regions agree.
  period_key         text        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX credits_org_unique ON credits (organization_id);

-- =============================================================================
-- credit_transactions — the authoritative ledger
--
-- APPEND-ONLY. `credits.balance_micro_usd` is a cache of SUM(amount) here, and
-- tests/security/entitlement-enforcement.test.ts reconciles the two. When they
-- disagree the ledger wins, because a ledger is what you can show a customer
-- who disputes a bill.
-- =============================================================================

CREATE TABLE credit_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,

  kind             text        NOT NULL,
  -- Signed: positive adds credit, negative consumes it.
  amount_micro_usd bigint      NOT NULL,
  reason           text,
  period_key       text        NOT NULL,

  -- No FK: usage is append-only and may be purged on a different schedule
  -- from billing, and a dangling reference is better than a purge that fails.
  usage_record_id  uuid,
  /*
   * A call happened that we could not price. NOT the same as a free call.
   *
   * Charging a guess invents a figure people budget against; charging zero
   * silently makes an unpriced model free and unlimited, which is the cheapest
   * possible exploit — use whichever model nobody has priced. So: charge
   * nothing, and record the gap as the registry bug it is.
   */
  unpriced         boolean     NOT NULL DEFAULT false,

  request_id       text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_transactions_kind_valid CHECK (
    kind IN ('grant', 'debit', 'refund', 'expiry', 'adjustment')
  ),
  /*
   * SIGN DISCIPLINE, enforced by the database.
   *
   * A `debit` of +500 would silently ADD credit — and would reconcile
   * perfectly, because the ledger and the cached balance would agree on the
   * wrong number. That is the class of bug that is obvious in review and
   * invisible in production, so it is a constraint rather than a convention.
   */
  CONSTRAINT credit_transactions_sign_matches_kind CHECK (
    (kind IN ('grant', 'refund')  AND amount_micro_usd > 0) OR
    (kind IN ('debit', 'expiry')  AND amount_micro_usd < 0) OR
    (kind = 'adjustment'          AND amount_micro_usd <> 0)
  ),
  -- An adjustment is a human overriding the ledger. It must say why.
  CONSTRAINT credit_transactions_adjustment_explained CHECK (
    kind <> 'adjustment' OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  ),
  -- An unpriced entry records that a call was not charged, so its amount is 0.
  CONSTRAINT credit_transactions_unpriced_is_zero CHECK (
    NOT unpriced OR amount_micro_usd = 0 OR kind = 'adjustment'
  )
);

CREATE INDEX credit_transactions_org_created_idx
  ON credit_transactions (organization_id, created_at DESC);
CREATE INDEX credit_transactions_org_period_idx
  ON credit_transactions (organization_id, period_key);

-- =============================================================================
-- ROW-LEVEL SECURITY
--
-- `plans` and `plan_entitlements` are GLOBAL and deliberately have none: one
-- catalogue for the installation, readable by every tenant, exactly like
-- `roles` and `permissions`. They are registered in INTENTIONALLY_GLOBAL_TABLES
-- so the isolation suite reviews that decision rather than skipping it.
-- =============================================================================

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_overrides FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entitlement_overrides
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credits
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_transactions
  USING (organization_id = current_org_id()) WITH CHECK (organization_id = current_org_id());

-- =============================================================================
-- TENANT INTEGRITY
--
-- Composite keys, for the reason established in 0010: referential integrity
-- checks run with row security DISABLED, so a single-column reference is
-- satisfied by any row in the installation.
--
-- `subscriptions.plan_id` is deliberately NOT composite: plans are global by
-- design, so pointing at one is not a cross-tenant reference.
-- =============================================================================

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_org_id_unique
  UNIQUE (organization_id, id);

-- =============================================================================
-- GRANTS — the important part
-- =============================================================================

/*
 * READ ONLY on the catalogue and on overrides.
 *
 * The application checks itself against these numbers, so it must not be able
 * to change them. A bug — or a compromised request path — that could UPDATE
 * `plan_entitlements` would not be a limit bypass in one place; it would be
 * every limit at once, silently, with the enforcement code still passing its
 * own tests.
 *
 * Plans are edited by an operator through migration or the seed script.
 * Overrides are granted the same way, deliberately: an override is a
 * commercial exception, and there is no self-service path to raising your own
 * limit. `docs/roadmap.md` records the absence of an admin UI for this as a
 * known gap rather than an oversight.
 */
GRANT SELECT ON plans, plan_entitlements, entitlement_overrides TO moka_app;

-- Subscriptions are written by the application: a new organization gets one,
-- and a plan change updates it.
GRANT SELECT, INSERT, UPDATE ON subscriptions TO moka_app;

-- The cached balance is updated on every debit.
GRANT SELECT, INSERT, UPDATE ON credits TO moka_app;

-- Append-only. No UPDATE, no DELETE: this is what a customer is charged from.
GRANT SELECT, INSERT ON credit_transactions TO moka_app;
