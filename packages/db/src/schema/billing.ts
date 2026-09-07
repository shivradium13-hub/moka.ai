import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';

/**
 * Plans, entitlements, subscriptions and credits (master prompt §34, §35).
 *
 * THREE LAYERS, so no limit is ever written in application code:
 *
 *     plans ──< plan_entitlements
 *                   │
 *     organizations ─┴─< subscriptions ──< entitlement_overrides
 *
 * `plans` and `plan_entitlements` are GLOBAL — one catalogue for the whole
 * installation, like `roles` and `permissions`. Everything else is
 * tenant-scoped and behind RLS.
 *
 * THE GRANT THAT MATTERS: the application role can SELECT the catalogue and
 * the overrides but cannot write either. A bug in application code therefore
 * cannot raise the limits it is checked against — the one escalation an
 * entitlement system has to rule out is the one where the thing being limited
 * gets to edit the limit.
 */

/* -------------------------------------------------------------------------- */
/* Catalogue (global)                                                          */
/* -------------------------------------------------------------------------- */

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Integer cents. Null means negotiated — never a made-up number. */
    priceMonthlyCents: integer('price_monthly_cents'),
    currency: text('currency').notNull().default('USD'),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plans_key_unique').on(t.key)],
);

export const planEntitlements = pgTable(
  'plan_entitlements',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    /**
     * NULL means UNLIMITED — not zero, and not "unset". A missing ROW means
     * the feature is not included at all. Three states, and conflating any two
     * of them either breaks paying customers or gives the product away.
     */
    limitValue: bigint('limit_value', { mode: 'number' }),
    /** For allowlist features such as which models a plan may call. */
    allowedValues: text('allowed_values').array(),
    unit: text('unit').notNull().default('count'),
  },
  (t) => [uniqueIndex('plan_entitlements_unique').on(t.planId, t.featureKey)],
);

/* -------------------------------------------------------------------------- */
/* Per-organization (tenant-scoped)                                            */
/* -------------------------------------------------------------------------- */

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),

    /** trialing | active | past_due | canceled | expired */
    status: text('status').notNull().default('active'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAt: timestamp('cancel_at', { withTimezone: true }),

    /**
     * The payment processor's identifier, when one was involved.
     *
     * Null for every subscription this build creates, because no processor is
     * integrated (§45 — see @moka/billing payment.ts). A manually recorded
     * subscription puts the operator's own reference here instead.
     */
    externalRef: text('external_ref'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live subscription per organization. Two would make "which plan am I
    // on?" a question with two answers, and enforcement would pick arbitrarily.
    uniqueIndex('subscriptions_org_unique').on(t.organizationId),
  ],
);

export const entitlementOverrides = pgTable(
  'entitlement_overrides',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key').notNull(),
    limitValue: bigint('limit_value', { mode: 'number' }),
    allowedValues: text('allowed_values').array(),
    /** Why this exception exists. Required — an unexplained override is a bug. */
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('entitlement_overrides_unique').on(t.organizationId, t.featureKey)],
);

/* -------------------------------------------------------------------------- */
/* Credits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The cached balance.
 *
 * A pre-flight check on every provider call cannot sum a million ledger rows,
 * so this exists. It is a CACHE: `credit_transactions` is authoritative, and a
 * security test reconciles the two. When they disagree the ledger wins,
 * because a ledger is what you can show a customer who disputes a bill.
 */
export const credits = pgTable(
  'credits',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Integer micro-dollars. May be negative — see planDebit in @moka/billing. */
    balanceMicroUsd: bigint('balance_micro_usd', { mode: 'number' }).notNull().default(0),
    /** The period this allowance belongs to, as `YYYY-MM` (UTC). */
    periodKey: text('period_key').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('credits_org_unique').on(t.organizationId)],
);

/**
 * The ledger. Append-only: the application holds INSERT and SELECT, and no
 * UPDATE or DELETE. This is what a customer is charged from, and a record the
 * application can rewrite is not a record.
 */
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** grant | debit | refund | expiry | adjustment */
    kind: text('kind').notNull(),
    /** Signed. Positive adds, negative consumes. Sign is CHECKed against kind. */
    amountMicroUsd: bigint('amount_micro_usd', { mode: 'number' }).notNull(),
    /** Human-readable, and required for an adjustment. */
    reason: text('reason'),
    periodKey: text('period_key').notNull(),

    /** The usage row this debit paid for, when there was one. No FK: usage is
     *  append-only and may be purged on a different schedule from billing. */
    usageRecordId: uuid('usage_record_id'),
    /**
     * True when a call happened that could not be priced. Not the same as a
     * free call — it is a gap in our model registry, surfaced rather than
     * absorbed as revenue or given away as a feature.
     */
    unpriced: boolean('unpriced').notNull().default(false),

    requestId: text('request_id'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_transactions_org_created_idx').on(t.organizationId, t.createdAt),
    index('credit_transactions_org_period_idx').on(t.organizationId, t.periodKey),
  ],
);
