import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { env } from '../src/config/env';
import { findPgTool, generateTempDatabaseName, libpqEnv, opsLog, parseConnection, runTool, safeTarget, type PgConnection } from './lib/pg-tools';
import type { BackupManifest } from './backup-db';

/**
 * Restore verification (`npm run db:restore:verify -- <manifest.json>`).
 *
 * Having a backup file is not the same as being able to recover. This restores a backup into a **throwaway** database
 * and proves the result is usable: checksum → temporary database → pg_restore → schema/data integrity → the
 * application's own Prisma client reads it → session revocation → drop the temporary database.
 *
 * It never touches the development, test or source database: the target is always a freshly generated
 * `hr_restore_verify_<random>` name, and the script refuses to continue if that name collides with a configured one.
 * Restoring *onto* a live database is deliberately not automated — that is a controlled procedure in the runbook.
 */
const CRITICAL_TABLES = [
  '_prisma_migrations', 'users', 'sessions', 'roles', 'permissions', 'employees', 'organizations', 'departments',
  'audit_logs', 'workflow_instances', 'workflow_instance_steps', 'leave_requests', 'leave_entitlements', 'leave_ledger', 'notifications',
];

export interface VerifyResult {
  manifestPath: string;
  dumpPath: string;
  temporaryDatabase: string;
  checksumOk: true;
  tables: number;
  counts: Record<string, number>;
  migrationsApplied: number;
  sessionsBefore: number;
  sessionsAfter: number;
  durationMs: number;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * The dump must sit next to its manifest. A manifest is an operator-supplied file, so its `backupFilename` is treated
 * as untrusted input: anything with a path separator or `..` is rejected rather than resolved.
 */
export function resolveDumpPath(manifestPath: string, manifest: Pick<BackupManifest, 'backupFilename'>): string {
  const name = manifest.backupFilename;
  if (!name || name !== path.basename(name) || name.includes('..') || path.isAbsolute(name)) {
    throw new Error(`Unsafe backupFilename in manifest: it must be a plain file name next to the manifest`);
  }
  const dir = path.dirname(path.resolve(manifestPath));
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== dir) throw new Error('Resolved dump path escapes the manifest directory');
  return resolved;
}

/** A restore target may never be a database this installation actually uses. */
export function assertSafeTargetDatabase(name: string, forbidden: string[]): void {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(name)) throw new Error('Unsafe temporary database name');
  if (forbidden.filter(Boolean).includes(name)) throw new Error(`Refusing to use ${name} as a restore target: it is a configured application database`);
}

const databaseOf = (url: string | undefined) => {
  if (!url) return '';
  try { return parseConnection(url).database; } catch { return ''; }
};

async function createDatabase(conn: PgConnection, name: string) {
  // Connect to the maintenance database; CREATE DATABASE cannot run inside the target itself.
  await runTool(findPgTool('createdb'), ['--no-password', name], libpqEnv(conn, { database: 'postgres' }));
}
async function dropDatabase(conn: PgConnection, name: string) {
  await runTool(findPgTool('dropdb'), ['--if-exists', '--force', '--no-password', name], libpqEnv(conn, { database: 'postgres' }));
}

export async function verifyBackup(manifestPath: string): Promise<VerifyResult> {
  const started = Date.now();
  const conn = parseConnection(env.databaseUrl); // same server/credentials as the running configuration
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8')) as BackupManifest;
  const dumpPath = resolveDumpPath(absoluteManifest, manifest);
  opsLog('restore_verify_started', { manifest: path.basename(absoluteManifest), dump: manifest.backupFilename, createdAt: manifest.createdAt });

  // 1. integrity of the file itself, before anything is restored
  const { size } = await stat(dumpPath);
  const actual = await sha256File(dumpPath);
  if (actual !== manifest.sha256) {
    opsLog('restore_verify_failed', { reason: 'BACKUP_CHECKSUM_MISMATCH' });
    throw new Error(`BACKUP_CHECKSUM_MISMATCH: ${path.basename(dumpPath)} does not match the checksum recorded in the manifest`);
  }
  if (manifest.backupSizeBytes && manifest.backupSizeBytes !== size) {
    opsLog('restore_verify_failed', { reason: 'BACKUP_SIZE_MISMATCH' });
    throw new Error('BACKUP_SIZE_MISMATCH: the dump size differs from the manifest');
  }

  // 2. isolated target
  const temporaryDatabase = generateTempDatabaseName();
  assertSafeTargetDatabase(temporaryDatabase, [databaseOf(env.DATABASE_URL), databaseOf(env.TEST_DATABASE_URL), manifest.databaseName]);

  let created = false;
  const prisma = new PrismaClient({ datasourceUrl: temporaryDatabaseUrl(env.databaseUrl, temporaryDatabase) });
  try {
    await createDatabase(conn, temporaryDatabase);
    created = true;

    // 3. restore. --no-owner/--no-privileges so the dump restores under whatever role is running the drill.
    await runTool(findPgTool('pg_restore'), ['--no-password', '--no-owner', '--no-privileges', '--exit-on-error', '--dbname', temporaryDatabase, dumpPath], libpqEnv(conn, { database: temporaryDatabase }));

    // 4. schema + data integrity, read through the application's own client
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const present = new Set(tables.map((t) => t.table_name));
    const missing = CRITICAL_TABLES.filter((t) => !present.has(t));
    if (missing.length) throw new Error(`Restored database is missing expected tables: ${missing.join(', ')}`);

    const migrations = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    const migrationsApplied = Number(migrations[0]?.count ?? 0);
    if (migrationsApplied === 0) throw new Error('Restored database has no applied migration history');

    const counts = {
      users: await prisma.user.count(),
      employees: await prisma.employee.count(),
      organizations: await prisma.organization.count(),
      leaveRequests: await prisma.leaveRequest.count(),
      leaveEntitlements: await prisma.leaveEntitlement.count(),
      leaveLedger: await prisma.leaveLedger.count(),
      auditLogs: await prisma.auditLog.count(),
      workflowInstances: await prisma.workflowInstance.count(),
      notifications: await prisma.notification.count(),
    };

    // Referential sanity on the restored copy (these joins must find nothing).
    const orphanLedger = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM leave_ledger l LEFT JOIN leave_entitlements e ON e.id = l.entitlement_id WHERE e.id IS NULL`;
    const orphanRequests = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM leave_requests r LEFT JOIN employees emp ON emp.id = r.employee_id WHERE emp.id IS NULL`;
    if (Number(orphanLedger[0].count) > 0 || Number(orphanRequests[0].count) > 0) throw new Error('Restored database contains orphaned rows');

    // 5. the restored copy can still move forward to the current application version
    await runTool('npx', ['prisma', 'migrate', 'deploy'], { ...libpqEnv(conn, { database: temporaryDatabase }), DATABASE_URL: temporaryDatabaseUrl(env.databaseUrl, temporaryDatabase) });

    // 6. sessions restored from a backup would be usable again — prove they can be revoked on the restored copy
    const sessionsBefore = await prisma.session.count();
    const { revoked } = await revokeAllSessions(prisma);
    const sessionsAfter = await prisma.session.count();
    if (sessionsAfter !== 0) throw new Error('Session revocation did not clear restored sessions');

    const result: VerifyResult = {
      manifestPath: absoluteManifest, dumpPath, temporaryDatabase, checksumOk: true,
      tables: present.size, counts, migrationsApplied, sessionsBefore, sessionsAfter, durationMs: Date.now() - started,
    };
    opsLog('restore_verify_completed', { temporaryDatabase, tables: present.size, migrationsApplied, sessionsRevoked: revoked, durationMs: result.durationMs, target: safeTarget(conn, temporaryDatabase) });
    return result;
  } catch (err) {
    opsLog('restore_verify_failed', { error: err instanceof Error ? err.message : String(err), temporaryDatabase, durationMs: Date.now() - started });
    throw err;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    if (created) await dropDatabase(conn, temporaryDatabase).catch((e) => opsLog('restore_verify_cleanup_failed', { temporaryDatabase, error: e instanceof Error ? e.message : String(e) }));
  }
}

/** Same server and credentials, different database. */
export function temporaryDatabaseUrl(sourceUrl: string, database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Deletes every session row. Used after a restore, because a dump contains the sessions that were valid when it was
 * taken — restoring one would silently bring those logins back to life. Touches sessions only: no user, role or
 * password data is modified.
 */
export async function revokeAllSessions(client: PrismaClient): Promise<{ revoked: number }> {
  const { count } = await client.session.deleteMany({});
  return { revoked: count };
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run db:restore:verify -- <path/to/hr-enterprise-*.manifest.json>');
    process.exit(2);
  }
  verifyBackup(arg)
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Restore verified in ${(r.durationMs / 1000).toFixed(1)}s: ${r.tables} tables, ${r.migrationsApplied} migrations, ${r.counts.employees} employees, ${r.counts.leaveLedger} ledger rows; ${r.sessionsBefore} restored session(s) revoked.`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('RESTORE_VERIFY_FAILED:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
