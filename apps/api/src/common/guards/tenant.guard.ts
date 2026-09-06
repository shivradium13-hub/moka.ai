import { CanActivate, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, createUserTenantContext } from '@moka/core';
import { detectTenantOverrides } from '@moka/tenancy';
import { SessionService } from '../../modules/auth/session.service.js';
import {
  ALLOW_NO_ORGANIZATION_KEY,
  IS_PUBLIC_KEY,
  type AuthenticatedRequest,
} from '../decorators.js';
import { logSecurityEvent } from '../logger.js';

/**
 * Guard 2 of 3: tenant resolution (docs/security.md §2.1).
 *
 * The organization is derived from the SESSION and re-verified against
 * organization_members on every request. Nothing the client sends contributes
 * to it. An organization id found anywhere in the request is discarded and
 * recorded as a security event — including one that happens to match, because
 * accepting matches would let an attacker enumerate valid ids by observing
 * which are rejected.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const userId = request.userId;
    if (!userId) throw new ForbiddenError('TenantGuard ran without an authenticated user.');

    const allowNoOrganization = this.reflector.getAllAndOverride<boolean>(
      ALLOW_NO_ORGANIZATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    const session = await this.sessions.resolve(this.tokenOf(request));
    const organizationId = session?.activeOrganizationId ?? null;

    if (!organizationId) {
      if (allowNoOrganization) return true;
      throw new ForbiddenError('No active organization selected for this session.');
    }

    // Membership is re-checked every request. A user removed from an
    // organization loses access immediately, without waiting for their
    // session to expire.
    const membership = await this.sessions.resolveMembership(userId, organizationId);
    if (!membership) {
      logSecurityEvent({
        type: 'tenant.membership_missing',
        requestId: request.requestId,
        organizationId,
        userId,
      });
      throw new ForbiddenError('User is not an active member of the session organization.');
    }

    // Discard and record any client-supplied tenant identity.
    const overrides = detectTenantOverrides(
      {
        body: request.body,
        query: request.query,
        headers: request.headers,
        params: request.params,
      },
      organizationId,
    );

    if (overrides.length > 0) {
      logSecurityEvent({
        type: 'tenant.client_supplied_identity',
        requestId: request.requestId,
        organizationId,
        userId,
        detail: {
          method: request.method,
          url: request.url,
          // Key names and locations only — never the submitted values.
          violations: overrides.map((v) => `${v.location}.${v.key}`),
          anyConflicting: overrides.some((v) => v.conflicting),
        },
      });
      // Deliberately NOT an error: the value is simply ignored. Rejecting
      // would confirm to a prober that the field is meaningful.
    }

    request.tenant = createUserTenantContext({
      organizationId: membership.organizationId,
      userId,
      role: membership.role,
    });

    return true;
  }

  private tokenOf(request: AuthenticatedRequest): string {
    return request.cookies?.['moka_session'] ?? '';
  }
}
