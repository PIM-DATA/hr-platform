import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for performance.
 *
 * A review comment is some of the most sensitive text an HR system holds — it is somebody's manager writing about
 * them. It is never copied into an audit payload: the log records *that* a comment changed, who changed it and when,
 * which is what an auditor needs, and the text stays in the one place the people entitled to read it can find it.
 */
export const performanceAudit = (
  actor: Actor,
  action: AuditAction,
  recordType: string,
  recordId: string,
  newValue: unknown,
  oldValue?: unknown,
) => ({
  userId: actor.auth.userId,
  ipAddress: actor.ipAddress,
  userAgent: actor.userAgent,
  action,
  module: 'performance' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});
