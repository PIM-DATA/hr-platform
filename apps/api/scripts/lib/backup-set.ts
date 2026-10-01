import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { assertToolCompatible, findPgTool, libpqEnv, opsLog, parseConnection, runTool, safeTarget, serverVersion, toolVersion, type PgConnection } from './pg-tools';

const execFileAsync = promisify(execFile);

/**
 * Task 49 (T44-P1-10 / P1-11) — the complete recovery set.
 *
 * A backup of this application is the PostgreSQL database **and** the document store, taken as one set:
 *
 *   <BACKUP_DIR>/hr-backup-<YYYYMMDDTHHMMSSZ>/
 *     database.dump        pg_dump custom format
 *     documents/…          the document store's object tree, opaque keys preserved byte for byte
 *     manifest.json        identity, versions, sizes, counts, consistency facts — never a credential or a file name
 *     SHA256SUMS           sha256 of every file above (manifest included)
 *     status.json          mutable operational state (verified, off-host) — outside the checksums by design
 *
 * The set is assembled in `<name>.partial/` and renamed only when complete, so no directory with a final name can be a
 * half-written backup. Everything is owner-only (umask 077, dirs 0700, files 0600).
 *
 * **Consistency model (single node, local files).** pg_dump takes a transactional snapshot at its start (T0). The
 * document tree is copied *after* the dump. Stored objects are immutable once referenced (an upload writes the bytes
 * before its metadata row commits; versions are append-only; bytes are only ever deleted for an upload that failed
 * before its row existed). Therefore every object referenced by the dump is present in the copy. Objects uploaded after
 * T0 may also be in the copy; after a restore they are unreferenced (reported as orphans, harmless). This is not an
 * atomic distributed snapshot and does not claim to be one; no maintenance window is needed. The backup checks the
 * claim instead of assuming it: every version known to the database at T0 must be in the copy with its recorded sha256.
 */
export const BACKUP_SET_FORMAT = 2;
export const SET_PREFIX = 'hr-backup-';
export const SET_NAME = /^hr-backup-\d{8}T\d{6}Z$/;

export interface BackupSetManifest {
  formatVersion: number;
  setId: string;
  createdAt: string;
  databaseSnapshotStartedAt: string;
  applicationVersion: string | null;
  database: { file: 'database.dump'; sizeBytes: number; sha256: string; postgresServerVersion: string; pgDumpVersion: string; latestMigration: string | null; migrationCount: number | null };
  documents:
    | { enabled: false }
    | { enabled: true; directory: 'documents'; files: number; bytes: number; referencedVersions: number; missingReferenced: number; checksumMismatch: number };
  consistency: string;
}

export type SetState = 'COMPLETE' | 'LOCAL_ONLY' | 'INCOMPLETE' | 'FAILED';
export interface SetStatus {
  setId: string;
  state: SetState;
  verified: boolean;
  verifiedAt: string | null;
  offhost: 'COPIED' | 'FAILED' | 'NOT_CONFIGURED' | 'NOT_REQUIRED';
  reason: string | null;
  updatedAt: string;
}

export interface BackupConfig {
  backupDir: string;
  databaseUrl: string;
  documentsRoot: string | null; // null = document center disabled
  applicationVersion: string | null;
  retainCount: number;
  offhost: { command: string | null; verifyCommand: string | null; required: boolean; timeoutMs: number };
  isProduction: boolean;
}

export class BackupError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/** Reads the operational configuration. Secrets (off-host credentials) are never read here — only passed through. */
export function backupConfigFromEnv(source: NodeJS.ProcessEnv, app: { databaseUrl: string; documentsRoot: string | null; applicationVersion: string | null; isProduction: boolean; defaultBackupDir: string }): BackupConfig {
  const dir = source.BACKUP_DIR?.trim();
  if (!dir && app.isProduction) throw new BackupError('BACKUP_DIR_REQUIRED', 'BACKUP_DIR is required in production');
  const retain = Number(source.BACKUP_RETAIN_COUNT ?? 7);
  if (!Number.isInteger(retain) || retain < 1 || retain > 1000) throw new BackupError('BACKUP_CONFIG_INVALID', 'BACKUP_RETAIN_COUNT must be a whole number between 1 and 1000');
  const timeout = Number(source.BACKUP_OFFHOST_TIMEOUT_SECONDS ?? 3600);
  if (!Number.isFinite(timeout) || timeout < 10) throw new BackupError('BACKUP_CONFIG_INVALID', 'BACKUP_OFFHOST_TIMEOUT_SECONDS must be at least 10');
  const requiredRaw = source.BACKUP_OFFHOST_REQUIRED?.trim().toLowerCase();
  if (requiredRaw && !['true', 'false'].includes(requiredRaw)) throw new BackupError('BACKUP_CONFIG_INVALID', 'BACKUP_OFFHOST_REQUIRED must be true or false');
  const command = source.BACKUP_OFFHOST_COMMAND?.trim() || null;
  const verifyCommand = source.BACKUP_OFFHOST_VERIFY_COMMAND?.trim() || null;
  for (const [name, value] of [['BACKUP_OFFHOST_COMMAND', command], ['BACKUP_OFFHOST_VERIFY_COMMAND', verifyCommand]] as const) {
    if (value && !path.isAbsolute(value)) throw new BackupError('BACKUP_CONFIG_INVALID', `${name} must be an absolute path to an executable (it is run without a shell)`);
  }
  const required = requiredRaw ? requiredRaw === 'true' : app.isProduction;
  if (command && !verifyCommand && required) throw new BackupError('BACKUP_CONFIG_INVALID', 'BACKUP_OFFHOST_VERIFY_COMMAND is required with BACKUP_OFFHOST_COMMAND: an upload is only trusted once the copy is confirmed');
  return {
    backupDir: path.resolve(dir || app.defaultBackupDir),
    databaseUrl: app.databaseUrl,
    documentsRoot: app.documentsRoot,
    applicationVersion: app.applicationVersion,
    retainCount: retain,
    offhost: { command, verifyCommand, required, timeoutMs: timeout * 1000 },
    isProduction: app.isProduction,
  };
}

export const setIdFor = (d: Date) => `${SET_PREFIX}${d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

/** Copies one file, hashing on the way, owner-only. Refuses to overwrite. */
async function copyHashed(from: string, to: string): Promise<{ sha256: string; size: number }> {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let size = 0;
  const src = createReadStream(from);
  src.on('data', (c: string | Buffer) => { hash.update(c); size += c.length; });
  await pipeline(src, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
  return { sha256: hash.digest('hex'), size };
}

/** Every regular file under `dir`, as POSIX-style paths relative to `base`. Symlinks are not followed. */
export async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** Objects of the store: `documents/<2 hex>/<uuid>`. Upload temp files and readiness probes are not objects. */
const OBJECT_KEY = /^documents\/[0-9a-f]{2}\/[0-9a-f-]{36}$/;

const writeJson = async (file: string, value: unknown) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
};
export const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

async function writeStatus(setDir: string, status: Omit<SetStatus, 'updatedAt'>) {
  await writeJson(path.join(setDir, 'status.json'), { ...status, updatedAt: new Date().toISOString() });
}

/** Runs an operator-provided executable without a shell. Its arguments carry no secret; its environment is inherited. */
async function runHook(binary: string, setDir: string, setId: string, sumsSha: string, timeoutMs: number) {
  await execFileAsync(binary, [setDir, setId], {
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, BACKUP_SET_DIR: setDir, BACKUP_SET_ID: setId, BACKUP_SHA256SUMS_SHA256: sumsSha },
  });
}

export interface VerifyReport { ok: boolean; setId: string; files: number; problems: string[] }

/**
 * Verifies a set on disk without restoring it: SHA256SUMS covers exactly the files present (no missing, no extra),
 * every checksum matches, the manifest agrees with the contents, and pg_restore can read the dump's table of contents
 * (a truncated or corrupted custom-format dump fails here).
 */
export async function verifyBackupSet(setDir: string): Promise<VerifyReport> {
  const setId = path.basename(setDir);
  const problems: string[] = [];
  let files = 0;
  try {
    const sumsText = await readFile(path.join(setDir, 'SHA256SUMS'), 'utf8').catch(() => { throw new BackupError('BACKUP_SET_INVALID', 'SHA256SUMS is missing'); });
    const listed = new Map<string, string>();
    for (const line of sumsText.split('\n').filter(Boolean)) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!m || m[2]!.includes('..') || path.isAbsolute(m[2]!)) { problems.push('SHA256SUMS contains an invalid line'); continue; }
      listed.set(m[2]!, m[1]!);
    }
    const present = (await listFiles(setDir)).filter((f) => f !== 'SHA256SUMS' && f !== 'status.json');
    for (const f of present) if (!listed.has(f)) problems.push(`unlisted file in set: ${f}`);
    for (const [f, expected] of listed) {
      const actual = await sha256File(path.join(setDir, f)).catch(() => null);
      if (actual === null) problems.push(`missing file: ${f}`);
      else if (actual !== expected) problems.push(`checksum mismatch: ${f}`);
      else files += 1;
    }
    const manifest = await readJson<BackupSetManifest>(path.join(setDir, 'manifest.json')).catch(() => null);
    if (!manifest) problems.push('manifest.json is missing or unreadable');
    else {
      if (manifest.setId !== setId) problems.push(`manifest setId ${manifest.setId} does not match the directory ${setId}`);
      if (manifest.formatVersion !== BACKUP_SET_FORMAT) problems.push(`unsupported set format ${manifest.formatVersion}`);
      const dump = await stat(path.join(setDir, 'database.dump')).catch(() => null);
      if (!dump || dump.size === 0) problems.push('database.dump is missing or empty');
      else if (dump.size !== manifest.database.sizeBytes) problems.push('database.dump size differs from the manifest');
      if (manifest.documents.enabled) {
        const objects = [...listed.keys()].filter((f) => f.startsWith('documents/'));
        if (objects.length !== manifest.documents.files) problems.push(`document count ${objects.length} differs from the manifest (${manifest.documents.files})`);
        if (manifest.documents.files < manifest.documents.referencedVersions - manifest.documents.missingReferenced) problems.push('fewer document objects than versions referenced by the database');
      }
      if (dump && dump.size > 0) {
        try { await runTool(findPgTool('pg_restore'), ['--list', path.join(setDir, 'database.dump')], process.env); }
        catch { problems.push('database.dump is not a readable PostgreSQL custom-format archive'); }
      }
    }
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return { ok: problems.length === 0, setId, files, problems };
}

export interface BackupOutcome {
  ok: boolean;
  setId: string;
  setDir: string | null;
  state: SetState | null;
  reason: string | null;
  manifest: BackupSetManifest | null;
  durationMs: number;
  deleted: string[];
}

/**
 * One command, one recovery set: dump → documents → cross-check → manifest/checksums → verify → off-host → retention.
 * Any failure is a non-success outcome (the CLI exits non-zero); `last-success.json` moves only on full success.
 */
export async function createBackupSet(cfg: BackupConfig, now = new Date()): Promise<BackupOutcome> {
  const started = Date.now();
  const setId = setIdFor(now);
  const finalDir = path.join(cfg.backupDir, setId);
  const partialDir = `${finalDir}.partial`;
  const conn = parseConnection(cfg.databaseUrl);
  const outcome = (o: Partial<BackupOutcome>): BackupOutcome => ({ ok: false, setId, setDir: null, state: null, reason: null, manifest: null, durationMs: Date.now() - started, deleted: [], ...o });
  const attempt = async (ok: boolean, reason: string | null, state: SetState | null) =>
    writeJson(path.join(cfg.backupDir, 'last-attempt.json'), { setId, at: new Date().toISOString(), ok, state, reason }).catch(() => undefined);

  opsLog('backup_started', { setId, target: safeTarget(conn), documents: cfg.documentsRoot ? 'enabled' : 'disabled', offhost: cfg.offhost.command ? 'configured' : 'not_configured' });
  let prisma: PrismaClient | null = null;
  try {
    await mkdir(cfg.backupDir, { recursive: true, mode: 0o700 });
    if (await stat(finalDir).catch(() => null)) throw new BackupError('BACKUP_SET_EXISTS', `${setId} already exists`);
    await mkdir(partialDir, { recursive: false, mode: 0o700 });

    // 1. database (the snapshot instant is the start of pg_dump)
    const pgDump = findPgTool('pg_dump');
    const [clientVersion, server] = [await toolVersion(pgDump), await serverVersion(conn)];
    assertToolCompatible(clientVersion, server);
    const snapshotAt = new Date();
    const dumpPath = path.join(partialDir, 'database.dump');
    try { await runTool(pgDump, ['--format=custom', '--no-password', '--file', dumpPath], libpqEnv(conn)); }
    catch { throw new BackupError('DATABASE_DUMP_FAILED', 'pg_dump failed (see the PostgreSQL server log; credentials are not printed)'); }
    await chmod(dumpPath, 0o600);
    const dumpSize = (await stat(dumpPath)).size;
    if (dumpSize === 0) throw new BackupError('DATABASE_DUMP_FAILED', 'pg_dump produced an empty file');
    let latestMigration: string | null = null;
    let migrationCount: number | null = null;
    try {
      const { stdout } = await runTool(findPgTool('psql'), ['-Atqc', "SELECT count(*), coalesce(max(migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL"], libpqEnv(conn));
      const [count, name] = stdout.trim().split('|');
      migrationCount = Number(count);
      latestMigration = name || null;
    } catch { /* no migration history: recorded as null */ }

    // 2. documents, copied after the snapshot (see the consistency model above)
    let documents: BackupSetManifest['documents'] = { enabled: false };
    const copied = new Map<string, string>(); // key → sha256
    let docBytes = 0;
    if (cfg.documentsRoot) {
      const root = await stat(cfg.documentsRoot).catch(() => null);
      if (!root?.isDirectory()) throw new BackupError('DOCUMENT_BACKUP_FAILED', 'the document storage root is missing or not a directory');
      let keys: string[];
      try { keys = (await listFiles(cfg.documentsRoot)).filter((k) => OBJECT_KEY.test(k)); }
      catch { throw new BackupError('DOCUMENT_BACKUP_FAILED', 'the document storage root cannot be read'); }
      for (const key of keys) {
        try {
          const r = await copyHashed(path.join(cfg.documentsRoot, key), path.join(partialDir, key));
          copied.set(key, r.sha256);
          docBytes += r.size;
        } catch {
          throw new BackupError('DOCUMENT_BACKUP_FAILED', `a stored object could not be copied (${key})`);
        }
      }
      // 3. cross-check against what the database referenced at the snapshot instant
      prisma = new PrismaClient({ datasourceUrl: cfg.databaseUrl });
      const versions = await prisma.documentVersion.findMany({ where: { uploadedAt: { lte: snapshotAt } }, select: { storageKey: true, sha256: true } });
      let missing = 0;
      let mismatch = 0;
      for (const v of versions) {
        const got = copied.get(v.storageKey);
        if (!got) missing += 1;
        else if (got !== v.sha256) mismatch += 1;
      }
      documents = { enabled: true, directory: 'documents', files: copied.size, bytes: docBytes, referencedVersions: versions.length, missingReferenced: missing, checksumMismatch: mismatch };
    }

    // 4. manifest + checksums
    const manifest: BackupSetManifest = {
      formatVersion: BACKUP_SET_FORMAT,
      setId,
      createdAt: new Date().toISOString(),
      databaseSnapshotStartedAt: snapshotAt.toISOString(),
      applicationVersion: cfg.applicationVersion,
      database: { file: 'database.dump', sizeBytes: dumpSize, sha256: await sha256File(dumpPath), postgresServerVersion: server, pgDumpVersion: clientVersion, latestMigration, migrationCount },
      documents,
      consistency: 'Database snapshot at databaseSnapshotStartedAt; documents copied afterwards. Referenced objects are immutable, so every object referenced by the dump is in the set; objects uploaded after the snapshot may also be present (unreferenced after restore).',
    };
    await writeJson(path.join(partialDir, 'manifest.json'), manifest);
    const sums: string[] = [];
    for (const f of await listFiles(partialDir)) sums.push(`${await sha256File(path.join(partialDir, f))}  ${f}`);
    await writeFile(path.join(partialDir, 'SHA256SUMS'), `${sums.join('\n')}\n`, { mode: 0o600 });
    await rename(partialDir, finalDir); // only now does a set with a final name exist

    // 5. verify what was written, from disk
    const verify = await verifyBackupSet(finalDir);
    if (!verify.ok) {
      await writeStatus(finalDir, { setId, state: 'FAILED', verified: false, verifiedAt: null, offhost: 'NOT_CONFIGURED', reason: `VERIFY_FAILED: ${verify.problems[0]}` });
      throw new BackupError('BACKUP_VERIFY_FAILED', verify.problems.join('; '));
    }
    const verifiedAt = new Date().toISOString();
    if (documents.enabled && (documents.missingReferenced > 0 || documents.checksumMismatch > 0)) {
      // The database is in the set, but the set is not a complete recovery set: kept for the operator, never "success".
      const reason = `DOCUMENT_REFERENCES_MISSING: ${documents.missingReferenced} referenced object(s) missing, ${documents.checksumMismatch} with a different checksum in the live store (run ops:integrity)`;
      await writeStatus(finalDir, { setId, state: 'INCOMPLETE', verified: true, verifiedAt, offhost: 'NOT_CONFIGURED', reason });
      throw new BackupError('DOCUMENT_REFERENCES_MISSING', reason);
    }

    // 6. off-host copy, confirmed by the operator's verify hook
    const sumsSha = await sha256File(path.join(finalDir, 'SHA256SUMS'));
    let offhost: SetStatus['offhost'] = cfg.offhost.required ? 'NOT_CONFIGURED' : 'NOT_REQUIRED';
    if (cfg.offhost.command) {
      try {
        await runHook(cfg.offhost.command, finalDir, setId, sumsSha, cfg.offhost.timeoutMs);
        if (cfg.offhost.verifyCommand) await runHook(cfg.offhost.verifyCommand, finalDir, setId, sumsSha, cfg.offhost.timeoutMs);
        offhost = 'COPIED';
        opsLog('offhost_copy_succeeded', { setId, verifiedRemotely: !!cfg.offhost.verifyCommand, command: path.basename(cfg.offhost.command) });
      } catch (e) {
        offhost = 'FAILED';
        const exit = (e as { code?: unknown }).code;
        opsLog('offhost_copy_failed', { setId, command: path.basename(cfg.offhost.command), exitCode: typeof exit === 'number' ? exit : null, timedOut: (e as { killed?: boolean }).killed === true });
      }
    }
    if (offhost === 'FAILED' || offhost === 'NOT_CONFIGURED') {
      const reason = offhost === 'FAILED' ? 'OFFHOST_COPY_FAILED: the local set is verified, the off-host copy was not confirmed' : 'OFFHOST_NOT_CONFIGURED: an off-host copy is required (BACKUP_OFFHOST_COMMAND) — a backup on this host alone does not survive the host';
      await writeStatus(finalDir, { setId, state: 'LOCAL_ONLY', verified: true, verifiedAt, offhost, reason });
      throw new BackupError(offhost === 'FAILED' ? 'OFFHOST_COPY_FAILED' : 'OFFHOST_NOT_CONFIGURED', reason);
    }

    // 7. success: record freshness, then (and only then) apply retention
    await writeStatus(finalDir, { setId, state: 'COMPLETE', verified: true, verifiedAt, offhost, reason: null });
    await writeJson(path.join(cfg.backupDir, 'last-success.json'), {
      setId, completedAt: new Date().toISOString(), verified: true, offhost,
      databaseBytes: dumpSize, documentFiles: documents.enabled ? documents.files : null,
    });
    const deleted = await applyRetention(cfg.backupDir, cfg.retainCount);
    await attempt(true, null, 'COMPLETE');
    const durationMs = Date.now() - started;
    opsLog('backup_succeeded', { setId, durationMs, databaseBytes: dumpSize, documentFiles: documents.enabled ? documents.files : null, documentBytes: documents.enabled ? documents.bytes : null, offhost, retentionDeleted: deleted.length });
    return { ok: true, setId, setDir: finalDir, state: 'COMPLETE', reason: null, manifest, durationMs, deleted };
  } catch (e) {
    const err = e instanceof BackupError ? e : new BackupError('BACKUP_FAILED', e instanceof Error ? e.message : String(e));
    await rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
    const kept = await stat(finalDir).catch(() => null);
    const state = kept ? (await readJson<SetStatus>(path.join(finalDir, 'status.json')).catch(() => null))?.state ?? 'FAILED' : null;
    await attempt(false, err.code, state);
    opsLog('backup_failed', { setId, reason: err.code, detail: err.message.slice(0, 300), keptLocalSet: !!kept, state, durationMs: Date.now() - started });
    return outcome({ setDir: kept ? finalDir : null, state, reason: err.message });
  } finally {
    await prisma?.$disconnect().catch(() => undefined);
  }
}

/**
 * Keep the newest `keep` COMPLETE sets; delete older COMPLETE sets, and non-complete sets / stale partials that are older
 * than the oldest set kept. Runs only after a successful backup, so the newest set is always a verified COMPLETE one —
 * the only valid backup is never deleted. Remote copies follow the provider's own lifecycle rules (documented).
 */
export async function applyRetention(backupDir: string, keep: number): Promise<string[]> {
  if (keep < 1) throw new BackupError('BACKUP_CONFIG_INVALID', 'retention must keep at least one set');
  const entries = (await readdir(backupDir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith(SET_PREFIX));
  const sets: { name: string; state: SetState | 'PARTIAL' }[] = [];
  for (const e of entries) {
    if (e.name.endsWith('.partial')) { sets.push({ name: e.name, state: 'PARTIAL' }); continue; }
    if (!SET_NAME.test(e.name)) continue;
    const s = await readJson<SetStatus>(path.join(backupDir, e.name, 'status.json')).catch(() => null);
    sets.push({ name: e.name, state: s?.state ?? 'FAILED' });
  }
  const byNewest = (a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name);
  const complete = sets.filter((s) => s.state === 'COMPLETE').sort(byNewest);
  if (complete.length === 0) return []; // nothing valid yet: delete nothing
  const kept = complete.slice(0, keep);
  const oldestKept = kept[kept.length - 1]!.name;
  const doomed = [
    ...complete.slice(keep).map((s) => s.name),
    ...sets.filter((s) => s.state !== 'COMPLETE' && s.name.replace(/\.partial$/, '') < oldestKept).map((s) => s.name),
  ];
  for (const name of doomed) {
    await rm(path.join(backupDir, name), { recursive: true, force: true });
    opsLog('backup_retention_deleted', { set: name });
  }
  return doomed;
}

export interface Freshness { ok: boolean; setId: string | null; completedAt: string | null; ageHours: number | null; reason: string | null }
/** "When was the last verified successful backup?" — answered from `last-success.json` (metadata only). */
export async function backupFreshness(backupDir: string, maxAgeHours: number, now = new Date()): Promise<Freshness> {
  const last = await readJson<{ setId: string; completedAt: string; verified: boolean }>(path.join(backupDir, 'last-success.json')).catch(() => null);
  if (!last?.completedAt || !last.verified) return { ok: false, setId: null, completedAt: null, ageHours: null, reason: 'NO_SUCCESSFUL_BACKUP' };
  const ageHours = (now.getTime() - Date.parse(last.completedAt)) / 3_600_000;
  const setPresent = !!(await stat(path.join(backupDir, last.setId)).catch(() => null));
  if (!setPresent) return { ok: false, setId: last.setId, completedAt: last.completedAt, ageHours, reason: 'LAST_SET_MISSING' };
  return { ok: ageHours <= maxAgeHours, setId: last.setId, completedAt: last.completedAt, ageHours: Math.round(ageHours * 10) / 10, reason: ageHours <= maxAgeHours ? null : 'BACKUP_STALE' };
}

export type { PgConnection };
