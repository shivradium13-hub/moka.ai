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
  /**
   * An anonymous member of the public talking to a customer-facing chatbot.
   * Holds no role and therefore no permission. See CustomerContext below.
   */
  CUSTOMER: 'customer',
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

/* -------------------------------------------------------------------------- */
/* Customer principals (master prompt §22–24)                                  */
/* -------------------------------------------------------------------------- */

/**
 * An anonymous visitor talking to a customer-facing chatbot.
 *
 * THIS IS NOT A USER WITH A LOW ROLE, and the distinction is the whole of
 * Phase 6's security model.
 *
 * The tempting shortcut is to model a visitor as `role: 'viewer'`. That would
 * be wrong in a way that is easy to miss: `viewer` carries `project:read`,
 * `organization:read` and `member:read`, so a stranger on a customer's
 * marketing site would inherit the ability to list the organization's projects
 * and members through any tool that accepts those permissions. The four-gate
 * authoriser would allow every one of those calls, correctly, because it was
 * told the caller was a viewer.
 *
 * So a visitor carries NO role at all. There is no field here from which a
 * permission can be derived, which means `hasPermission` cannot be called on a
 * customer even by mistake — it does not typecheck. Authority is absent by
 * construction rather than set to a low value.
 *
 * What a CustomerContext does carry is the scope it was issued for: one
 * organization, one chatbot, one deployment, one conversation. Every field is
 * read back from a verified deployment record, never from the request.
 */
export interface CustomerContext {
  /** Tenant root, from the deployment record. Never from the request. */
  readonly organizationId: string;
  readonly chatbotId: string;
  readonly deploymentId: string;
  readonly conversationId: string;
  /**
   * Opaque per-conversation identifier. Deliberately not a user id and not
   * derived from IP: it identifies a conversation, not a person.
   */
  readonly visitorId: string;
  readonly actorType: typeof ActorType.CUSTOMER;
}

export function createCustomerContext(params: {
  organizationId: string;
  chatbotId: string;
  deploymentId: string;
  conversationId: string;
  visitorId: string;
}): CustomerContext {
  return { ...params, actorType: ActorType.CUSTOMER };
}

/**
 * Anything that names exactly one organization and was built from a verified
 * record — a session, an API key, or a chatbot deployment.
 *
 * This union exists for the few components that legitimately serve both kinds
 * of principal (retrieval is the only one today). It is safe to widen to
 * because BOTH members are unconstructible from request data: neither
 * `createUserTenantContext` nor `createCustomerContext` is ever called with a
 * client-supplied organization id.
 *
 * It carries no role, so widening a parameter to this type also removes the
 * ability to make an authorisation decision from it. That is the point.
 */
export type OrganizationScoped = TenantContext | CustomerContext;

export function isCustomerContext(scope: OrganizationScoped): scope is CustomerContext {
  return scope.actorType === ActorType.CUSTOMER;
}
