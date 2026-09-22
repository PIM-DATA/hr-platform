import { APPROVER_TYPES, UNRESOLVED_REASONS } from '@hr/shared';
import type { Tx } from './workflow.types';

export interface ResolvedApprover {
  approverEmployeeId: string | null;
  approverUserId: string;
}
export type ResolveResult = { ok: true; approver: ResolvedApprover } | { ok: false; reason: string };

interface RequesterContext {
  employeeId: string;
  managerId: string | null;
  departmentHeadEmployeeId: string | null;
}

/** An approver is usable only when the employee (if any) is ACTIVE and has an active login account. */
async function approverFromEmployee(tx: Tx, employeeId: string): Promise<ResolveResult> {
  const emp = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, employmentStatus: true, user: { select: { id: true, isActive: true } } } });
  if (!emp) return { ok: false, reason: UNRESOLVED_REASONS.USER_NOT_FOUND };
  if (emp.employmentStatus !== 'ACTIVE') return { ok: false, reason: UNRESOLVED_REASONS.EMPLOYEE_INACTIVE };
  if (!emp.user) return { ok: false, reason: UNRESOLVED_REASONS.NO_USER_ACCOUNT };
  if (!emp.user.isActive) return { ok: false, reason: UNRESOLVED_REASONS.USER_INACTIVE };
  return { ok: true, approver: { approverEmployeeId: emp.id, approverUserId: emp.user.id } };
}

/**
 * Resolves the approver for one definition step from the requester's CURRENT organization data.
 * Called only at submit time; the result is snapshotted on the instance step.
 * The client never influences this — it only sends business data.
 */
export async function resolveApprover(
  tx: Tx,
  step: { approverType: string; approverUserId: string | null },
  requester: RequesterContext,
): Promise<ResolveResult> {
  switch (step.approverType) {
    case APPROVER_TYPES.DIRECT_MANAGER:
      if (!requester.managerId) return { ok: false, reason: UNRESOLVED_REASONS.NO_MANAGER };
      return approverFromEmployee(tx, requester.managerId);
    case APPROVER_TYPES.DEPARTMENT_HEAD:
      if (!requester.departmentHeadEmployeeId) return { ok: false, reason: UNRESOLVED_REASONS.NO_DEPARTMENT_HEAD };
      return approverFromEmployee(tx, requester.departmentHeadEmployeeId);
    case APPROVER_TYPES.SPECIFIC_USER: {
      if (!step.approverUserId) return { ok: false, reason: UNRESOLVED_REASONS.USER_NOT_FOUND };
      const user = await tx.user.findUnique({ where: { id: step.approverUserId }, select: { id: true, isActive: true, employeeId: true } });
      if (!user) return { ok: false, reason: UNRESOLVED_REASONS.USER_NOT_FOUND };
      if (!user.isActive) return { ok: false, reason: UNRESOLVED_REASONS.USER_INACTIVE };
      return { ok: true, approver: { approverEmployeeId: user.employeeId, approverUserId: user.id } };
    }
    default:
      // ROLE / approver groups are not supported yet (definitions with them cannot be activated)
      return { ok: false, reason: UNRESOLVED_REASONS.USER_NOT_FOUND };
  }
}
