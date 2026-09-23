import {
  ATTENDANCE_WORKFLOW, AUDIT_ACTIONS, businessToday, isOvernightShift, zonedTimeToUtc,
  type CorrectionDto, type CorrectionListQuery, type CreateCorrectionInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from '../employees/employees.scope';
import { attendanceAudit, type Actor, type Tx } from './attendance.types';
import { attendanceCalculationService } from './attendance-calculation.service';

/**
 * "I forgot to clock out."
 *
 * A correction is a **request about a day**, not an edit of it. The employee states the times that should have been
 * recorded; an approver decides; only then does the calculation take those times into account. The raw clock events
 * are never touched, so the trail always shows both what happened and what was decided about it.
 *
 * Approval reuses the workflow engine exactly as Leave does — same definitions, same inbox, same locking. The
 * definition is looked up by a fixed code (`ATTENDANCE_CORRECTION`), which keeps configuration to one place a
 * customer already understands: Administration → Workflows.
 */
export const ATTENDANCE_CORRECTION_WORKFLOW_CODE = 'ATTENDANCE_CORRECTION';

const correctionInclude = {
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  createdBy: { select: { id: true, email: true } },
} satisfies Prisma.AttendanceCorrectionInclude;
type Row = Prisma.AttendanceCorrectionGetPayload<{ include: typeof correctionInclude }>;

function toDto(row: Row, current: CorrectionDto['current'] = null): CorrectionDto {
  return {
    id: row.id,
    employee: row.employee,
    attendanceDate: row.attendanceDate,
    requestedClockIn: row.requestedClockIn?.toISOString() ?? null,
    requestedClockOut: row.requestedClockOut?.toISOString() ?? null,
    reason: row.reason,
    status: row.status as CorrectionDto['status'],
    workflowInstanceId: row.workflowInstanceId,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    current,
  };
}

/** Wall-clock `HH:mm` on the attendance date → a UTC instant, using the employee organization's timezone. */
function instantFor(date: string, time: string, timezone: string, shift: { startTime: string; endTime: string } | null, isEnd: boolean): Date {
  // An overnight shift's end belongs to the following calendar day: 05:00 after a 20:00 start is the next morning.
  const overnightEnd = isEnd && shift && isOvernightShift(shift.startTime, shift.endTime) && time < shift.startTime;
  return zonedTimeToUtc(overnightEnd ? nextDay(date) : date, time, timezone);
}
const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export const correctionsService = {
  /**
   * Submit a correction for one of the caller's own days. One open request per day: a second one would leave two
   * approvers deciding the same thing.
   */
  async submit(auth: AuthContext, input: CreateCorrectionInput, actor: Actor): Promise<CorrectionDto> {
    if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
    const employee = await prisma.employee.findUniqueOrThrow({
      where: { id: auth.employeeId },
      select: { id: true, organization: { select: { timezone: true } } },
    });
    const timezone = employee.organization.timezone;
    if (input.attendanceDate > businessToday(timezone)) throw new AppError(400, 'VALIDATION_ERROR', 'A correction can only be requested for a day that has started');

    const schedule = await prisma.attendanceSchedule.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: input.attendanceDate } },
      select: { shift: { select: { startTime: true, endTime: true } } },
    });
    const requestedClockIn = input.requestedClockIn ? instantFor(input.attendanceDate, input.requestedClockIn, timezone, schedule?.shift ?? null, false) : null;
    const requestedClockOut = input.requestedClockOut ? instantFor(input.attendanceDate, input.requestedClockOut, timezone, schedule?.shift ?? null, true) : null;
    if (requestedClockIn && requestedClockOut && requestedClockOut.getTime() <= requestedClockIn.getTime()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The clock-out time must be after the clock-in time');
    }

    const row = await prisma.$transaction(async (tx) => {
      // Serialise per employee so two submissions for the same day cannot both pass the "one open request" check.
      await tx.$executeRaw`SELECT "id" FROM "employees" WHERE "id" = ${employee.id} FOR UPDATE`;
      const open = await tx.attendanceCorrection.findFirst({
        where: { employeeId: employee.id, attendanceDate: input.attendanceDate, status: 'PENDING' },
        select: { id: true },
      });
      if (open) throw new AppError(409, 'CORRECTION_ALREADY_PENDING', 'There is already a correction waiting for approval for that day');

      const created = await tx.attendanceCorrection.create({
        data: {
          employeeId: employee.id,
          attendanceDate: input.attendanceDate,
          requestedClockIn,
          requestedClockOut,
          reason: input.reason,
          status: 'PENDING',
          submittedAt: new Date(),
          createdByUserId: auth.userId,
        },
        include: correctionInclude,
      });

      const instance = await workflowEngine.submit(
        {
          definitionCode: ATTENDANCE_CORRECTION_WORKFLOW_CODE,
          module: ATTENDANCE_WORKFLOW.module,
          entityType: ATTENDANCE_WORKFLOW.entityType,
          entityId: created.id,
          requesterEmployeeId: employee.id,
        },
        actor,
        tx,
      );
      const withInstance = await tx.attendanceCorrection.update({ where: { id: created.id }, data: { workflowInstanceId: instance.id }, include: correctionInclude });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.SUBMIT_ATTENDANCE_CORRECTION, 'AttendanceCorrection', created.id, {
        attendanceDate: created.attendanceDate,
        requestedClockIn: requestedClockIn?.toISOString() ?? null,
        requestedClockOut: requestedClockOut?.toISOString() ?? null,
        workflowInstanceId: instance.id,
      }), tx);

      // A definition that auto-approves every step (no approver resolved, SKIP) completes immediately, and the
      // handler has already applied it — so re-read rather than assume the row is still PENDING.
      return tx.attendanceCorrection.findUniqueOrThrow({ where: { id: withInstance.id }, include: correctionInclude });
    });
    return toDto(row);
  },

  /** The caller withdrawing their own pending request. */
  async cancel(auth: AuthContext, id: string, actor: Actor): Promise<CorrectionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.attendanceCorrection.findUnique({ where: { id }, include: correctionInclude });
      if (!before) throw new AppError(404, 'CORRECTION_NOT_FOUND', 'Correction request not found');
      if (before.employeeId !== auth.employeeId) throw new AppError(404, 'CORRECTION_NOT_FOUND', 'Correction request not found');
      if (before.status !== 'PENDING') throw new AppError(409, 'CORRECTION_NOT_PENDING', `This request is already ${before.status.toLowerCase()}`);
      if (before.workflowInstanceId) await workflowEngine.cancel(before.workflowInstanceId, actor, tx, 'Withdrawn by the requester');
      return tx.attendanceCorrection.findUniqueOrThrow({ where: { id }, include: correctionInclude });
    });
    return toDto(row);
  },

  async list(auth: AuthContext, q: CorrectionListQuery): Promise<{ data: CorrectionDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.AttendanceCorrectionWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { attendanceDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    if (q.view === 'mine') {
      where.employeeId = auth.employeeId ?? '__no_employee__';
    } else if (q.view === 'inbox') {
      // Exactly the requests this person is the current approver of — the workflow engine owns that truth.
      const steps = await prisma.workflowInstanceStep.findMany({
        where: { status: 'PENDING', approverUserId: auth.userId, instance: { module: ATTENDANCE_WORKFLOW.module, status: 'PENDING' } },
        select: { instance: { select: { entityId: true } } },
        take: 500,
      });
      where.id = { in: steps.map((s) => s.instance.entityId) };
    } else {
      where.employee = { AND: [employeeScopeWhere(auth), ...(q.employeeId ? [{ id: q.employeeId }] : [])] };
    }

    const [total, rows] = await prisma.$transaction([
      prisma.attendanceCorrection.count({ where }),
      prisma.attendanceCorrection.findMany({ where, include: correctionInclude, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map((r) => toDto(r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** One request, with the day as it stands now so an approver can see what they are about to change. */
  async getById(auth: AuthContext, id: string): Promise<CorrectionDto> {
    const row = await prisma.attendanceCorrection.findUnique({ where: { id }, include: correctionInclude });
    if (!row) throw new AppError(404, 'CORRECTION_NOT_FOUND', 'Correction request not found');

    const isOwn = row.employeeId === auth.employeeId;
    const isApprover = row.workflowInstanceId
      ? !!(await prisma.workflowInstanceStep.findFirst({ where: { instanceId: row.workflowInstanceId, approverUserId: auth.userId }, select: { id: true } }))
      : false;
    if (!isOwn && !isApprover) {
      // Fall back to the data scope: HR with ALL scope may read any request; everyone else gets the same 404 a
      // non-existent id would produce, so the endpoint never confirms that somebody else's request exists.
      const visible = await prisma.employee.findFirst({ where: { AND: [{ id: row.employeeId }, employeeScopeWhere(auth)] }, select: { id: true } });
      if (!visible) throw new AppError(404, 'CORRECTION_NOT_FOUND', 'Correction request not found');
    }

    const record = await prisma.attendanceRecord.findUnique({
      where: { employeeId_attendanceDate: { employeeId: row.employeeId, attendanceDate: row.attendanceDate } },
      select: { firstClockIn: true, lastClockOut: true, status: true },
    });
    return toDto(row, record ? { firstClockIn: record.firstClockIn?.toISOString() ?? null, lastClockOut: record.lastClockOut?.toISOString() ?? null, status: record.status } : null);
  },

  /** Internal: load a correction for a workflow transition, locked. */
  async loadForTransition(tx: Tx, id: string) {
    await tx.$executeRaw`SELECT "id" FROM "attendance_corrections" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.attendanceCorrection.findUnique({ where: { id }, include: correctionInclude });
    if (!row) throw new AppError(404, 'CORRECTION_NOT_FOUND', 'Correction request not found');
    return row;
  },

  /** Internal: apply a decision and recalculate the day it refers to. */
  async applyDecision(tx: Tx, id: string, status: 'APPROVED' | 'REJECTED' | 'CANCELLED') {
    const row = await correctionsService.loadForTransition(tx, id);
    if (row.status !== 'PENDING') throw new AppError(409, 'CORRECTION_NOT_PENDING', `This request is already ${row.status.toLowerCase()}`);
    const updated = await tx.attendanceCorrection.update({ where: { id }, data: { status, decidedAt: new Date() }, include: correctionInclude });
    // The day is recalculated either way: approval brings the corrected times in, rejection leaves the raw ones.
    await attendanceCalculationService.recalculate(tx, row.employeeId, row.attendanceDate);
    return updated;
  },
};
