/**
 * Task 49 — backup, recovery and monitoring baseline (T44-P1-10, P1-11, P1-12).
 *
 * Real PostgreSQL (the test database) and real files in private temporary directories: a recovery set is created,
 * verified, corrupted, copied "off-host" through operator hooks (a second directory standing in for the remote), rotated,
 * restored into a NEW database + EMPTY document directory, and checked. Nothing here touches the development database or
 * the application's own document root, except the readiness tests, which rename the test root away and put it back.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { documentStorageRoot } from '../src/modules/documents/storage';
import { applyRetention, backupConfigFromEnv, backupFreshness, createBackupSet, readJson, setIdFor, verifyBackupSet, type BackupConfig, type SetStatus } from '../scripts/lib/backup-set';
import { runIntegrity } from '../scripts/lib/integrity';
import { runMonitorChecks } from '../scripts/lib/monitor';
import { databaseUrlFor, restoreBackupSet } from '../scripts/lib/restore-set';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
let work: string;
let docs: string; // a private document root for the backup tests (not the application's)
let hooks: string;
let remote: string;
let userId: string;
const objects: { key: string; sha: string }[] = [];
let clock = Date.parse('2026-10-01T01:00:00Z');
const nextNow = () => new Date((clock += 1000));

const cfg = (over: Omit<Partial<BackupConfig>, 'offhost'> & { offhost?: Partial<BackupConfig['offhost']> } = {}): BackupConfig => ({
  backupDir: path.join(work, 'backups'),
  databaseUrl: env.databaseUrl,
  documentsRoot: docs,
  applicationVersion: 'test',
  retainCount: 3,
  isProduction: false,
  ...over,
  offhost: { command: null, verifyCommand: null, required: false, timeoutMs: 30_000, ...(over.offhost ?? {}) },
});

async function storeObject(content: string) {
  const id = randomUUID();
  const key = `documents/${id.slice(0, 2)}/${id}`;
  await mkdir(path.join(docs, path.dirname(key)), { recursive: true });
  await writeFile(path.join(docs, key), content, { mode: 0o600 });
  const sha = createHash('sha256').update(content).digest('hex');
  objects.push({ key, sha });
  return { key, sha, size: Buffer.byteLength(content) };
}

async function addDocument(content: string, categoryId: string) {
  const o = await storeObject(content);
  const doc = await prisma.document.create({ data: { documentNumber: `DOC-T49-${objects.length}`, title: 'Contract', categoryId, createdByUserId: userId } });
  await prisma.documentVersion.create({ data: { documentId: doc.id, versionNumber: 1, storageKey: o.key, originalFilename: 'contract.pdf', mimeType: 'application/pdf', fileSize: o.size, sha256: o.sha, uploadedByUserId: userId, uploadedAt: new Date(Date.now() - 60_000) } });
  return doc.id;
}

async function hook(name: string, body: string) {
  const file = path.join(hooks, name);
  await writeFile(file, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

let categoryId: string;
beforeAll(async () => {
  await resetDatabase();
  work = await mkdtemp(path.join(tmpdir(), 'hr-t49-'));
  docs = path.join(work, 'store');
  hooks = path.join(work, 'hooks');
  remote = path.join(work, 'remote');
  await mkdir(docs, { recursive: true });
  await mkdir(hooks);
  await mkdir(remote);
  const u = await createUser({ email: 'ops@t49.local', password: 'Correct-Horse-1', role: 'SYSTEM_ADMIN' });
  userId = u.id;
  categoryId = (await prisma.documentCategory.create({ data: { code: 'T49', name: 'T49' } })).id;
  for (const c of ['alpha', 'bravo', 'charlie']) await addDocument(`%PDF-1.4 ${c}`, categoryId);
}, 60000);
afterAll(async () => { vi.useRealTimers(); await rm(work, { recursive: true, force: true }); await resetDatabase(); await prisma.$disconnect(); });

describe('one command, one recovery set (T44-P1-10)', () => {
  let setDir: string;
  it('database + documents + manifest + SHA256SUMS, owner-only, verified; freshness recorded', async () => {
    const r = await createBackupSet(cfg(), nextNow());
    expect(r.ok, r.reason ?? '').toBe(true);
    setDir = r.setDir!;
    expect((await readdir(setDir)).sort()).toEqual(['SHA256SUMS', 'database.dump', 'documents', 'manifest.json', 'status.json']);
    const m = r.manifest!;
    expect(m.documents).toMatchObject({ enabled: true, files: 3, referencedVersions: 3, missingReferenced: 0, checksumMismatch: 0 });
    expect(m.database.sizeBytes).toBeGreaterThan(0);
    // opaque keys preserved byte for byte
    for (const o of objects) expect(createHash('sha256').update(await readFile(path.join(setDir, o.key))).digest('hex')).toBe(o.sha);
    // no credential, password or file name in the manifest
    const text = await readFile(path.join(setDir, 'manifest.json'), 'utf8');
    expect(text).not.toMatch(/password|postgresql:\/\/|contract\.pdf/i);
    expect((await stat(setDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(setDir, 'database.dump'))).mode & 0o777).toBe(0o600);
    expect(await readJson<SetStatus>(path.join(setDir, 'status.json'))).toMatchObject({ state: 'COMPLETE', verified: true, offhost: 'NOT_REQUIRED' });
    expect((await backupFreshness(cfg().backupDir, 26, new Date())).ok).toBe(true);
    expect((await verifyBackupSet(setDir)).ok).toBe(true);
  }, 60000);

  it('a backed-up document modified afterwards fails verification, naming the file', async () => {
    const copy = path.join(work, 'tamper-doc');
    await cpSet(setDir, copy);
    await writeFile(path.join(copy, objects[0]!.key), 'tampered');
    const v = await verifyBackupSet(copy);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain(`checksum mismatch: ${objects[0]!.key}`);
  });

  it('a truncated dump fails verification (checksum and pg_restore --list), and cannot be restored', async () => {
    const copy = path.join(work, 'tamper-dump');
    await cpSet(setDir, copy);
    await truncate(path.join(copy, 'database.dump'), 100);
    const v = await verifyBackupSet(copy);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/checksum mismatch: database.dump/);
    await expect(restoreBackupSet({ setDir: copy, sourceDatabaseUrl: env.databaseUrl, verifyOnly: true, forbiddenDatabases: [], forbiddenDirectories: [] })).rejects.toThrow(/RESTORE_SET_INVALID/);
  });

  it('an extra or missing file in the set is reported', async () => {
    const copy = path.join(work, 'tamper-extra');
    await cpSet(setDir, copy);
    await writeFile(path.join(copy, 'documents', 'intruder'), 'x');
    await rm(path.join(copy, objects[1]!.key));
    const v = await verifyBackupSet(copy);
    expect(v.problems.join(' ')).toMatch(/unlisted file in set: documents\/intruder/);
    expect(v.problems.join(' ')).toMatch(/missing file/);
  });
});

describe('failures are failures (non-zero, no false success)', () => {
  it('a database dump failure leaves no set and does not move freshness', async () => {
    const before = await readFile(path.join(cfg().backupDir, 'last-success.json'), 'utf8');
    const bad = new URL(env.databaseUrl); bad.pathname = '/hr_t49_does_not_exist';
    const r = await createBackupSet(cfg({ databaseUrl: bad.toString() }), nextNow());
    expect(r.ok).toBe(false);
    expect(r.setDir).toBeNull();
    expect((await readdir(cfg().backupDir)).filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect(await readFile(path.join(cfg().backupDir, 'last-success.json'), 'utf8')).toBe(before);
    expect(await readJson(path.join(cfg().backupDir, 'last-attempt.json'))).toMatchObject({ ok: false });
  }, 60000);

  it('a missing or unreadable document root fails the set — a database dump alone is not a recovery set', async () => {
    const r = await createBackupSet(cfg({ documentsRoot: path.join(work, 'no-such-store') }), nextNow());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DOCUMENT_BACKUP_FAILED/);
    expect(r.setDir).toBeNull();
  }, 60000);

  it('a referenced object missing from the store: the set is kept INCOMPLETE, never a success', async () => {
    const lost = await storeObject('%PDF lost later');
    const doc = await prisma.document.create({ data: { documentNumber: 'DOC-T49-LOST', title: 'Lost', categoryId, createdByUserId: userId } });
    await prisma.documentVersion.create({ data: { documentId: doc.id, versionNumber: 1, storageKey: lost.key, originalFilename: 'x.pdf', mimeType: 'application/pdf', fileSize: lost.size, sha256: lost.sha, uploadedByUserId: userId, uploadedAt: new Date(Date.now() - 60_000) } });
    await rename(path.join(docs, lost.key), path.join(work, 'parked'));
    const r = await createBackupSet(cfg(), nextNow());
    expect(r.ok).toBe(false);
    expect(r.state).toBe('INCOMPLETE');
    expect(r.reason).toMatch(/DOCUMENT_REFERENCES_MISSING: 1/);
    // the integrity check names the version, and restore refuses the incomplete set
    const ir = await runIntegrity(prisma, docs);
    expect(ir.failures.join(' ')).toMatch(/DOCUMENT_OBJECTS_MISSING: 1/);
    expect(ir.documents!.samples.missing).toHaveLength(1);
    await expect(restoreBackupSet({ setDir: r.setDir!, sourceDatabaseUrl: env.databaseUrl, verifyOnly: true, forbiddenDatabases: [], forbiddenDirectories: [] })).rejects.toThrow(/RESTORE_SET_INCOMPLETE/);
    await rename(path.join(work, 'parked'), path.join(docs, lost.key));
  }, 60000);
});

describe('off-host copy (T44-P1-11)', () => {
  it('success: the hook copies, the verify hook re-hashes the remote copy against SHA256SUMS; the set is COMPLETE', async () => {
    const copy = await hook('copy.sh', `cp -R "$1" "${remote}/$2"`);
    const check = await hook('check.sh', `cd "${remote}/$2" && shasum -a 256 -c SHA256SUMS >/dev/null && [ "$(shasum -a 256 SHA256SUMS | cut -d' ' -f1)" = "$BACKUP_SHA256SUMS_SHA256" ]`);
    const r = await createBackupSet(cfg({ offhost: { command: copy, verifyCommand: check, required: true } }), nextNow());
    expect(r.ok, r.reason ?? '').toBe(true);
    expect(await readJson<SetStatus>(path.join(r.setDir!, 'status.json'))).toMatchObject({ state: 'COMPLETE', offhost: 'COPIED' });
    expect((await verifyBackupSet(path.join(remote, r.setId))).ok).toBe(true);
  }, 60000);

  it('destination unavailable: the local set stays verified (LOCAL_ONLY) but the job fails and freshness does not move', async () => {
    const before = await readJson<{ setId: string }>(path.join(cfg().backupDir, 'last-success.json'));
    const down = await hook('down.sh', 'echo "remote unreachable" >&2; exit 3');
    const check = await hook('never.sh', 'exit 0');
    const r = await createBackupSet(cfg({ offhost: { command: down, verifyCommand: check, required: true } }), nextNow());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/OFFHOST_COPY_FAILED/);
    expect(await readJson<SetStatus>(path.join(r.setDir!, 'status.json'))).toMatchObject({ state: 'LOCAL_ONLY', verified: true, offhost: 'FAILED' });
    expect((await readJson<{ setId: string }>(path.join(cfg().backupDir, 'last-success.json'))).setId).toBe(before.setId);
  }, 60000);

  it('a copy that succeeds but cannot be confirmed remotely is a failure too', async () => {
    const copy = await hook('copy2.sh', 'exit 0'); // claims success, copies nothing
    const check = await hook('check2.sh', `test -f "${remote}/$2/SHA256SUMS"`);
    const r = await createBackupSet(cfg({ offhost: { command: copy, verifyCommand: check, required: true } }), nextNow());
    expect(r.ok).toBe(false);
    expect(r.state).toBe('LOCAL_ONLY');
  }, 60000);

  it('production refuses to call a local-only backup a success, and requires a verify hook with the upload hook', async () => {
    const r = await createBackupSet(cfg({ offhost: { command: null, verifyCommand: null, required: true } }), nextNow());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/OFFHOST_NOT_CONFIGURED/);
    const app0 = { databaseUrl: 'postgresql://x@h/db', documentsRoot: null, applicationVersion: null, isProduction: true, defaultBackupDir: '/tmp/x' };
    expect(() => backupConfigFromEnv({}, app0)).toThrow(/BACKUP_DIR_REQUIRED/);
    expect(() => backupConfigFromEnv({ BACKUP_DIR: '/b', BACKUP_OFFHOST_COMMAND: '/bin/true' }, app0)).toThrow(/VERIFY_COMMAND is required/);
    expect(() => backupConfigFromEnv({ BACKUP_DIR: '/b', BACKUP_OFFHOST_COMMAND: 'relative.sh', BACKUP_OFFHOST_VERIFY_COMMAND: '/bin/true' }, app0)).toThrow(/absolute path/);
    expect(backupConfigFromEnv({ BACKUP_DIR: '/b' }, app0).offhost.required).toBe(true);
  }, 60000);
});

describe('retention never deletes the only valid backup', () => {
  it('keeps the newest N COMPLETE sets; older complete, LOCAL_ONLY/INCOMPLETE and stale partial sets older than the kept ones go', async () => {
    const dir = path.join(work, 'retention');
    await mkdir(dir);
    const mk = async (minute: number, state: SetStatus['state'] | 'PARTIAL') => {
      const name = setIdFor(new Date(Date.UTC(2026, 9, 1, 0, minute))) + (state === 'PARTIAL' ? '.partial' : '');
      await mkdir(path.join(dir, name));
      if (state !== 'PARTIAL') await writeFile(path.join(dir, name, 'status.json'), JSON.stringify({ state }));
      return name;
    };
    const old1 = await mk(1, 'COMPLETE');
    const failedOld = await mk(2, 'LOCAL_ONLY');
    const partialOld = await mk(3, 'PARTIAL');
    const c2 = await mk(4, 'COMPLETE');
    const c3 = await mk(5, 'COMPLETE');
    const failedNew = await mk(6, 'INCOMPLETE');
    const deleted = await applyRetention(dir, 2);
    expect(deleted.sort()).toEqual([failedOld, old1, partialOld].sort());
    expect((await readdir(dir)).sort()).toEqual([c2, c3, failedNew].sort()); // the newest failure stays for investigation

    // only failures and no COMPLETE set → nothing is deleted at all
    const dir2 = path.join(work, 'retention2');
    await mkdir(dir2);
    await mkdir(path.join(dir2, setIdFor(new Date(Date.UTC(2026, 9, 1)))));
    expect(await applyRetention(dir2, 1)).toEqual([]);
    await expect(applyRetention(dir2, 0)).rejects.toThrow(/at least one/);
  });

  it('a real run with keep=3 leaves exactly 3 COMPLETE sets', async () => {
    const r = await createBackupSet(cfg(), nextNow());
    expect(r.ok, r.reason ?? '').toBe(true);
    const states = [];
    for (const n of (await readdir(cfg().backupDir)).filter((n) => /^hr-backup-.*Z$/.test(n))) states.push((await readJson<SetStatus>(path.join(cfg().backupDir, n, 'status.json'))).state);
    expect(states.filter((s) => s === 'COMPLETE')).toHaveLength(3);
  }, 60000);
});

describe('monitoring signals (T44-P1-12)', () => {
  const healthy = async () => ({ ok: true });
  it('backup freshness: fresh → ok; old → BACKUP_STALE; none → NO_SUCCESSFUL_BACKUP', async () => {
    const dir = cfg().backupDir;
    expect((await backupFreshness(dir, 26, new Date())).ok).toBe(true);
    expect(await backupFreshness(dir, 26, new Date(Date.now() + 27 * 3_600_000))).toMatchObject({ ok: false, reason: 'BACKUP_STALE' });
    expect(await backupFreshness(path.join(work, 'empty'), 26)).toMatchObject({ ok: false, reason: 'NO_SUCCESSFUL_BACKUP' });
  });

  it('healthy system → ok; API down → fails; storage unavailable → fails; stale/missing backup → fails', async () => {
    const port = (app.address() as { port: number }).port; // createTestServer() is already listening
    {
      const base = { timeoutMs: 3000, documentsRoot: docs, maxBackupAgeHours: 1e6, minFreeMb: 1 };
      const ok = await runMonitorChecks({ ...base, apiBaseUrl: `http://127.0.0.1:${port}`, storageHealth: healthy, backupDir: cfg().backupDir });
      expect(ok.checks.filter((c) => !c.ok).map((c) => c.name), JSON.stringify(ok.checks)).toEqual([]);
      const apiDown = await runMonitorChecks({ ...base, apiBaseUrl: 'http://127.0.0.1:9', storageHealth: healthy, backupDir: cfg().backupDir });
      expect(apiDown.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['api_live', 'api_ready']);
      const storage = await runMonitorChecks({ ...base, apiBaseUrl: null, storageHealth: async () => ({ ok: false, reason: 'ROOT_MISSING' }), backupDir: cfg().backupDir });
      expect(storage.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['document_storage']);
      const noBackup = await runMonitorChecks({ ...base, apiBaseUrl: null, storageHealth: healthy, backupDir: path.join(work, 'never-backed-up') });
      expect(noBackup.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['backup_freshness', 'backup_free_space']);
      const stale = await runMonitorChecks({ ...base, maxBackupAgeHours: 1e-9, apiBaseUrl: null, storageHealth: healthy, backupDir: cfg().backupDir });
      expect(stale.checks.find((c) => c.name === 'backup_freshness')).toMatchObject({ ok: false, detail: { reason: 'BACKUP_STALE' } });
      const full = await runMonitorChecks({ ...base, minFreeMb: 1e12, apiBaseUrl: null, storageHealth: healthy, backupDir: cfg().backupDir });
      expect(full.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['document_storage_free_space', 'backup_free_space']);
    }
  });

  it('readiness: the document root is never re-created once documents exist; reason codes are path-free', async () => {
    const root = documentStorageRoot()!;
    await mkdir(root, { recursive: true });
    const parked = `${root}.t49-parked`;
    await rename(root, parked);
    try {
      const r = await request(app).get('/api/v1/health/ready');
      // documents exist in this database (created above) → a missing root is unavailable, and stays missing
      expect(r.status).toBe(503);
      expect(r.body.data).toMatchObject({ status: 'unavailable', database: 'ok', documentStorage: 'unavailable', documentStorageReason: 'ROOT_MISSING' });
      expect(await stat(root).catch(() => null)).toBeNull();
      expect(JSON.stringify(r.body)).not.toContain(root);
      // an empty directory where the store should be (unmounted volume) is unavailable too
      await mkdir(root);
      const empty = await request(app).get('/api/v1/health/ready');
      expect(empty.body.data).toMatchObject({ documentStorage: 'unavailable', documentStorageReason: 'ROOT_EMPTY_BUT_DOCUMENTS_EXIST' });
      await rm(root, { recursive: true });
    } finally {
      await rename(parked, root);
    }
    await mkdir(path.join(root, 'documents'), { recursive: true });
    const ok = await request(app).get('/api/v1/health/ready');
    expect(ok.status).toBe(200);
    expect(ok.body.data.documentStorage).toBe('ok');
  });
});

describe('restore (T44-P1-10): new database + empty directory, sessions and reset tokens revoked', () => {
  it('a pre-backup session and reset token do not survive; post-backup changes are absent; documents match', async () => {
    const session = await loginAs(app, 'ops@t49.local', 'Correct-Horse-1');
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', session.cookie)).status).toBe(200);
    await prisma.passwordResetToken.create({ data: { userId, tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000), createdByUserId: userId } });
    const b = await createBackupSet(cfg(), nextNow());
    expect(b.ok, b.reason ?? '').toBe(true);
    // after the backup: a new document and a new employee-free change
    await addDocument('%PDF-1.4 after backup', categoryId);

    const target = `hr_t49_restore_${randomUUID().slice(0, 8)}`;
    const targetDocs = path.join(work, 'restored-store');
    const r = await restoreBackupSet({ setDir: b.setDir!, sourceDatabaseUrl: env.databaseUrl, targetDatabase: target, targetDocumentsDir: targetDocs, forbiddenDatabases: [], forbiddenDirectories: [docs] });
    try {
      expect(r.sessionsRevoked).toBeGreaterThanOrEqual(1);
      expect(r.resetTokensRevoked).toBe(1);
      const restored = new PrismaClient({ datasourceUrl: databaseUrlFor(env.databaseUrl, target) });
      try {
        expect(await restored.session.count()).toBe(0);
        expect(await restored.passwordResetToken.count({ where: { revokedAt: null, usedAt: null } })).toBe(0);
        expect(await restored.document.count({ where: { documentNumber: { startsWith: 'DOC-T49-' } } })).toBe(objects.length - 1); // the post-backup document is not in the set
        expect(r.integrity.documents).toMatchObject({ missing: 0, sizeMismatch: 0, checksumMismatch: 0, deep: true });
        expect(JSON.parse(await readFile(path.join(targetDocs, '.hr-backup-set.json'), 'utf8')).setId).toBe(b.setId);
      } finally { await restored.$disconnect(); }
    } finally {
      await restoreCleanup(target);
    }
  }, 120000);

  it('refuses to overwrite: an existing database, a configured database, a non-empty directory, the configured root', async () => {
    const set = (await readdir(cfg().backupDir)).filter((n) => /Z$/.test(n)).sort().pop()!;
    const setDir = path.join(cfg().backupDir, set);
    const live = new URL(env.databaseUrl).pathname.slice(1);
    await expect(restoreBackupSet({ setDir, sourceDatabaseUrl: env.databaseUrl, targetDatabase: live, targetDocumentsDir: path.join(work, 'x1'), forbiddenDatabases: [live], forbiddenDirectories: [] })).rejects.toThrow(/RESTORE_TARGET_FORBIDDEN/);
    await expect(restoreBackupSet({ setDir, sourceDatabaseUrl: env.databaseUrl, targetDatabase: 'hr_t49_x2', targetDocumentsDir: docs, forbiddenDatabases: [], forbiddenDirectories: [docs] })).rejects.toThrow(/RESTORE_TARGET_FORBIDDEN/);
    await expect(restoreBackupSet({ setDir, sourceDatabaseUrl: env.databaseUrl, targetDatabase: 'hr_t49_x3', targetDocumentsDir: hooks, forbiddenDatabases: [], forbiddenDirectories: [] })).rejects.toThrow(/RESTORE_TARGET_NOT_EMPTY/);
    await expect(restoreBackupSet({ setDir, sourceDatabaseUrl: env.databaseUrl, targetDatabase: 'postgres', targetDocumentsDir: path.join(work, 'x4'), forbiddenDatabases: ['postgres'], forbiddenDirectories: [] })).rejects.toThrow(/RESTORE_TARGET_FORBIDDEN/);
  });

  it('restore of a set + documents of ANOTHER set: the integrity check reports the mismatch', async () => {
    const sets = (await readdir(cfg().backupDir)).filter((n) => /Z$/.test(n)).sort();
    const r = await restoreBackupSet({ setDir: path.join(cfg().backupDir, sets[sets.length - 1]!), sourceDatabaseUrl: env.databaseUrl, verifyOnly: true, forbiddenDatabases: [], forbiddenDirectories: [] });
    expect(r.verifyOnly).toBe(true);
    // the restored database against a store that lacks one of its objects (a different set) → named failure
    const partialStore = path.join(work, 'other-store');
    await cpSet(docs, partialStore);
    await rm(path.join(partialStore, objects[0]!.key));
    const ir = await runIntegrity(prisma, partialStore, { deep: true });
    expect(ir.failures.join(' ')).toMatch(/DOCUMENT_OBJECTS_MISSING: 1/);
  }, 120000);
});

describe('financial reconciliation preflight (Task 48 follow-up)', () => {
  it('a SENT_TO_PAYROLL report without a payroll line is reported (not repaired)', async () => {
    const org = await prisma.organization.create({ data: { code: 'T49', name: 'T49', timezone: 'Asia/Bangkok' } });
    const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'T49D', name: 'D' } });
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'T49P', title: 'P' } });
    const e = await prisma.employee.create({ data: { employeeCode: 'T49E', firstName: 'T', lastName: 'E', email: 't49e@t49.local', hireDate: new Date('2020-01-01'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } });
    const policy = await prisma.expensePolicy.create({ data: { code: 'T49POL', name: 'P', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'NONE', createdByUserId: userId } });
    const report = await prisma.expenseReport.create({ data: { reportNumber: 'EXP-T49-1', title: 'Load', employeeId: e.id, policyId: policy.id, policyCodeSnapshot: 'T49POL', policyNameSnapshot: 'P', employeeCodeSnapshot: 'T49E', employeeNameSnapshot: 'T E', currency: 'THB', createdByUserId: userId, status: 'SENT_TO_PAYROLL', paymentMethod: 'PAYROLL' } });
    const r = await runIntegrity(prisma, null);
    expect(r.ok).toBe(false);
    expect(r.financial.sentWithoutLine).toBe(1);
    expect(r.financial.samples).toEqual([`EXPENSE_REPORT:${report.id}`]);
    expect((await prisma.expenseReport.findUniqueOrThrow({ where: { id: report.id } })).status).toBe('SENT_TO_PAYROLL'); // untouched
  });
});

describe('ops commands act on the configured database (drill finding)', () => {
  it('with ENV_FILE, an ops command uses that file\'s DATABASE_URL — not the repository .env loaded by @prisma/client', async () => {
    const { execFile } = await import('node:child_process');
    const probeDb = 'hr_t49_envfile_probe';
    const url = new URL(env.databaseUrl); url.pathname = `/${probeDb}`;
    const envFile = path.join(work, 'probe.env');
    await writeFile(envFile, `NODE_ENV=development\nDATABASE_URL="${url.toString()}"\nDOCUMENTS_ENABLED=false\n`, { mode: 0o600 });
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['DATABASE_URL', 'TEST_DATABASE_URL', 'NODE_ENV'].includes(k)));
    const out = await new Promise<{ code: number; text: string }>((resolve) => execFile('npx', ['tsx', 'scripts/ops-integrity.ts'], { cwd: path.resolve(__dirname, '..'), env: { ...childEnv, ENV_FILE: envFile } }, (err, stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, text: `${stdout}${stderr}` })));
    // the probe database does not exist: the command must fail on IT (before the fix it read the development database)
    expect(out.code).not.toBe(0);
    expect(out.text).toContain(probeDb);
    expect(out.text).not.toMatch(/postgresql:\/\/[^ ]*:[^ ]*@/); // no credentials printed
  }, 60000);
});

async function cpSet(from: string, to: string) {
  const { cp } = await import('node:fs/promises');
  await cp(from, to, { recursive: true });
}
async function restoreCleanup(db: string) {
  const { findPgTool, libpqEnv, parseConnection, runTool } = await import('../scripts/lib/pg-tools');
  await runTool(findPgTool('dropdb'), ['--if-exists', '--force', '--no-password', db], libpqEnv(parseConnection(env.databaseUrl), { database: 'postgres' }));
}
