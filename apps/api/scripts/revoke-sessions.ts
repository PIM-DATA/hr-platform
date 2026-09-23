/**
 * Operational session revocation (`npm run ops:revoke-sessions`).
 *
 * Run this after restoring a database: a dump contains the sessions that were valid when it was taken, so a restore
 * would otherwise bring those logins back to life. Everyone simply signs in again.
 *
 * Deletes session rows only — no user, role, permission or password data is touched. There is deliberately no HTTP
 * endpoint for this: it is a privileged operational action, not an application feature.
 */
import { PrismaClient } from '@prisma/client';
import { env } from '../src/config/env';
import { opsLog, parseConnection, safeTarget } from './lib/pg-tools';

async function main() {
  const targetUrl = process.env.REVOKE_SESSIONS_DATABASE_URL ?? env.DATABASE_URL;
  const conn = parseConnection(targetUrl);
  const prisma = new PrismaClient({ datasourceUrl: targetUrl });
  try {
    const before = await prisma.session.count();
    const { count } = await prisma.session.deleteMany({});
    opsLog('sessions_revoked', { target: safeTarget(conn), revoked: count, before });
    // eslint-disable-next-line no-console
    console.log(`Revoked ${count} session(s) on ${safeTarget(conn)}. Everyone must sign in again.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  opsLog('sessions_revoke_failed', { error: err instanceof Error ? err.message : String(err) });
  // eslint-disable-next-line no-console
  console.error('SESSION_REVOKE_FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
