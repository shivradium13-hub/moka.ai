import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '@moka/config';
import { ForbiddenError, ValidationError } from '@moka/core';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { SESSION_COOKIE } from '../../common/guards/auth.guard.js';
import {
  AllowNoOrganization,
  Public,
  RequestId,
  type AuthenticatedRequest,
} from '../../common/decorators.js';
import { RATE_LIMITER, enforceRateLimit, type RateLimiter } from '../../common/rate-limit.js';

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters.')
    .max(200, 'Password must be at most 200 characters.'),
  name: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

const switchOrgSchema = z.object({
  organizationId: z.string().uuid(),
});

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
  ) {}

  @Public()
  @Post('register')
  async register(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @RequestId() requestId: string,
  ) {
    const input = parse(registerSchema, body);
    await enforceRateLimit(this.rateLimiter, `register:${this.ipOf(request)}`, 5, 3600);

    const result = await this.auth.register({
      ...input,
      requestId,
      ip: this.ipOf(request),
      userAgent: this.userAgentOf(request),
    });

    await this.issueSession(reply, request, result.userId, result.organizationId);

    return {
      user: { id: result.userId, email: result.email, name: result.name },
      organizationId: result.organizationId,
    };
  }

  @Public()
  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(loginSchema, body);

    // Two limits: per-IP blunts distributed stuffing, per-account blunts a
    // targeted attack from many addresses.
    await enforceRateLimit(this.rateLimiter, `login:ip:${this.ipOf(request)}`, 10, 900);
    await enforceRateLimit(
      this.rateLimiter,
      `login:acct:${AuthService.normaliseEmail(input.email)}`,
      5,
      900,
    );

    const { userId } = await this.auth.verifyCredentials(input.email, input.password);
    const memberships = await this.sessions.listMemberships(userId);
    const activeOrganizationId = memberships[0]?.organizationId ?? null;

    await this.issueSession(reply, request, userId, activeOrganizationId);
    await this.sessions.touchLastLogin(userId);

    return {
      user: { id: userId },
      organizations: memberships,
      activeOrganizationId,
    };
  }

  @AllowNoOrganization()
  @Post('logout')
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (request.sessionId) await this.sessions.revoke(request.sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @AllowNoOrganization()
  @Get('me')
  async me(@Req() request: AuthenticatedRequest) {
    const userId = request.userId;
    if (!userId) throw new ForbiddenError('No authenticated user.');
    const memberships = await this.sessions.listMemberships(userId);
    const session = request.sessionId ? await this.sessions.resolve(this.tokenOf(request)) : null;
    return {
      user: { id: userId },
      organizations: memberships,
      activeOrganizationId: session?.activeOrganizationId ?? null,
    };
  }

  /**
   * Switch the active organization.
   *
   * The requested id is validated against the user's OWN memberships before
   * being written to the session. This is the one endpoint that legitimately
   * accepts an organization id from the client, so it is also the one that
   * must verify it hardest.
   */
  @AllowNoOrganization()
  @Post('switch-organization')
  async switchOrganization(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const input = parse(switchOrgSchema, body);
    const userId = request.userId;
    const sessionId = request.sessionId;
    if (!userId || !sessionId) throw new ForbiddenError('No authenticated session.');

    const membership = await this.sessions.resolveMembership(userId, input.organizationId);
    if (!membership) {
      // Same message as any other denial: never confirm whether the
      // organization exists.
      throw new ForbiddenError('User is not a member of the requested organization.');
    }

    await this.sessions.setActiveOrganization(sessionId, input.organizationId);
    return { activeOrganizationId: input.organizationId, role: membership.role };
  }

  private async issueSession(
    reply: FastifyReply,
    request: AuthenticatedRequest,
    userId: string,
    activeOrganizationId: string | null,
  ): Promise<void> {
    const config = loadConfig();
    const { token, expiresAt } = await this.sessions.create({
      userId,
      activeOrganizationId,
      ip: this.ipOf(request),
      userAgent: this.userAgentOf(request),
      ttlSeconds: config.SESSION_TTL_SECONDS,
    });

    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, // unreadable from JavaScript
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax', // blocks cross-site form CSRF while allowing top-level navigation
      path: '/',
      expires: expiresAt,
    });
  }

  private ipOf(request: AuthenticatedRequest): string {
    return request.ip ?? 'unknown';
  }

  private userAgentOf(request: AuthenticatedRequest): string | null {
    const value = request.headers['user-agent'];
    return typeof value === 'string' ? value.slice(0, 500) : null;
  }

  private tokenOf(request: AuthenticatedRequest): string {
    return request.cookies?.[SESSION_COOKIE] ?? '';
  }
}
