import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { loadConfig } from '@moka/config';
import { Database } from '@moka/db';
import { MAX_DOCUMENT_BYTES } from '@moka/knowledge';
import { AppModule } from './app.module.js';
import { DATABASE } from './database/database.module.js';
import { createLogger, getLogger, setRootLogger } from './common/logger.js';
import { OriginVerdict, checkOrigin } from './common/origin-check.js';

async function bootstrap(): Promise<void> {
  // Configuration is validated first: the process must fail loudly on a bad
  // environment rather than start in a half-configured state.
  const config = loadConfig();

  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === 'development',
  });
  setRootLogger(logger);

  const adapter = new FastifyAdapter({
    // Fastify generates a request id; we prefer an inbound one when present so
    // a trace can span the web app and the API.
    genReqId: (req: IncomingMessage) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && inbound.length <= 128 ? inbound : randomUUID();
    },
    trustProxy: config.NODE_ENV === 'production',
    /*
     * Derived from the document limit, NOT a round number.
     *
     * This was 1 MiB while `MAX_DOCUMENT_BYTES` was 25 MB, and the two never
     * met: uploads arrive as base64 inside JSON, which inflates by a third, so
     * Fastify rejected anything over ~768 KB before the handler ran. The
     * knowledge controller's friendly "File exceeds the 25 MB limit" was
     * unreachable, and users got a bare FST_ERR_CTP_BODY_TOO_LARGE instead.
     *
     * Computing it from the same constant means the two cannot drift again.
     * The 64 KiB is for the surrounding JSON — field names, filename, mime
     * type — so the handler's own check is what a large file actually hits.
     *
     * The cost is that every route now accepts a body this size rather than
     * 1 MiB. That is the trade-off for uploads being a JSON field instead of
     * multipart; multipart arrives with the queue-backed pipeline, and the
     * limit should come back down to 1 MiB with it.
     */
    bodyLimit: Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 65_536,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: ['error', 'warn'],
    bufferLogs: true,
  });

  // --- Security headers ---
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  /*
   * --- CORS ---
   *
   * TWO POLICIES, because there are two kinds of caller and only one of them
   * has any ambient authority.
   *
   * THE APP (everything not under /public/): an explicit origin allowlist with
   * credentials enabled. These routes authenticate by cookie, so CORS is doing
   * real work — it is what stops another site making authenticated requests
   * with the user's session. A wildcard is impossible by construction:
   * `credentials: true` plus `*` is rejected by browsers, and the list comes
   * from validated configuration.
   *
   * THE PUBLIC CHAT SURFACE (/public/): any origin, credentials OFF. This
   * looks alarming and is not, because of the second half: these endpoints
   * send and accept NO cookies. The visitor token travels in a header, so
   * there is no ambient authority for a cross-site request to ride on, and
   * CORS therefore protects nothing here — anyone can already call these
   * endpoints with curl. Reflecting the origin would give false comfort;
   * refusing it would only break the legitimate embeds, since a chatbot is
   * meant to be called from the customer's own site and we cannot know every
   * such site at boot.
   *
   * The control that actually decides which sites may use a deployment is the
   * per-deployment allowlist, enforced in the handler and — the strong half —
   * as `frame-ancestors` on the chat frame, which the visitor's own browser
   * enforces. See @moka/chat origin.ts.
   */
  await app.register(fastifyCors, {
    /*
     * `delegator` is per-request, unlike the top-level options, which is what
     * lets one registration serve two policies. It is called for the preflight
     * as well as the actual request, so both halves agree.
     */
    delegator: (request, callback) => {
      if (typeof request.url === 'string' && request.url.startsWith('/public/')) {
        callback(null, {
          origin: true,
          credentials: false,
          methods: ['GET', 'POST', 'OPTIONS'],
          allowedHeaders: ['content-type', 'x-request-id', 'x-moka-key', 'x-moka-visitor'],
          maxAge: 600,
        });
        return;
      }

      callback(null, {
        origin: config.CORS_ORIGINS,
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['content-type', 'x-request-id'],
        maxAge: 600,
      });
    },
  });

  // --- Cookies ---
  await app.register(fastifyCookie, {
    secret: config.AUTH_SECRET,
    // Defaults for serialisation. The session cookie sets these explicitly in
    // auth.controller.ts; keeping them in step here means a cookie added later
    // by some other route inherits the same deployment-correct behaviour
    // rather than a hard-coded `lax` that breaks on a split domain.
    parseOptions: {
      httpOnly: true,
      sameSite: config.COOKIE_SAMESITE,
      ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
      path: '/',
    },
  });

  /*
   * --- Origin check on state-changing requests ---
   *
   * THIS IS WHAT MAKES `COOKIE_SAMESITE=none` SAFE TO OFFER.
   *
   * `SameSite=lax` blocks CSRF by refusing to send the cookie cross-site. A
   * split-domain deployment cannot use `lax` (see @moka/config), and switching
   * to `none` gives that protection up. Something has to replace it.
   *
   * CORS alone does not. CORS decides whether a caller may READ a response; it
   * does not stop the request executing. A "simple" cross-site request — a
   * form POST, a GET — is dispatched with credentials and runs on the server,
   * and only the response is withheld. For a state-changing route that is too
   * late: the write already happened.
   *
   * So every mutating request must carry an Origin this deployment allows.
   * Browsers set `Origin` on all cross-site requests and cannot be talked out
   * of it from script, which is what makes the check meaningful.
   *
   * Deliberately NOT applied to:
   *   - safe methods (GET/HEAD/OPTIONS), which change nothing;
   *   - `/public/`, the chatbot surface, which is called from customer sites we
   *     cannot enumerate and carries NO ambient authority — its visitor token
   *     travels in a header, so there is no cookie for a forged request to
   *     ride on;
   *   - requests with no Origin at all, which is curl, a mobile client or a
   *     server-to-server call. Those carry no browser cookie jar, so they are
   *     not the CSRF threat; rejecting them would break every non-browser
   *     caller to defend against something that cannot happen.
   */
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    const verdict = checkOrigin({
      method: request.method,
      url: typeof request.url === 'string' ? request.url : undefined,
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      allowedOrigins: config.CORS_ORIGINS,
    });

    if (verdict !== OriginVerdict.REFUSED) {
      done();
      return;
    }

    getLogger().warn(
      {
        origin: request.headers.origin,
        method: request.method,
        requestId: String(request.id),
      },
      'refused a state-changing request from an origin that is not allowed',
    );
    void reply.status(403).send({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'This request did not come from an allowed origin.',
      },
    });
  });

  // Attach the request id and echo it, so a user can quote it in a report.
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    (request as { requestId?: string }).requestId = String(request.id);
    void reply.header('x-request-id', String(request.id));
    done();
  });

  app.enableShutdownHooks();

  const database = app.get<Database>(DATABASE);

  /*
   * --- The one check that must happen before the first request ---
   *
   * Every tenant-isolation control in this system reduces to "the connecting
   * role is subject to RLS". If DATABASE_URL points at a superuser, all of
   * them stop applying at once and NOTHING breaks — every request succeeds,
   * and every tenant is served every other tenant's data.
   *
   * A failure that loud deserves to happen at boot rather than in a support
   * ticket, so the process refuses to listen.
   */
  await database.assertRuntimeRoleIsConstrained();

  // --- Graceful shutdown ---
  const shutdown = async (signal: string): Promise<void> => {
    getLogger().warn({ signal }, 'shutting down');
    try {
      await app.close();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /*
   * §38: an unhandled rejection means the process is in an unknown state.
   * Log it and exit rather than continuing to serve requests from a process
   * whose invariants may no longer hold.
   */
  process.on('unhandledRejection', (reason) => {
    getLogger().fatal({ reason }, 'unhandled promise rejection — exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    getLogger().fatal({ err: error }, 'uncaught exception — exiting');
    process.exit(1);
  });

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  getLogger().info(
    { port: config.API_PORT, host: config.API_HOST, env: config.NODE_ENV },
    'moka api listening',
  );
}

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this one path
  // legitimately uses console.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
