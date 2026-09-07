-- =============================================================================
-- 0013_unpriced_debits — let the ledger record a call it could not price
--
-- Run as: moka_migrator
--
-- 0012 asserted that a `debit` is always negative, which is right for every
-- debit that charges something. It is wrong for the one case that matters
-- most to get right:
--
--   A provider call completed, and we could not price it, because the model's
--   pricing is not configured in our own registry.
--
-- That is neither a charge nor a non-event. Charging a guess would invent a
-- figure people budget against; recording nothing would make the unpriced
-- model free and unlimited — the cheapest possible exploit, since a customer
-- only has to use whichever model nobody has priced. So the ledger records a
-- ZERO-AMOUNT debit flagged `unpriced`, and the usage page reports "N calls
-- this period could not be priced".
--
-- The gap is a bug in our model registry. This makes it visible as one,
-- rather than absorbing it as revenue or giving it away as a feature.
--
-- The constraint is therefore relaxed in exactly one direction: a debit may be
-- zero if and only if it is flagged unpriced. Every other debit must still be
-- negative, because a debit that ADDED credit would reconcile perfectly
-- against a wrong balance — the class of bug that is obvious in review and
-- invisible in production.
-- =============================================================================

ALTER TABLE credit_transactions DROP CONSTRAINT credit_transactions_sign_matches_kind;

ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_sign_matches_kind CHECK (
  (kind IN ('grant', 'refund') AND amount_micro_usd > 0)
  OR (kind = 'expiry' AND amount_micro_usd < 0)
  OR (kind = 'debit' AND amount_micro_usd < 0)
  -- The one new case: a completed call that could not be priced.
  OR (kind = 'debit' AND amount_micro_usd = 0 AND unpriced)
  OR (kind = 'adjustment' AND amount_micro_usd <> 0)
);
