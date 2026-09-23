import type { Prisma } from '@prisma/client';
import type { AuditAction, AuditModule } from '@hr/shared';
import type { AuthContext } from '../auth/auth.types';

export type Tx = Prisma.TransactionClient;
export type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;
export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/** Audit entry builder for the attendance module — the same shape every other module uses. */
export const attendanceAudit = (
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
  module: 'attendance' as AuditModule,
  recordType,
  recordId,
  oldValue,
  newValue,
});

export const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true, department: { select: { id: true, name: true } } } } as const;
