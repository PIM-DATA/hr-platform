/**
 * `npm run ops:integrity [-- --deep]` — documents ↔ database and financial handoff integrity. Report only: nothing is
 * repaired or deleted. Exit 1 on any failure (missing / mismatched objects, broken handoffs); orphans are warnings.
 */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { PrismaClient } from '@prisma/client';
import { runIntegrity } from './lib/integrity';
import { opsContext } from './lib/ops-context';
import { opsLog } from './lib/pg-tools';

async function main() {
  const c = opsContext();
  const prisma = new PrismaClient({ datasourceUrl: c.databaseUrl });
  try {
    const r = await runIntegrity(prisma, c.documentsRoot, { deep: process.argv.includes('--deep') });
    opsLog(r.ok ? 'integrity_check_ok' : 'integrity_check_failed', { documents: r.documents && { versions: r.documents.versions, objects: r.documents.objects, missing: r.documents.missing, sizeMismatch: r.documents.sizeMismatch, checksumMismatch: r.documents.checksumMismatch, orphans: r.documents.orphans, deep: r.documents.deep }, financial: r.financial, failures: r.failures, warnings: r.warnings });
    /* eslint-disable no-console */
    console.log(r.ok ? 'Integrity OK.' : `INTEGRITY_FAILED:\n - ${r.failures.join('\n - ')}`);
    if (r.warnings.length) console.log(`Warnings:\n - ${r.warnings.join('\n - ')}`);
    if (r.documents?.samples.missing.length) console.log(`Document version ids without their object (first ${r.documents.samples.missing.length}): ${r.documents.samples.missing.join(', ')}`);
    if (r.financial.samples.length) console.log(`Financial records to reconcile (first ${r.financial.samples.length}): ${r.financial.samples.join(', ')}`);
    /* eslint-enable no-console */
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((err) => {
  opsLog('integrity_check_failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
