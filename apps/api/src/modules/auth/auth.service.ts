import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Database, organizationMembers, organizations, users } from '@moka/db';
import { generateDek, hashPassword, loadRootKey, verifyPassword, wrapDek } from '@moka/crypto';
import {
  ConflictError,
  InvalidCredentialsError,
  SystemRole,
  createUserTenantContext,
} from '@moka/core';
import { loadConfig } from '@moka/config';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { CreditsService } from '../billing/credits.service.js';

export interface RegisteredUser {
  userId: string;
  organizationId: string;
  email: string;
  name: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly credits: CreditsService,
  ) {}

  /** Emails are stored normalised so the unique index is meaningful. */
  static normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Register a user and create their first organization.
   *
   * The organization id is generated here rather than by the database default,
   * because the `organizations` RLS policy checks the row's own id against the
   * bound context — the context must exist before the INSERT.
   */
  async register(params: {
    email: string;
    password: string;
    name: string;
    organizationName: string;
    requestId?: string;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<RegisteredUser> {
    const email = AuthService.normaliseEmail(params.email);

    const existing = await this.db.global
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError('An account with that email already exists.');
    }

    const passwordHash = await hashPassword(params.password);
    const [created] = await this.db.global
      .insert(users)
      .values({ email, name: params.name.trim(), passwordHash })
      .returning({ id: users.id });

    if (!created) throw new ConflictError('Account could not be created.');

    const organizationId = randomUUID();
    const rootKey = loadRootKey(loadConfig().ENCRYPTION_KEY);
    const dekWrapped = wrapDek(rootKey, generateDek(), organizationId).toString('base64');

    /*
     * Slug uniqueness is settled by the unique INDEX, not by a pre-flight
     * SELECT. A "is this slug taken?" query would have to read across
     * organizations, which RLS correctly forbids — and building an exception
     * for it would leak the existence of other tenants' organizations.
     * Insert-and-retry avoids both problems.
     */
    const base = AuthService.slugify(params.organizationName);
    let inserted = false;

    for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 6)}`;
      try {
        await this.db.withNewOrganization(organizationId, async (tx) => {
          await tx.insert(organizations).values({
            id: organizationId,
            name: params.organizationName.trim(),
            slug,
            dekWrapped,
          });

          await tx.insert(organizationMembers).values({
            organizationId,
            userId: created.id,
            roleKey: SystemRole.OWNER,
            joinedAt: new Date(),
          });
        });
        inserted = true;
      } catch (error) {
        if (!AuthService.isSlugConflict(error)) throw error;
      }
    }

    if (!inserted) {
      throw new ConflictError('Could not allocate a unique organization identifier.');
    }

    const context = createUserTenantContext({
      organizationId,
      userId: created.id,
      role: SystemRole.OWNER,
    });

    /*
     * A new organization gets a subscription to the DEFAULT PLAN, by key, and
     * its first period's credit allowance from whatever that plan currently
     * says. Neither number is written here — an operator who edits the free
     * plan changes what new signups receive without a deployment.
     *
     * Both are best-effort. A registration that succeeded must not be undone
     * because the plan catalogue was unseeded; the organization would simply
     * be refused everything until an operator noticed, which is a safe failure
     * rather than a lost account. `ensureSubscription` logs loudly in that case.
     */
    await this.entitlements.ensureSubscription(context);
    await this.credits.grantPeriodAllowance(context);

    await this.audit.record(context, {
      action: 'auth.register',
      resourceType: 'user',
      resourceId: created.id,
      after: { email, name: params.name },
      requestId: params.requestId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    });

    return { userId: created.id, organizationId, email, name: params.name };
  }

  /**
   * Verify credentials.
   *
   * A dummy verification runs when the account does not exist, so that the
   * response time does not distinguish "no such user" from "wrong password".
   * The error message is identical in both cases (see InvalidCredentialsError).
   */
  async verifyCredentials(email: string, password: string): Promise<{ userId: string }> {
    const normalised = AuthService.normaliseEmail(email);

    const rows = await this.db.global
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalised))
      .limit(1);

    const user = rows[0];
    if (!user) {
      await verifyPassword(password, DUMMY_HASH);
      throw new InvalidCredentialsError('No user row for that email.');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new InvalidCredentialsError('Password verification failed.');
    }

    return { userId: user.id };
  }

  /** Must satisfy the organizations_slug_format check constraint. */
  static slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    // The constraint requires at least two characters starting alphanumeric.
    return slug.length >= 2 ? slug : 'org';
  }

  /** PostgreSQL 23505 = unique_violation, narrowed to the slug index. */
  private static isSlugConflict(error: unknown): boolean {
    const candidate = error as { code?: string; constraint?: string } | null;
    return candidate?.code === '23505' && candidate.constraint === 'organizations_slug_unique';
  }
}

/**
 * A real Argon2id hash of a fixed value, used only to equalise timing on the
 * "user not found" path. Never matches any real password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEyMw$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
