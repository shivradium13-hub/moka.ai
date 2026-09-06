import {
  CLIENT_SUPPLIED_TENANT_KEYS,
  TenantMismatchError,
  type TenantContext,
} from '@moka/core';

/**
 * Tenant enforcement helpers (docs/security.md §2.1).
 *
 * These are framework-agnostic so they can be unit-tested without booting the
 * API, and reused later by the worker and the public API surface.
 */

export interface TenantViolation {
  readonly location: 'body' | 'query' | 'headers' | 'params';
  readonly key: string;
  /** Whether the supplied value differed from the authenticated organization. */
  readonly conflicting: boolean;
}

/**
 * Detect any attempt by a client to supply tenant identity.
 *
 * Note that a MATCHING value is still reported. A client has no legitimate
 * reason to send an organization id at all, and treating "matching" as
 * acceptable would let an attacker probe for valid identifiers by observing
 * which values are rejected.
 */
export function detectTenantOverrides(
  request: {
    body?: unknown;
    query?: unknown;
    headers?: unknown;
    params?: unknown;
  },
  authenticatedOrganizationId: string,
): TenantViolation[] {
  const violations: TenantViolation[] = [];

  const scan = (source: unknown, location: TenantViolation['location']): void => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const normalised = key.toLowerCase().replace(/[-_]/g, '');
      const isTenantKey = CLIENT_SUPPLIED_TENANT_KEYS.some(
        (candidate) => candidate.toLowerCase().replace(/[-_]/g, '') === normalised,
      );
      if (!isTenantKey) continue;
      violations.push({
        location,
        key,
        conflicting: typeof value === 'string' && value !== authenticatedOrganizationId,
      });
    }
  };

  scan(request.body, 'body');
  scan(request.query, 'query');
  scan(request.headers, 'headers');
  scan(request.params, 'params');

  return violations;
}

/**
 * Strip tenant-identifying keys from a payload before it reaches a service.
 *
 * Defence in depth: even if a handler forgot to validate, the value is gone
 * by the time business logic runs, so it cannot be picked up accidentally.
 */
export function stripTenantKeys<T extends Record<string, unknown>>(payload: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const normalised = key.toLowerCase().replace(/[-_]/g, '');
    const isTenantKey = CLIENT_SUPPLIED_TENANT_KEYS.some(
      (candidate) => candidate.toLowerCase().replace(/[-_]/g, '') === normalised,
    );
    if (!isTenantKey) out[key] = value;
  }
  return out as T;
}

/**
 * Assert that a record loaded from the database belongs to the request's
 * organization.
 *
 * RLS should make this unreachable. It exists precisely because it should be
 * unreachable: if it ever fires, a policy is missing or a query escaped the
 * scoped client, and we want a loud failure rather than a silent leak.
 */
export function assertBelongsToTenant(
  record: { organizationId: string } | null | undefined,
  context: TenantContext,
  resourceLabel: string,
): void {
  if (!record) return;
  if (record.organizationId !== context.organizationId) {
    throw new TenantMismatchError(
      `RLS bypass detected: ${resourceLabel} from organization ${record.organizationId} ` +
        `was reachable under context ${context.organizationId}.`,
    );
  }
}
