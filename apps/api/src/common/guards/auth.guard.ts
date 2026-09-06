import { CanActivate, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '@moka/core';
import { SessionService } from '../../modules/auth/session.service.js';
import { IS_PUBLIC_KEY, type AuthenticatedRequest } from '../decorators.js';

export const SESSION_COOKIE = 'moka_session';

/**
 * Guard 1 of 3: authentication.
 *
 * Registered globally, so every route is authenticated unless explicitly
 * marked @Public(). Failing open is therefore impossible by omission —
 * forgetting to add a guard leaves a route protected, not exposed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
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

    const token = this.extractToken(request);
    if (!token) throw new UnauthenticatedError('No session cookie present.');

    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthenticatedError('Session token did not resolve to a live session.');

    request.userId = session.userId;
    request.sessionId = session.sessionId;
    return true;
  }

  /**
   * Cookie only. A bearer token is deliberately NOT accepted here: browser
   * sessions and API keys are separate authentication schemes with different
   * CSRF properties, and conflating them is a common source of bypass.
   */
  private extractToken(
    request: AuthenticatedRequest,
  ): string | null {
    return request.cookies?.[SESSION_COOKIE] ?? null;
  }
}
