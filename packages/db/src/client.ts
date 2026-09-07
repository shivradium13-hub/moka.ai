import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import {
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

  async healthCheck(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { schema };
