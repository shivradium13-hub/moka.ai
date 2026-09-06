import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { Database, organizationMembers, organizations, sessions, users } from '@moka/db';
import { hashToken, generateSessionToken } from '@moka/crypto';
import { isSystemRole, SystemRole, UnauthenticatedError } from '@moka/core';
import { DATABASE } from '../../database/database.module.js';

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  activeOrganizationId: string | null;
}

export interface ResolvedMembership {
  organizationId: string;
  role: SystemRole;
}

/**
 * Session lookup and membership resolution.
 *
 * Both queries here run against GLOBAL tables (sessions, users,
 * organization_members) before any tenant context exists — this is the code
 * that establishes it. `organization_members` is RLS-protected, so the
 * membership lookup deliberately runs inside a transaction bound to the
 * candidate organization: the row is only visible if it genuinely belongs to
 * that organization, which makes RLS part of the authentication path rather
 * than something applied after it.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(params: {
    userId: string;
    activeOrganizationId: string | null;
    ip: string | null;
    userAgent: string | null;
    ttlSeconds: number;
  }): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

    const [row] = await this.db.global
      .insert(sessions)
      .values({
        userId: params.userId,
        tokenHash: hashToken(token),
        activeOrganizationId: params.activeOrganizationId,
        ip: params.ip,
        userAgent: params.userAgent,
        expiresAt,
      })
      .returning({ id: sessions.id });

    if (!row) throw new UnauthenticatedError('Session insert returned no row.');
    return { token, sessionId: row.id, expiresAt };
  }

  /** Resolve a bearer/cookie token to a live session, or null. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!token) return null;

    const rows = await this.db.global
      .select({
        id: sessions.id,
        userId: sessions.userId,
        activeOrganizationId: sessions.activeOrganizationId,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);

    const session = rows[0];
    if (!session) return null;

    return {
      sessionId: session.id,
      userId: session.userId,
      activeOrganizationId: session.activeOrganizationId,
    };
  }

  /**
   * Verify that `userId` is an active member of `organizationId`, returning
   * their role. Returns null when there is no membership — which is what makes
   * a forged organization id useless.
   */
  async resolveMembership(
    userId: string,
    organizationId: string,
  ): Promise<ResolvedMembership | null> {
    const rows = await this.db.withNewOrganization(organizationId, async (tx) =>
      tx
        .select({ roleKey: organizationMembers.roleKey })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, 'active'),
          ),
        )
        .limit(1),
    );

    const membership = rows[0];
    if (!membership || !isSystemRole(membership.roleKey)) return null;

    return { organizationId, role: membership.roleKey };
  }

  /** Organizations the user belongs to. Used by the org switcher. */
  async listMemberships(
    userId: string,
  ): Promise<Array<{ organizationId: string; name: string; slug: string; role: SystemRole }>> {
    // Cross-organization by nature, so there is no organization to bind.
    // withUserScope binds app.current_user_id instead; the policy from
    // 0002_user_scope.sql then exposes exactly this user's membership rows and
    // the organizations they belong to — nothing else, and only because no
    // organization is bound.
    const rows = await this.db.withUserScope(userId, async (tx) =>
      tx
        .select({
          organizationId: organizationMembers.organizationId,
          role: organizationMembers.roleKey,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.status, 'active'),
            isNull(organizations.deletedAt),
          ),
        ),
    );

    return rows
      .filter((r) => isSystemRole(r.role))
      .map((r) => ({
        organizationId: r.organizationId,
        name: r.name,
        slug: r.slug,
        role: r.role as SystemRole,
      }));
  }

  async setActiveOrganization(sessionId: string, organizationId: string): Promise<void> {
    await this.db.global
      .update(sessions)
      .set({ activeOrganizationId: organizationId })
      .where(eq(sessions.id, sessionId));
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.global
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.global
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  async touchLastLogin(userId: string): Promise<void> {
    await this.db.global
      .update(users)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(users.id, userId));
  }
}
