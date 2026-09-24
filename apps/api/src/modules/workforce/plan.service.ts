import { AUDIT_ACTIONS, REQUISITION_REASON_FOR_PLAN, headcountDelta, planGrainKey, remainingDemand, type AddWorkforcePlanItemInput, type CreatePlannedMovementInput, type PlannedMovementDto, type RecruitmentContextDto, type RequisitionFromPlanInput, type UpdatePlannedMovementInput, type UpdateWorkforcePlanItemInput, type VacancyDto, type WorkforceDashboardDto, type WorkforcePlanItemDto, type WorkforcePlanItemsQuery, type WorkforcePlanReason } from '@hr/shared';
import { PERMISSIONS } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { requisitionService } from '../recruitment/requisition.service';
import { assertDraft, loadCycle } from './cycle.service';
import { canManage, currentHeadcountByGrain, departmentFilter, lockRow, notFound, textAudit, visibleDepartmentIds, workforceAudit, type Actor, type Db } from './workforce.types';

/**
 * The headcount plan: one row per department + job, current (snapshot) vs planned, and the factual delta.
 *
 * Numbers only. The plan never names who fills a reduction, never opens a requisition by itself and never touches
 * the employee, position or department masters. Recruitment context is read from Task 27's tables and shown beside
 * the delta so HR can decide the requested openings; the handoff is an explicit action through the recruitment
 * service, with the recruitment module's own rules and numbering.
 */
type ItemRow = Prisma.WorkforcePlanItemGetPayload<{ include: { requisitions: true } }>;
const include = { requisitions: true } as const;

/** Recruitment demand in flight per department + job, read from the recruitment module (never re-derived elsewhere). */
async function recruitmentContext(db: Db, organizationId: string | null): Promise<Map<string, RecruitmentContextDto>> {
  const reqs = await db.recruitmentRequisition.findMany({ where: { status: { in: ['APPROVED', 'PENDING_APPROVAL'] }, ...(organizationId ? { organizationId } : {}) }, select: { departmentId: true, jobId: true, status: true, requestedOpenings: true } });
  const opens = await db.recruitmentOpening.findMany({ where: { status: 'OPEN', ...(organizationId ? { requisition: { organizationId } } : {}) }, select: { jobId: true, openingsCount: true, requisition: { select: { departmentId: true } }, _count: { select: { applications: { where: { stage: 'HIRED' } } } } } });
  const out = new Map<string, RecruitmentContextDto>();
  const at = (dept: string | null, job: string) => { const k = `${dept ?? '?'}:${job}`; let v = out.get(k); if (!v) { v = { approvedRequisitions: 0, approvedOpenings: 0, pendingRequisitions: 0, openOpenings: 0, hired: 0, openRecruitmentDemand: 0 }; out.set(k, v); } return v; };
  for (const r of reqs) { const v = at(r.departmentId, r.jobId); if (r.status === 'APPROVED') { v.approvedRequisitions += 1; v.approvedOpenings += r.requestedOpenings; } else v.pendingRequisitions += 1; }
  for (const o of opens) { const v = at(o.requisition.departmentId, o.jobId); v.openOpenings += o.openingsCount; v.hired += o._count.applications; }
  for (const v of out.values()) v.openRecruitmentDemand = Math.max(0, v.openOpenings - v.hired);
  return out;
}
const emptyContext = (): RecruitmentContextDto => ({ approvedRequisitions: 0, approvedOpenings: 0, pendingRequisitions: 0, openOpenings: 0, hired: 0, openRecruitmentDemand: 0 });

async function itemDtos(db: Db, cycle: { id: string; organizationId: string | null; status: string }, rows: ItemRow[]): Promise<WorkforcePlanItemDto[]> {
  const [ctx, live, reqRows] = await Promise.all([
    recruitmentContext(db, cycle.organizationId),
    cycle.status === 'FINALIZED' || cycle.status === 'ARCHIVED' ? null : currentHeadcountByGrain(db, cycle.organizationId),
    rows.some((r) => r.requisitions.length) ? db.recruitmentRequisition.findMany({ where: { id: { in: rows.flatMap((r) => r.requisitions.map((x) => x.requisitionId)) } }, select: { id: true, requisitionNumber: true, status: true, requestedOpenings: true } }) : [],
  ]);
  const reqById = new Map(reqRows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const { delta, classification } = headcountDelta(r.plannedHeadcount, r.currentHeadcountSnapshot);
    const recruitment = (r.jobId && ctx.get(`${r.departmentId}:${r.jobId}`)) || emptyContext();
    return {
      id: r.id, cycleId: r.cycleId, organizationId: r.organizationId, departmentId: r.departmentId, departmentName: r.departmentNameSnapshot, jobId: r.jobId, jobTitle: r.jobTitleSnapshot,
      currentHeadcountSnapshot: r.currentHeadcountSnapshot, snapshotAt: r.snapshotAt.toISOString(), currentHeadcountLive: live ? (live.get(r.grainKey)?.count ?? 0) : null,
      plannedHeadcount: r.plannedHeadcount, delta, classification, reason: r.reason as WorkforcePlanItemDto['reason'], priority: r.priority as WorkforcePlanItemDto['priority'], targetDate: r.targetDate, notes: r.notes,
      recruitment, remainingDemand: remainingDemand(r.plannedHeadcount, r.currentHeadcountSnapshot, recruitment.openRecruitmentDemand),
      requisitions: r.requisitions.map((x) => reqById.get(x.requisitionId)).filter((x): x is NonNullable<typeof x> => !!x), updatedAt: r.updatedAt.toISOString(),
    };
  });
}

async function names(db: Db, departmentIds: string[], jobIds: string[]) {
  const [depts, jobs] = await Promise.all([
    departmentIds.length ? db.department.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true, organizationId: true } }) : [],
    jobIds.length ? db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true } }) : [],
  ]);
  return { dept: new Map(depts.map((d) => [d.id, d])), job: new Map(jobs.map((j) => [j.id, j.title])) };
}

export const workforcePlanService = {
  /**
   * "Initialize from current workforce": one row per current department + job with planned = current. Idempotent —
   * rows that exist are left alone (their planned figures are HR's), so a double click adds nothing.
   */
  async initialize(cycleId: string, actor: Actor): Promise<{ created: number; existing: number }> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'workforce_planning_cycles', cycleId);
      const cycle = await loadCycle(tx, cycleId);
      assertDraft(cycle);
      const current = await currentHeadcountByGrain(tx, cycle.organizationId);
      const existing = new Set((await tx.workforcePlanItem.findMany({ where: { cycleId }, select: { grainKey: true } })).map((r) => r.grainKey));
      const n = await names(tx, [...new Set([...current.values()].map((c) => c.departmentId))], [...new Set([...current.values()].map((c) => c.jobId).filter((x): x is string => !!x))]);
      const now = new Date();
      const rows = [...current.entries()].filter(([key]) => !existing.has(key)).map(([grainKey, c]) => ({
        cycleId, organizationId: c.organizationId, departmentId: c.departmentId, jobId: c.jobId, grainKey, departmentNameSnapshot: n.dept.get(c.departmentId)?.name ?? '?', jobTitleSnapshot: c.jobId ? (n.job.get(c.jobId) ?? null) : null,
        currentHeadcountSnapshot: c.count, snapshotAt: now, plannedHeadcount: c.count,
      }));
      const created = rows.length ? (await tx.workforcePlanItem.createMany({ data: rows, skipDuplicates: true })).count : 0;
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.INITIALIZE_WORKFORCE_PLAN, 'WorkforcePlanningCycle', cycleId, { created, existing: existing.size, currentHeadcount: [...current.values()].reduce((s, c) => s + c.count, 0) }), tx);
      return { created, existing: existing.size };
    });
  },

  async items(auth: AuthContext, cycleId: string, q: WorkforcePlanItemsQuery): Promise<WorkforcePlanItemDto[]> {
    const cycle = await loadCycle(prisma, cycleId);
    const visible = await visibleDepartmentIds(prisma, auth);
    const rows = await prisma.workforcePlanItem.findMany({ where: { cycleId, ...departmentFilter(visible), departmentId: q.departmentId ?? (visible ? { in: visible } : undefined), jobId: q.jobId }, include, orderBy: [{ departmentNameSnapshot: 'asc' }, { jobTitleSnapshot: 'asc' }] });
    const dtos = await itemDtos(prisma, cycle, rows);
    return q.classification ? dtos.filter((d) => d.classification === q.classification) : dtos;
  },

  /** A row for a department + job that has nobody today (a new function), or a job not yet present in a department. */
  async addItem(cycleId: string, input: AddWorkforcePlanItemInput, actor: Actor): Promise<WorkforcePlanItemDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'workforce_planning_cycles', cycleId);
      const cycle = await loadCycle(tx, cycleId);
      assertDraft(cycle);
      const dept = await tx.department.findUnique({ where: { id: input.departmentId }, select: { id: true, name: true, organizationId: true } });
      if (!dept || (cycle.organizationId && dept.organizationId !== cycle.organizationId)) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown department for this cycle', [{ field: 'departmentId', message: 'Unknown department' }]);
      const job = input.jobId ? await tx.job.findUnique({ where: { id: input.jobId }, select: { id: true, title: true } }) : null;
      if (input.jobId && !job) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field: 'jobId', message: 'Unknown job' }]);
      const grainKey = planGrainKey(dept.id, job?.id ?? null);
      if (await tx.workforcePlanItem.findUnique({ where: { cycleId_grainKey: { cycleId, grainKey } } })) throw new AppError(409, 'WORKFORCE_PLAN_ITEM_EXISTS', 'This department and job are already in the plan');
      const current = (await currentHeadcountByGrain(tx, cycle.organizationId)).get(grainKey)?.count ?? 0;
      const created = await tx.workforcePlanItem.create({ data: { cycleId, organizationId: dept.organizationId, departmentId: dept.id, jobId: job?.id ?? null, grainKey, departmentNameSnapshot: dept.name, jobTitleSnapshot: job?.title ?? null, currentHeadcountSnapshot: current, snapshotAt: new Date(), plannedHeadcount: input.plannedHeadcount ?? current }, include });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_WORKFORCE_PLAN_ITEM, 'WorkforcePlanItem', created.id, { added: true, departmentId: dept.id, jobId: job?.id ?? null, current, plannedHeadcount: created.plannedHeadcount }), tx);
      return { cycle, created };
    });
    return (await itemDtos(prisma, row.cycle, [row.created]))[0];
  },

  async updateItem(itemId: string, input: UpdateWorkforcePlanItemInput, actor: Actor): Promise<WorkforcePlanItemDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.workforcePlanItem.findUnique({ where: { id: itemId }, include });
      if (!before) throw notFound('plan item');
      await lockRow(tx, 'workforce_planning_cycles', before.cycleId);
      const cycle = await loadCycle(tx, before.cycleId);
      assertDraft(cycle);
      const after = await tx.workforcePlanItem.update({ where: { id: itemId }, data: { plannedHeadcount: input.plannedHeadcount, reason: input.reason === undefined ? undefined : input.reason, priority: input.priority === undefined ? undefined : input.priority, targetDate: input.targetDate === undefined ? undefined : input.targetDate, notes: input.notes === undefined ? undefined : input.notes }, include });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_WORKFORCE_PLAN_ITEM, 'WorkforcePlanItem', itemId, { plannedHeadcount: after.plannedHeadcount, reason: after.reason, priority: after.priority, targetDate: after.targetDate, ...textAudit('notes', before.notes, after.notes) }, { plannedHeadcount: before.plannedHeadcount, reason: before.reason, priority: before.priority, targetDate: before.targetDate }), tx);
      return { cycle, after };
    });
    return (await itemDtos(prisma, row.cycle, [row.after]))[0];
  },

  async removeItem(itemId: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.workforcePlanItem.findUnique({ where: { id: itemId }, include });
      if (!before) throw notFound('plan item');
      await lockRow(tx, 'workforce_planning_cycles', before.cycleId);
      assertDraft(await loadCycle(tx, before.cycleId));
      if (before.requisitions.length) throw new AppError(409, 'WORKFORCE_PLAN_ITEM_HAS_REQUISITIONS', 'A row that was handed to recruitment cannot be removed');
      await tx.workforcePlanItem.delete({ where: { id: itemId } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_WORKFORCE_PLAN_ITEM, 'WorkforcePlanItem', itemId, { removed: true }, { plannedHeadcount: before.plannedHeadcount, departmentId: before.departmentId, jobId: before.jobId }), tx);
    });
  },

  /** Metrics for one cycle (or the live workforce alone when no cycle exists yet). Counts, never a person. */
  async dashboard(auth: AuthContext, cycleId: string | null): Promise<WorkforceDashboardDto> {
    const visible = await visibleDepartmentIds(prisma, auth);
    const cycle = cycleId ? await loadCycle(prisma, cycleId) : null;
    const rows = cycle ? await itemDtos(prisma, cycle, await prisma.workforcePlanItem.findMany({ where: { cycleId: cycle.id, ...departmentFilter(visible) }, include })) : [];
    const live = await currentHeadcountByGrain(prisma, cycle?.organizationId ?? null, visible);
    const currentHeadcount = cycle ? rows.reduce((s, r) => s + r.currentHeadcountSnapshot, 0) : [...live.values()].reduce((s, c) => s + c.count, 0);
    const plannedHeadcount = rows.reduce((s, r) => s + r.plannedHeadcount, 0);
    const byDept = new Map<string, WorkforceDashboardDto['byDepartment'][number]>();
    const byJob = new Map<string, WorkforceDashboardDto['byJob'][number]>();
    for (const r of rows) {
      const d = byDept.get(r.departmentId) ?? { departmentId: r.departmentId, departmentName: r.departmentName, current: 0, planned: 0, delta: 0, classification: 'NO_CHANGE' as const };
      d.current += r.currentHeadcountSnapshot; d.planned += r.plannedHeadcount; byDept.set(r.departmentId, d);
      const j = byJob.get(r.jobId ?? '-') ?? { jobId: r.jobId, jobTitle: r.jobTitle ?? 'No job assigned', current: 0, planned: 0, delta: 0 };
      j.current += r.currentHeadcountSnapshot; j.planned += r.plannedHeadcount; byJob.set(r.jobId ?? '-', j);
    }
    for (const d of byDept.values()) { const h = headcountDelta(d.planned, d.current); d.delta = h.delta; d.classification = h.classification; }
    for (const j of byJob.values()) j.delta = j.planned - j.current;
    const vacancies = await this.vacancies(auth, cycle?.organizationId ?? null);
    return {
      cycle: cycle ? { id: cycle.id, code: cycle.code, name: cycle.name, status: cycle.status } : null,
      currentHeadcount, plannedHeadcount: cycle ? plannedHeadcount : currentHeadcount, netDelta: cycle ? plannedHeadcount - currentHeadcount : 0,
      expansionDemand: rows.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0), plannedReductions: rows.filter((r) => r.delta < 0).reduce((s, r) => s + -r.delta, 0), noChangeRows: rows.filter((r) => r.delta === 0).length,
      vacantPositions: vacancies.filter((v) => v.status === 'VACANT').length,
      openRecruitmentDemand: rows.reduce((s, r) => s + r.recruitment.openRecruitmentDemand, 0), remainingDemand: rows.reduce((s, r) => s + r.remainingDemand, 0),
      byDepartment: [...byDept.values()].sort((a, b) => a.departmentName.localeCompare(b.departmentName)), byJob: [...byJob.values()].sort((a, b) => a.jobTitle.localeCompare(b.jobTitle)), generatedAt: new Date().toISOString(),
    };
  },

  /**
   * Position projection. A position here is not a single seat, so "vacant" means exactly one thing: an active
   * position with no active employee assigned to it today. Nothing is inferred from missing data.
   */
  async vacancies(auth: AuthContext, organizationId: string | null): Promise<VacancyDto[]> {
    const visible = await visibleDepartmentIds(prisma, auth);
    const positions = await prisma.position.findMany({ where: { isActive: true, department: { isActive: true, ...(organizationId ? { organizationId } : {}), ...(visible ? { id: { in: visible } } : {}) } }, select: { id: true, code: true, title: true, jobId: true, job: { select: { title: true } }, department: { select: { id: true, name: true } }, _count: { select: { employees: { where: { employmentStatus: 'ACTIVE' } } } } }, orderBy: [{ department: { name: 'asc' } }, { code: 'asc' }] });
    return positions.map((p) => ({ positionId: p.id, positionCode: p.code, positionTitle: p.title, departmentId: p.department.id, departmentName: p.department.name, jobId: p.jobId, jobTitle: p.job?.title ?? null, activeEmployees: p._count.employees, status: p._count.employees > 0 ? 'FILLED' : 'VACANT' }));
  },

  /**
   * The explicit handoff. HR chose the openings; the plan supplies the facts and a justification line. The requisition
   * is created by the recruitment service under its own validation and numbering — this module writes no
   * recruitment row — and the link is remembered so the plan row shows what it produced.
   */
  async createRequisition(itemId: string, input: RequisitionFromPlanInput, actor: Actor) {
    if (!canManage(actor.auth) || !hasPermission(actor.auth, PERMISSIONS.RECRUITMENT_MANAGE)) throw AppError.forbidden('Creating a requisition from a plan needs workforce.manage and recruitment.manage');
    const item = await prisma.workforcePlanItem.findUnique({ where: { id: itemId }, include });
    if (!item) throw notFound('plan item');
    const cycle = await loadCycle(prisma, item.cycleId);
    if (cycle.status === 'ARCHIVED') throw new AppError(409, 'WORKFORCE_CYCLE_ARCHIVED', 'An archived plan cannot hand off to recruitment');
    if (!item.jobId) throw new AppError(409, 'WORKFORCE_PLAN_ITEM_NO_JOB', 'This row has no job; a requisition needs one');
    const dto = (await itemDtos(prisma, cycle, [item]))[0];
    const requisition = await requisitionService.create({
      organizationId: item.organizationId, departmentId: item.departmentId, jobId: item.jobId, requestedOpenings: input.requestedOpenings,
      reason: input.reason ?? REQUISITION_REASON_FOR_PLAN[(item.reason as WorkforcePlanReason | null) ?? 'OTHER'], hiringManagerEmployeeId: input.hiringManagerEmployeeId ?? null, desiredStartDate: input.desiredStartDate ?? item.targetDate ?? null,
      justification: input.justification ?? `Workforce plan ${cycle.code}: current ${dto.currentHeadcountSnapshot}, planned ${dto.plannedHeadcount}, open recruitment demand ${dto.recruitment.openRecruitmentDemand}`,
    }, actor);
    await prisma.$transaction(async (tx) => {
      await tx.workforcePlanRequisition.create({ data: { planItemId: itemId, requisitionId: requisition.id, createdByUserId: actor.auth.userId } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.CREATE_REQUISITION_FROM_WORKFORCE_PLAN, 'WorkforcePlanItem', itemId, { requisitionId: requisition.id, requisitionNumber: requisition.requisitionNumber, requestedOpenings: input.requestedOpenings, current: dto.currentHeadcountSnapshot, planned: dto.plannedHeadcount }), tx);
    });
    return requisition;
  },

  // ---------- planned movements: records of intent, never an employee update ----------
  async movements(auth: AuthContext, cycleId: string): Promise<PlannedMovementDto[]> {
    await loadCycle(prisma, cycleId);
    const visible = await visibleDepartmentIds(prisma, auth);
    const rows = await prisma.workforcePlannedMovement.findMany({ where: { cycleId, ...(visible ? { OR: [{ fromDepartmentId: { in: visible } }, { toDepartmentId: { in: visible } }] } : {}) }, orderBy: [{ targetDate: 'asc' }, { createdAt: 'asc' }] });
    return movementDtos(prisma, rows);
  },
  async createMovement(cycleId: string, input: CreatePlannedMovementInput, actor: Actor): Promise<PlannedMovementDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'workforce_planning_cycles', cycleId);
      assertDraft(await loadCycle(tx, cycleId));
      for (const [field, id] of [['fromDepartmentId', input.fromDepartmentId], ['toDepartmentId', input.toDepartmentId]] as const) if (id && !(await tx.department.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown department', [{ field, message: 'Unknown department' }]);
      for (const [field, id] of [['fromJobId', input.fromJobId], ['toJobId', input.toJobId]] as const) if (id && !(await tx.job.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field, message: 'Unknown job' }]);
      if (input.employeeId && !(await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown employee', [{ field: 'employeeId', message: 'Unknown employee' }]);
      const created = await tx.workforcePlannedMovement.create({ data: { cycleId, employeeId: input.employeeId ?? null, fromDepartmentId: input.fromDepartmentId ?? null, toDepartmentId: input.toDepartmentId ?? null, fromJobId: input.fromJobId ?? null, toJobId: input.toJobId ?? null, targetDate: input.targetDate ?? null, notes: input.notes ?? null, createdByUserId: actor.auth.userId } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.CREATE_WORKFORCE_PLANNED_MOVEMENT, 'WorkforcePlannedMovement', created.id, { cycleId, employeeId: created.employeeId, fromDepartmentId: created.fromDepartmentId, toDepartmentId: created.toDepartmentId, fromJobId: created.fromJobId, toJobId: created.toJobId, targetDate: created.targetDate, ...textAudit('notes', null, created.notes) }), tx);
      return created;
    });
    return (await movementDtos(prisma, [row]))[0];
  },
  async updateMovement(id: string, input: UpdatePlannedMovementInput, actor: Actor): Promise<PlannedMovementDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.workforcePlannedMovement.findUnique({ where: { id } });
      if (!before) throw notFound('planned movement');
      await lockRow(tx, 'workforce_planning_cycles', before.cycleId);
      const cycle = await loadCycle(tx, before.cycleId);
      if (cycle.status === 'ARCHIVED') throw new AppError(409, 'WORKFORCE_CYCLE_NOT_EDITABLE', 'An archived plan cannot be changed');
      if (cycle.status === 'FINALIZED' && (input.targetDate !== undefined || input.notes !== undefined)) throw new AppError(409, 'WORKFORCE_CYCLE_NOT_EDITABLE', 'Only the status of a movement can change after finalization');
      const after = await tx.workforcePlannedMovement.update({ where: { id }, data: { status: input.status, targetDate: input.targetDate === undefined ? undefined : input.targetDate, notes: input.notes === undefined ? undefined : input.notes } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_WORKFORCE_PLANNED_MOVEMENT, 'WorkforcePlannedMovement', id, { status: after.status, targetDate: after.targetDate, ...textAudit('notes', before.notes, after.notes) }, { status: before.status, targetDate: before.targetDate }), tx);
      return after;
    });
    return (await movementDtos(prisma, [row]))[0];
  },
};

async function movementDtos(db: Db, rows: Prisma.WorkforcePlannedMovementGetPayload<object>[]): Promise<PlannedMovementDto[]> {
  const n = await names(db, [...new Set(rows.flatMap((r) => [r.fromDepartmentId, r.toDepartmentId]).filter((x): x is string => !!x))], [...new Set(rows.flatMap((r) => [r.fromJobId, r.toJobId]).filter((x): x is string => !!x))]);
  const empIds = [...new Set(rows.map((r) => r.employeeId).filter((x): x is string => !!x))];
  const emps = new Map((empIds.length ? await db.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, employeeCode: true, firstName: true, lastName: true } }) : []).map((e) => [e.id, e]));
  const dept = (id: string | null) => (id && n.dept.get(id) ? { id, name: n.dept.get(id)!.name } : null);
  const job = (id: string | null) => (id && n.job.get(id) ? { id, title: n.job.get(id)! } : null);
  return rows.map((r) => ({ id: r.id, cycleId: r.cycleId, employee: r.employeeId ? (emps.get(r.employeeId) ?? null) : null, fromDepartment: dept(r.fromDepartmentId), toDepartment: dept(r.toDepartmentId), fromJob: job(r.fromJobId), toJob: job(r.toJobId), targetDate: r.targetDate, status: r.status as PlannedMovementDto['status'], notes: r.notes, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }));
}
