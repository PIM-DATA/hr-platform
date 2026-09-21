import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreatePositionInput, type PositionDto, type PositionListQuery, type UpdatePositionInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { MODULE, actorMeta, inUse, notFound, paging, type Actor, type Db } from './organization.shared';

const include = {
  department: { select: { id: true, code: true, name: true, organization: { select: { id: true, code: true, name: true } } } },
  job: { select: { id: true, code: true, title: true, level: true } },
  _count: { select: { employees: true } },
} satisfies Prisma.PositionInclude;
type Row = Prisma.PositionGetPayload<{ include: typeof include }>;

const toDto = (p: Row): PositionDto => ({
  id: p.id, code: p.code, title: p.title, isActive: p.isActive, department: p.department, job: p.job,
  employeeCount: p._count.employees, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
});

async function findOrThrow(db: Db | typeof prisma, id: string) {
  const row = await db.position.findUnique({ where: { id }, include });
  if (!row) throw notFound.position();
  return row;
}

async function assertCodeFree(db: Db, code: string, exceptId?: string) {
  const existing = await db.position.findUnique({ where: { code } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'POSITION_CODE_EXISTS', `Position code ${code} already exists`);
}

/** An active position must sit in an active department of an active organization. */
async function assertActiveDepartment(db: Db, departmentId: string) {
  const dept = await db.department.findUnique({ where: { id: departmentId }, include: { organization: true } });
  if (!dept) throw notFound.department();
  if (!dept.isActive) throw new AppError(409, 'DEPARTMENT_INACTIVE', 'Department is inactive');
  if (!dept.organization.isActive) throw new AppError(409, 'ORGANIZATION_INACTIVE', 'Organization is inactive');
}

/** An active position must use an active job. */
async function assertActiveJob(db: Db, jobId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw notFound.job();
  if (!job.isActive) throw new AppError(409, 'JOB_INACTIVE', 'Job is inactive');
}

/**
 * Structural fields (departmentId, jobId) define what a position *means*. Once any employee
 * holds or ever held the position (current pointer or employee_positions history), changing them
 * would silently rewrite history and break the employee ↔ department ↔ organization invariant.
 * Moving people between positions/departments is done only through the employee assignment service.
 */
async function assertStructureChangeable(db: Db, positionId: string) {
  const [current, historical] = await Promise.all([
    db.employee.count({ where: { positionId } }),
    db.employeePosition.count({ where: { positionId } }),
  ]);
  if (current > 0 || historical > 0) {
    throw new AppError(
      409,
      'POSITION_ASSIGNMENT_IN_USE',
      `Department and job of this position cannot be changed: it is referenced by ${current} current and ${historical} historical employee assignment(s). Create a new position and move the employees instead.`,
    );
  }
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  ...actorMeta(actor), action: AUDIT_ACTIONS[action], module: MODULE, recordType: 'Position', recordId, oldValue, newValue,
});

export const positionsService = {
  async list(q: PositionListQuery) {
    const where: Prisma.PositionWhereInput = {};
    if (q.departmentId) where.departmentId = q.departmentId;
    if (q.organizationId) where.department = { organizationId: q.organizationId };
    if (q.jobId) where.jobId = q.jobId;
    if (q.status) where.isActive = q.status === 'active';
    if (q.search) where.OR = [{ code: { contains: q.search } }, { title: { contains: q.search } }];
    const [total, rows] = await prisma.$transaction([
      prisma.position.count({ where }),
      prisma.position.findMany({ where, include, orderBy: { [q.sortBy]: q.sortDir }, ...paging(q) }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreatePositionInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      await assertActiveDepartment(tx, input.departmentId);
      await assertActiveJob(tx, input.jobId);
      await assertCodeFree(tx, input.code);
      const created = await tx.position.create({ data: { departmentId: input.departmentId, jobId: input.jobId, code: input.code, title: input.title }, include });
      await auditService.log(audit(actor, 'CREATE_POSITION', created.id, undefined, { departmentId: created.departmentId, jobId: created.jobId, code: created.code, title: created.title }), tx);
      return created;
    });
    return toDto(row);
  },

  async update(id: string, input: UpdatePositionInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      const structuralChange = (input.departmentId !== undefined && input.departmentId !== before.departmentId) || (input.jobId !== undefined && input.jobId !== before.jobId);
      if (structuralChange) await assertStructureChangeable(tx, id);
      // an active position keeps the active-department / active-job invariant when re-pointed
      if (input.departmentId && input.departmentId !== before.departmentId && before.isActive) await assertActiveDepartment(tx, input.departmentId);
      else if (input.departmentId && !(await tx.department.findUnique({ where: { id: input.departmentId } }))) throw notFound.department();
      if (input.jobId && input.jobId !== before.jobId && before.isActive) await assertActiveJob(tx, input.jobId);
      else if (input.jobId && !(await tx.job.findUnique({ where: { id: input.jobId } }))) throw notFound.job();
      if (input.code) await assertCodeFree(tx, input.code, id);
      const after = await tx.position.update({ where: { id }, data: { departmentId: input.departmentId, jobId: input.jobId, code: input.code, title: input.title }, include });
      const pick = (p: Row) => ({ departmentId: p.departmentId, jobId: p.jobId, code: p.code, title: p.title });
      const diff = diffFields(pick(before), pick(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_POSITION', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  /** Guard: no active employees may hold the position. */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      const employees = await tx.employee.count({ where: { positionId: id, employmentStatus: 'ACTIVE' } });
      if (employees) throw inUse('POSITION_IN_USE', 'Position', [`${employees} active employee(s)`]);
      const after = await tx.position.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_POSITION', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },

  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      await assertActiveDepartment(tx, before.departmentId);
      if (before.jobId) await assertActiveJob(tx, before.jobId);
      const after = await tx.position.update({ where: { id }, data: { isActive: true }, include });
      await auditService.log(audit(actor, 'ACTIVATE_POSITION', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },
};
