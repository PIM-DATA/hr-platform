import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, PERMISSIONS,
  type ChangeEmployeeManagerInput, type ChangeEmployeePositionInput, type CreateEmployeeInput, type EmployeeDetail, type EmployeeListItem,
  type EmployeeListQuery, type EmployeeSelectorOption, type EmployeeSelectorQuery, type ManagerHistoryItem, type PositionHistoryItem, type UpdateEmployeeProfileInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from './employees.scope';
import { assertValidManager, resolvePositionAssignment } from './assignment.service';

type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
type Db = Prisma.TransactionClient | typeof prisma;
const MODULE = 'employees';

const orgRef = { select: { id: true, code: true, name: true } } as const;
const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true } } as const;

const listInclude = {
  organization: orgRef,
  department: orgRef,
  position: { select: { id: true, code: true, title: true } },
  manager: employeeRef,
} satisfies Prisma.EmployeeInclude;
type ListRow = Prisma.EmployeeGetPayload<{ include: typeof listInclude }>;

const detailInclude = {
  ...listInclude,
  position: { select: { id: true, code: true, title: true, job: { select: { id: true, code: true, title: true, level: true } } } },
  headOfDepartments: { where: { isActive: true }, ...orgRef },
  user: { select: { id: true, email: true, isActive: true, lastLoginAt: true } },
  _count: { select: { directReports: { where: { employmentStatus: 'ACTIVE' } } } },
} satisfies Prisma.EmployeeInclude;
type DetailRow = Prisma.EmployeeGetPayload<{ include: typeof detailInclude }>;

function toListItem(e: ListRow): EmployeeListItem {
  return {
    id: e.id, employeeCode: e.employeeCode, firstName: e.firstName, lastName: e.lastName, nickname: e.nickname, email: e.email,
    employmentType: e.employmentType, employmentStatus: e.employmentStatus, hireDate: e.hireDate.toISOString(),
    organization: e.organization, department: e.department, position: { id: e.position.id, code: e.position.code, title: e.position.title }, manager: e.manager,
  };
}

function toDetail(e: DetailRow, auth: AuthContext): EmployeeDetail {
  const base = toListItem(e as unknown as ListRow);
  return {
    ...base,
    phone: e.phone, terminationDate: e.terminationDate?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
    job: e.position.job, directReportCount: e._count.directReports, headOfDepartments: e.headOfDepartments,
    // administrative account data only for callers allowed to manage users
    ...(hasPermission(auth, PERMISSIONS.USERS_VIEW)
      ? { account: e.user ? { ...e.user, lastLoginAt: e.user.lastLoginAt?.toISOString() ?? null } : null }
      : {}),
  };
}

const actorMeta = (a: Actor) => ({ userId: a.auth.userId, ipAddress: a.ipAddress, userAgent: a.userAgent });
const audit = (a: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  ...actorMeta(a), action: AUDIT_ACTIONS[action], module: MODULE, recordType: 'Employee', recordId, oldValue, newValue,
});

/**
 * Phase 1 effective-date policy for assignment changes (no scheduled assignments yet):
 *   default now · never in the future · never before the start of the current open history row.
 * Backdating inside the current assignment is allowed; endDate stays an exclusive boundary.
 */
function resolveEffectiveDate(requested: Date | undefined, currentStart: Date | null): Date {
  const now = new Date();
  const effective = requested ?? now;
  if (effective.getTime() > now.getTime()) {
    throw new AppError(400, 'FUTURE_EFFECTIVE_DATE_NOT_SUPPORTED', 'Effective date cannot be in the future (scheduled assignments are not supported yet)');
  }
  if (currentStart && effective.getTime() < currentStart.getTime()) {
    throw new AppError(400, 'INVALID_EFFECTIVE_DATE', `Effective date cannot be before the start of the current assignment (${currentStart.toISOString()})`);
  }
  return effective;
}

/** Scoped lookup: an employee outside the caller's data scope is reported as not found (no existence leak). */
async function findInScope(db: Db, auth: AuthContext, id: string) {
  const row = await db.employee.findFirst({ where: { AND: [{ id }, employeeScopeWhere(auth)] }, include: detailInclude });
  if (!row) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return row;
}

async function assertUnique(db: Db, field: 'employeeCode' | 'email', value: string, exceptId?: string) {
  const existing = await db.employee.findUnique({ where: field === 'email' ? { email: value } : { employeeCode: value } });
  if (existing && existing.id !== exceptId) {
    throw field === 'email'
      ? new AppError(409, 'EMAIL_ALREADY_EXISTS', 'An employee with this email already exists')
      : new AppError(409, 'EMPLOYEE_CODE_ALREADY_EXISTS', `Employee code ${value} already exists`);
  }
}

const SORT: Record<EmployeeListQuery['sortBy'], (d: 'asc' | 'desc') => Prisma.EmployeeOrderByWithRelationInput> = {
  employeeCode: (d) => ({ employeeCode: d }),
  firstName: (d) => ({ firstName: d }),
  lastName: (d) => ({ lastName: d }),
  hireDate: (d) => ({ hireDate: d }),
  createdAt: (d) => ({ createdAt: d }),
};

export const employeesService = {
  async list(auth: AuthContext, q: EmployeeListQuery) {
    const filters: Prisma.EmployeeWhereInput = {};
    if (q.organizationId) filters.organizationId = q.organizationId;
    if (q.departmentId) filters.departmentId = q.departmentId;
    if (q.positionId) filters.positionId = q.positionId;
    if (q.managerId) filters.managerId = q.managerId;
    if (q.employmentType) filters.employmentType = q.employmentType;
    if (q.employmentStatus) filters.employmentStatus = q.employmentStatus;
    if (q.search) {
      const terms = q.search.split(/\s+/).filter(Boolean);
      // every term must match some field → "Somchai Prasert" finds by full name
      filters.AND = terms.map((t) => ({ OR: [{ employeeCode: { contains: t } }, { firstName: { contains: t } }, { lastName: { contains: t } }, { nickname: { contains: t } }, { email: { contains: t } }] }));
    }
    const where: Prisma.EmployeeWhereInput = { AND: [employeeScopeWhere(auth), filters] };
    const [total, rows] = await prisma.$transaction([
      prisma.employee.count({ where }),
      prisma.employee.findMany({ where, include: listInclude, orderBy: SORT[q.sortBy](q.sortDir), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toListItem), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(auth: AuthContext, id: string): Promise<EmployeeDetail> {
    return toDetail(await findInScope(prisma, auth, id), auth);
  },

  async positionHistory(auth: AuthContext, id: string): Promise<PositionHistoryItem[]> {
    await findInScope(prisma, auth, id);
    const rows = await prisma.employeePosition.findMany({
      where: { employeeId: id },
      include: { position: { select: { id: true, code: true, title: true } }, department: { select: { id: true, code: true, name: true, organization: orgRef } } },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({ id: r.id, position: r.position, department: { id: r.department.id, code: r.department.code, name: r.department.name }, organization: r.department.organization, startDate: r.startDate.toISOString(), endDate: r.endDate?.toISOString() ?? null }));
  },

  async managerHistory(auth: AuthContext, id: string): Promise<ManagerHistoryItem[]> {
    await findInScope(prisma, auth, id);
    const rows = await prisma.employeeManager.findMany({
      where: { employeeId: id },
      include: { manager: { select: { id: true, employeeCode: true, firstName: true, lastName: true, position: { select: { id: true, title: true } } } } },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({ id: r.id, manager: r.manager, startDate: r.startDate.toISOString(), endDate: r.endDate?.toISOString() ?? null }));
  },

  /** Direct reports of an in-scope employee, themselves filtered by the caller's scope (TEAM cannot see a report's reports). */
  async directReports(auth: AuthContext, id: string): Promise<EmployeeListItem[]> {
    await findInScope(prisma, auth, id);
    const rows = await prisma.employee.findMany({ where: { AND: [{ managerId: id }, employeeScopeWhere(auth)] }, include: listInclude, orderBy: { employeeCode: 'asc' } });
    return rows.map(toListItem);
  },

  /** Selector search (manager / department-head pickers): active, in scope, max 20. */
  async options(auth: AuthContext, q: EmployeeSelectorQuery): Promise<EmployeeSelectorOption[]> {
    const filters: Prisma.EmployeeWhereInput = { employmentStatus: 'ACTIVE' };
    if (q.departmentId) filters.departmentId = q.departmentId;
    if (q.excludeId) filters.id = { not: q.excludeId };
    if (q.search) {
      const terms = q.search.split(/\s+/).filter(Boolean);
      filters.AND = terms.map((t) => ({ OR: [{ employeeCode: { contains: t } }, { firstName: { contains: t } }, { lastName: { contains: t } }, { email: { contains: t } }] }));
    }
    const rows = await prisma.employee.findMany({
      where: { AND: [employeeScopeWhere(auth), filters] },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, position: { select: { id: true, title: true } }, department: orgRef },
      orderBy: { employeeCode: 'asc' },
      take: 20,
    });
    return rows;
  },

  /** Create employee + initial position history (+ manager history) + audit, atomically. */
  async create(input: CreateEmployeeInput, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      await assertUnique(tx, 'employeeCode', input.employeeCode);
      await assertUnique(tx, 'email', input.email);
      const assignment = await resolvePositionAssignment(tx, input.positionId);
      if (input.managerId) await assertValidManager(tx, null, input.managerId);
      const startDate = input.hireDate;
      const created = await tx.employee.create({
        data: {
          employeeCode: input.employeeCode, firstName: input.firstName, lastName: input.lastName, nickname: input.nickname ?? null,
          email: input.email, phone: input.phone ?? null, hireDate: input.hireDate, employmentType: input.employmentType, employmentStatus: 'ACTIVE',
          ...assignment, managerId: input.managerId ?? null, createdBy: actor.auth.userId, updatedBy: actor.auth.userId,
          positionHistory: { create: { positionId: assignment.positionId, departmentId: assignment.departmentId, startDate } },
          managerHistory: input.managerId ? { create: { managerId: input.managerId, startDate } } : undefined,
        },
        include: detailInclude,
      });
      await auditService.log(audit(actor, 'CREATE_EMPLOYEE', created.id, undefined, {
        employeeCode: created.employeeCode, firstName: created.firstName, lastName: created.lastName, email: created.email, hireDate: created.hireDate, employmentType: created.employmentType,
        organizationId: created.organizationId, departmentId: created.departmentId, positionId: created.positionId, managerId: created.managerId,
      }), tx);
      return created;
    });
    return toDetail(row, actor.auth);
  },

  /** Profile fields only — assignment fields are rejected by the schema and never touched here. */
  async updateProfile(id: string, input: UpdateEmployeeProfileInput, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findInScope(tx, actor.auth, id);
      if (input.employeeCode) await assertUnique(tx, 'employeeCode', input.employeeCode, id);
      if (input.email) await assertUnique(tx, 'email', input.email, id);
      const after = await tx.employee.update({
        where: { id },
        data: {
          employeeCode: input.employeeCode, firstName: input.firstName, lastName: input.lastName, nickname: input.nickname === undefined ? undefined : input.nickname,
          email: input.email, phone: input.phone === undefined ? undefined : input.phone, hireDate: input.hireDate, employmentType: input.employmentType, updatedBy: actor.auth.userId,
        },
        include: detailInclude,
      });
      const pick = (e: DetailRow) => ({ employeeCode: e.employeeCode, firstName: e.firstName, lastName: e.lastName, nickname: e.nickname, email: e.email, phone: e.phone, hireDate: e.hireDate.toISOString(), employmentType: e.employmentType });
      const diff = diffFields(pick(before), pick(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_EMPLOYEE', id, diff.old, diff.new), tx);
      return after;
    });
    return toDetail(row, actor.auth);
  },

  /**
   * Position change: close the open position history row, open a new one, update the three current
   * pointers (position/department/organization derived from the position) and audit — one transaction.
   * Invariant: at most one open (endDate = null) position history row per employee.
   */
  async changePosition(id: string, input: ChangeEmployeePositionInput, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findInScope(tx, actor.auth, id);
      if (before.positionId === input.positionId) return before; // no-op, no duplicate history
      const next = await resolvePositionAssignment(tx, input.positionId);
      const blockingHead = before.headOfDepartments.find((d) => d.id !== next.departmentId);
      if (blockingHead) {
        throw new AppError(409, 'EMPLOYEE_IS_DEPARTMENT_HEAD', `${before.employeeCode} is head of department ${blockingHead.code}; change or clear the department head before moving them`);
      }
      const open = await tx.employeePosition.findFirst({ where: { employeeId: id, endDate: null }, select: { startDate: true } });
      const effective = resolveEffectiveDate(input.effectiveDate, open?.startDate ?? null);
      await tx.employeePosition.updateMany({ where: { employeeId: id, endDate: null }, data: { endDate: effective } });
      await tx.employeePosition.create({ data: { employeeId: id, positionId: next.positionId, departmentId: next.departmentId, startDate: effective } });
      const after = await tx.employee.update({ where: { id }, data: { ...next, updatedBy: actor.auth.userId }, include: detailInclude });
      await auditService.log(audit(actor, 'CHANGE_EMPLOYEE_POSITION', id,
        { organizationId: before.organizationId, departmentId: before.departmentId, positionId: before.positionId },
        { organizationId: after.organizationId, departmentId: after.departmentId, positionId: after.positionId, effectiveDate: effective },
      ), tx);
      return after;
    });
    return toDetail(row, actor.auth);
  },

  /** Manager change (or clear with null). Invariant: at most one open manager history row per employee. */
  async changeManager(id: string, input: ChangeEmployeeManagerInput, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findInScope(tx, actor.auth, id);
      if (before.managerId === input.managerId) return before; // no-op
      if (input.managerId) await assertValidManager(tx, id, input.managerId);
      const open = await tx.employeeManager.findFirst({ where: { employeeId: id, endDate: null }, select: { startDate: true } });
      const effective = resolveEffectiveDate(input.effectiveDate, open?.startDate ?? null);
      await tx.employeeManager.updateMany({ where: { employeeId: id, endDate: null }, data: { endDate: effective } });
      if (input.managerId) await tx.employeeManager.create({ data: { employeeId: id, managerId: input.managerId, startDate: effective } });
      const after = await tx.employee.update({ where: { id }, data: { managerId: input.managerId, updatedBy: actor.auth.userId }, include: detailInclude });
      await auditService.log(audit(actor, 'CHANGE_EMPLOYEE_MANAGER', id, { managerId: before.managerId }, { managerId: after.managerId, effectiveDate: effective }), tx);
      return after;
    });
    return toDetail(row, actor.auth);
  },

  /** INACTIVE (not TERMINATED). Refused while the employee still manages active reports or heads an active department. Linked user account is NOT touched. */
  async deactivate(id: string, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findInScope(tx, actor.auth, id);
      if (before.employmentStatus === 'INACTIVE') return before;
      const activeDirectReports = before._count.directReports;
      const headedDepartments = before.headOfDepartments.length;
      if (activeDirectReports > 0 || headedDepartments > 0) {
        throw new AppError(409, 'EMPLOYEE_IN_USE',
          `${before.employeeCode} still manages ${activeDirectReports} active employee(s) and heads ${headedDepartments} department(s); reassign them first`,
          [{ field: 'activeDirectReports', message: String(activeDirectReports) }, { field: 'headedDepartments', message: String(headedDepartments) }]);
      }
      const after = await tx.employee.update({ where: { id }, data: { employmentStatus: 'INACTIVE', updatedBy: actor.auth.userId }, include: detailInclude });
      await auditService.log(audit(actor, 'DEACTIVATE_EMPLOYEE', id, { employmentStatus: before.employmentStatus }, { employmentStatus: 'INACTIVE' }), tx);
      return after;
    });
    return toDetail(row, actor.auth);
  },

  /** Re-activation requires the current assignment to be valid (position chain + manager active). */
  async activate(id: string, actor: Actor): Promise<EmployeeDetail> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findInScope(tx, actor.auth, id);
      if (before.employmentStatus === 'ACTIVE') return before;
      try {
        await resolvePositionAssignment(tx, before.positionId);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 409) throw new AppError(409, 'EMPLOYEE_POSITION_INACTIVE', `Current assignment is no longer valid (${err.message}); change the position before activating`);
        throw err;
      }
      if (before.managerId) {
        const manager = await tx.employee.findUnique({ where: { id: before.managerId }, select: { employmentStatus: true, employeeCode: true } });
        if (!manager || manager.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_MANAGER_INACTIVE', `Current manager ${manager?.employeeCode ?? ''} is not active; change the manager before activating`);
      }
      const after = await tx.employee.update({ where: { id }, data: { employmentStatus: 'ACTIVE', updatedBy: actor.auth.userId }, include: detailInclude });
      await auditService.log(audit(actor, 'ACTIVATE_EMPLOYEE', id, { employmentStatus: before.employmentStatus }, { employmentStatus: 'ACTIVE' }), tx);
      return after;
    });
    return toDetail(row, actor.auth);
  },
};
