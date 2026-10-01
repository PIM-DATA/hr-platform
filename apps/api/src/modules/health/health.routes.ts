import { documentStorage, documentStorageConfigured } from '../documents/storage';
import { copilotStatus } from '../copilot/provider';
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
async function documentStorageHealth(): Promise<{ state: 'ok' | 'unavailable' | 'disabled'; reason?: string }> {
  if (!documentStorageConfigured()) return { state: 'disabled' };
  try {
    // Does the database reference any stored object? (one indexed row, not a scan)
    const hasDocuments = !!(await prisma.documentVersion.findFirst({ select: { id: true } }));
    const h = await documentStorage().health(hasDocuments);
    if (h.ok) return { state: 'ok' };
    logger.error({ event: 'document_storage_unavailable', reason: h.reason }, 'readiness check failed: document storage unavailable');
    return { state: 'unavailable', reason: h.reason };
  } catch (err) {
    logger.error({ event: 'document_storage_unavailable', err }, 'readiness check failed: document storage unavailable');
    return { state: 'unavailable', reason: 'CHECK_FAILED' };
  }
}

export const healthRouter = Router();

const base = () => ({ status: 'ok' as const, version: env.APP_VERSION ?? null, timestamp: new Date().toISOString() });

async function databaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ event: 'db_readiness_failed', err }, 'readiness check failed: database unreachable');
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
  // Document storage: 'ok' | 'unavailable' | 'disabled'. An unwritable root makes the process not ready — a document
  // center that accepts metadata but cannot keep bytes is worse than one that refuses.
  // Without a database the storage cannot be judged (it depends on whether documents exist); report it as unknown.
  const storage: { state: string; reason?: string } = ok ? await documentStorageHealth() : { state: 'unknown' };
  const ready = ok && storage.state !== 'unavailable';
  // Reason codes are stable and path-free (e.g. ROOT_MISSING); the server log carries the same code.
  res.status(ready ? 200 : 503).json({ data: { ...base(), status: ready ? 'ready' : 'unavailable', database: ok ? 'ok' : 'unavailable', documentStorage: storage.state, ...(storage.reason ? { documentStorageReason: storage.reason } : {}), copilot: copilotStatus() } });
});
