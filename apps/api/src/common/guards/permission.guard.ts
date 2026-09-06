import { CanActivate, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InsufficientPermissionError, hasPermission, type Permission } from '@moka/core';
import {
  ALLOW_NO_ORGANIZATION_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSION_KEY,
  type AuthenticatedRequest,
} from '../decorators.js';
import { logSecurityEvent } from '../logger.js';

/**
 * Guard 3 of 3: authorization (docs/security.md §7).
 *
 * Permissions are evaluated server-side from the role resolved by TenantGuard.
 * Nothing the client sends influences the decision.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // A route with no declared permission needs no permission check, but it
    // must have opted out of organization scope explicitly. This prevents a
    // tenant-scoped route from silently shipping without authorization.
    if (!required) {
      const allowNoOrganization = this.reflector.getAllAndOverride<boolean>(
        ALLOW_NO_ORGANIZATION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (allowNoOrganization) return true;

      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      logSecurityEvent({
        type: 'authz.route_missing_permission_declaration',
        requestId: request.requestId,
        detail: { method: request.method, url: request.url },
      });
      throw new InsufficientPermissionError(
        'undeclared',
        'Route is tenant-scoped but declares no @RequirePermission.',
      );
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tenant = request.tenant;
    if (!tenant) {
      throw new InsufficientPermissionError(required, 'PermissionGuard ran without tenant context.');
    }

    if (!hasPermission(tenant.role, required)) {
      logSecurityEvent({
        type: 'authz.denied',
        requestId: request.requestId,
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        detail: { required, role: tenant.role, method: request.method, url: request.url },
      });
      throw new InsufficientPermissionError(required);
    }

    return true;
  }
}
