import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateHolidayInput, type HolidayDto, type UpdateHolidayInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import type { Actor } from './calendars.service';

type Db = Prisma.TransactionClient | typeof prisma;
type Row = Prisma.HolidayGetPayload<object>;
const toDto = (h: Row): HolidayDto => ({ id: h.id, calendarId: h.calendarId, date: h.date, name: h.name, isActive: h.isActive, createdAt: h.createdAt.toISOString(), updatedAt: h.updatedAt.toISOString() });
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent, action: AUDIT_ACTIONS[action], module: 'calendar', recordType: 'Holiday', recordId, oldValue, newValue });

async function findOrThrow(db: Db, id: string) {
  const row = await db.holiday.findUnique({ where: { id } });
  if (!row) throw new AppError(404, 'HOLIDAY_NOT_FOUND', 'Holiday not found');
  return row;
}
async function assertDateFree(db: Db, calendarId: string, date: string, exceptId?: string) {
  const existing = await db.holiday.findUnique({ where: { calendarId_date: { calendarId, date } } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'HOLIDAY_ALREADY_EXISTS', `A holiday on ${date} already exists in this calendar`);
}

export const holidaysService = {
  async list(calendarId: string, q: { year?: number; status?: 'active' | 'inactive' }) {
    if (!(await prisma.workCalendar.findUnique({ where: { id: calendarId } }))) throw new AppError(404, 'CALENDAR_NOT_FOUND', 'Calendar not found');
    const where: Prisma.HolidayWhereInput = { calendarId, isActive: q.status ? q.status === 'active' : undefined, date: q.year ? { startsWith: `${q.year}-` } : undefined };
    return (await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } })).map(toDto);
  },
  async create(calendarId: string, input: CreateHolidayInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      if (!(await tx.workCalendar.findUnique({ where: { id: calendarId } }))) throw new AppError(404, 'CALENDAR_NOT_FOUND', 'Calendar not found');
      await assertDateFree(tx, calendarId, input.date);
      const created = await tx.holiday.create({ data: { calendarId, date: input.date, name: input.name, createdBy: actor.auth.userId, updatedBy: actor.auth.userId } });
      await auditService.log(audit(actor, 'CREATE_HOLIDAY', created.id, undefined, { calendarId, date: created.date, name: created.name }), tx);
      return created;
    });
    return toDto(row);
  },
  async update(id: string, input: UpdateHolidayInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.date) await assertDateFree(tx, before.calendarId, input.date, id);
      const after = await tx.holiday.update({ where: { id }, data: { date: input.date, name: input.name, updatedBy: actor.auth.userId } });
      const diff = diffFields({ date: before.date, name: before.name }, { date: after.date, name: after.name });
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_HOLIDAY', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },
  async setActive(id: string, isActive: boolean, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive === isActive) return before;
      const after = await tx.holiday.update({ where: { id }, data: { isActive, updatedBy: actor.auth.userId } });
      await auditService.log(audit(actor, isActive ? 'ACTIVATE_HOLIDAY' : 'DEACTIVATE_HOLIDAY', id, { isActive: before.isActive }, { isActive }), tx);
      return after;
    });
    return toDto(row);
  },
};
