import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateLeaveTypeInput, type LeaveTypeDto, type UpdateLeaveTypeInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
type Db = Prisma.TransactionClient | typeof prisma;
const include = { _count: { select: { policies: { where: { isActive: true } } } } } satisfies Prisma.LeaveTypeInclude;
type Row = Prisma.LeaveTypeGetPayload<{ include: typeof include }>;
const toDto = (t: Row): LeaveTypeDto => ({ id: t.id, code: t.code, name: t.name, description: t.description, isActive: t.isActive, activePolicyCount: t._count.policies, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString() });
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent, action: AUDIT_ACTIONS[action], module: 'leave', recordType: 'LeaveType', recordId, oldValue, newValue });

async function findOrThrow(db: Db, id: string) {
  const row = await db.leaveType.findUnique({ where: { id }, include });
  if (!row) throw new AppError(404, 'LEAVE_TYPE_NOT_FOUND', 'Leave type not found');
  return row;
}
async function assertCodeFree(db: Db, code: string, exceptId?: string) {
  const existing = await db.leaveType.findUnique({ where: { code } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'LEAVE_TYPE_CODE_ALREADY_EXISTS', `Leave type code ${code} already exists`);
}

export const leaveTypesService = {
  async list(q: { page: number; pageSize: number; search?: string; status?: 'active' | 'inactive' }) {
    const where: Prisma.LeaveTypeWhereInput = { isActive: q.status ? q.status === 'active' : undefined };
    if (q.search) where.OR = [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }];
    const [total, rows] = await prisma.$transaction([prisma.leaveType.count({ where }), prisma.leaveType.findMany({ where, include, orderBy: { code: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },
  async create(input: CreateLeaveTypeInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      await assertCodeFree(tx, input.code);
      const created = await tx.leaveType.create({ data: { code: input.code, name: input.name, description: input.description ?? null }, include });
      await auditService.log(audit(actor, 'CREATE_LEAVE_TYPE', created.id, undefined, { code: created.code, name: created.name }), tx);
      return created;
    });
    return toDto(row);
  },
  async update(id: string, input: UpdateLeaveTypeInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.code) await assertCodeFree(tx, input.code, id);
      const after = await tx.leaveType.update({ where: { id }, data: { code: input.code, name: input.name, description: input.description === undefined ? undefined : input.description }, include });
      const pick = (t: Row) => ({ code: t.code, name: t.name, description: t.description });
      const diff = diffFields(pick(before), pick(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_LEAVE_TYPE', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },
  /** Guard: no active policy may reference the type (deactivate policies first; no cascade). */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      if (before._count.policies > 0) throw new AppError(409, 'LEAVE_TYPE_IN_USE', `${before.code} is used by ${before._count.policies} active polic${before._count.policies === 1 ? 'y' : 'ies'}; deactivate them first`);
      const after = await tx.leaveType.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_LEAVE_TYPE', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },
  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      const after = await tx.leaveType.update({ where: { id }, data: { isActive: true }, include });
      await auditService.log(audit(actor, 'ACTIVATE_LEAVE_TYPE', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },
};
