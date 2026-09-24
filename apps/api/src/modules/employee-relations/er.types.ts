import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for employee relations.
 *
 * What somebody is said to have done, and what was written to them about it, is the most sensitive text this system
 * holds. It lives in exactly two tables — the case and the issued letter — and never reaches an audit payload: the
 * log records that a narrative changed, who changed it and when, and the text stays behind its own authorization.
 */
export const erAudit = (
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
  module: 'employee_relations' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});

/** What an audit entry may say about a narrative: that it changed, and how long it is now. Never the text. */
export const narrativeAudit = (field: string, before: string | null | undefined, after: string | null | undefined) =>
  (before ?? null) === (after ?? null) ? {} : { [`${field}Changed`]: true, [`${field}Length`]: after?.length ?? 0 };
