import { AppError } from '../../lib/errors';
import type { AuthContext } from '../../modules/auth/auth.types';

/**
 * Task 51 (T44-P1-19) — subject ≠ actor, maker ≠ checker.
 *
 * "Self" is the employee record linked to the session's user — server-owned, never taken from the request, and an
 * administrator cannot re-link their own account (users.service). These rules are business rules on top of RBAC: no
 * permission, role name or data scope lifts them, and there is no emergency bypass. An organization with a single
 * authorized administrator gets a clear refusal for changes about that administrator; a second authorized person is the
 * documented minimum (docs/payroll.md, docs/compensation-planning.md).
 */
export const isSelf = (auth: Pick<AuthContext, 'employeeId'>, employeeId: string | null | undefined): boolean =>
  !!auth.employeeId && !!employeeId && auth.employeeId === employeeId;

/** A financial record (salary, recurring pay, adjustment, salary proposal, applied raise) about the actor themselves. */
export function assertNotSelfFinancial(auth: Pick<AuthContext, 'employeeId'>, employeeId: string | null | undefined, what: string): void {
  if (isSelf(auth, employeeId)) {
    throw new AppError(403, 'FINANCIAL_SELF_BENEFIT_NOT_ALLOWED', `You cannot ${what} about yourself. Another authorized administrator must do it.`);
  }
}

export const makerCheckerConflict = (what: string) =>
  new AppError(409, 'MAKER_CHECKER_CONFLICT', `You set this ${what} yourself; another authorized reviewer must approve it.`);
