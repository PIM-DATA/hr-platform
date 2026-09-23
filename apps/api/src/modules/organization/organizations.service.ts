import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, isValidTimezone, type CreateOrganizationInput, type OrganizationDto, type OrganizationListQuery, type UpdateOrganizationInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { MODULE, actorMeta, inUse, notFound, paging, type Actor, type Db } from './organization.shared';

/** The caller's transaction: these services compose into a bulk operation (onboarding import) without nesting transactions. */
export type Tx = Prisma.TransactionClient;

const include = { _count: { select: { departments: true, employees: true } }, defaultCalendar: { select: { id: true, code: true, name: true } } } satisfies Prisma.OrganizationInclude;
type Row = Prisma.OrganizationGetPayload<{ include: typeof include }>;

const toDto = (o: Row): OrganizationDto => ({
  id: o.id, code: o.code, name: o.name, timezone: o.timezone, defaultCalendar: o.defaultCalendar, isActive: o.isActive,
  departmentCount: o._count.departments, employeeCount: o._count.employees,
  createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
});

async function findOrThrow(db: Db | typeof prisma, id: string) {
  const row = await db.organization.findUnique({ where: { id }, include });
  if (!row) throw notFound.organization();
  return row;
}

async function assertCodeFree(db: Db, code: string, exceptId?: string) {
  const existing = await db.organization.findUnique({ where: { code } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'ORGANIZATION_CODE_EXISTS', `Organization code ${code} already exists`);
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  ...actorMeta(actor), action: AUDIT_ACTIONS[action], module: MODULE, recordType: 'Organization', recordId, oldValue, newValue,
});

/**
 * Create on the caller's transaction, so a bulk operation (customer onboarding import) composes many creates into ONE
 * transaction while running exactly the same invariants and audit as the HTTP path. `timezone` is accepted here only
 * for that importer: the public create endpoint does not expose it (organizations start on the default).
 */
export async function createOrganizationWithTx(tx: Tx, input: CreateOrganizationInput & { timezone?: string }, actor: Actor) {
  await assertCodeFree(tx, input.code);
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw new AppError(400, 'ORGANIZATION_TIMEZONE_INVALID', 'Timezone must be an IANA name such as Asia/Bangkok');
  const created = await tx.organization.create({ data: { code: input.code, name: input.name, ...(input.timezone ? { timezone: input.timezone } : {}) }, include });
  await auditService.log(audit(actor, 'CREATE_ORGANIZATION', created.id, undefined, { code: created.code, name: created.name, ...(input.timezone ? { timezone: input.timezone } : {}) }), tx);
  return created;
}

export const organizationsService = {
  async list(q: OrganizationListQuery) {
    const where: Prisma.OrganizationWhereInput = {};
    if (q.status) where.isActive = q.status === 'active';
    if (q.search) where.OR = [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }];
    const [total, rows] = await prisma.$transaction([
      prisma.organization.count({ where }),
      prisma.organization.findMany({ where, include, orderBy: { [q.sortBy]: q.sortDir }, ...paging(q) }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreateOrganizationInput, actor: Actor) {
    const row = await prisma.$transaction((tx) => createOrganizationWithTx(tx, input, actor));
    return toDto(row);
  },

  async update(id: string, input: UpdateOrganizationInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.code) await assertCodeFree(tx, input.code, id);
      if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw new AppError(400, 'ORGANIZATION_TIMEZONE_INVALID', 'Timezone must be an IANA name such as Asia/Bangkok');
      const after = await tx.organization.update({ where: { id }, data: { code: input.code, name: input.name, timezone: input.timezone }, include });
      const diff = diffFields({ code: before.code, name: before.name, timezone: before.timezone }, { code: after.code, name: after.name, timezone: after.timezone });
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_ORGANIZATION', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  /** Guard: no active departments and no active employees may reference the organization. */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      const [departments, employees] = await Promise.all([
        tx.department.count({ where: { organizationId: id, isActive: true } }),
        tx.employee.count({ where: { organizationId: id, employmentStatus: 'ACTIVE' } }),
      ]);
      const reasons = [departments && `${departments} active department(s)`, employees && `${employees} active employee(s)`].filter(Boolean) as string[];
      if (reasons.length) throw inUse('ORGANIZATION_IN_USE', 'Organization', reasons);
      const after = await tx.organization.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_ORGANIZATION', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },

  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      const after = await tx.organization.update({ where: { id }, data: { isActive: true }, include });
      await auditService.log(audit(actor, 'ACTIVATE_ORGANIZATION', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },
};
