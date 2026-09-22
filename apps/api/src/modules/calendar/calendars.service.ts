import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, normalizeWorkingDays, type CalendarListQuery, type CreateCalendarInput, type UpdateCalendarInput, type WorkCalendarDto, type Weekday,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
type Db = Prisma.TransactionClient | typeof prisma;
const MODULE = 'calendar';

const include = {
  organization: { select: { id: true, code: true, name: true, defaultCalendarId: true } },
  _count: { select: { holidays: { where: { isActive: true } } } },
} satisfies Prisma.WorkCalendarInclude;
type Row = Prisma.WorkCalendarGetPayload<{ include: typeof include }>;

/** working_days is stored as JSON text; always parsed through the shared normalizer so output is validated + ordered. */
export function parseWorkingDays(text: string): Weekday[] {
  try {
    return normalizeWorkingDays(JSON.parse(text)) ?? [];
  } catch {
    return [];
  }
}

const toDto = (c: Row): WorkCalendarDto => ({
  id: c.id, organization: { id: c.organization.id, code: c.organization.code, name: c.organization.name }, code: c.code, name: c.name,
  workingDays: parseWorkingDays(c.workingDays), isActive: c.isActive, isDefault: c.organization.defaultCalendarId === c.id, holidayCount: c._count.holidays,
  createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
});

async function findOrThrow(db: Db, id: string) {
  const row = await db.workCalendar.findUnique({ where: { id }, include });
  if (!row) throw new AppError(404, 'CALENDAR_NOT_FOUND', 'Calendar not found');
  return row;
}
async function assertCodeFree(db: Db, organizationId: string, code: string, exceptId?: string) {
  const existing = await db.workCalendar.findUnique({ where: { organizationId_code: { organizationId, code } } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'CALENDAR_CODE_ALREADY_EXISTS', `Calendar code ${code} already exists in this organization`);
}
const meta = (a: Actor) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent });
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordType: string, recordId: string, oldValue?: unknown, newValue?: unknown) => ({ ...meta(a), action: AUDIT_ACTIONS[action], module: MODULE, recordType, recordId, oldValue, newValue });

export const calendarsService = {
  async list(q: CalendarListQuery) {
    const where: Prisma.WorkCalendarWhereInput = { organizationId: q.organizationId, isActive: q.status ? q.status === 'active' : undefined };
    if (q.search) where.OR = [{ code: { contains: q.search } }, { name: { contains: q.search } }];
    const [total, rows] = await prisma.$transaction([prisma.workCalendar.count({ where }), prisma.workCalendar.findMany({ where, include, orderBy: [{ organizationId: 'asc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreateCalendarInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
      if (!org) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
      await assertCodeFree(tx, input.organizationId, input.code);
      const created = await tx.workCalendar.create({ data: { organizationId: input.organizationId, code: input.code, name: input.name, workingDays: JSON.stringify(input.workingDays), createdBy: actor.auth.userId, updatedBy: actor.auth.userId }, include });
      await auditService.log(audit(actor, 'CREATE_CALENDAR', 'WorkCalendar', created.id, undefined, { organizationId: created.organizationId, code: created.code, name: created.name, workingDays: input.workingDays }), tx);
      return created;
    });
    return toDto(row);
  },

  async update(id: string, input: UpdateCalendarInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.code) await assertCodeFree(tx, before.organizationId, input.code, id);
      const after = await tx.workCalendar.update({ where: { id }, data: { code: input.code, name: input.name, workingDays: input.workingDays ? JSON.stringify(input.workingDays) : undefined, updatedBy: actor.auth.userId }, include });
      const pick = (c: Row) => ({ code: c.code, name: c.name, workingDays: parseWorkingDays(c.workingDays) });
      const diff = diffFields(pick(before), pick(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_CALENDAR', 'WorkCalendar', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  /** Guard: the organization's default calendar cannot be deactivated (change/clear the default first). */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      if (before.organization.defaultCalendarId === id) throw new AppError(409, 'CALENDAR_IN_USE', 'This calendar is the default calendar of its organization; change or clear the default first');
      const after = await tx.workCalendar.update({ where: { id }, data: { isActive: false, updatedBy: actor.auth.userId }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_CALENDAR', 'WorkCalendar', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },
  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      const after = await tx.workCalendar.update({ where: { id }, data: { isActive: true, updatedBy: actor.auth.userId }, include });
      await auditService.log(audit(actor, 'ACTIVATE_CALENDAR', 'WorkCalendar', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },

  /** Sets (or clears with null) the organization default. Calendar must exist, be active and belong to the organization. */
  async setOrganizationDefault(organizationId: string, calendarId: string | null, actor: Actor) {
    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!org) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
      if (calendarId) {
        const cal = await tx.workCalendar.findUnique({ where: { id: calendarId } });
        if (!cal) throw new AppError(404, 'CALENDAR_NOT_FOUND', 'Calendar not found');
        if (cal.organizationId !== organizationId) throw new AppError(400, 'CALENDAR_ORGANIZATION_MISMATCH', 'Calendar belongs to a different organization');
        if (!cal.isActive) throw new AppError(409, 'CALENDAR_INACTIVE', 'An inactive calendar cannot be the default');
      }
      if (org.defaultCalendarId === calendarId) return { organizationId, defaultCalendarId: calendarId };
      await tx.organization.update({ where: { id: organizationId }, data: { defaultCalendarId: calendarId } });
      await auditService.log(audit(actor, 'SET_DEFAULT_CALENDAR', 'Organization', organizationId, { defaultCalendarId: org.defaultCalendarId }, { defaultCalendarId: calendarId }), tx);
      return { organizationId, defaultCalendarId: calendarId };
    });
  },

  /**
   * Internal (no HTTP permission): effective working calendar for an organization — default calendar + active holidays.
   * Employee-level assignments arrive with Attendance (Phase 2B).
   */
  async effectiveForOrganization(db: Db, organizationId: string): Promise<{ calendarId: string; workingDays: Weekday[]; holidays: Set<string> } | null> {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { defaultCalendar: { select: { id: true, isActive: true, workingDays: true, holidays: { where: { isActive: true }, select: { date: true } } } } } });
    const cal = org?.defaultCalendar;
    if (!cal || !cal.isActive) return null;
    return { calendarId: cal.id, workingDays: parseWorkingDays(cal.workingDays), holidays: new Set(cal.holidays.map((h) => h.date)) };
  },
};
