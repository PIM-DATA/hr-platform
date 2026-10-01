/** `npm run ops:backup:verify -- <set directory>` — checksums, manifest, readable dump. Exit 1 on any problem. */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { verifyBackupSet } from './lib/backup-set';
import { opsLog } from './lib/pg-tools';

const dir = process.argv[2];
if (!dir) {
  // eslint-disable-next-line no-console
  console.error('Usage: npm run ops:backup:verify -- <BACKUP_DIR>/hr-backup-YYYYMMDDTHHMMSSZ');
  process.exit(2);
}
verifyBackupSet(dir).then((r) => {
  opsLog(r.ok ? 'backup_verify_succeeded' : 'backup_verify_failed', { setId: r.setId, files: r.files, problems: r.problems.slice(0, 20) });
  // eslint-disable-next-line no-console
  console.log(r.ok ? `Set ${r.setId} verified: ${r.files} file(s), checksums match, dump readable.` : `VERIFY_FAILED ${r.setId}:\n - ${r.problems.join('\n - ')}`);
  process.exit(r.ok ? 0 : 1);
});
