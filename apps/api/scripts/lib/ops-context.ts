import path from 'node:path';
import { env } from '../../src/config/env';
import { documentStorageRoot } from '../../src/modules/documents/storage';
import { backupConfigFromEnv, type BackupConfig } from './backup-set';
import { parseConnection } from './pg-tools';

/**
 * The configuration every ops command shares, taken from the application's own validated settings (so `ENV_FILE`,
 * NODE_ENV and DOCUMENT_STORAGE_DIR mean exactly what they mean for the running API). Nothing here is printed.
 */
export const opsContext = () => ({
  env,
  databaseUrl: env.databaseUrl,
  documentsRoot: documentStorageRoot(),
  isProduction: env.isProduction,
});

export function backupConfig(): BackupConfig {
  const c = opsContext();
  return backupConfigFromEnv(process.env, { databaseUrl: c.databaseUrl, documentsRoot: c.documentsRoot, applicationVersion: env.APP_VERSION ?? null, isProduction: c.isProduction, defaultBackupDir: path.resolve(__dirname, '../../backups') });
}

const databaseOf = (url: string | undefined) => { try { return url ? parseConnection(url).database : ''; } catch { return ''; } };
/** Databases and directories a restore must never target. */
export const protectedTargets = () => ({
  databases: [databaseOf(env.DATABASE_URL), databaseOf(env.TEST_DATABASE_URL), databaseOf(env.databaseUrl), 'postgres', 'template0', 'template1'].filter(Boolean),
  directories: [documentStorageRoot()].filter((d): d is string => !!d),
});

/** Every ops command writes owner-only files, whatever the caller's umask. */
export const ownerOnly = () => process.umask(0o077);
