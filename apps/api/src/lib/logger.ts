import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logger. Pretty output in development, JSON in production
 * (JSON is what log collectors expect). Use child loggers per module:
 *   const log = logger.child({ module: 'employees' })
 */
export const logger = pino({
  // tests are silent unless TEST_LOG_LEVEL is set (e.g. TEST_LOG_LEVEL=error to surface 5xx causes)
  level: env.isTest ? (process.env.TEST_LOG_LEVEL ?? 'silent') : env.LOG_LEVEL,
  redact: {
    // never let secrets leak into logs, even by accident
    paths: ['password', 'passwordHash', 'password_hash', 'token', 'tokenHash', 'cookie', 'req.headers.cookie', 'req.headers.authorization', 'apiKey', 'api_key', 'COPILOT_API_KEY', 'req.headers["x-api-key"]'],
    censor: '[REDACTED]',
  },
  // pretty transport only in development; production and tests write JSON lines in-process (tests: so vitest can capture them)
  transport: env.isProduction || env.isTest ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
