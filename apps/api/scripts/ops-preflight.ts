/**
 * `npm run ops:preflight` — run before deploying a new release (and after a restore). Non-mutating.
 * Checks: database reachable; migration history (failed migrations, or migrations unknown to this release = FAIL;
 * pending ones are listed — `npm run db:deploy` applies them); document storage usable; integrity (documents +
 * financial handoff). Exit 1 when anything must be resolved by the operator first.
 */
// Must be the first import: it loads ENV_FILE. @prisma/client loads apps/api/.env when it is imported, and the first
// loader wins — an ops command would otherwise silently act on the repository's .env database (found in the Task 49 drill).
import '../src/config/env';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { LocalFileDocumentStorage } from '../src/modules/documents/storage';
import { runIntegrity } from './lib/integrity';
import { opsContext } from './lib/ops-context';
import { opsLog } from './lib/pg-tools';

async function main() {
  const c = opsContext();
  const failures: string[] = [];
  const info: Record<string, unknown> = {};
  const prisma = new PrismaClient({ datasourceUrl: c.databaseUrl });
  try {
    try { await prisma.$queryRaw`SELECT 1`; info.database = 'ok'; } catch { failures.push('DATABASE_UNREACHABLE'); throw new Error('stop'); }

    const shipped = (await readdir(path.resolve(__dirname, '../prisma/migrations'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const rows = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`.catch(() => []);
    const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    const unknown = [...applied].filter((m) => !shipped.includes(m));
    const pending = shipped.filter((m) => !applied.has(m));
    info.migrations = { shipped: shipped.length, applied: applied.size, pending, failed, unknown };
    if (failed.length) failures.push(`MIGRATION_FAILED: ${failed.join(', ')}`);
    if (unknown.length) failures.push(`MIGRATION_UNKNOWN_TO_THIS_RELEASE: ${unknown.join(', ')} (the database is newer than this code)`);

    if (c.documentsRoot) {
      const hasDocuments = !!(await prisma.documentVersion.findFirst({ select: { id: true } }).catch(() => null));
      const h = await new LocalFileDocumentStorage(c.documentsRoot).health(hasDocuments);
      info.documentStorage = h.ok ? 'ok' : h.reason;
      if (!h.ok) failures.push(`DOCUMENT_STORAGE_${h.reason}`);
    } else info.documentStorage = 'disabled';

    if (!pending.length) {
      const r = await runIntegrity(prisma, c.documentsRoot);
      info.integrity = { failures: r.failures, warnings: r.warnings };
      failures.push(...r.failures);
    } else {
      info.integrity = 'skipped until pending migrations are applied';
    }
  } catch (e) {
    if (!(e instanceof Error && e.message === 'stop')) failures.push(`PREFLIGHT_ERROR: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
  opsLog(failures.length ? 'preflight_failed' : 'preflight_ok', { ...info, failures });
  // eslint-disable-next-line no-console
  console.log(failures.length ? `PREFLIGHT_FAILED:\n - ${failures.join('\n - ')}` : 'Preflight OK.');
  process.exit(failures.length ? 1 : 0);
}
void main();
