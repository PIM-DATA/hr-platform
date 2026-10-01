/**
 * `npm run ops:backup` — one complete recovery set: database + documents + manifest + checksums, verified, copied
 * off-host, then retention. Exit 0 only when all of it succeeded (see docs/backup-restore.md). Every failure path exits
 * non-zero so the scheduler (systemd timer / cron) can alert on it.
 */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { createBackupSet } from './lib/backup-set';
import { backupConfig, ownerOnly } from './lib/ops-context';
import { opsLog } from './lib/pg-tools';

async function main() {
  ownerOnly();
  const result = await createBackupSet(backupConfig());
  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log(`Backup set ${result.setId} complete (${(result.durationMs / 1000).toFixed(1)}s); retention removed ${result.deleted.length} old set(s).`);
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error(`BACKUP_FAILED: ${result.reason}${result.setDir ? ` (local set kept as ${result.state})` : ''}`);
  process.exit(1);
}
main().catch((err) => {
  opsLog('backup_failed', { reason: 'BACKUP_CONFIG', detail: err instanceof Error ? err.message : String(err) });
  // eslint-disable-next-line no-console
  console.error('BACKUP_FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
