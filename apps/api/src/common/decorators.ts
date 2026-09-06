import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { TenantContextMissingError, type Permission, type TenantContext } from '@moka/core';
import type { FastifyRequest } from 'fastify';

/**
 * Request as augmented by the guard chain.
 *
 * `userId`/`sessionId` are set by AuthGuard, `tenant` by TenantGuard. All are
 * optional at the type level because a @Public() route legitimately has none
 * of them — handlers must therefore acknowledge that rather than assuming a
 * caller is present.
 *
 * `cookies` is not declared here: @fastify/cookie contributes it to
 * FastifyRequest by declaration merging, and redeclaring it would conflict.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  requestId?: string;
  tenant?: TenantContext;
  sessionId?: string;
  userId?: string;
}

export const IS_PUBLIC_KEY = 'moka:isPublic';
export const REQUIRED_PERMISSION_KEY = 'moka:requiredPermission';
export const ALLOW_NO_ORGANIZATION_KEY = 'moka:allowNoOrganization';

/**
 * Marks a route as reachable without authentication.
 *
 * Routes are authenticated by DEFAULT — AuthGuard is registered globally — so
 * exposing an endpoint is an explicit, greppable act rather than an omission.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Declares the permission a route requires. Enforced by PermissionGuard, which
 * denies by default if a non-public route carries no declaration.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);

/**
 * For authenticated routes that legitimately have no organization yet:
 * listing your organizations, creating your first one, reading your profile.
 */
export const AllowNoOrganization = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_NO_ORGANIZATION_KEY, true);

/**
 * Injects the resolved TenantContext.
 *
 * Throws rather than returning undefined: a handler that asks for tenant
 * context must never silently receive nothing and proceed unscoped.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenant) {
      throw new TenantContextMissingError(
        'CurrentTenant used on a route that did not resolve an organization.',
      );
    }
    return request.tenant;
  },
);

/** Injects the authenticated user id, for routes with no organization scope. */
export const CurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.userId) {
    throw new TenantContextMissingError('CurrentUserId used on an unauthenticated route.');
  }
  return request.userId;
});

export const RequestId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.requestId ?? 'unknown';
});
