/**
 * Operational cleanup of spent password-reset tokens (`npm run ops:cleanup-reset-tokens`).
 *
 * Used, revoked and expired rows are security artifacts: they cannot be turned back into a working link (only the
 * hash is stored), but there is no reason to keep them once the operator's retention window has passed. How long that
 * is, is a customer policy decision — hence the flag, with a conservative default and no scheduler.
 */
import { accountService } from '../src/modules/account/account.service';
import { prisma } from '../src/lib/prisma';
import { opsLog } from './lib/pg-tools';

const DEFAULT_DAYS = 30;

async function main() {
  const raw = process.env.RESET_TOKEN_RETENTION_DAYS ?? process.argv[2] ?? String(DEFAULT_DAYS);
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error('cleanup-reset-tokens: retention must be a whole number of days between 1 and 3650');
    process.exit(1);
  }
  const { deleted } = await accountService.cleanupResetTokens(days);
  opsLog('reset_tokens_cleaned', { olderThanDays: days, deleted });
  console.log(`Removed ${deleted} spent password reset token(s) older than ${days} day(s).`);
}

main()
  .catch((err) => {
    opsLog('reset_tokens_cleanup_failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
