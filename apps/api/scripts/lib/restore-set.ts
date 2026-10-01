import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PrismaClient } from '@prisma/client';
import { BackupError, readJson, verifyBackupSet, type BackupSetManifest } from './backup-set';
import { runIntegrity, type IntegrityReport } from './integrity';
import { findPgTool, generateTempDatabaseName, libpqEnv, opsLog, parseConnection, runTool, safeTarget } from './pg-tools';

/**
 * Task 49 — canonical restore of a recovery set (T44-P1-10).
 *
 * Order (tested): verify the set → create a NEW database → pg_restore → copy the documents into an EMPTY directory →
 * `prisma migrate deploy` (an older set is brought forward to this release) → revoke every restored session and every
 * unused password-reset token (mandatory, no flag) → integrity of the restored pair (every referenced object present
 * with its recorded size and sha256) → report. The application is started only after this, pointed at the new
 * database and directory.
 *
 * Restoring *over* a live database is deliberately impossible here: the target database must not exist yet and must not
 * be a configured one; the target directory must be absent or empty. Switching production to the restored copy is an
 * explicit operator step (change DATABASE_URL / DOCUMENT_STORAGE_DIR, restart) — see docs/backup-restore.md.
 *
 * A failed restore removes what it created (database, directory) so a half-restored copy can never be mistaken for one.
 */
export interface RestoreOptions {
  setDir: string;
  sourceDatabaseUrl: string; // server + credentials to use (the configured one)
  targetDatabase?: string; // omitted with verifyOnly → generated throwaway name
  targetDocumentsDir?: string; // omitted with verifyOnly → throwaway directory next to the set
  verifyOnly?: boolean;
  forbiddenDatabases: string[]; // configured application / test databases
  forbiddenDirectories: string[]; // configured document roots
}
export interface RestoreResult {
  setId: string;
  targetDatabase: string;
  targetDocumentsDir: string | null;
  migrationsAfter: number;
  sessionsRevoked: number;
  resetTokensRevoked: number;
  counts: Record<string, number>;
  integrity: IntegrityReport;
  durationMs: number;
  verifyOnly: boolean;
}

const CRITICAL_TABLES = ['_prisma_migrations', 'users', 'sessions', 'roles', 'permissions', 'employees', 'organizations', 'departments', 'audit_logs', 'workflow_instances', 'document_versions', 'payroll_runs'];

export function databaseUrlFor(sourceUrl: string, database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function copyVerified(from: string, to: string, expected: string) {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  const src = createReadStream(from);
  src.on('data', (c) => hash.update(c));
  await pipeline(src, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
  if (hash.digest('hex') !== expected) throw new BackupError('RESTORE_DOCUMENT_CHECKSUM', `restored object differs from SHA256SUMS: ${path.basename(to)}`);
}

export async function restoreBackupSet(o: RestoreOptions): Promise<RestoreResult> {
  const started = Date.now();
  const setDir = path.resolve(o.setDir);
  const setId = path.basename(setDir);
  const conn = parseConnection(o.sourceDatabaseUrl);
  const verifyOnly = !!o.verifyOnly;
  const targetDatabase = o.targetDatabase ?? (verifyOnly ? generateTempDatabaseName('hr_restore_drill') : '');
  const targetDocumentsDir = o.targetDocumentsDir ? path.resolve(o.targetDocumentsDir) : verifyOnly ? path.join(path.dirname(setDir), `.restore-drill-${targetDatabase}`) : '';
  const event = (name: string) => (verifyOnly ? name.replace('restore_', 'restore_verify_') : name);
  opsLog(event('restore_started'), { setId, target: targetDatabase ? safeTarget(conn, targetDatabase) : null, verifyOnly });

  let createdDb = false;
  let createdDir = false;
  let prisma: PrismaClient | null = null;
  try {
    // 0. guard rails
    if (!targetDatabase || !/^[a-z][a-z0-9_]{1,62}$/.test(targetDatabase)) throw new BackupError('RESTORE_TARGET_INVALID', 'a new target database name ([a-z][a-z0-9_]*) is required');
    if (o.forbiddenDatabases.filter(Boolean).includes(targetDatabase)) throw new BackupError('RESTORE_TARGET_FORBIDDEN', `${targetDatabase} is a configured application database; restore into a new database and switch to it explicitly`);
    if (!targetDocumentsDir) throw new BackupError('RESTORE_TARGET_INVALID', 'a target documents directory is required');
    if (o.forbiddenDirectories.filter(Boolean).map((d) => path.resolve(d)).includes(targetDocumentsDir)) throw new BackupError('RESTORE_TARGET_FORBIDDEN', 'the target documents directory is the configured document root; restore into a new directory');
    const existing = await stat(targetDocumentsDir).catch(() => null);
    if (existing && (!existing.isDirectory() || (await readdir(targetDocumentsDir)).length > 0)) throw new BackupError('RESTORE_TARGET_NOT_EMPTY', 'the target documents directory must be absent or empty');

    // 1. the set itself
    const verify = await verifyBackupSet(setDir);
    if (!verify.ok) throw new BackupError('RESTORE_SET_INVALID', verify.problems.join('; '));
    const manifest = await readJson<BackupSetManifest>(path.join(setDir, 'manifest.json'));
    if (manifest.documents.enabled && (manifest.documents.missingReferenced > 0 || manifest.documents.checksumMismatch > 0)) {
      throw new BackupError('RESTORE_SET_INCOMPLETE', 'this set lacks objects its database references; choose a COMPLETE set');
    }

    // 2. database into a NEW database (createdb fails if it exists — nothing is ever overwritten)
    try { await runTool(findPgTool('createdb'), ['--no-password', targetDatabase], libpqEnv(conn, { database: 'postgres' })); }
    catch { throw new BackupError('RESTORE_TARGET_EXISTS', `could not create ${targetDatabase} (it may already exist)`); }
    createdDb = true;
    try { await runTool(findPgTool('pg_restore'), ['--no-password', '--no-owner', '--no-privileges', '--exit-on-error', '--dbname', targetDatabase, path.join(setDir, 'database.dump')], libpqEnv(conn, { database: targetDatabase })); }
    catch { throw new BackupError('RESTORE_DATABASE_FAILED', 'pg_restore failed'); }

    // 3. documents from the SAME set, each object checked against SHA256SUMS while copying
    await mkdir(targetDocumentsDir, { recursive: true, mode: 0o700 });
    createdDir = !existing;
    if (manifest.documents.enabled) {
      const text = await readFile(path.join(setDir, 'SHA256SUMS'), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const sha = line.slice(0, 64);
        const f = line.slice(66);
        if (f.startsWith('documents/')) await copyVerified(path.join(setDir, f), path.join(targetDocumentsDir, f), sha);
      }
    }
    // identity of the pair, for later mismatch questions (no secret, no path)
    await writeFile(path.join(targetDocumentsDir, '.hr-backup-set.json'), `${JSON.stringify({ setId, restoredAt: new Date().toISOString() })}\n`, { mode: 0o600 });

    // 4. forward to this release
    const targetUrl = databaseUrlFor(o.sourceDatabaseUrl, targetDatabase);
    try { await runTool('npx', ['prisma', 'migrate', 'deploy'], { ...libpqEnv(conn, { database: targetDatabase }), DATABASE_URL: targetUrl }); }
    catch { throw new BackupError('RESTORE_MIGRATE_FAILED', 'prisma migrate deploy failed on the restored database'); }

    // 5. security: nothing restored may log anybody in
    prisma = new PrismaClient({ datasourceUrl: targetUrl });
    const tables = new Set((await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((t) => t.table_name));
    const missingTables = CRITICAL_TABLES.filter((t) => !tables.has(t));
    if (missingTables.length) throw new BackupError('RESTORE_SCHEMA_INCOMPLETE', `missing tables: ${missingTables.join(', ')}`);
    const { count: sessionsRevoked } = await prisma.session.deleteMany({});
    const { count: resetTokensRevoked } = await prisma.passwordResetToken.updateMany({ where: { usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    if ((await prisma.session.count()) !== 0) throw new BackupError('RESTORE_SESSIONS_NOT_REVOKED', 'restored sessions remain');
    opsLog('sessions_revoked', { target: safeTarget(conn, targetDatabase), revoked: sessionsRevoked, resetTokensRevoked, reason: 'restore' });

    // 6. the restored pair is coherent
    const migrationsAfter = Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`)[0]?.n ?? 0);
    const counts = {
      users: await prisma.user.count(), employees: await prisma.employee.count(), organizations: await prisma.organization.count(),
      documentVersions: await prisma.documentVersion.count(), leaveRequests: await prisma.leaveRequest.count(), payrollRuns: await prisma.payrollRun.count(),
      auditLogs: await prisma.auditLog.count(),
    };
    const integrity = await runIntegrity(prisma, manifest.documents.enabled ? targetDocumentsDir : null, { deep: true });
    const documentFailures = integrity.failures.filter((f) => f.startsWith('DOCUMENT_'));
    if (documentFailures.length) throw new BackupError('RESTORE_DOCUMENTS_INCONSISTENT', documentFailures.join('; '));

    const result: RestoreResult = { setId, targetDatabase, targetDocumentsDir: manifest.documents.enabled ? targetDocumentsDir : null, migrationsAfter, sessionsRevoked, resetTokensRevoked, counts, integrity, durationMs: Date.now() - started, verifyOnly };
    opsLog(event('restore_succeeded'), { setId, target: safeTarget(conn, targetDatabase), migrationsAfter, sessionsRevoked, resetTokensRevoked, documentVersions: counts.documentVersions, orphans: integrity.documents?.orphans ?? 0, financialFindings: integrity.failures.length, durationMs: result.durationMs });
    return result;
  } catch (e) {
    const err = e instanceof BackupError ? e : new BackupError('RESTORE_FAILED', e instanceof Error ? e.message : String(e));
    opsLog(event('restore_failed'), { setId, reason: err.code, detail: err.message.slice(0, 300), durationMs: Date.now() - started });
    await cleanup();
    throw err;
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
    if (verifyOnly) await cleanup();
  }

  async function cleanup() {
    await prisma?.$disconnect().catch(() => undefined);
    prisma = null;
    if (createdDb) { await runTool(findPgTool('dropdb'), ['--if-exists', '--force', '--no-password', targetDatabase], libpqEnv(conn, { database: 'postgres' })).catch(() => opsLog('restore_cleanup_failed', { targetDatabase })); createdDb = false; }
    if (createdDir) { await rm(targetDocumentsDir, { recursive: true, force: true }).catch(() => undefined); createdDir = false; }
  }
}
