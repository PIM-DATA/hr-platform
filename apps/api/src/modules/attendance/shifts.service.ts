import { AUDIT_ACTIONS, isOvernightShift, minutesOfDay, type CreateShiftInput, type ShiftDto, type ShiftListQuery, type UpdateShiftInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { attendanceAudit, type Actor } from './attendance.types';

/**
 * Shift master data: the working patterns an organization uses.
 *
 * A shift is deliberately thin — start, end, break and how much lateness is forgiven. Everything derived from it
 * (the instants it covers on a given date, whether it runs overnight, how much work it requires) is computed by the
 * shared domain code, so the same rules apply on the server, in the UI and in tests.
 */
const shiftInclude = { organization: { select: { id: true, code: true, name: true } } } as const;
type Row = Awaited<ReturnType<typeof prisma.attendanceShift.findFirstOrThrow<{ include: typeof shiftInclude }>>>;

export function toShiftDto(row: Row): ShiftDto {
  const spanMinutes = (minutesOfDay(row.endTime) - minutesOfDay(row.startTime) + 1440) % 1440 || 1440;
  return {
    id: row.id,
    organization: row.organization,
    code: row.code,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    breakMinutes: row.breakMinutes,
    lateGraceMinutes: row.lateGraceMinutes,
    earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
    isOvernight: row.isOvernight,
    requiredMinutes: Math.max(0, spanMinutes - row.breakMinutes),
    isActive: row.isActive,
  };
}

async function findOrThrow(id: string) {
  const row = await prisma.attendanceShift.findUnique({ where: { id }, include: shiftInclude });
  if (!row) throw new AppError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
  return row;
}

export const shiftsService = {
  async list(q: ShiftListQuery): Promise<{ data: ShiftDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where = {
      organizationId: q.organizationId,
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' as const } }, { name: { contains: q.search, mode: 'insensitive' as const } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.attendanceShift.count({ where }),
      prisma.attendanceShift.findMany({ where, include: shiftInclude, orderBy: [{ organizationId: 'asc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toShiftDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** Shifts an operator can assign: active ones, optionally for one organization. */
  async options(organizationId?: string): Promise<ShiftDto[]> {
    const rows = await prisma.attendanceShift.findMany({ where: { isActive: true, organizationId }, include: shiftInclude, orderBy: { code: 'asc' }, take: 200 });
    return rows.map(toShiftDto);
  },

  async getById(id: string): Promise<ShiftDto> {
    return toShiftDto(await findOrThrow(id));
  },

  async create(input: CreateShiftInput, actor: Actor): Promise<ShiftDto> {
    const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
    if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const duplicate = await prisma.attendanceShift.findUnique({ where: { organizationId_code: { organizationId: input.organizationId, code: input.code } }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'SHIFT_CODE_EXISTS', 'A shift with this code already exists in the organization');

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.attendanceShift.create({
        data: {
          organizationId: input.organizationId, code: input.code, name: input.name,
          startTime: input.startTime, endTime: input.endTime,
          breakMinutes: input.breakMinutes, lateGraceMinutes: input.lateGraceMinutes, earlyLeaveGraceMinutes: input.earlyLeaveGraceMinutes,
          // Derived, never taken from the client: a shift that ends at or before it starts runs into the next day.
          isOvernight: isOvernightShift(input.startTime, input.endTime),
        },
        include: shiftInclude,
      });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CREATE_SHIFT, 'AttendanceShift', created.id, {
        code: created.code, name: created.name, startTime: created.startTime, endTime: created.endTime, isOvernight: created.isOvernight,
      }), tx);
      return created;
    });
    return toShiftDto(row);
  },

  async update(id: string, input: UpdateShiftInput, actor: Actor): Promise<ShiftDto> {
    const before = await findOrThrow(id);
    const startTime = input.startTime ?? before.startTime;
    const endTime = input.endTime ?? before.endTime;
    if (startTime === endTime) throw new AppError(400, 'VALIDATION_ERROR', 'A shift cannot start and end at the same time');

    const row = await prisma.$transaction(async (tx) => {
      const after = await tx.attendanceShift.update({
        where: { id },
        data: { ...input, startTime, endTime, isOvernight: isOvernightShift(startTime, endTime) },
        include: shiftInclude,
      });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.UPDATE_SHIFT, 'AttendanceShift', id,
        { startTime: after.startTime, endTime: after.endTime, breakMinutes: after.breakMinutes, lateGraceMinutes: after.lateGraceMinutes, earlyLeaveGraceMinutes: after.earlyLeaveGraceMinutes, isActive: after.isActive },
        { startTime: before.startTime, endTime: before.endTime, breakMinutes: before.breakMinutes, lateGraceMinutes: before.lateGraceMinutes, earlyLeaveGraceMinutes: before.earlyLeaveGraceMinutes, isActive: before.isActive }), tx);
      return after;
    });
    // Existing attendance is NOT recalculated: a day was worked against the shift as it was, and rewriting history
    // because a pattern changed today would quietly alter what people were paid for.
    return toShiftDto(row);
  },
};
