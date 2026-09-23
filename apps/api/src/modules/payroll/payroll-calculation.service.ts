import { createHash } from 'node:crypto';
import {
  LEAVE_REQUEST_STATUS, SYSTEM_PAY_COMPONENTS, calculateLeaveUnits, calculateProration, compareBusinessDate,
  enumerateDates, intersectRanges, type ProrationBasis, type Weekday,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { calendarsService } from '../calendar/calendars.service';
import { parseWorkingDays } from '../calendar/calendars.service';
import { overtimeService } from '../attendance/overtime.service';
import { dec, deriveRates, money, rate, sumMoney, ZERO } from './money';
import { payComponentService } from './payroll-master.service';
import type { Db, Tx } from './payroll.types';

/**
 * The payroll engine: inputs in, payslip lines out.
 *
 * Three properties matter more than anything else here.
 *
 * **Deterministic.** The same inputs produce the same lines, to the satang. Every amount goes through `money()`, every
 * derived rate through `rate()`, and nothing is a JavaScript number.
 *
 * **Snapshotted.** A result records *what it was calculated from* — the compensation row, the overtime request, the
 * leave request, the attendance date, the recurring item — so a payslip can always explain itself, and so changing a
 * salary tomorrow cannot rewrite what was paid yesterday.
 *
 * **Honest about its inputs.** Every source the calculation reads goes into a fingerprint. If any of it changes after
 * the run was calculated, approval is refused until somebody recalculates. Silently approving a stale payroll is the
 * failure mode this whole module exists to prevent.
 *
 * It calculates **no statutory amounts**: no withholding tax, no social security, no provident fund. Those are absent,
 * not approximated.
 */
export interface CalculationInputs {
  periodStart: string;
  periodEnd: string;
  attendanceFrom: string;
  attendanceTo: string;
  currencyCode: string;
  policy: {
    id: string;
    monthlyDivisorDays: Prisma.Decimal;
    dailyWorkHours: Prisma.Decimal;
    newHireProration: string;
    terminationProration: string;
    absenceDeductionEnabled: boolean;
    lateDeductionEnabled: boolean;
  };
}

interface LineDraft {
  componentCode: string;
  componentName: string;
  componentId: string | null;
  type: 'EARNING' | 'DEDUCTION';
  source: 'BASE' | 'RECURRING' | 'OT' | 'ATTENDANCE' | 'LEAVE' | 'MANUAL';
  quantity?: Prisma.Decimal | null;
  rate?: Prisma.Decimal | null;
  multiplier?: Prisma.Decimal | null;
  amount: Prisma.Decimal;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
}

export interface EmployeeCalculation {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  organizationId: string | null;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionTitle: string | null;
  compensationId: string;
  baseSalary: Prisma.Decimal;
  dailyRate: Prisma.Decimal;
  minuteRate: Prisma.Decimal;
  grossPay: Prisma.Decimal;
  totalDeductions: Prisma.Decimal;
  netPay: Prisma.Decimal;
  absentDays: Prisma.Decimal;
  lateMinutes: number;
  unpaidLeaveUnits: Prisma.Decimal;
  approvedOtMinutes: number;
  proratedDays: Prisma.Decimal | null;
  lines: LineDraft[];
}

const componentCache = new Map<string, { id: string; name: string; type: string }>();
async function systemComponent(db: Db, code: string) {
  const cached = componentCache.get(code);
  if (cached) return cached;
  await payComponentService.ensureSystemComponents(db);
  const row = await db.payComponent.findUnique({ where: { code }, select: { id: true, name: true, type: true } });
  if (!row) throw new AppError(500, 'PAY_COMPONENT_NOT_FOUND', `System pay component ${code} is missing`);
  componentCache.set(code, row);
  return row;
}

export const payrollCalculationService = {
  /**
   * Calculates every employee in the population and returns drafts — nothing is written here, so the caller decides
   * what to persist and inside which transaction.
   */
  async calculate(db: Db, employees: EmployeeForPayroll[], inputs: CalculationInputs): Promise<EmployeeCalculation[]> {
    if (employees.length === 0) return [];
    const employeeIds = employees.map((e) => e.id);

    // Everything is loaded in batches, once — a payroll run over a few hundred people must not become a few thousand
    // round trips.
    const [compensations, payItems, overtime, leaveRequests, attendance, calendars] = await Promise.all([
      db.employeeCompensation.findMany({
        where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: inputs.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: inputs.periodStart } }] },
        orderBy: { effectiveFrom: 'asc' },
      }),
      db.employeePayItem.findMany({
        where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: inputs.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: inputs.periodStart } }] },
        include: { component: { select: { id: true, code: true, name: true, type: true, isActive: true } } },
      }),
      // Overtime comes from the Task 21 service, never from raw attendance: the multiplier and the minutes were
      // decided when the claim was approved, and payroll must not form a second opinion about either.
      overtimeService.getApprovedOvertimeForPayroll({ employeeIds, from: inputs.attendanceFrom, to: inputs.attendanceTo }),
      db.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: LEAVE_REQUEST_STATUS.APPROVED,
          startDate: { lte: inputs.attendanceTo },
          endDate: { gte: inputs.attendanceFrom },
        },
        select: {
          id: true, employeeId: true, startDate: true, endDate: true, startPart: true, endPart: true, units: true,
          calendarId: true, leaveType: { select: { code: true, name: true } }, policy: { select: { id: true, name: true, isPaid: true } },
        },
      }),
      db.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, attendanceDate: { gte: inputs.attendanceFrom, lte: inputs.attendanceTo } },
        select: { id: true, employeeId: true, attendanceDate: true, status: true, lateMinutes: true },
      }),
      Promise.resolve(new Map<string, { workingDays: Weekday[]; holidays: Set<string> }>()),
    ]);

    // One calendar per organization, resolved once.
    for (const organizationId of new Set(employees.map((e) => e.organizationId))) {
      const calendar = await calendarsService.effectiveForOrganization(db, organizationId);
      if (calendar) calendars.set(organizationId, { workingDays: calendar.workingDays, holidays: calendar.holidays });
    }

    const byEmployee = <T extends { employeeId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
      return map;
    };
    const compensationsBy = byEmployee(compensations);
    const payItemsBy = byEmployee(payItems);
    const overtimeBy = byEmployee(overtime);
    const leaveBy = byEmployee(leaveRequests);
    const attendanceBy = byEmployee(attendance);

    const results: EmployeeCalculation[] = [];
    for (const employee of employees) {
      results.push(
        await calculateEmployee(db, employee, inputs, {
          compensations: compensationsBy.get(employee.id) ?? [],
          payItems: payItemsBy.get(employee.id) ?? [],
          overtime: overtimeBy.get(employee.id) ?? [],
          leave: leaveBy.get(employee.id) ?? [],
          attendance: attendanceBy.get(employee.id) ?? [],
          calendar: calendars.get(employee.organizationId) ?? null,
        }),
      );
    }
    return results;
  },

  /**
   * A fingerprint of everything the calculation read.
   *
   * It is compared before approval: if a correction, an overtime decision, a salary change or a recurring item has
   * moved since the run was calculated, the numbers on screen are not the numbers the sources now imply, and the run
   * must be recalculated rather than approved.
   */
  async fingerprint(db: Db, employeeIds: string[], inputs: CalculationInputs): Promise<string> {
    const [compensations, payItems, overtime, leave, attendance] = await Promise.all([
      db.employeeCompensation.findMany({
        where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: inputs.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: inputs.periodStart } }] },
        select: { id: true, baseSalary: true, effectiveFrom: true, effectiveTo: true },
        orderBy: { id: 'asc' },
      }),
      db.employeePayItem.findMany({
        where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: inputs.periodEnd }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: inputs.periodStart } }] },
        select: { id: true, amount: true, effectiveFrom: true, effectiveTo: true, componentId: true },
        orderBy: { id: 'asc' },
      }),
      db.overtimeRequest.findMany({
        where: { employeeId: { in: employeeIds }, attendanceDate: { gte: inputs.attendanceFrom, lte: inputs.attendanceTo }, status: 'APPROVED' },
        select: { id: true, approvedMinutes: true, rateMultiplierSnapshot: true, dayType: true },
        orderBy: { id: 'asc' },
      }),
      db.leaveRequest.findMany({
        where: { employeeId: { in: employeeIds }, status: LEAVE_REQUEST_STATUS.APPROVED, startDate: { lte: inputs.attendanceTo }, endDate: { gte: inputs.attendanceFrom } },
        select: { id: true, units: true, startDate: true, endDate: true, startPart: true, endPart: true, policyId: true },
        orderBy: { id: 'asc' },
      }),
      db.attendanceRecord.findMany({
        where: { employeeId: { in: employeeIds }, attendanceDate: { gte: inputs.attendanceFrom, lte: inputs.attendanceTo } },
        select: { id: true, status: true, lateMinutes: true, attendanceDate: true },
        orderBy: { id: 'asc' },
      }),
    ]);

    const payload = JSON.stringify({
      period: { ...inputs, policy: { ...inputs.policy, monthlyDivisorDays: inputs.policy.monthlyDivisorDays.toString(), dailyWorkHours: inputs.policy.dailyWorkHours.toString() } },
      employees: [...employeeIds].sort(),
      compensations: compensations.map((c) => [c.id, c.baseSalary.toString(), c.effectiveFrom, c.effectiveTo]),
      payItems: payItems.map((p) => [p.id, p.amount.toString(), p.effectiveFrom, p.effectiveTo, p.componentId]),
      overtime: overtime.map((o) => [o.id, o.approvedMinutes, o.rateMultiplierSnapshot, o.dayType]),
      leave: leave.map((l) => [l.id, l.units, l.startDate, l.endDate, l.startPart, l.endPart, l.policyId]),
      attendance: attendance.map((a) => [a.id, a.status, a.lateMinutes, a.attendanceDate]),
    });
    return createHash('sha256').update(payload).digest('hex');
  },
};

export interface EmployeeForPayroll {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  organizationId: string;
  departmentId: string | null;
  positionId: string | null;
  hireDate: Date;
  terminationDate: Date | null;
  department: { name: string } | null;
  position: { title: string } | null;
}

type EmployeeSources = {
  compensations: Prisma.EmployeeCompensationGetPayload<object>[];
  payItems: Prisma.EmployeePayItemGetPayload<{ include: { component: { select: { id: true; code: true; name: true; type: true; isActive: true } } } }>[];
  overtime: Awaited<ReturnType<typeof overtimeService.getApprovedOvertimeForPayroll>>;
  leave: {
    id: string; employeeId: string; startDate: string; endDate: string; startPart: string; endPart: string; units: number;
    calendarId: string | null; leaveType: { code: string; name: string }; policy: { id: string; name: string; isPaid: boolean } | null;
  }[];
  attendance: { id: string; employeeId: string; attendanceDate: string; status: string; lateMinutes: number }[];
  calendar: { workingDays: Weekday[]; holidays: Set<string> } | null;
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

async function calculateEmployee(db: Db, employee: EmployeeForPayroll, inputs: CalculationInputs, sources: EmployeeSources): Promise<EmployeeCalculation> {
  // ---- salary ------------------------------------------------------------
  // The period must resolve to exactly one salary. A change mid-period would need proration rules nobody has agreed,
  // so it is refused loudly rather than guessed at (documented in docs/payroll.md).
  if (sources.compensations.length === 0) {
    throw new AppError(409, 'PAYROLL_COMPENSATION_NOT_FOUND', `${employee.employeeCode} has no salary record covering ${inputs.periodStart} → ${inputs.periodEnd}`);
  }
  if (sources.compensations.length > 1) {
    throw new AppError(409, 'PAYROLL_COMPENSATION_SPLITS_PERIOD', `${employee.employeeCode} has more than one salary record inside ${inputs.periodStart} → ${inputs.periodEnd}; this release does not prorate a mid-period salary change`);
  }
  const compensation = sources.compensations[0];
  if (compareBusinessDate(compensation.effectiveFrom, inputs.periodStart) > 0 || (compensation.effectiveTo && compareBusinessDate(compensation.effectiveTo, inputs.periodEnd) < 0)) {
    throw new AppError(409, 'PAYROLL_COMPENSATION_SPLITS_PERIOD', `${employee.employeeCode}'s salary record does not cover the whole period ${inputs.periodStart} → ${inputs.periodEnd}`);
  }

  const { dailyRate, minuteRate } = deriveRates(compensation.baseSalary, inputs.policy.monthlyDivisorDays, inputs.policy.dailyWorkHours);
  const calendar = sources.calendar ?? { workingDays: parseWorkingDays('MON,TUE,WED,THU,FRI'), holidays: new Set<string>() };
  const lines: LineDraft[] = [];

  // ---- base salary, prorated for a part-month ----------------------------
  const hireDate = isoDate(employee.hireDate);
  const terminationDate = employee.terminationDate ? isoDate(employee.terminationDate) : null;
  const joinsMidPeriod = compareBusinessDate(hireDate, inputs.periodStart) > 0 && compareBusinessDate(hireDate, inputs.periodEnd) <= 0;
  const leavesMidPeriod = !!terminationDate && compareBusinessDate(terminationDate, inputs.periodEnd) < 0 && compareBusinessDate(terminationDate, inputs.periodStart) >= 0;
  const proration = joinsMidPeriod || leavesMidPeriod
    ? calculateProration({
        periodStart: inputs.periodStart,
        periodEnd: inputs.periodEnd,
        hireDate: joinsMidPeriod ? hireDate : null,
        terminationDate: leavesMidPeriod ? terminationDate : null,
        basis: (joinsMidPeriod ? inputs.policy.newHireProration : inputs.policy.terminationProration) as ProrationBasis,
        calendar,
      })
    : null;

  const baseComponent = await systemComponent(db, SYSTEM_PAY_COMPONENTS.BASE_SALARY);
  const baseAmount = proration && !proration.full && proration.periodDays > 0
    ? money(dec(compensation.baseSalary).times(proration.employedDays).dividedBy(proration.periodDays))
    : money(compensation.baseSalary);
  lines.push({
    componentCode: baseComponent.type === 'EARNING' ? SYSTEM_PAY_COMPONENTS.BASE_SALARY : SYSTEM_PAY_COMPONENTS.BASE_SALARY,
    componentName: baseComponent.name,
    componentId: baseComponent.id,
    type: 'EARNING',
    source: 'BASE',
    quantity: proration && !proration.full ? dec(proration.employedDays) : null,
    rate: proration && !proration.full ? rate(dec(compensation.baseSalary).dividedBy(proration.periodDays)) : null,
    amount: baseAmount,
    description: proration && !proration.full ? `Prorated: ${proration.employedDays} of ${proration.periodDays} ${inputs.policy.newHireProration === 'WORKING_DAYS' ? 'working' : 'calendar'} days (${proration.from} → ${proration.to})` : null,
    referenceType: 'EmployeeCompensation',
    referenceId: compensation.id,
  });

  // ---- recurring earnings and deductions ---------------------------------
  for (const item of sources.payItems) {
    if (!item.component.isActive) continue;
    lines.push({
      componentCode: item.component.code,
      componentName: item.component.name,
      componentId: item.component.id,
      type: item.component.type as 'EARNING' | 'DEDUCTION',
      source: 'RECURRING',
      amount: money(item.amount),
      description: item.note,
      referenceType: 'EmployeePayItem',
      referenceId: item.id,
    });
  }

  // ---- approved overtime -------------------------------------------------
  const otComponent = await systemComponent(db, SYSTEM_PAY_COMPONENTS.OT_PAY);
  let approvedOtMinutes = 0;
  for (const ot of sources.overtime) {
    approvedOtMinutes += ot.approvedMinutes;
    const multiplier = dec(ot.rateMultiplierSnapshot);
    lines.push({
      componentCode: SYSTEM_PAY_COMPONENTS.OT_PAY,
      componentName: otComponent.name,
      componentId: otComponent.id,
      type: 'EARNING',
      source: 'OT',
      quantity: dec(ot.approvedMinutes),
      rate: minuteRate,
      multiplier,
      // minutes × minute rate × the multiplier the claim was approved with — all in decimal, rounded once.
      amount: money(dec(ot.approvedMinutes).times(minuteRate).times(multiplier)),
      description: `${ot.attendanceDate} · ${ot.dayType.toLowerCase().replace('_', ' ')} · ${ot.approvedMinutes} min × ${multiplier.toString()}`,
      referenceType: 'OvertimeRequest',
      referenceId: ot.requestId,
    });
  }

  // ---- unpaid leave ------------------------------------------------------
  // Leave is deducted only when its policy says the leave is unpaid, and only for the part of the request that falls
  // inside the attendance window — recomputed from the request's own snapshot (dates, half-day boundaries, calendar).
  const unpaidComponent = await systemComponent(db, SYSTEM_PAY_COMPONENTS.UNPAID_LEAVE_DEDUCTION);
  let unpaidLeaveUnits = ZERO;
  const leaveDays = new Set<string>();
  for (const request of sources.leave) {
    const window = intersectRanges(request.startDate, request.endDate, inputs.attendanceFrom, inputs.attendanceTo);
    if (!window) continue;
    for (const date of enumerateDates(window.from, window.to)) leaveDays.add(date);
    if (request.policy?.isPaid !== false) continue; // paid leave costs nothing here

    const units = calculateLeaveUnits({
      calendar,
      startDate: window.from,
      endDate: window.to,
      // A half-day boundary only applies when that boundary day is inside the window.
      startPart: window.from === request.startDate ? (request.startPart as 'FULL' | 'PM') : 'FULL',
      endPart: window.to === request.endDate ? (request.endPart as 'FULL' | 'AM') : 'FULL',
    });
    if (!units.ok || units.units <= 0) continue;
    unpaidLeaveUnits = unpaidLeaveUnits.plus(dec(units.units));
    lines.push({
      componentCode: SYSTEM_PAY_COMPONENTS.UNPAID_LEAVE_DEDUCTION,
      componentName: unpaidComponent.name,
      componentId: unpaidComponent.id,
      type: 'DEDUCTION',
      source: 'LEAVE',
      quantity: dec(units.units),
      rate: dailyRate,
      amount: money(dec(units.units).times(dailyRate)),
      description: `${request.leaveType.name} ${window.from}${window.from === window.to ? '' : ` → ${window.to}`} (${units.units} day${units.units === 1 ? '' : 's'}, unpaid)`,
      referenceType: 'LeaveRequest',
      referenceId: request.id,
    });
  }

  // ---- absence and lateness ---------------------------------------------
  // A day covered by approved leave is never also an absence: leave wins, and the double deduction that would
  // otherwise appear is exactly the bug this guard exists for.
  const absenceComponent = await systemComponent(db, SYSTEM_PAY_COMPONENTS.ABSENCE_DEDUCTION);
  const lateComponent = await systemComponent(db, SYSTEM_PAY_COMPONENTS.LATE_DEDUCTION);
  const absentDates = sources.attendance.filter((a) => a.status === 'ABSENT' && !leaveDays.has(a.attendanceDate)).map((a) => a.attendanceDate);
  let absentDays = ZERO;
  if (inputs.policy.absenceDeductionEnabled && absentDates.length > 0) {
    absentDays = dec(absentDates.length);
    lines.push({
      componentCode: SYSTEM_PAY_COMPONENTS.ABSENCE_DEDUCTION,
      componentName: absenceComponent.name,
      componentId: absenceComponent.id,
      type: 'DEDUCTION',
      source: 'ATTENDANCE',
      quantity: absentDays,
      rate: dailyRate,
      amount: money(absentDays.times(dailyRate)),
      description: `${absentDates.length} absent day(s): ${absentDates.slice(0, 5).join(', ')}${absentDates.length > 5 ? '…' : ''}`,
      referenceType: 'AttendanceRecord',
      referenceId: null,
    });
  }

  const lateMinutes = sources.attendance.reduce((sum, a) => sum + (leaveDays.has(a.attendanceDate) ? 0 : a.lateMinutes), 0);
  if (inputs.policy.lateDeductionEnabled && lateMinutes > 0) {
    lines.push({
      componentCode: SYSTEM_PAY_COMPONENTS.LATE_DEDUCTION,
      componentName: lateComponent.name,
      componentId: lateComponent.id,
      type: 'DEDUCTION',
      source: 'ATTENDANCE',
      quantity: dec(lateMinutes),
      rate: minuteRate,
      // Exact minutes: no rounding up to the nearest half hour, which would be a policy nobody configured.
      amount: money(dec(lateMinutes).times(minuteRate)),
      description: `${lateMinutes} late minute(s)`,
      referenceType: 'AttendanceRecord',
      referenceId: null,
    });
  }

  const grossPay = sumMoney(lines.filter((l) => l.type === 'EARNING').map((l) => l.amount));
  const totalDeductions = sumMoney(lines.filter((l) => l.type === 'DEDUCTION').map((l) => l.amount));

  return {
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    employeeName: `${employee.firstName} ${employee.lastName}`,
    organizationId: employee.organizationId,
    departmentId: employee.departmentId,
    departmentName: employee.department?.name ?? null,
    positionId: employee.positionId,
    positionTitle: employee.position?.title ?? null,
    compensationId: compensation.id,
    baseSalary: money(compensation.baseSalary),
    dailyRate,
    minuteRate,
    grossPay,
    totalDeductions,
    netPay: money(grossPay.minus(totalDeductions)),
    absentDays,
    lateMinutes: inputs.policy.lateDeductionEnabled ? lateMinutes : 0,
    unpaidLeaveUnits,
    approvedOtMinutes,
    proratedDays: proration && !proration.full ? dec(proration.employedDays) : null,
    lines,
  };
}

export type { LineDraft };
export { systemComponent };
