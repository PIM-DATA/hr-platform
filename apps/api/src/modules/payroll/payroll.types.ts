import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Audit entries for payroll.
 *
 * Financial data is more sensitive than the rest of the system, so these entries record **what changed and by how
 * much at the level a reviewer needs**, not entire payroll payloads: a run's totals and counts, a compensation's
 * amount (which is the point of the record), an adjustment's amount and reason. Nobody's full payslip is copied into
 * the audit log.
 */
export const payrollAudit = (
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
  module: 'payroll' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});

export const employeeRef = {
  select: { id: true, employeeCode: true, firstName: true, lastName: true, department: { select: { id: true, name: true } } },
} as const;
