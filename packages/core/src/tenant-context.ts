import type { SystemRole } from './rbac.js';

/**
 * The ONLY legitimate representation of tenant identity (docs/security.md §2.1).
 *
 * A TenantContext is constructed exclusively from an authenticated session or
 * a verified API key record. It is never built from request-supplied data.
 *
 * The type is deliberately `readonly` end to end so that no downstream code
 * can mutate the organization it is scoped to mid-request.
 */
export interface TenantContext {
  /** Tenant root. Every tenant-scoped query is bound to this value. */
  readonly organizationId: string;
  /** Null for API-key authenticated requests, which act as the organization. */
  readonly userId: string | null;
  readonly role: SystemRole;
  /** Scopes carried by an API key. Empty for interactive sessions. */
  readonly scopes: readonly string[];
  readonly actorType: ActorType;
  /** Set for API-key requests, for audit attribution. */
  readonly apiKeyId: string | null;
}

export const ActorType = {
  USER: 'user',
  API_KEY: 'api_key',
  AGENT: 'agent',
  SYSTEM: 'system',
} as const;

export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/**
 * Field names that a client might use to try to override tenant identity.
 * Their presence in a request body, query or header is a security event and
 * the value is discarded (docs/security.md §2.1).
 */
export const CLIENT_SUPPLIED_TENANT_KEYS: readonly string[] = [
  'organizationId',
  'organization_id',
  'orgId',
  'org_id',
  'tenantId',
  'tenant_id',
  'organization',
  'tenant',
];

export function createUserTenantContext(params: {
  organizationId: string;
  userId: string;
  role: SystemRole;
}): TenantContext {
  return {
    organizationId: params.organizationId,
    userId: params.userId,
    role: params.role,
    scopes: [],
    actorType: ActorType.USER,
    apiKeyId: null,
  };
}

export function createApiKeyTenantContext(params: {
  organizationId: string;
  apiKeyId: string;
  role: SystemRole;
  scopes: readonly string[];
}): TenantContext {
  return {
    organizationId: params.organizationId,
    userId: null,
    role: params.role,
    scopes: params.scopes,
    actorType: ActorType.API_KEY,
    apiKeyId: params.apiKeyId,
  };
}
