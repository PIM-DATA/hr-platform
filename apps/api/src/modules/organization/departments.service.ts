import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateDepartmentInput, type DepartmentDto, type DepartmentListQuery, type UpdateDepartmentHeadInput, type UpdateDepartmentInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { MODULE, actorMeta, inUse, notFound, paging, type Actor, type Db } from './organization.shared';

/** The caller's transaction: these services compose into a bulk operation (onboarding import) without nesting transactions. */
export type Tx = Prisma.TransactionClient;

const include = {
  organization: { select: { id: true, code: true, name: true } },
  parent: { select: { id: true, code: true, name: true } },
  headEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  _count: { select: { children: true, positions: true, employees: true } },
} satisfies Prisma.DepartmentInclude;
type Row = Prisma.DepartmentGetPayload<{ include: typeof include }>;

const toDto = (d: Row): DepartmentDto => ({
  id: d.id, organizationId: d.organizationId, organization: d.organization, parentId: d.parentId, parent: d.parent,
  code: d.code, name: d.name, isActive: d.isActive, headEmployee: d.headEmployee,
  childCount: d._count.children, positionCount: d._count.positions, employeeCount: d._count.employees,
  createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(),
});

async function findOrThrow(db: Db | typeof prisma, id: string) {
  const row = await db.department.findUnique({ where: { id }, include });
  if (!row) throw notFound.department();
  return row;
}

async function assertCodeFree(db: Db, organizationId: string, code: string, exceptId?: string) {
  const existing = await db.department.findUnique({ where: { organizationId_code: { organizationId, code } } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'DEPARTMENT_CODE_EXISTS', `Department code ${code} already exists in this organization`);
}

/**
 * Validates a (new) parent for `departmentId` (undefined when creating):
 *  exists · same organization · active · not itself · not one of its own descendants (cycle).
 * Walks the parent chain in memory using one query for the organization's departments.
 */
async function assertValidParent(db: Db, organizationId: string, parentId: string, departmentId?: string) {
  if (departmentId && parentId === departmentId) throw new AppError(400, 'SELF_PARENT_NOT_ALLOWED', 'A department cannot be its own parent');
  const parent = await db.department.findUnique({ where: { id: parentId } });
  if (!parent) throw new AppError(404, 'PARENT_DEPARTMENT_NOT_FOUND', 'Parent department not found');
  if (parent.organizationId !== organizationId) throw new AppError(400, 'PARENT_ORGANIZATION_MISMATCH', 'Parent department belongs to a different organization');
  if (!parent.isActive) throw new AppError(409, 'PARENT_DEPARTMENT_INACTIVE', 'Parent department is inactive');
  if (departmentId) {
    const all = await db.department.findMany({ where: { organizationId }, select: { id: true, parentId: true } });
    const parentOf = new Map(all.map((d) => [d.id, d.parentId]));
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === departmentId) throw new AppError(400, 'CIRCULAR_HIERARCHY', 'This move would create a cycle in the department hierarchy');
      if (seen.has(cursor)) break; // defensive: pre-existing cycle in data
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  ...actorMeta(actor), action: AUDIT_ACTIONS[action], module: MODULE, recordType: 'Department', recordId, oldValue, newValue,
});

/** Create on the caller's transaction (shared by the HTTP path and the onboarding importer). */
export async function createDepartmentWithTx(tx: Tx, input: CreateDepartmentInput, actor: Actor) {
  const org = await tx.organization.findUnique({ where: { id: input.organizationId } });
  if (!org) throw notFound.organization();
  if (!org.isActive) throw new AppError(409, 'ORGANIZATION_INACTIVE', 'Cannot add a department to an inactive organization');
  if (input.parentId) await assertValidParent(tx, input.organizationId, input.parentId);
  await assertCodeFree(tx, input.organizationId, input.code);
  const created = await tx.department.create({ data: { organizationId: input.organizationId, parentId: input.parentId ?? null, code: input.code, name: input.name }, include });
  await auditService.log(audit(actor, 'CREATE_DEPARTMENT', created.id, undefined, { organizationId: created.organizationId, parentId: created.parentId, code: created.code, name: created.name }), tx);
  return created;
}

export const departmentsService = {
  async list(q: DepartmentListQuery) {
    const where: Prisma.DepartmentWhereInput = {};
    if (q.organizationId) where.organizationId = q.organizationId;
    if (q.parentId) where.parentId = q.parentId;
    if (q.status) where.isActive = q.status === 'active';
    if (q.search) where.OR = [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }];
    const [total, rows] = await prisma.$transaction([
      prisma.department.count({ where }),
      prisma.department.findMany({ where, include, orderBy: { [q.sortBy]: q.sortDir }, ...paging(q) }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreateDepartmentInput, actor: Actor) {
    const row = await prisma.$transaction((tx) => createDepartmentWithTx(tx, input, actor));
    return toDto(row);
  },

  async update(id: string, input: UpdateDepartmentInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.parentId) await assertValidParent(tx, before.organizationId, input.parentId, id);
      if (input.code) await assertCodeFree(tx, before.organizationId, input.code, id);
      const after = await tx.department.update({
        where: { id },
        data: { code: input.code, name: input.name, parentId: input.parentId === undefined ? undefined : input.parentId },
        include,
      });
      const diff = diffFields({ code: before.code, name: before.name, parentId: before.parentId }, { code: after.code, name: after.name, parentId: after.parentId });
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_DEPARTMENT', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  /** Guard: no active child departments, active positions or active employees. */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      const [children, positions, employees] = await Promise.all([
        tx.department.count({ where: { parentId: id, isActive: true } }),
        tx.position.count({ where: { departmentId: id, isActive: true } }),
        tx.employee.count({ where: { departmentId: id, employmentStatus: 'ACTIVE' } }),
      ]);
      const reasons = [children && `${children} active sub-department(s)`, positions && `${positions} active position(s)`, employees && `${employees} active employee(s)`].filter(Boolean) as string[];
      if (reasons.length) throw inUse('DEPARTMENT_IN_USE', 'Department', reasons);
      const after = await tx.department.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_DEPARTMENT', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },

  /** Re-activation requires an active organization and (if any) an active parent. */
  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      const org = await tx.organization.findUniqueOrThrow({ where: { id: before.organizationId } });
      if (!org.isActive) throw new AppError(409, 'ORGANIZATION_INACTIVE', 'Activate the organization first');
      if (before.parentId) {
        const parent = await tx.department.findUniqueOrThrow({ where: { id: before.parentId } });
        if (!parent.isActive) throw new AppError(409, 'PARENT_DEPARTMENT_INACTIVE', 'Activate the parent department first');
      }
      const after = await tx.department.update({ where: { id }, data: { isActive: true }, include });
      await auditService.log(audit(actor, 'ACTIVATE_DEPARTMENT', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },

  /**
   * Department head (≠ manager relationship — never touches employees.managerId).
   * Head must be an ACTIVE employee whose current assignment is in this department (hence this organization).
   */
  async setHead(id: string, input: UpdateDepartmentHeadInput, actor: Actor) {
    const row = await prisma.$transaction((tx) => setDepartmentHeadWithTx(tx, id, input.employeeId, actor));
    return toDto(row);
  },
};

/** Department-head assignment on the caller's transaction (shared by the HTTP path and the onboarding importer). */
export async function setDepartmentHeadWithTx(tx: Tx, id: string, employeeId: string | null, actor: Actor) {
  const before = await findOrThrow(tx, id);
  if (employeeId) {
    const emp = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, employeeCode: true, employmentStatus: true, organizationId: true, departmentId: true } });
    if (!emp) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    if (emp.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_INACTIVE', `${emp.employeeCode} is not an active employee`);
    if (emp.organizationId !== before.organizationId) throw new AppError(400, 'HEAD_ORGANIZATION_MISMATCH', `${emp.employeeCode} belongs to a different organization`);
    if (emp.departmentId !== id) throw new AppError(400, 'HEAD_DEPARTMENT_MISMATCH', `${emp.employeeCode} is not assigned to this department`);
  }
  if (before.headEmployeeId === employeeId) return before;
  const after = await tx.department.update({ where: { id }, data: { headEmployeeId: employeeId }, include });
  await auditService.log(audit(actor, 'UPDATE_DEPARTMENT_HEAD', id, { headEmployeeId: before.headEmployeeId }, { headEmployeeId: after.headEmployeeId }), tx);
  return after;
}
