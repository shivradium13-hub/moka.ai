import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Database, usageRecords } from '@moka/db';
import type { OrganizationScoped } from '@moka/core';
import { formatCredit, periodStart } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';

/**
 * The usage dashboard's data (§35).
 *
 * Reads `usage_records`, which the gateway has been writing since Phase 3 —
 * every call, successful or not, because a failed call still consumed provider
 * quota and latency, and a ledger that only records successes hides exactly
 * the traffic worth investigating.
 *
 * TWO NUMBERS THAT MUST NOT BE MERGED
 *
 *   `costMicroUsd` summed over rows where it is known.
 *   `unpricedCalls` — rows where it is NULL.
 *
 * Summing with `COALESCE(cost, 0)` would produce one confident figure that
 * silently understates the bill, and nobody would ever discover that a model
 * is missing a pricing row. They are reported separately so a total that is
 * incomplete says so.
 */
@Injectable()
export class UsageService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async summary(scope: OrganizationScoped) {
    const since = periodStart(new Date());

    return this.db.withScope(scope, async (tx) => {
      const totals = await tx
        .select({
          calls: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::bigint`,
          // Only rows with a known cost. See the note above.
          knownCostMicroUsd: sql<number>`coalesce(sum(${usageRecords.costMicroUsd}), 0)::bigint`,
          unpricedCalls: sql<number>`count(*) FILTER (WHERE ${usageRecords.costMicroUsd} IS NULL)::int`,
          failedCalls: sql<number>`count(*) FILTER (WHERE ${usageRecords.errorCode} IS NOT NULL)::int`,
        })
        .from(usageRecords)
        .where(
          and(eq(usageRecords.organizationId, scope.organizationId), gte(usageRecords.createdAt, since)),
        );

      const byModel = await tx
        .select({
          modelId: usageRecords.modelId,
          providerId: usageRecords.providerId,
          calls: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::bigint`,
          knownCostMicroUsd: sql<number>`coalesce(sum(${usageRecords.costMicroUsd}), 0)::bigint`,
          unpricedCalls: sql<number>`count(*) FILTER (WHERE ${usageRecords.costMicroUsd} IS NULL)::int`,
        })
        .from(usageRecords)
        .where(
          and(eq(usageRecords.organizationId, scope.organizationId), gte(usageRecords.createdAt, since)),
        )
        .groupBy(usageRecords.modelId, usageRecords.providerId)
        .orderBy(desc(sql`count(*)`))
        .limit(50);

      const byDay = await tx
        .select({
          day: sql<string>`to_char(date_trunc('day', ${usageRecords.createdAt}), 'YYYY-MM-DD')`,
          calls: sql<number>`count(*)::int`,
          knownCostMicroUsd: sql<number>`coalesce(sum(${usageRecords.costMicroUsd}), 0)::bigint`,
        })
        .from(usageRecords)
        .where(
          and(eq(usageRecords.organizationId, scope.organizationId), gte(usageRecords.createdAt, since)),
        )
        .groupBy(sql`date_trunc('day', ${usageRecords.createdAt})`)
        .orderBy(sql`date_trunc('day', ${usageRecords.createdAt})`);

      const total = totals[0];

      return {
        period: { start: since, key: `${since.getUTCFullYear()}-${String(since.getUTCMonth() + 1).padStart(2, '0')}` },
        totals: {
          calls: Number(total?.calls ?? 0),
          inputTokens: Number(total?.inputTokens ?? 0),
          outputTokens: Number(total?.outputTokens ?? 0),
          knownCostMicroUsd: Number(total?.knownCostMicroUsd ?? 0),
          knownCostDisplay: formatCredit(Number(total?.knownCostMicroUsd ?? 0)),
          /*
           * Reported alongside the total, never folded into it. A figure of
           * "$4.20 across 300 calls, 12 of which could not be priced" is
           * honest; "$4.20" alone is a number somebody will budget against.
           */
          unpricedCalls: Number(total?.unpricedCalls ?? 0),
          failedCalls: Number(total?.failedCalls ?? 0),
        },
        byModel: byModel.map((row) => ({
          ...row,
          calls: Number(row.calls),
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
          knownCostMicroUsd: Number(row.knownCostMicroUsd),
          knownCostDisplay: formatCredit(Number(row.knownCostMicroUsd)),
          unpricedCalls: Number(row.unpricedCalls),
        })),
        byDay: byDay.map((row) => ({
          day: row.day,
          calls: Number(row.calls),
          knownCostMicroUsd: Number(row.knownCostMicroUsd),
        })),
      };
    });
  }
}
