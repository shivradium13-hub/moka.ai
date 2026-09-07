import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Database } from '@moka/db';
import { loadConfig } from '@moka/config';
import { DATABASE } from '../../database/database.module.js';
import { Public } from '../../common/decorators.js';
import { getLogger } from '../../common/logger.js';

/**
 * Health and readiness (docs/operations.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ENDPOINTS BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS
 *
 * LIVENESS (`/health`) asks "is this process wedged?". A failure means restart
 * me. It must not consult dependencies: if the database is down and liveness
 * reports failure, the orchestrator restarts every instance in a loop, turning
 * a recoverable outage into a crash cascade at exactly the moment the database
 * least needs a thundering herd of reconnections.
 *
 * READINESS (`/health/ready`) asks "should traffic come to me?". A failure means
 * take me out of rotation but leave me running. This one does consult
 * dependencies, because that is the entire point.
 *
 * Conflating the two is the single most common way a health check makes an
 * incident worse, so they are deliberately separate handlers with different
 * behaviour rather than one handler with a flag.
 *
 * WHAT THESE RESPONSES DELIBERATELY DO NOT CONTAIN
 *
 * Both are unauthenticated — they have to be, since the prober has no
 * credentials — which makes them a reconnaissance surface. So the body carries
 * coarse status only: no version, no hostname, no connection string, no driver
 * name, no error text. An attacker learns nothing they could not learn by
 * observing whether requests succeed.
 *
 * The detail an operator genuinely needs goes to the LOG instead, where it is
 * behind whatever protects the logs. That is a real trade-off — debugging is
 * slightly harder — and it is made deliberately in this direction.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Liveness. Consults nothing. If this handler runs at all, the event loop is
   * turning and the process is worth keeping.
   */
  @Public()
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessBody> {
    const config = loadConfig();
    const probe = await this.db.probe();

    /*
     * `schema: 'unknown'` is a third state on purpose. The probe can be
     * reachable and still fail to answer the structural question, and
     * collapsing that into "ok" would report a check that did not happen as a
     * check that passed. §45 in the spirit it was meant: do not fake a result.
     */
    const schema: Status =
      probe.unprotectedTables === null
        ? 'unknown'
        : probe.unprotectedTables.length === 0
          ? 'ok'
          : 'failed';

    /*
     * The rate limiter is REPORTED, not probed. In-memory is a genuine,
     * working limiter — it is simply per-process, so behind more than one
     * instance it does not limit what an operator thinks it limits.
     * Configuration refuses to boot without REDIS_URL in production, so this
     * line is here for the staging deployments where that guard does not run.
     */
    const rateLimiter: 'shared' | 'per-process' = config.REDIS_URL ? 'shared' : 'per-process';

    const ready = probe.reachable && schema !== 'failed';

    if (!ready) {
      /*
       * Named tables go to the log and never to the response. Knowing which
       * table lost its policy is exactly what an operator needs and exactly
       * what an unauthenticated caller should not be handed.
       */
      getLogger().error(
        {
          reachable: probe.reachable,
          unprotectedTables: probe.unprotectedTables ?? undefined,
        },
        probe.reachable
          ? 'readiness failed: organization-scoped tables are missing row-level security'
          : 'readiness failed: the database is unreachable',
      );
      void reply.status(503);
    }

    return {
      status: ready ? 'ok' : 'not_ready',
      database: probe.reachable ? 'ok' : 'failed',
      schema,
      rateLimiter,
    };
  }
}

type Status = 'ok' | 'failed' | 'unknown';

interface ReadinessBody {
  readonly status: 'ok' | 'not_ready';
  readonly database: 'ok' | 'failed';
  readonly schema: Status;
  readonly rateLimiter: 'shared' | 'per-process';
}
