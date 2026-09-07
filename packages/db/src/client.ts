import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import {
  ConfigurationError,
  TenantContextMissingError,
  InternalError,
  type CustomerContext,
  type OrganizationScoped,
  type TenantContext,
} from '@moka/core';
import * as schema from './schema/index.js';

export type MokaDatabase = NodePgDatabase<typeof schema>;
/** A transaction handle already bound to one organization. */
export type TenantTransaction = Parameters<Parameters<MokaDatabase['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors isDeploymentKeyFormat in @moka/chat. Duplicated rather than imported
 *  so that @moka/db does not depend on a package that depends on it. */
const DEPLOYMENT_KEY_RE = /^moka_cb_[A-Za-z0-9_-]{20,64}$/;

/** What a readiness probe learned about the database. */
export interface DatabaseProbe {
  /** The pool could execute a statement. */
  readonly reachable: boolean;
  /**
   * Organization-scoped tables missing RLS, or `null` when the check could not
   * be run. Empty means checked and clean; `null` means unknown.
   */
  readonly unprotectedTables: readonly string[] | null;
}

/**
 * Drizzle's node-postgres driver returns a pg.Result; some paths return the
 * rows directly. Normalising here keeps that detail out of the callers.
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export interface DatabaseOptions {
  connectionString: string;
  poolMax?: number;
  ssl?: boolean;
}

/**
 * Database access (docs/security.md §2.2, §2.3).
 *
 * The pool is NOT exported. All tenant data must be reached through
 * `withTenant()`, which opens a transaction and binds `app.current_org_id`
 * for its duration. RLS policies read that setting; if it is unset, every
 * policy matches nothing and queries return zero rows — the system fails
 * closed rather than returning unscoped data.
 */
export class Database {
  private readonly pool: pg.Pool;
  private readonly db: MokaDatabase;

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolMax ?? 10,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
      // A connection must never carry a leftover app.current_org_id.
      // SET LOCAL is transaction-scoped, so this is belt-and-braces.
      allowExitOnIdle: false,
    });
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Access to GLOBAL (non-tenant) tables only: users, sessions, roles,
   * permissions. Deliberately verbose so that any use of it stands out in
   * review. Touching a tenant table through this handle returns zero rows,
   * because RLS has no organization bound.
   */
  get global(): MokaDatabase {
    return this.db;
  }

  /**
   * Run `fn` inside a transaction scoped to `context.organizationId`.
   *
   * `set_config(..., true)` is used rather than string-interpolating a
   * `SET LOCAL` statement: the value is passed as a bind parameter, so an
   * organization id can never be used for SQL injection. The `true` argument
   * makes the setting transaction-local, which is what keeps it correct
   * behind a connection pool.
   */
  async withTenant<T>(
    context: TenantContext,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const organizationId = context?.organizationId;
    if (!organizationId) {
      throw new TenantContextMissingError();
    }
    if (!UUID_RE.test(organizationId)) {
      // Defence in depth: a non-UUID here means the context was constructed
      // from something other than a verified session or API key.
      throw new InternalError(`TenantContext carried a malformed organizationId.`);
    }

    return this.bindAndRun(organizationId, fn);
  }

  /**
   * Run `fn` scoped to the organization a CHATBOT VISITOR is talking to.
   *
   * The binding is byte-for-byte identical to `withTenant` — RLS needs an
   * organization id and nothing else. The separate name is the point: it makes
   * "which queries can an anonymous member of the public reach?" a grep rather
   * than an audit, and it prevents a CustomerContext being passed where code
   * expects a role it can check.
   *
   * A CustomerContext carries no role, so nothing reachable from here can make
   * an RBAC decision from the caller. Authorisation for the customer path lives
   * in `authorizeToolCall`'s customer branch and in the scoping of the tools
   * themselves.
   */
  async withCustomer<T>(
    context: CustomerContext,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withScope(context, fn);
  }

  /**
   * The shared binding primitive, for the few components that genuinely serve
   * both principals (retrieval is the only one today).
   *
   * Safe to widen to because every member of `OrganizationScoped` is built by
   * a constructor that takes its organization id from a verified session, API
   * key or deployment record — never from a request. And because the union
   * carries no role, receiving one removes the ability to authorise from it.
   */
  async withScope<T>(
    scope: OrganizationScoped,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const organizationId = scope?.organizationId;
    if (!organizationId) throw new TenantContextMissingError();
    if (!UUID_RE.test(organizationId)) {
      throw new InternalError('OrganizationScoped carried a malformed organizationId.');
    }
    return this.bindAndRun(organizationId, fn);
  }

  /**
   * Bind a transaction to an organization that is being CREATED inside it.
   *
   * The `organizations` policy is `WITH CHECK (id = current_org_id())`, so the
   * row's own id must already be bound before the INSERT. That means the id is
   * generated by the caller rather than by the database default. Kept as a
   * separate, explicitly named method so it cannot be mistaken for a way to
   * bypass tenant scoping.
   */
  async withNewOrganization<T>(
    organizationId: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(organizationId)) {
      throw new InternalError('withNewOrganization requires a pre-generated UUID.');
    }
    return this.bindAndRun(organizationId, fn);
  }

  /**
   * Bind a transaction to a USER rather than an organization.
   *
   * The only legitimate use is reading a user's own membership list, which by
   * definition spans organizations and so has no organization to bind. The
   * policy added in 0002_user_scope.sql permits exactly that and nothing else,
   * and only while no organization is bound.
   *
   * This deliberately does NOT bind an organization: doing both at once would
   * widen tenant-scoped reads to include the user's other organizations.
   */
  async withUserScope<T>(userId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(userId)) {
      throw new InternalError('withUserScope requires a valid user UUID.');
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`);
      return fn(tx);
    });
  }

  /**
   * Bind a transaction to a chatbot deployment's PUBLIC KEY, with no
   * organization bound (0007_chatbots.sql).
   *
   * The only legitimate use is the first step of a public chat request: a
   * visitor arrives holding only a public key, and the organization cannot be
   * bound until that key has been looked up. Under this binding the narrow
   * policy on `chatbot_deployments` makes exactly one row visible — the active
   * deployment whose key was presented — and nothing else in the database.
   *
   * Like `withUserScope`, this deliberately does NOT bind an organization.
   * Binding both would make the public branch of the policy reachable from
   * inside a tenant-scoped transaction, which is precisely what the
   * `current_org_id() IS NULL` guard exists to prevent.
   *
   * The key is passed as a bind parameter, so a hostile value is data rather
   * than SQL; the format check above it simply avoids a pointless round trip.
   */
  async withDeploymentKey<T>(
    publicKey: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    if (!DEPLOYMENT_KEY_RE.test(publicKey)) {
      throw new InternalError('withDeploymentKey requires a well-formed public key.');
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_deployment_key', ${publicKey}, true)`);
      return fn(tx);
    });
  }

  private async bindAndRun<T>(
    organizationId: string,
    fn: (tx: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org_id', ${organizationId}, true)`);
      return fn(tx);
    });
  }

  /*
   * There is deliberately no `withSystemScope()` / cross-tenant escape hatch.
   *
   * An earlier draft had one. It turned out to be useless as well as
   * dangerous: under FORCE ROW LEVEL SECURITY an unbound connection sees
   * nothing, so the only way to make such a method work would have been to
   * grant the application BYPASSRLS — which is precisely the property this
   * design refuses. Legitimate cross-organization reads are expressed as
   * narrow RLS policies instead (see withUserScope and 0002_user_scope.sql).
   */

  /**
   * Refuse to run as a role that can bypass row-level security.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE ONE MISCONFIGURATION THAT SILENTLY DISABLES EVERYTHING
   *
   * Almost every tenant-isolation control in this system reduces to "the
   * connecting role is subject to RLS". Point `DATABASE_URL` at a superuser —
   * or at any role with BYPASSRLS — and every policy stops applying. Not
   * some. All of them.
   *
   * Nothing would break. Every request would succeed. Every test that runs as
   * `moka_app` would still pass. The application would serve every tenant's
   * data to every tenant, and the only symptom would be a customer seeing
   * somebody else's projects.
   *
   * It is a plausible mistake rather than an exotic one: `postgres://postgres@…`
   * is what half the tutorials print, and it is what a hurried operator reaches
   * for when a permission error blocks a deploy.
   *
   * So this is checked at BOOT and refuses to start, in every environment
   * rather than only in production. A development database that quietly has no
   * isolation is where the habit forms.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async assertRuntimeRoleIsConstrained(): Promise<void> {
    const result = await this.db.execute<{
      who: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      sql`SELECT current_user AS who, rolsuper, rolbypassrls
            FROM pg_roles WHERE rolname = current_user`,
    );

    const rows = (result as unknown as { rows?: Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }> })
      .rows ?? (result as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>);
    const role = Array.isArray(rows) ? rows[0] : undefined;

    if (!role) {
      throw new InternalError('Could not determine the database role this process connects as.');
    }

    if (role.rolsuper || role.rolbypassrls) {
      throw new ConfigurationError(
        [
          `Refusing to start: the application connects as "${role.who}", which ` +
            (role.rolsuper ? 'is a superuser.' : 'has BYPASSRLS.'),
          '',
          'Row-level security does not apply to such a role, so every tenant-isolation',
          'policy in this database would stop applying — silently. Nothing would break,',
          'every request would succeed, and every tenant would be served every other',
          "tenant's data.",
          '',
          'Point DATABASE_URL at the unprivileged application role (moka_app).',
          'See infra/db/bootstrap.sql and docs/operations.md.',
        ].join('\n'),
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Readiness probe.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THIS ASKS MORE THAN "IS THE DATABASE UP"
   *
   * `SELECT 1` answers a question that is almost never the one that matters.
   * A connection pool that can reach PostgreSQL tells you nothing about
   * whether the database is in the shape this build expects, and the failure
   * mode this system actually has is a migration that adds an organization-
   * scoped table and forgets its RLS policy. That table is then readable
   * across tenants, and every request against it succeeds.
   *
   * So readiness also asks the catalog a structural question: does every table
   * carrying an `organization_id` have row-level security ENABLED and FORCED?
   * Enabled alone is not enough — without FORCE, the table owner is exempt,
   * and the migration role owns every table here.
   *
   * It is two cheap catalog scans against tables PostgreSQL keeps in memory,
   * so a load balancer polling every few seconds costs effectively nothing.
   * ─────────────────────────────────────────────────────────────────────────
   */
  async probe(): Promise<DatabaseProbe> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      return { reachable: false, unprotectedTables: null };
    }

    try {
      const result = await this.db.execute<{ relname: string }>(sql`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attname = 'organization_id'
                    AND a.attnum > 0
                    AND NOT a.attisdropped
               )
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
         ORDER BY c.relname
      `);

      const rows = extractRows<{ relname: string }>(result);
      return { reachable: true, unprotectedTables: rows.map((r) => r.relname) };
    } catch {
      /*
       * Reachable but the structural question could not be answered. Reported
       * as `null` rather than as `[]`: "I did not check" and "I checked and
       * found nothing" must not look the same to whoever reads this.
       */
      return { reachable: true, unprotectedTables: null };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { schema };
