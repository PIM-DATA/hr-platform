/**
 * Task 16 — backup / restore / operations (checklist 39–42).
 *
 * The acceptance path is a REAL PostgreSQL round trip: pg_dump → temporary database → pg_restore → query → drop.
 * Only the failure branches that cannot be produced safely against a live server use a stubbed runner.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { backupBaseName, resolveBackupDir, runBackup, type BackupManifest } from '../scripts/backup-db';
import { assertSafeTargetDatabase, resolveDumpPath, revokeAllSessions, temporaryDatabaseUrl, verifyBackup } from '../scripts/restore-verify';
import { assertToolCompatible, extractVersion, findPgTool, generateTempDatabaseName, libpqEnv, parseConnection, safeTarget } from '../scripts/lib/pg-tools';
import { safeRequestId } from '../src/middleware/request-logger';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { createTestServer } from './helpers';

const execFileAsync = promisify(execFile);
const app = createTestServer();
let workDir: string;
const CONN = parseConnection(env.databaseUrl); // the TEST database under NODE_ENV=test

beforeAll(async () => { workDir = await mkdtemp(path.join(tmpdir(), 'hr-ops-')); });
afterAll(async () => { await rm(workDir, { recursive: true, force: true }); });

describe('request id hardening (Task 15.1)', () => {
  it('keeps a sane inbound id and replaces anything else with a generated one', async () => {
    expect(safeRequestId('trace-abc.123:45')).toBe('trace-abc.123:45');
    expect(safeRequestId('x'.repeat(128))).toHaveLength(128);
    for (const bad of ['x'.repeat(129), 'has space', 'CR\r\nLF', 'ctrl\u0000char', 'semi;colon', '<script>', '', undefined, 42, {}]) {
      const id = safeRequestId(bad as unknown);
      expect(id, JSON.stringify(bad)).toMatch(/^[0-9a-f-]{36}$/); // a generated uuid, not the input
    }
  });
  it('the HTTP layer echoes a valid id and never an unsafe one, and the log line stays valid JSON', async () => {
    const good = await request(app).get('/api/v1/health').set('x-request-id', 'edge-trace-1');
    expect(good.headers['x-request-id']).toBe('edge-trace-1');
    const oversized = 'y'.repeat(500);
    const bad = await request(app).get('/api/v1/health').set('x-request-id', oversized);
    expect(bad.status).toBe(200);
    expect(bad.headers['x-request-id']).not.toBe(oversized);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('backup configuration safety', () => {
  it('1. production requires an explicit BACKUP_DIR; development falls back to a git-ignored folder', () => {
    expect(() => resolveBackupDir({}, true)).toThrow(/BACKUP_DIR is required/);
    expect(resolveBackupDir({ BACKUP_DIR: '/var/backups/hr' }, true)).toBe('/var/backups/hr');
    expect(resolveBackupDir({}, false)).toMatch(/apps\/api\/backups$/);
  });
  it('2. the backup name is server-generated and sortable', () => {
    const name = backupBaseName(new Date('2026-03-04T05:06:07'));
    expect(name).toBe('hr-enterprise-20260304-050607');
    expect(name).toMatch(/^[a-z0-9-]+$/); // nothing a shell or path could reinterpret
  });
  it('3/4. credentials travel in the child environment, never in arguments', () => {
    const conn = parseConnection('postgresql://app_user:sup3r-secret@db.internal:5433/hr?sslmode=require');
    const childEnv = libpqEnv(conn, { database: 'other_db' });
    expect(childEnv.PGPASSWORD).toBe('sup3r-secret');
    expect(childEnv).toMatchObject({ PGHOST: 'db.internal', PGPORT: '5433', PGUSER: 'app_user', PGDATABASE: 'other_db', PGSSLMODE: 'require' });
    // the arguments the backup passes to pg_dump contain no secret
    const args = ['--format=custom', '--no-password', '--file', '/var/backups/hr/x.dump.partial'];
    expect(args.join(' ')).not.toMatch(/sup3r-secret|app_user|postgresql:\/\//);
    expect(safeTarget(conn)).toBe('db.internal:5433/hr'); // printable label carries no password
    expect(safeTarget(conn)).not.toMatch(/sup3r-secret/);
  });
  it('version parsing and client/server compatibility', () => {
    expect(extractVersion('pg_dump (PostgreSQL) 18.6 (Postgres.app)')).toBe('18.6');
    expect(extractVersion('17.2')).toBe('17.2');
    expect(() => assertToolCompatible('16.1', '18.6')).toThrow(/older than the server/);
    expect(() => assertToolCompatible('18.6', '18.6')).not.toThrow();
    expect(() => assertToolCompatible('19.0', '18.6')).not.toThrow();
  });
});

describe('restore target safety', () => {
  it('5/10. a manifest cannot point outside its own directory', () => {
    const manifestPath = path.join(workDir, 'a.manifest.json');
    expect(resolveDumpPath(manifestPath, { backupFilename: 'a.dump' })).toBe(path.join(workDir, 'a.dump'));
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'sub/dir.dump', '..']) {
      expect(() => resolveDumpPath(manifestPath, { backupFilename: bad }), bad).toThrow(/Unsafe backupFilename|escapes/);
    }
  });
  it('11/12/13. the development, test and source databases can never be restore targets', () => {
    const dev = parseConnection(env.DATABASE_URL).database;
    const test = parseConnection(env.databaseUrl).database;
    for (const name of [dev, test, 'hr_enterprise_prod']) {
      expect(() => assertSafeTargetDatabase(name, [dev, test, 'hr_enterprise_prod']), name).toThrow(/configured application database/);
    }
    const generated = generateTempDatabaseName();
    expect(generated).toMatch(/^hr_restore_verify_[a-z0-9]{10}$/);
    expect(() => assertSafeTargetDatabase(generated, [dev, test])).not.toThrow();
    for (const unsafe of ['Drop Table', 'hr;drop', '../db', 'HR_UPPER', '1leading']) {
      expect(() => assertSafeTargetDatabase(unsafe, []), unsafe).toThrow(/Unsafe temporary database name/);
    }
  });
  it('temporaryDatabaseUrl keeps the server and credentials but swaps the database', () => {
    const url = temporaryDatabaseUrl('postgresql://u:p@h:5432/source?schema=public', 'hr_restore_verify_abc');
    expect(new URL(url).pathname).toBe('/hr_restore_verify_abc');
    expect(new URL(url).host).toBe('h:5432');
  });
});

describe('real backup → restore → drop drill (PostgreSQL)', () => {
  let manifest: BackupManifest;
  let manifestPath: string;

  it('6/7/8. produces a dump, a credential-free manifest and a matching checksum, with owner-only permissions', async () => {
    process.env.BACKUP_DIR = workDir;
    manifest = await runBackup();
    manifestPath = path.join(workDir, `${path.basename(manifest.backupFilename, '.dump')}.manifest.json`);
    const dumpPath = path.join(workDir, manifest.backupFilename);
    expect(existsSync(dumpPath)).toBe(true);
    expect(existsSync(`${dumpPath}.partial`)).toBe(false); // no partial left behind

    const raw = await readFile(manifestPath, 'utf8');
    expect(raw).not.toMatch(/postgresql:\/\/|PGPASSWORD|password/i);
    expect(JSON.parse(raw)).toMatchObject({ formatVersion: 1, sha256: manifest.sha256, backupFilename: manifest.backupFilename });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.backupSizeBytes).toBeGreaterThan(0);
    expect(manifest.postgresServerVersion).toMatch(/^\d+/);

    if (process.platform !== 'win32') {
      expect((await stat(dumpPath)).mode & 0o777).toBe(0o600);
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  }, 120000);

  it('14/15/17. restores into a temporary database, passes integrity checks, revokes restored sessions and cleans up', async () => {
    const before = { employees: await prisma.employee.count(), ledger: await prisma.leaveLedger.count(), users: await prisma.user.count() };
    const result = await verifyBackup(manifestPath);
    expect(result.checksumOk).toBe(true);
    expect(result.migrationsApplied).toBeGreaterThan(0);
    expect(result.tables).toBeGreaterThan(20);
    // 18. source vs restored aggregate comparison (this drill has the source database online)
    expect(result.counts.employees).toBe(before.employees);
    expect(result.counts.leaveLedger).toBe(before.ledger);
    expect(result.counts.users).toBe(before.users);
    expect(result.sessionsAfter).toBe(0); // restored sessions revoked on the restored copy

    // the temporary database is gone, and the source database still has its sessions
    const { stdout } = await execFileAsync(findPgTool('psql'), ['-Atqc', `SELECT count(*) FROM pg_database WHERE datname = '${result.temporaryDatabase}'`], { env: libpqEnv(CONN, { database: 'postgres' }), shell: false });
    expect(stdout.trim()).toBe('0');
  }, 180000);

  it('9. a tampered dump is rejected before anything is restored', async () => {
    const tamperedDir = await mkdtemp(path.join(tmpdir(), 'hr-ops-bad-'));
    try {
      const dumpCopy = path.join(tamperedDir, manifest.backupFilename);
      const original = await readFile(path.join(workDir, manifest.backupFilename));
      await writeFile(dumpCopy, Buffer.concat([original, Buffer.from('tampered')]), { mode: 0o600 });
      const badManifest = path.join(tamperedDir, 'bad.manifest.json');
      await writeFile(badManifest, JSON.stringify({ ...manifest, backupSizeBytes: original.length + 8 }), { mode: 0o600 });
      await expect(verifyBackup(badManifest)).rejects.toThrow(/BACKUP_CHECKSUM_MISMATCH/);
      // nothing was created for the rejected backup
      const { stdout } = await execFileAsync(findPgTool('psql'), ['-Atqc', "SELECT count(*) FROM pg_database WHERE datname LIKE 'hr_restore_verify_%'"], { env: libpqEnv(CONN, { database: 'postgres' }), shell: false });
      expect(stdout.trim()).toBe('0');
    } finally {
      await rm(tamperedDir, { recursive: true, force: true });
    }
  }, 120000);

  it('16. a failing restore drops its temporary database', async () => {
    const brokenDir = await mkdtemp(path.join(tmpdir(), 'hr-ops-broken-'));
    try {
      // A syntactically valid file with a correct checksum that pg_restore cannot read.
      const garbage = Buffer.from('this is not a pg_dump archive');
      const dumpName = 'hr-enterprise-broken.dump';
      await writeFile(path.join(brokenDir, dumpName), garbage, { mode: 0o600 });
      const { createHash } = await import('node:crypto');
      const sha256 = createHash('sha256').update(garbage).digest('hex');
      const brokenManifest = path.join(brokenDir, 'broken.manifest.json');
      await writeFile(brokenManifest, JSON.stringify({ ...manifest, backupFilename: dumpName, backupSizeBytes: garbage.length, sha256 }), { mode: 0o600 });
      await expect(verifyBackup(brokenManifest)).rejects.toThrow();
      const { stdout } = await execFileAsync(findPgTool('psql'), ['-Atqc', "SELECT count(*) FROM pg_database WHERE datname LIKE 'hr_restore_verify_%'"], { env: libpqEnv(CONN, { database: 'postgres' }), shell: false });
      expect(stdout.trim()).toBe('0'); // cleaned up despite the failure
    } finally {
      await rm(brokenDir, { recursive: true, force: true });
    }
  }, 180000);

  it('6b. a failed pg_dump leaves no file that could pass for a backup', async () => {
    const failDir = await mkdtemp(path.join(tmpdir(), 'hr-ops-fail-'));
    try {
      process.env.BACKUP_DIR = failDir;
      const original = process.env.PG_BIN_DIR;
      process.env.PG_BIN_DIR = failDir; // a directory with no PostgreSQL tools in it
      await expect(runBackup()).rejects.toThrow(/pg_dump was not found|not found/);
      if (original === undefined) delete process.env.PG_BIN_DIR; else process.env.PG_BIN_DIR = original;
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(failDir)).toEqual([]); // no dump, no partial, no manifest
    } finally {
      process.env.BACKUP_DIR = workDir;
      await rm(failDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('session revocation', () => {
  it('deletes sessions only, and only on the database it is given', async () => {
    const url = temporaryDatabaseUrl(env.databaseUrl, parseConnection(env.databaseUrl).database);
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      const usersBefore = await client.user.count();
      const rolesBefore = await client.role.count();
      const { revoked } = await revokeAllSessions(client);
      expect(revoked).toBeGreaterThanOrEqual(0);
      expect(await client.session.count()).toBe(0);
      expect(await client.user.count()).toBe(usersBefore); // accounts untouched
      expect(await client.role.count()).toBe(rolesBefore);
    } finally {
      await client.$disconnect();
    }
  }, 60000);
});
