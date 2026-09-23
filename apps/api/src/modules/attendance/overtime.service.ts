import {
  AUDIT_ACTIONS, OVERTIME_SETTLED, OVERTIME_WORKFLOW, businessToday, checkOvertimeClaim, multiplierFor,
  type ApprovedOvertimeForPayrollDto, type CreateOvertimeRequestInput, type OvertimeDayType, type OvertimeListQuery,
  type OvertimeReportDto, type OvertimeReportQuery, type OvertimeRequestDto, type OvertimeStatus,
  type UpdateOvertimeRequestInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine } from '../../services/workflow';
import { employeeScopeWhere } from '../employees/employees.scope';
import type { AuthContext } from '../auth/auth.types';
import { attendanceAudit, employeeRef, type Actor, type Db, type Tx } from './attendance.types';
import { overtimeEligibilityService } from './overtime-eligibility.service';

/**
 * Overtime claims: raised by the employee about a day that has already happened, decided through the shared workflow
 * engine, and frozen once approved so payroll has something it can rely on.
 *
 * What the client may say is deliberately tiny — a date, a number of minutes, a reason. Who the employee is, what
 * kind of day it was, which policy applied, what multiplier it earns and how much of the day was even eligible are
 * all derived here, because each of them decides what somebody is eventually paid.
 *
 * **No money is calculated anywhere in this module.** Approved minutes and a multiplier are the output; payroll
 * (Task 22) is what turns them into an amount.
 */
const requestInclude = {
  employee: employeeRef,
  policy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, email: true } },
} satisfies Prisma.OvertimeRequestInclude;
type Row = Prisma.OvertimeRequestGetPayload<{ include: typeof requestInclude }>;

function toDto(row: Row): OvertimeRequestDto {
  return {
    id: row.id,
    employee: row.employee,
    attendanceDate: row.attendanceDate,
    dayType: (row.dayType ?? 'WORKDAY') as OvertimeDayType,
    claimedMinutes: row.claimedMinutes,
    eligibleMinutesSnapshot: row.eligibleMinutesSnapshot,
    approvedMinutes: row.approvedMinutes,
    rateMultiplierSnapshot: row.rateMultiplierSnapshot,
    policy: row.policy,
    reason: row.reason,
    status: row.status as OvertimeStatus,
    workflowInstanceId: row.workflowInstanceId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function requireEmployeeId(auth: AuthContext): string {
  if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record, so it cannot claim overtime');
  return auth.employeeId;
}

/** Serialises everything one employee does with overtime, so the "one open claim per day" rule cannot be raced. */
async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$executeRaw`SELECT "id" FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
}

/** A claim that is already pending or approved blocks another one for the same day; rejected and cancelled do not. */
async function assertNoOpenClaim(tx: Tx, employeeId: string, attendanceDate: string, exceptId = '__none__') {
  const open = await tx.overtimeRequest.findFirst({
    where: { id: { not: exceptId }, employeeId, attendanceDate, status: { in: ['PENDING', 'APPROVED'] } },
    select: { id: true, status: true },
  });
  if (open) throw new AppError(409, 'OT_ALREADY_CLAIMED', `There is already a ${open.status.toLowerCase()} overtime claim for that day`);
}

/** Loads a claim for a state change, with the row locked. */
async function loadForMutation(tx: Tx, id: string) {
  await tx.$executeRaw`SELECT "id" FROM "overtime_requests" WHERE "id" = ${id} FOR UPDATE`;
  const row = await tx.overtimeRequest.findUnique({ where: { id }, include: requestInclude });
  if (!row) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
  return row;
}

export const overtimeService = {
  /** What the claim screen shows: the day, what was worked, what is eligible and what the policy allows. */
  async preview(auth: AuthContext, attendanceDate: string) {
    return overtimeEligibilityService.preview(prisma, requireEmployeeId(auth), attendanceDate);
  },

  /**
   * Create a draft claim for one of the caller's own days. Basic eligibility is checked here so a hopeless claim is
   * refused at the point it is made, not after somebody has been asked to approve it.
   */
  async create(auth: AuthContext, input: CreateOvertimeRequestInput, actor: Actor): Promise<OvertimeRequestDto> {
    const employeeId = requireEmployeeId(auth);
    const row = await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      await assertNoOpenClaim(tx, employeeId, input.attendanceDate);
      await overtimeService.assertClaimable(tx, employeeId, input.attendanceDate, input.claimedMinutes);

      const created = await tx.overtimeRequest.create({
        data: {
          employeeId,
          attendanceDate: input.attendanceDate,
          claimedMinutes: input.claimedMinutes,
          reason: input.reason ?? null,
          status: 'DRAFT',
          createdByUserId: auth.userId,
        },
        include: requestInclude,
      });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CREATE_OVERTIME_REQUEST, 'OvertimeRequest', created.id, {
        attendanceDate: created.attendanceDate, claimedMinutes: created.claimedMinutes, status: created.status,
      }), tx);
      return created;
    });
    return toDto(row);
  },

  /** Drafts can be edited; everything after submit is immutable. */
  async update(auth: AuthContext, id: string, input: UpdateOvertimeRequestInput, actor: Actor): Promise<OvertimeRequestDto> {
    const employeeId = requireEmployeeId(auth);
    const row = await prisma.$transaction(async (tx) => {
      const before = await loadForMutation(tx, id);
      if (before.employeeId !== employeeId) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
      if (before.status !== 'DRAFT') throw new AppError(409, 'OT_REQUEST_NOT_DRAFT', `This claim is ${before.status.toLowerCase()} and can no longer be edited`);

      const attendanceDate = input.attendanceDate ?? before.attendanceDate;
      const claimedMinutes = input.claimedMinutes ?? before.claimedMinutes;
      await lockEmployee(tx, employeeId);
      await assertNoOpenClaim(tx, employeeId, attendanceDate, id);
      await overtimeService.assertClaimable(tx, employeeId, attendanceDate, claimedMinutes);

      const after = await tx.overtimeRequest.update({
        where: { id },
        data: { attendanceDate, claimedMinutes, reason: input.reason === undefined ? undefined : input.reason },
        include: requestInclude,
      });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.UPDATE_OVERTIME_REQUEST, 'OvertimeRequest', id,
        { attendanceDate: after.attendanceDate, claimedMinutes: after.claimedMinutes },
        { attendanceDate: before.attendanceDate, claimedMinutes: before.claimedMinutes }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * Submit for approval. Everything that decides the eventual value is resolved and snapshotted here, in one
   * transaction, after locking the claim and the employee: the day type, the eligible minutes, the policy and its
   * multiplier, and where the employee sat at the time.
   */
  async submit(auth: AuthContext, id: string, actor: Actor): Promise<OvertimeRequestDto> {
    const employeeId = requireEmployeeId(auth);
    const row = await prisma.$transaction(async (tx) => {
      const before = await loadForMutation(tx, id);
      if (before.employeeId !== employeeId) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
      if (before.status !== 'DRAFT') throw new AppError(409, 'OT_REQUEST_NOT_DRAFT', `This claim is already ${before.status.toLowerCase()}`);
      await lockEmployee(tx, employeeId);
      await assertNoOpenClaim(tx, employeeId, before.attendanceDate, id);

      const { assessment, policy } = await overtimeEligibilityService.assessWithPolicy(tx, employeeId, before.attendanceDate);
      overtimeService.assertClaimAllowed(assessment, policy, before.claimedMinutes);

      const multiplier = multiplierFor(policy, assessment.dayType);
      await tx.overtimeRequest.update({
        where: { id },
        data: {
          status: 'PENDING',
          submittedAt: new Date(),
          dayType: assessment.dayType,
          eligibleMinutesSnapshot: assessment.eligibility.eligibleMinutes,
          rateMultiplierSnapshot: multiplier,
          policyId: policy.id,
          organizationId: assessment.organizationId,
          departmentId: assessment.departmentId,
          positionId: assessment.positionId,
        },
      });

      const instance = await workflowEngine.submit(
        {
          definitionCode: policy.workflowDefinitionCode,
          module: OVERTIME_WORKFLOW.module,
          entityType: OVERTIME_WORKFLOW.entityType,
          entityId: id,
          requesterEmployeeId: employeeId,
        },
        actor,
        tx,
      );
      await tx.overtimeRequest.update({ where: { id }, data: { workflowInstanceId: instance.id } });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.SUBMIT_OVERTIME_REQUEST, 'OvertimeRequest', id, {
        attendanceDate: before.attendanceDate, claimedMinutes: before.claimedMinutes, dayType: assessment.dayType,
        eligibleMinutes: assessment.eligibility.eligibleMinutes, multiplier, policyId: policy.id, workflowInstanceId: instance.id,
      }, { status: 'DRAFT' }), tx);

      // A definition whose every step resolves to nothing completes immediately and the handler has already run, so
      // re-read rather than assume the claim is still PENDING.
      return tx.overtimeRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
    });
    return toDto(row);
  },

  /** The requester withdrawing their own claim. An approved claim is never cancelled here — see docs/overtime.md. */
  async cancel(auth: AuthContext, id: string, actor: Actor): Promise<OvertimeRequestDto> {
    const employeeId = requireEmployeeId(auth);
    const row = await prisma.$transaction(async (tx) => {
      const before = await loadForMutation(tx, id);
      if (before.employeeId !== employeeId) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
      if (before.status === 'APPROVED') throw new AppError(409, 'OT_REQUEST_APPROVED', 'An approved overtime claim cannot be withdrawn; it is payroll input. Ask HR to handle it.');
      if (OVERTIME_SETTLED.includes(before.status as OvertimeStatus)) throw new AppError(409, 'OT_REQUEST_NOT_PENDING', `This claim is already ${before.status.toLowerCase()}`);

      if (before.status === 'PENDING' && before.workflowInstanceId) {
        // The engine's cancel drives the handler, which writes the cancelled state and the audit entry.
        await workflowEngine.cancel(before.workflowInstanceId, actor, tx, 'Withdrawn by the requester');
      } else {
        await tx.overtimeRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CANCEL_OVERTIME_REQUEST, 'OvertimeRequest', id, { status: 'CANCELLED' }, { status: before.status }), tx);
      }
      return tx.overtimeRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
    });
    return toDto(row);
  },

  async list(auth: AuthContext, q: OvertimeListQuery): Promise<{ data: OvertimeRequestDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.OvertimeRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.dayType ? { dayType: q.dayType } : {}),
      ...(q.from || q.to ? { attendanceDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    if (q.view === 'mine') {
      where.employeeId = auth.employeeId ?? '__no_employee__';
    } else if (q.view === 'inbox') {
      // The workflow engine owns "whose decision is this": the snapshot approver of the current pending step.
      const steps = await prisma.workflowInstanceStep.findMany({
        where: { status: 'PENDING', approverUserId: auth.userId, instance: { module: OVERTIME_WORKFLOW.module, entityType: OVERTIME_WORKFLOW.entityType, status: 'PENDING' } },
        select: { instance: { select: { entityId: true } } },
        take: 500,
      });
      where.id = { in: steps.map((s) => s.instance.entityId) };
    } else {
      where.employee = {
        AND: [
          employeeScopeWhere(auth),
          ...(q.employeeId ? [{ id: q.employeeId }] : []),
          ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
          ...(q.search
            ? [{ OR: [
                { employeeCode: { contains: q.search, mode: 'insensitive' as const } },
                { firstName: { contains: q.search, mode: 'insensitive' as const } },
                { lastName: { contains: q.search, mode: 'insensitive' as const } },
              ] }]
            : []),
        ],
      };
    }

    const [total, rows] = await prisma.$transaction([
      prisma.overtimeRequest.count({ where }),
      prisma.overtimeRequest.findMany({ where, include: requestInclude, orderBy: [{ attendanceDate: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** One claim. Visible to its owner, to an approver on its workflow, or to anyone whose data scope covers them. */
  async getById(auth: AuthContext, id: string): Promise<OvertimeRequestDto> {
    const row = await prisma.overtimeRequest.findUnique({ where: { id }, include: requestInclude });
    if (!row) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
    if (row.employeeId !== auth.employeeId) {
      const isApprover = row.workflowInstanceId
        ? !!(await prisma.workflowInstanceStep.findFirst({ where: { instanceId: row.workflowInstanceId, approverUserId: auth.userId }, select: { id: true } }))
        : false;
      if (!isApprover) {
        const visible = await prisma.employee.findFirst({ where: { AND: [{ id: row.employeeId }, employeeScopeWhere(auth)] }, select: { id: true } });
        // The same 404 a missing id would produce: the endpoint never confirms that somebody else's claim exists.
        if (!visible) throw new AppError(404, 'OT_REQUEST_NOT_FOUND', 'Overtime request not found');
      }
    }
    return toDto(row);
  },

  // ---------- shared validation ----------
  /** Throws unless the day can be claimed at all and the minutes fit inside eligibility and the policy limits. */
  async assertClaimable(db: Db, employeeId: string, attendanceDate: string, claimedMinutes: number) {
    const { assessment, policy } = await overtimeEligibilityService.assessWithPolicy(db, employeeId, attendanceDate);
    overtimeService.assertClaimAllowed(assessment, policy, claimedMinutes);
  },

  assertClaimAllowed(
    assessment: Awaited<ReturnType<typeof overtimeEligibilityService.assess>>,
    policy: { minimumEligibleMinutes: number | null; maximumApprovedMinutesPerDay: number | null },
    claimedMinutes: number,
  ) {
    // A day nobody could have worked yet is a mistake in the form, not a state of the attendance.
    overtimeService.assertNotFuture(assessment.attendanceDate, assessment.timezone);
    if (assessment.notFinalReason) throw new AppError(409, 'OT_ATTENDANCE_NOT_FINAL', assessment.notFinalReason);
    const check = checkOvertimeClaim(
      {
        eligibleMinutes: assessment.eligibility.eligibleMinutes,
        minimumEligibleMinutes: policy.minimumEligibleMinutes,
        maximumApprovedMinutesPerDay: policy.maximumApprovedMinutesPerDay,
      },
      claimedMinutes,
    );
    if (check.ok) return;
    const messages: Record<typeof check.code, string> = {
      OT_NOT_ELIGIBLE: 'That day has no overtime to claim',
      OT_BELOW_MINIMUM: `The policy requires at least ${policy.minimumEligibleMinutes} minutes`,
      OT_EXCEEDS_ELIGIBLE_TIME: `Only ${assessment.eligibility.eligibleMinutes} minute(s) of that day are eligible`,
      OT_EXCEEDS_DAILY_MAX: `The policy allows at most ${policy.maximumApprovedMinutesPerDay} minutes a day`,
    };
    throw new AppError(409, check.code, messages[check.code]);
  },

  /** Guard for a date nobody could have worked yet. */
  assertNotFuture(attendanceDate: string, timezone: string) {
    if (attendanceDate > businessToday(timezone)) throw new AppError(400, 'VALIDATION_ERROR', 'Overtime is claimed for a day that has already happened');
  },

  // ---------- reporting ----------
  async report(auth: AuthContext, q: OvertimeReportQuery): Promise<OvertimeReportDto> {
    const employees = await prisma.employee.findMany({
      where: {
        AND: [
          employeeScopeWhere(auth),
          ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
          ...(q.employeeId ? [{ id: q.employeeId }] : []),
        ],
      },
      ...employeeRef,
      orderBy: { employeeCode: 'asc' },
      take: 500,
    });
    const empty = { WORKDAY: 0, OFF_DAY: 0, HOLIDAY: 0 };
    if (employees.length === 0) {
      return { from: q.from, to: q.to, rows: [], totals: { requests: 0, approvedRequests: 0, approvedMinutes: 0, byDayType: { ...empty } }, note: 'Minutes and multipliers only — this release calculates no monetary overtime.' };
    }

    const grouped = await prisma.overtimeRequest.groupBy({
      by: ['employeeId', 'status', 'dayType'],
      where: { employeeId: { in: employees.map((e) => e.id) }, attendanceDate: { gte: q.from, lte: q.to }, status: { not: 'DRAFT' } },
      _count: { _all: true },
      _sum: { approvedMinutes: true },
    });

    const rows = employees.map((employee) => {
      const mine = grouped.filter((g) => g.employeeId === employee.id);
      const byDayType = { ...empty };
      let approvedMinutes = 0;
      let approvedRequests = 0;
      for (const g of mine.filter((g) => g.status === 'APPROVED')) {
        const minutes = g._sum.approvedMinutes ?? 0;
        approvedMinutes += minutes;
        approvedRequests += g._count._all;
        if (g.dayType && g.dayType in byDayType) byDayType[g.dayType as keyof typeof byDayType] += minutes;
      }
      return {
        employee,
        requests: mine.reduce((sum, g) => sum + g._count._all, 0),
        approvedRequests,
        approvedMinutes,
        byDayType,
      };
    });

    const totals = rows.reduce(
      (acc, r) => ({
        requests: acc.requests + r.requests,
        approvedRequests: acc.approvedRequests + r.approvedRequests,
        approvedMinutes: acc.approvedMinutes + r.approvedMinutes,
        byDayType: {
          WORKDAY: acc.byDayType.WORKDAY + r.byDayType.WORKDAY,
          OFF_DAY: acc.byDayType.OFF_DAY + r.byDayType.OFF_DAY,
          HOLIDAY: acc.byDayType.HOLIDAY + r.byDayType.HOLIDAY,
        },
      }),
      { requests: 0, approvedRequests: 0, approvedMinutes: 0, byDayType: { ...empty } },
    );
    return { from: q.from, to: q.to, rows, totals, note: 'Minutes and multipliers only — this release calculates no monetary overtime.' };
  },

  /**
   * **The payroll handoff** (Task 22 reads this, and nothing else).
   *
   * Approved claims only, with exactly the five facts a payroll run needs. Payroll never queries workflow instances,
   * attendance records or policies for itself: if it needs more, this shape grows, deliberately.
   */
  async getApprovedOvertimeForPayroll(input: { employeeId?: string; employeeIds?: string[]; from: string; to: string }): Promise<ApprovedOvertimeForPayrollDto[]> {
    const employeeIds = input.employeeIds ?? (input.employeeId ? [input.employeeId] : undefined);
    const rows = await prisma.overtimeRequest.findMany({
      where: {
        status: 'APPROVED',
        attendanceDate: { gte: input.from, lte: input.to },
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      },
      select: { id: true, employeeId: true, attendanceDate: true, approvedMinutes: true, dayType: true, rateMultiplierSnapshot: true, policyId: true },
      orderBy: [{ employeeId: 'asc' }, { attendanceDate: 'asc' }],
    });
    return rows.map((r) => ({
      requestId: r.id,
      employeeId: r.employeeId,
      attendanceDate: r.attendanceDate,
      approvedMinutes: r.approvedMinutes ?? 0,
      dayType: (r.dayType ?? 'WORKDAY') as OvertimeDayType,
      rateMultiplierSnapshot: r.rateMultiplierSnapshot ?? 0,
      policyId: r.policyId,
    }));
  },

  /** Internal: approved minutes already granted for a day — the figure an attendance correction must not undercut. */
  async approvedMinutesForDay(db: Db, employeeId: string, attendanceDate: string): Promise<number> {
    const approved = await db.overtimeRequest.findMany({
      where: { employeeId, attendanceDate, status: 'APPROVED' },
      select: { approvedMinutes: true },
    });
    return approved.reduce((sum, r) => sum + (r.approvedMinutes ?? 0), 0);
  },

  loadForMutation,
};
