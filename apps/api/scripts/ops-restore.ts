/**
 * `npm run ops:restore -- <set dir> --database <new_db> --documents <empty dir>` — canonical restore into a NEW database
 * and an EMPTY document directory (migrate, revoke sessions + reset tokens, verify). Nothing existing is overwritten.
 * `npm run ops:restore -- <set dir> --verify-only` — the same into throwaway targets that are removed afterwards
 * (the restore drill; safe to schedule).
 */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { restoreBackupSet } from './lib/restore-set';
import { opsContext, ownerOnly, protectedTargets } from './lib/ops-context';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const setDir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--database' && args[args.indexOf(a) - 1] !== '--documents');
const verifyOnly = args.includes('--verify-only');
if (!setDir || (!verifyOnly && (!flag('--database') || !flag('--documents')))) {
  // eslint-disable-next-line no-console
  console.error('Usage:\n  npm run ops:restore -- <set dir> --database <new_database> --documents <empty directory>\n  npm run ops:restore -- <set dir> --verify-only');
  process.exit(2);
}
ownerOnly();
const t = protectedTargets();
restoreBackupSet({ setDir, sourceDatabaseUrl: opsContext().databaseUrl, targetDatabase: flag('--database'), targetDocumentsDir: flag('--documents'), verifyOnly, forbiddenDatabases: t.databases, forbiddenDirectories: t.directories })
  .then((r) => {
    /* eslint-disable no-console */
    console.log(`${verifyOnly ? 'Restore drill' : 'Restore'} of ${r.setId} succeeded in ${(r.durationMs / 1000).toFixed(1)}s: ${r.counts.employees} employees, ${r.counts.documentVersions} document versions, ${r.migrationsAfter} migrations; ${r.sessionsRevoked} session(s) and ${r.resetTokensRevoked} reset token(s) revoked.`);
    if (r.integrity.warnings.length) console.log(`Warnings: ${r.integrity.warnings.join('; ')}`);
    if (r.integrity.failures.length) console.log(`Integrity findings carried over from the source (reconcile by hand): ${r.integrity.failures.join('; ')}`);
    if (!verifyOnly) console.log(`Next: point DATABASE_URL at database "${r.targetDatabase}" and DOCUMENT_STORAGE_DIR at the restored directory, then start the API and run npm run ops:monitor-check.`);
    /* eslint-enable no-console */
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('RESTORE_FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
