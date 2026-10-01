// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env';
import { assertToolCompatible, findPgTool, libpqEnv, opsLog, parseConnection, runTool, safeTarget, serverVersion, toolVersion } from './lib/pg-tools';

/**
 * PostgreSQL backup (`npm run db:backup`).
 *
 * Uses pg_dump's custom format (-Fc): compressed, restorable with pg_restore, and inspectable — never a hand-written
 * SELECT export. pg_dump takes a consistent snapshot of a running database, so the application does not need to stop.
 *
 * Safety properties:
 *  - the password reaches pg_dump through libpq environment variables, never through argv (process lists are public)
 *  - the dump is written to `<name>.dump.partial` and only renamed to `<name>.dump` after it completed and was
 *    checksummed, so a truncated file can never masquerade as a usable backup
 *  - a failure removes the partial file, writes no manifest and exits non-zero (a scheduler can alert on that)
 *  - dump and manifest are chmod 600: a dump contains every HR record in the system
 *
 * The manifest carries no credentials: only what is needed to verify and identify the backup.
 */
const MANIFEST_FORMAT_VERSION = 1;

export interface BackupManifest {
  formatVersion: number;
  createdAt: string;
  applicationVersion: string | null;
  postgresServerVersion: string;
  pgDumpVersion: string;
  databaseName: string;
  backupFilename: string;
  backupSizeBytes: number;
  sha256: string;
  latestMigration: string | null;
  migrationCount: number | null;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

/** `hr-enterprise-YYYYMMDD-HHmmss` — generated here, never taken from user input. */
export function backupBaseName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `hr-enterprise-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Production must name the destination explicitly; development falls back to a git-ignored folder in the repo. */
export function resolveBackupDir(source: NodeJS.ProcessEnv, isProduction: boolean): string {
  const configured = source.BACKUP_DIR?.trim();
  if (configured) return path.resolve(configured);
  if (isProduction) throw new Error('BACKUP_DIR is required in production: set it to the directory that should hold database backups');
  return path.resolve(__dirname, '../backups');
}

export async function runBackup(): Promise<BackupManifest> {
  const started = Date.now();
  // env.databaseUrl is the connection this process is actually configured with (the test database under NODE_ENV=test),
  // so a backup never silently dumps a different database than the one the application is using.
  const conn = parseConnection(env.databaseUrl);
  const dir = resolveBackupDir(process.env, env.isProduction);
  await mkdir(dir, { recursive: true });

  const pgDump = findPgTool('pg_dump');
  const [clientVersion, server] = [await toolVersion(pgDump), await serverVersion(conn)];
  assertToolCompatible(clientVersion, server);

  const base = backupBaseName();
  const finalPath = path.join(dir, `${base}.dump`);
  const partialPath = `${finalPath}.partial`;
  const manifestPath = path.join(dir, `${base}.manifest.json`);
  opsLog('backup_started', { target: safeTarget(conn), directory: dir, pgDumpVersion: clientVersion, serverVersion: server });

  try {
    // --no-password: never prompt; credentials come from the environment. -Fc: custom (restorable) format.
    await runTool(pgDump, ['--format=custom', '--no-password', '--file', partialPath], libpqEnv(conn));
    await chmod(partialPath, 0o600); // an HR dump is readable by its owner only

    const sha256 = await sha256File(partialPath);
    const { size } = await stat(partialPath);
    if (size === 0) throw new Error('pg_dump produced an empty file');

    let latestMigration: string | null = null;
    let migrationCount: number | null = null;
    try {
      const { stdout } = await runTool(findPgTool('psql'), ['-Atqc', 'SELECT count(*), coalesce(max(migration_name), \'\') FROM _prisma_migrations WHERE finished_at IS NOT NULL'], libpqEnv(conn));
      const [count, name] = stdout.trim().split('|');
      migrationCount = Number(count);
      latestMigration = name || null;
    } catch {
      // A database without migration history is still backed up; the manifest simply records nothing for it.
    }

    await rename(partialPath, finalPath); // only now does a file with the final name exist
    const manifest: BackupManifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      applicationVersion: env.APP_VERSION ?? null,
      postgresServerVersion: server,
      pgDumpVersion: clientVersion,
      databaseName: conn.database,
      backupFilename: path.basename(finalPath),
      backupSizeBytes: size,
      sha256,
      latestMigration,
      migrationCount,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);

    opsLog('backup_completed', { file: manifest.backupFilename, sizeBytes: size, durationMs: Date.now() - started, sha256, latestMigration });
    return manifest;
  } catch (err) {
    await rm(partialPath, { force: true }); // never leave a partial dump behind
    opsLog('backup_failed', { error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started });
    throw err;
  }
}

if (require.main === module) {
  runBackup()
    .then((m) => {
      // eslint-disable-next-line no-console
      console.log(`Backup written: ${m.backupFilename} (${(m.backupSizeBytes / 1024 / 1024).toFixed(1)} MB)`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('BACKUP_FAILED:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
