import { AUDIT_ACTIONS, WORKFORCE_CYCLE_TRANSITIONS, type CreateWorkforceCycleInput, type UpdateWorkforceCycleInput, type WorkforceCycleDto, type WorkforceCycleListQuery, type WorkforceCycleStatus } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { canManage, canPlan, currentHeadcountByGrain, lockRow, notFound, textAudit, workforceAudit, type Actor, type Db } from './workforce.types';

/**
 * Planning cycles. A cycle is a container for one plan; its status decides whether the plan is editable (DRAFT),
 * under review (ACTIVE), frozen (FINALIZED) or historical (ARCHIVED). Finalizing re-snapshots the current headcount
 * on every row — so the plan stays readable after the real workforce moves on — and does nothing to any live table.
 */
const include = { _count: { select: { items: true } } } as const;
type Row = Prisma.WorkforcePlanningCycleGetPayload<{ include: typeof include }>;
const orgOf = async (db: Db, id: string | null) => (id ? db.organization.findUnique({ where: { id }, select: { name: true } }) : null);
async function dto(db: Db, row: Row, auth: AuthContext): Promise<WorkforceCycleDto> {
  const org = await orgOf(db, row.organizationId);
  return {
    id: row.id, code: row.code, name: row.name, organizationId: row.organizationId, organizationName: org?.name ?? null, periodStart: row.periodStart, periodEnd: row.periodEnd,
    status: row.status as WorkforceCycleStatus, description: row.description, itemCount: row._count.items, finalizedAt: row.finalizedAt?.toISOString() ?? null, archivedAt: row.archivedAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    can: { edit: row.status === 'DRAFT' && canPlan(auth), finalize: row.status === 'ACTIVE' && canManage(auth) },
  };
}
export async function loadCycle(db: Db, id: string) {
  const row = await db.workforcePlanningCycle.findUnique({ where: { id }, include });
  if (!row) throw notFound('planning cycle');
  return row;
}
export const assertDraft = (row: { status: string }) => { if (row.status !== 'DRAFT') throw new AppError(409, 'WORKFORCE_CYCLE_NOT_EDITABLE', `This plan is ${row.status.toLowerCase()} and can no longer be edited`); };

export const workforceCycleService = {
  async list(auth: AuthContext, q: WorkforceCycleListQuery) {
    const where: Prisma.WorkforcePlanningCycleWhereInput = { status: q.status, organizationId: q.organizationId };
    const [total, rows] = await prisma.$transaction([prisma.workforcePlanningCycle.count({ where }), prisma.workforcePlanningCycle.findMany({ where, include, orderBy: [{ periodStart: 'desc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => dto(prisma, r, auth))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<WorkforceCycleDto> { return dto(prisma, await loadCycle(prisma, id), auth); },

  async create(input: CreateWorkforceCycleInput, actor: Actor): Promise<WorkforceCycleDto> {
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
    if (await prisma.workforcePlanningCycle.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'WORKFORCE_CYCLE_CODE_EXISTS', 'A planning cycle with this code already exists');
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.workforcePlanningCycle.create({ data: { code: input.code.toUpperCase(), name: input.name, organizationId: input.organizationId ?? null, periodStart: input.periodStart, periodEnd: input.periodEnd, description: input.description ?? null, createdByUserId: actor.auth.userId }, include });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.CREATE_WORKFORCE_CYCLE, 'WorkforcePlanningCycle', created.id, { code: created.code, name: created.name, periodStart: created.periodStart, periodEnd: created.periodEnd, organizationId: created.organizationId, ...textAudit('description', null, created.description) }), tx);
      return created;
    });
    return dto(prisma, row, actor.auth);
  },

  async update(id: string, input: UpdateWorkforceCycleInput, actor: Actor): Promise<WorkforceCycleDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'workforce_planning_cycles', id);
      const before = await loadCycle(tx, id);
      if (before.status === 'FINALIZED' || before.status === 'ARCHIVED') throw new AppError(409, 'WORKFORCE_CYCLE_NOT_EDITABLE', 'A finalized or archived cycle cannot be changed');
      const periodStart = input.periodStart ?? before.periodStart; const periodEnd = input.periodEnd ?? before.periodEnd;
      if (periodStart > periodEnd) throw new AppError(422, 'VALIDATION_ERROR', 'periodEnd must not be before periodStart', [{ field: 'periodEnd', message: 'Before the start' }]);
      const after = await tx.workforcePlanningCycle.update({ where: { id }, data: { name: input.name, periodStart, periodEnd, description: input.description === undefined ? undefined : input.description }, include });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_WORKFORCE_CYCLE, 'WorkforcePlanningCycle', id, { name: after.name, periodStart, periodEnd, ...textAudit('description', before.description, after.description) }, { name: before.name, periodStart: before.periodStart, periodEnd: before.periodEnd }), tx);
      return after;
    });
    return dto(prisma, row, actor.auth);
  },

  /**
   * DRAFT → ACTIVE (plan goes into review), ACTIVE → DRAFT (back to editing), ACTIVE → FINALIZED (freeze; needs
   * workforce.manage; re-snapshots current headcount), DRAFT/FINALIZED → ARCHIVED. Under the row lock, so a double
   * finalize sees the second attempt refused.
   */
  async transition(id: string, status: WorkforceCycleStatus, actor: Actor): Promise<WorkforceCycleDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'workforce_planning_cycles', id);
      const before = await loadCycle(tx, id);
      if (!WORKFORCE_CYCLE_TRANSITIONS[before.status as WorkforceCycleStatus].includes(status)) throw new AppError(409, 'WORKFORCE_CYCLE_INVALID_TRANSITION', `A ${before.status.toLowerCase()} cycle cannot become ${status.toLowerCase()}`);
      if ((status === 'FINALIZED' || status === 'ARCHIVED') && !canManage(actor.auth)) throw AppError.forbidden();
      let resnapshot = 0;
      if (status === 'FINALIZED') {
        // Freeze what the workforce looks like right now on every row; the plan's history no longer follows the live master.
        const now = new Date();
        const current = await currentHeadcountByGrain(tx, before.organizationId);
        const items = await tx.workforcePlanItem.findMany({ where: { cycleId: id }, select: { id: true, grainKey: true } });
        for (const it of items) { await tx.workforcePlanItem.update({ where: { id: it.id }, data: { currentHeadcountSnapshot: current.get(it.grainKey)?.count ?? 0, snapshotAt: now } }); resnapshot += 1; }
      }
      const after = await tx.workforcePlanningCycle.update({ where: { id }, data: { status, finalizedAt: status === 'FINALIZED' ? new Date() : undefined, archivedAt: status === 'ARCHIVED' ? new Date() : undefined }, include });
      await auditService.log(workforceAudit(actor, status === 'FINALIZED' ? AUDIT_ACTIONS.FINALIZE_WORKFORCE_CYCLE : AUDIT_ACTIONS.UPDATE_WORKFORCE_CYCLE, 'WorkforcePlanningCycle', id, { status, itemsSnapshotted: resnapshot }, { status: before.status }), tx);
      return after;
    });
    return dto(prisma, row, actor.auth);
  },
};
