import { createApp } from './app';
import { databaseIsLocal, env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

const app = createApp();
const server = app.listen(env.PORT, () => {
  // Startup logs carry no connection string, host or credential — only what an operator needs to confirm the process.
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, version: env.APP_VERSION ?? 'unknown', trustProxy: env.TRUST_PROXY, allowedOrigins: env.allowedOrigins.length },
    'API started',
  );
  // Not an error: a single-host install is a supported topology. Said out loud so nobody deploys it by accident.
  if (env.isProduction && databaseIsLocal) logger.warn('production database is on this host — expected only for a single-VM install');
});

/** Requests already in flight get this long to finish before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 10_000;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return; // a second signal must not race the first shutdown
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');

  const force = setTimeout(() => {
    logger.error({ reason, graceMs: SHUTDOWN_GRACE_MS }, 'graceful shutdown timed out — forcing exit');
    process.exit(exitCode || 1);
  }, SHUTDOWN_GRACE_MS);
  force.unref(); // the timer itself must never hold the process open

  try {
    // Stop accepting new connections, wait for in-flight requests, then release the database pool.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    logger.info({ reason }, 'shutdown complete');
  } catch (err) {
    logger.error({ err, reason }, 'error during shutdown');
    exitCode = exitCode || 1;
  } finally {
    clearTimeout(force);
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// A process that has thrown out of band is in an unknown state: log it and shut down instead of limping on quietly.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — shutting down');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'unhandled rejection — shutting down');
  void shutdown('unhandledRejection', 1);
});

export { server, shutdown };
