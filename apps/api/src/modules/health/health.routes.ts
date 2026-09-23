import { Router } from 'express';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * Probe endpoints. Deliberately unauthenticated, exempt from rate limiting (a platform probe must never be throttled)
 * and free of any internal detail: no database URL or host, no credentials, no stack traces — a failed readiness check
 * says "unavailable" and the reason goes to the server log with the request id.
 *
 *   /health       overall status (kept for existing clients): app + database
 *   /health/live  liveness  — the process is running; never touches the database
 *   /health/ready readiness — the process can serve traffic (database reachable); 503 when it cannot
 */
export const healthRouter = Router();

const base = () => ({ status: 'ok' as const, version: env.APP_VERSION ?? null, timestamp: new Date().toISOString() });

async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'readiness check failed: database unreachable');
    return false;
  }
}

healthRouter.get('/', async (_req, res) => {
  const ok = await databaseReachable();
  res.status(ok ? 200 : 503).json({ data: { ...base(), status: ok ? 'ok' : 'unavailable', database: ok ? 'ok' : 'unavailable' } });
});
healthRouter.get('/live', (_req, res) => res.json({ data: base() }));
healthRouter.get('/ready', async (_req, res) => {
  const ok = await databaseReachable();
  res.status(ok ? 200 : 503).json({ data: { ...base(), status: ok ? 'ready' : 'unavailable', database: ok ? 'ok' : 'unavailable' } });
});
