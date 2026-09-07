import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './identity.js';
import { projects } from './projects.js';

/**
 * Web research runs and the sources they actually fetched (§8, §9).
 *
 * `research_sources` is the citation ledger, persisted. Its purpose is to make
 * a citation AUDITABLE after the fact: the URL that was finally fetched, when,
 * a hash of what came back, and the exact excerpt the model was shown.
 *
 * That last column is what makes the phase's gate checkable rather than merely
 * asserted. "No fabricated citations" is a claim about a system; with the
 * excerpt stored, anyone can open a six-month-old answer and see precisely
 * what the model had in front of it when it wrote a sentence.
 */

export const researchRuns = pgTable(
  'research_runs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),

    question: text('question').notNull(),
    /** 'answered' | 'no_sources' | 'no_results' | 'failed' */
    status: text('status').notNull().default('running'),
    /** The verified answer — after invalid markers and invented URLs are removed. */
    answer: text('answer'),
    /** What the model actually returned, kept so a correction can be reviewed. */
    rawAnswer: text('raw_answer'),

    /** 'seed' | 'searxng'. Recorded so an answer's provenance is legible. */
    searchProvider: text('search_provider').notNull(),
    /**
     * Integrity signals from verification: invalid markers, invented URLs,
     * unverified quotes. Stored so a pattern across runs is visible — a model
     * or a prompt that fabricates often is a fact worth being able to see.
     */
    verification: jsonb('verification').notNull().default({}),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    errorCode: text('error_code'),
    requestId: text('request_id'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('research_runs_org_started_idx').on(t.organizationId, t.startedAt)],
);

export const researchSources = pgTable(
  'research_sources',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => researchRuns.id, { onDelete: 'cascade' }),

    /** The citation number. Null for a candidate that was never collected. */
    ordinal: integer('ordinal'),
    requestedUrl: text('requested_url').notNull(),
    /** After redirects. Null when the page was never successfully fetched. */
    finalUrl: text('final_url'),
    title: text('title'),
    contentHash: text('content_hash'),
    /** Exactly what the model was shown. The evidence, kept. */
    excerpt: text('excerpt'),

    /** 'collected' | 'robots_disallowed' | 'fetch_failed' | 'blocked' | … */
    outcome: text('outcome').notNull(),
    /** Why it was skipped, in words safe to show a user. */
    detail: text('detail'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('research_sources_run_idx').on(t.organizationId, t.runId),
    uniqueIndex('research_sources_run_ordinal_unique').on(t.runId, t.ordinal),
  ],
);
