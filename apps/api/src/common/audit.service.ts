import { Inject, Injectable } from '@nestjs/common';
import { Database, auditLogs } from '@moka/db';
import { ActorType, redactValue, type OrganizationScoped } from '@moka/core';
import { DATABASE } from '../database/database.module.js';
import { getLogger } from './logger.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: 'success' | 'failure';
  requestId?: string | undefined;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Audit writing (docs/security.md §11).
 *
 * `before` and `after` pass through redaction before they are stored, so the
 * audit table can never become a place where secrets accumulate.
 *
 * A failed audit write is logged but does not fail the request. That is a
 * deliberate trade-off for Phase 1: losing an audit row is bad, but a
 * transient audit failure taking down a working mutation is worse. It is
 * revisited in Phase 5, where tool executions must be atomically audited.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * `OrganizationScoped` rather than `TenantContext` so the PUBLIC chat path is
   * audited too. An anonymous visitor has no user id, so `actorId` is null and
   * the actor type is 'customer' — but the row is written, because the surface
   * reachable by strangers is the last one that should be missing a trail.
   */
  async record(context: OrganizationScoped, entry: AuditEntry): Promise<void> {
    try {
      await this.db.withScope(context, async (tx) => {
        await tx.insert(auditLogs).values({
          organizationId: context.organizationId,
          actorType: context.actorType,
          actorId: context.actorType === ActorType.CUSTOMER ? null : context.userId,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          before: entry.before === undefined ? null : redactValue(entry.before),
          after: entry.after === undefined ? null : redactValue(entry.after),
          requestId: entry.requestId ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
          outcome: entry.outcome ?? 'success',
        });
      });
    } catch (error) {
      getLogger().error(
        {
          auditFailure: true,
          action: entry.action,
          organizationId: context.organizationId,
          requestId: entry.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to write audit record',
      );
    }
  }
}
