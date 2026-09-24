import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for training and development.
 *
 * Development comments — what an employee wrote about their own progress, what their manager thinks, what HR noted —
 * are among the most sensitive text in the system. The log records that they changed and who changed them; the words
 * stay on the record, behind its own authorization.
 */
export const trainingAudit = (
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
  module: 'training' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});

/** What an audit entry may say about a comment: that it changed, and how long it is. Never the text. */
export const commentAudit = (before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? undefined : { commentChanged: true, length: after?.length ?? 0 };
