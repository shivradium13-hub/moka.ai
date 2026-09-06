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
import { AppModule } from './app.module.js';
import { DATABASE } from './database/database.module.js';
import { createLogger, getLogger, setRootLogger } from './common/logger.js';

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
    bodyLimit: 1_048_576, // 1 MiB
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

  // --- CORS ---
  // An explicit origin allowlist with credentials enabled. A wildcard origin
  // is impossible here by construction: `credentials: true` plus `*` is
  // rejected by browsers, and the list comes from validated configuration.
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id'],
    maxAge: 600,
  });

  // --- Cookies ---
  await app.register(fastifyCookie, {
    secret: config.AUTH_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', path: '/' },
  });

  // Attach the request id and echo it, so a user can quote it in a report.
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    (request as { requestId?: string }).requestId = String(request.id);
    void reply.header('x-request-id', String(request.id));
    done();
  });

  app.enableShutdownHooks();

  // --- Graceful shutdown ---
  const database = app.get<Database>(DATABASE);
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
