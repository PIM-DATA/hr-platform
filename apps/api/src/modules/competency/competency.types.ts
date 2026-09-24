import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for competency.
 *
 * An assessment comment is a manager's written opinion of somebody's ability. It never reaches the audit payload:
 * the log records that comments were entered and how many, which is what an auditor needs, and the text stays where
 * only the people entitled to read it can find it.
 */
export const competencyAudit = (
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
  module: 'competency' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});
