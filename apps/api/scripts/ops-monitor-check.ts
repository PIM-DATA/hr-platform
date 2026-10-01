/**
 * `npm run ops:monitor-check` — exit 0 when the API is up and ready, document storage is usable with free space, and a
 * verified backup is fresh; exit 1 otherwise, naming every failed check (event `monitor_check_failed`). Meant to be run
 * every few minutes by an external scheduler whose job is to page someone on a non-zero exit (docs/operations-monitoring.md).
 */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { PrismaClient } from '@prisma/client';
import { LocalFileDocumentStorage } from '../src/modules/documents/storage';
import { runMonitorChecks } from './lib/monitor';
import { backupConfig, opsContext } from './lib/ops-context';
import { opsLog } from './lib/pg-tools';

async function main() {
  const c = opsContext();
  const num = (name: string, fallback: number) => { const v = Number(process.env[name] ?? fallback); if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`); return v; };
  const skipApi = process.env.MONITOR_SKIP_API === 'true';
  const skipBackup = process.env.MONITOR_SKIP_BACKUP === 'true';
  if (skipBackup && c.isProduction) throw new Error('MONITOR_SKIP_BACKUP is not allowed in production: backup freshness is a required signal');
  const prisma = new PrismaClient({ datasourceUrl: c.databaseUrl });
  try {
    const result = await runMonitorChecks({
      apiBaseUrl: skipApi ? null : (process.env.OPS_CHECK_URL ?? `http://127.0.0.1:${c.env.PORT}`),
      timeoutMs: num('OPS_CHECK_TIMEOUT_MS', 5000),
      documentsRoot: c.documentsRoot,
      storageHealth: c.documentsRoot ? async () => {
        // If the database is down, assume documents exist: an empty root must not look healthy then.
        const hasDocuments = await prisma.documentVersion.findFirst({ select: { id: true } }).then((r) => !!r).catch(() => true);
        return new LocalFileDocumentStorage(c.documentsRoot!).health(hasDocuments);
      } : null,
      backupDir: skipBackup ? null : backupConfig().backupDir,
      maxBackupAgeHours: num('BACKUP_MAX_AGE_HOURS', 26),
      minFreeMb: num('MONITOR_MIN_FREE_MB', 1024),
    });
    const failed = result.checks.filter((x) => !x.ok).map((x) => x.name);
    opsLog(result.ok ? 'monitor_check_ok' : 'monitor_check_failed', { failed, checks: result.checks });
    // eslint-disable-next-line no-console
    console.log(result.ok ? `Monitor check OK (${result.checks.length} checks).` : `MONITOR_CHECK_FAILED: ${failed.join(', ')}`);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
main().catch((err) => {
  opsLog('monitor_check_failed', { failed: ['monitor_config'], error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
