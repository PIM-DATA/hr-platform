import { payrollPeriodLabel } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';

type Db = Prisma.TransactionClient | typeof import('../../lib/prisma').prisma;

/**
 * Task 48 (T44-P1-16) — once payroll is approved, its inputs stop moving.
 *
 * An APPROVED or CLOSED payroll period is what somebody signed off and what employees are (or were) paid. A source
 * change dated inside it — an attendance day, an overtime or leave approval, a salary record, a recurring pay item —
 * would make that payroll disagree with its sources without anybody noticing, so it is refused here, at the source,
 * with `PAYROLL_PERIOD_LOCKED`. There is no retro-adjustment procedure in this release: a correction belongs in a later
 * period (a manual adjustment), not in history.
 *
 * Two windows exist per period: attendance-type inputs (attendance, overtime, leave) are read from the cut-off window
 * `attendanceFrom..attendanceTo`; salary-type inputs (compensation, recurring items) from `periodStart..periodEnd`.
 *
 * The overlapping period rows are locked `FOR SHARE`: an approval takes the same rows `FOR UPDATE` before comparing the
 * input fingerprint, so a source change and an approval never interleave — whichever commits first, the other sees it.
 * Anything not guarded at its source is still caught when the run is closed (`close` re-checks the fingerprint).
 */
export const PAYROLL_FROZEN_STATUSES = ['APPROVED', 'CLOSED'] as const;

export type PayrollInputBasis = 'ATTENDANCE' | 'PAY';

/** `to = null` means open-ended. Dates are business dates (YYYY-MM-DD), compared as text like everywhere in payroll. */
export async function assertPayrollInputsOpen(db: Db, employeeId: string, window: { from: string; to: string | null }, basis: PayrollInputBasis, what: string): Promise<void> {
  const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { organizationId: true, employeeCode: true } });
  if (!employee) return;
  const to = window.to ?? '9999-12-31';
  const rows = basis === 'ATTENDANCE'
    ? await db.$queryRaw<{ year: number; month: number; status: string }[]>`
        SELECT "year", "month", "status" FROM "payroll_periods"
        WHERE "organization_id" = ${employee.organizationId} AND "attendance_from" <= ${to} AND "attendance_to" >= ${window.from}
        ORDER BY "year", "month" FOR SHARE`
    : await db.$queryRaw<{ year: number; month: number; status: string }[]>`
        SELECT "year", "month", "status" FROM "payroll_periods"
        WHERE "organization_id" = ${employee.organizationId} AND "period_start" <= ${to} AND "period_end" >= ${window.from}
        ORDER BY "year", "month" FOR SHARE`;
  const frozen = rows.find((r) => (PAYROLL_FROZEN_STATUSES as readonly string[]).includes(r.status));
  if (frozen) {
    throw new AppError(409, 'PAYROLL_PERIOD_LOCKED', `${what} for ${employee.employeeCode} falls inside payroll ${payrollPeriodLabel(frozen.year, frozen.month)}, which is ${frozen.status.toLowerCase()}. An approved or closed payroll is not changed after the fact; record the correction in a later period.`);
  }
}

/** The part of a date range whose coverage changes when its end moves from `before` to `after` (null = open). */
export function endDateChangeWindow(before: string | null, after: string | null, addDays: (d: string, n: number) => string): { from: string; to: string | null } | null {
  if (before === after) return null;
  if (before === null) return { from: addDays(after!, 1), to: null };
  if (after === null) return { from: addDays(before, 1), to: null };
  return before < after ? { from: addDays(before, 1), to: after } : { from: addDays(after, 1), to: before };
}
