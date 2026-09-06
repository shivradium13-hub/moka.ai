import pino, { type Logger } from 'pino';
import { redactValue } from '@moka/core';

/**
 * Structured logging (docs/security.md §3.4, docs/architecture.md §8).
 *
 * Redaction is installed as a pino FORMATTER, not applied at call sites. A
 * caller therefore cannot opt out, and a secret cannot be logged by accident
 * even by code written later that knows nothing about this module.
 */

let root: Logger | null = null;

export function createLogger(options: { level: string; pretty: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: 'moka-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Every log object passes through redaction before serialisation.
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    // Belt and braces: pino's own path-based redaction for the hot paths,
    // in case a formatter is ever bypassed.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'password',
        'passwordHash',
        'token',
        'tokenHash',
        'apiKey',
        'secret',
        'dekWrapped',
        'ciphertext',
        '*.password',
        '*.token',
        '*.secret',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

export function setRootLogger(logger: Logger): void {
  root = logger;
}

export function getLogger(): Logger {
  if (!root) {
    throw new Error('Logger accessed before initialisation.');
  }
  return root;
}

/**
 * Security events get their own channel so they can be alerted on
 * independently of application errors.
 */
export function logSecurityEvent(event: {
  type: string;
  requestId?: string;
  organizationId?: string;
  userId?: string | null;
  detail?: Record<string, unknown>;
}): void {
  getLogger().warn({ securityEvent: true, ...event }, `security.${event.type}`);
}
