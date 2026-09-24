import { AUDIT_ACTIONS, type CreateOrgDesignNodeInput, type CreateOrgDesignPositionInput, type CreateOrgDesignScenarioInput, type OrgDesignComparisonDto, type OrgDesignNodeDto, type OrgDesignScenarioDto, type OrgDesignScenarioListQuery, type OrgDesignScenarioStatus, type OrgDesignTreeDto, type ScenarioComparisonDto, type UpdateOrgDesignNodeInput, type UpdateOrgDesignPositionInput, type UpdateOrgDesignScenarioInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { canDesign, currentHeadcountByGrain, lockRow, notFound, textAudit, workforceAudit, type Actor, type Db } from './workforce.types';

/**
 * Organization-design scenarios: a planned hierarchy of units with planned headcount per job, beside the live
 * organization. A node may point at a live department (so "current" can be shown next to "planned") or be
 * planned-only. Finalizing writes an immutable snapshot; it creates no department, no position and no job.
 */
const include = { _count: { select: { nodes: true } }, positions: { select: { plannedHeadcount: true } }, planningCycle: { select: { name: true } } } as const;
type ScenarioRow = Prisma.OrganizationDesignScenarioGetPayload<{ include: typeof include }>;
async function scenarioDto(db: Db, row: ScenarioRow, auth: AuthContext): Promise<OrgDesignScenarioDto> {
  const org = await db.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } });
  return {
    id: row.id, name: row.name, description: row.description, organizationId: row.organizationId, organizationName: org?.name ?? '?', planningCycleId: row.planningCycleId, planningCycleName: row.planningCycle?.name ?? null,
    status: row.status as OrgDesignScenarioStatus, nodeCount: row._count.nodes, plannedHeadcount: row.positions.reduce((s, p) => s + p.plannedHeadcount, 0), finalizedAt: row.finalizedAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), can: { edit: row.status === 'DRAFT' && canDesign(auth) },
  };
}
async function loadScenario(db: Db, id: string) {
  const row = await db.organizationDesignScenario.findUnique({ where: { id }, include });
  if (!row) throw notFound('scenario');
  return row;
}
const assertDraft = (row: { status: string }) => { if (row.status !== 'DRAFT') throw new AppError(409, 'ORG_DESIGN_SCENARIO_NOT_EDITABLE', `This scenario is ${row.status.toLowerCase()} and can no longer be edited`); };
const structureAudit = (actor: Actor, scenarioId: string, detail: unknown) => workforceAudit(actor, AUDIT_ACTIONS.UPDATE_ORG_DESIGN_STRUCTURE, 'OrganizationDesignScenario', scenarioId, detail);

/** Builds the tree with planned headcount rolled up and current headcount for nodes that point at a live department. */
async function buildTree(db: Db, scenario: ScenarioRow): Promise<{ roots: OrgDesignNodeDto[]; totals: OrgDesignTreeDto['totals']; flat: OrgDesignNodeDto[] }> {
  const [nodes, positions, live] = await Promise.all([
    db.organizationDesignNode.findMany({ where: { scenarioId: scenario.id }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    db.organizationDesignPosition.findMany({ where: { scenarioId: scenario.id }, orderBy: { createdAt: 'asc' } }),
    currentHeadcountByGrain(db, scenario.organizationId),
  ]);
  const jobIds = [...new Set(positions.map((p) => p.jobId).filter((x): x is string => !!x))];
  const jobs = new Map((jobIds.length ? await db.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, title: true } }) : []).map((j) => [j.id, j.title]));
  const deptIds = [...new Set(nodes.map((n) => n.sourceDepartmentId).filter((x): x is string => !!x))];
  const depts = new Map((deptIds.length ? await db.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : []).map((d) => [d.id, d.name]));
  const currentOfDept = new Map<string, number>();
  for (const c of live.values()) currentOfDept.set(c.departmentId, (currentOfDept.get(c.departmentId) ?? 0) + c.count);
  const byId = new Map<string, OrgDesignNodeDto>();
  for (const n of nodes) byId.set(n.id, { id: n.id, nodeType: n.nodeType as OrgDesignNodeDto['nodeType'], name: n.name, code: n.code, parentNodeId: n.parentNodeId, sourceDepartmentId: n.sourceDepartmentId, sourceDepartmentName: n.sourceDepartmentId ? (depts.get(n.sourceDepartmentId) ?? null) : null, plannedOnly: n.plannedOnly, sortOrder: n.sortOrder, plannedHeadcount: 0, currentHeadcount: n.sourceDepartmentId ? (currentOfDept.get(n.sourceDepartmentId) ?? 0) : 0, positions: [], children: [] });
  for (const p of positions) { const node = byId.get(p.nodeId); if (node) { node.positions.push({ id: p.id, nodeId: p.nodeId, jobId: p.jobId, jobTitle: p.jobId ? (jobs.get(p.jobId) ?? null) : null, plannedJobTitle: p.plannedJobTitle, plannedHeadcount: p.plannedHeadcount, reportsToNodeId: p.reportsToNodeId, notes: p.notes }); node.plannedHeadcount += p.plannedHeadcount; } }
  const roots: OrgDesignNodeDto[] = [];
  for (const n of byId.values()) { const parent = n.parentNodeId ? byId.get(n.parentNodeId) : undefined; if (parent) parent.children.push(n); else roots.push(n); }
  const flat = [...byId.values()];
  return { roots, flat, totals: { planned: flat.reduce((s, n) => s + n.plannedHeadcount, 0), current: flat.reduce((s, n) => s + n.currentHeadcount, 0), delta: flat.reduce((s, n) => s + n.plannedHeadcount - n.currentHeadcount, 0), plannedOnlyNodes: flat.filter((n) => n.plannedOnly).length } };
}

export const orgDesignService = {
  async list(auth: AuthContext, q: OrgDesignScenarioListQuery) {
    const where: Prisma.OrganizationDesignScenarioWhereInput = { status: q.status, organizationId: q.organizationId };
    const [total, rows] = await prisma.$transaction([prisma.organizationDesignScenario.count({ where }), prisma.organizationDesignScenario.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: await Promise.all(rows.map((r) => scenarioDto(prisma, r, auth))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async tree(auth: AuthContext, id: string): Promise<OrgDesignTreeDto> {
    const row = await loadScenario(prisma, id);
    const t = await buildTree(prisma, row);
    return { scenario: await scenarioDto(prisma, row, auth), roots: t.roots, totals: t.totals };
  },

  async create(input: CreateOrgDesignScenarioInput, actor: Actor): Promise<OrgDesignScenarioDto> {
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true, name: true } });
    if (!org) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
    if (input.planningCycleId && !(await prisma.workforcePlanningCycle.findUnique({ where: { id: input.planningCycleId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown planning cycle', [{ field: 'planningCycleId', message: 'Unknown cycle' }]);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.organizationDesignScenario.create({ data: { name: input.name, description: input.description ?? null, organizationId: org.id, planningCycleId: input.planningCycleId ?? null, createdByUserId: actor.auth.userId }, include });
      // The organization itself is the root of every scenario, as a reference to the live one.
      await tx.organizationDesignNode.create({ data: { scenarioId: created.id, nodeType: 'ORGANIZATION', name: org.name, sourceOrganizationId: org.id, plannedOnly: false, sortOrder: 0 } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.CREATE_ORG_DESIGN_SCENARIO, 'OrganizationDesignScenario', created.id, { name: created.name, organizationId: org.id, planningCycleId: created.planningCycleId, ...textAudit('description', null, created.description) }), tx);
      return created;
    });
    return scenarioDto(prisma, await loadScenario(prisma, row.id), actor.auth);
  },

  /** Adds the live departments of the organization as referenced nodes (idempotent), so a scenario starts from today. */
  async importCurrent(id: string, actor: Actor): Promise<{ created: number }> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', id);
      const s = await loadScenario(tx, id);
      assertDraft(s);
      const root = await tx.organizationDesignNode.findFirst({ where: { scenarioId: id, nodeType: 'ORGANIZATION' }, select: { id: true } });
      const existing = new Set((await tx.organizationDesignNode.findMany({ where: { scenarioId: id, sourceDepartmentId: { not: null } }, select: { sourceDepartmentId: true } })).map((n) => n.sourceDepartmentId!));
      const depts = await tx.department.findMany({ where: { organizationId: s.organizationId, isActive: true }, select: { id: true, code: true, name: true, parentId: true }, orderBy: { name: 'asc' } });
      const idOf = new Map<string, string>();
      for (const n of await tx.organizationDesignNode.findMany({ where: { scenarioId: id, sourceDepartmentId: { not: null } }, select: { id: true, sourceDepartmentId: true } })) idOf.set(n.sourceDepartmentId!, n.id);
      let created = 0;
      // Parents first so children can point at them.
      const pending = depts.filter((d) => !existing.has(d.id));
      let progress = true;
      while (pending.length && progress) {
        progress = false;
        for (let i = 0; i < pending.length; i += 1) {
          const d = pending[i];
          if (d.parentId && !idOf.has(d.parentId) && depts.some((x) => x.id === d.parentId)) continue;
          const node = await tx.organizationDesignNode.create({ data: { scenarioId: id, nodeType: 'DEPARTMENT', name: d.name, code: d.code, parentNodeId: d.parentId ? (idOf.get(d.parentId) ?? root?.id ?? null) : (root?.id ?? null), sourceDepartmentId: d.id, plannedOnly: false, sortOrder: created + 1 } });
          idOf.set(d.id, node.id); pending.splice(i, 1); i -= 1; created += 1; progress = true;
        }
      }
      await auditService.log(structureAudit(actor, id, { importedDepartments: created }), tx);
      return { created };
    });
  },

  async update(id: string, input: UpdateOrgDesignScenarioInput, actor: Actor): Promise<OrgDesignScenarioDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', id);
      const before = await loadScenario(tx, id);
      assertDraft(before);
      if (input.planningCycleId && !(await tx.workforcePlanningCycle.findUnique({ where: { id: input.planningCycleId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown planning cycle', [{ field: 'planningCycleId', message: 'Unknown cycle' }]);
      const after = await tx.organizationDesignScenario.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, planningCycleId: input.planningCycleId === undefined ? undefined : input.planningCycleId } });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.UPDATE_ORG_DESIGN_SCENARIO, 'OrganizationDesignScenario', id, { name: after.name, planningCycleId: after.planningCycleId, ...textAudit('description', before.description, after.description) }, { name: before.name }), tx);
    });
    return scenarioDto(prisma, await loadScenario(prisma, id), actor.auth);
  },

  /** DRAFT → FINALIZED (immutable snapshot of the target, nothing else) or → ARCHIVED; FINALIZED → ARCHIVED. */
  async transition(id: string, status: OrgDesignScenarioStatus, actor: Actor): Promise<OrgDesignScenarioDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', id);
      const before = await loadScenario(tx, id);
      const allowed: Record<string, string[]> = { DRAFT: ['FINALIZED', 'ARCHIVED'], FINALIZED: ['ARCHIVED'], ARCHIVED: [] };
      if (!allowed[before.status].includes(status)) throw new AppError(409, 'ORG_DESIGN_INVALID_TRANSITION', `A ${before.status.toLowerCase()} scenario cannot become ${status.toLowerCase()}`);
      const snapshot = status === 'FINALIZED' ? await buildTree(tx, before) : null;
      await tx.organizationDesignScenario.update({ where: { id }, data: { status, finalizedAt: status === 'FINALIZED' ? new Date() : undefined, finalSnapshot: snapshot ? ({ roots: snapshot.roots, totals: snapshot.totals, at: new Date().toISOString() } as unknown as Prisma.InputJsonValue) : undefined } });
      await auditService.log(workforceAudit(actor, status === 'FINALIZED' ? AUDIT_ACTIONS.FINALIZE_ORG_DESIGN_SCENARIO : AUDIT_ACTIONS.UPDATE_ORG_DESIGN_SCENARIO, 'OrganizationDesignScenario', id, { status, ...(snapshot ? { plannedHeadcount: snapshot.totals.planned, nodes: snapshot.flat.length } : {}) }, { status: before.status }), tx);
    });
    return scenarioDto(prisma, await loadScenario(prisma, id), actor.auth);
  },

  /** A copy with new ids and the same structure and headcount; editing the copy never touches the original. */
  async duplicate(id: string, name: string, actor: Actor): Promise<OrgDesignScenarioDto> {
    const copyId = await prisma.$transaction(async (tx) => {
      const src = await loadScenario(tx, id);
      const copy = await tx.organizationDesignScenario.create({ data: { name, description: src.description, organizationId: src.organizationId, planningCycleId: src.planningCycleId, duplicatedFromId: src.id, createdByUserId: actor.auth.userId } });
      const nodes = await tx.organizationDesignNode.findMany({ where: { scenarioId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
      const map = new Map<string, string>();
      const remaining = [...nodes];
      while (remaining.length) {
        const n = remaining.find((x) => !x.parentNodeId || map.has(x.parentNodeId)) ?? remaining[0];
        const created = await tx.organizationDesignNode.create({ data: { scenarioId: copy.id, nodeType: n.nodeType, name: n.name, code: n.code, parentNodeId: n.parentNodeId ? (map.get(n.parentNodeId) ?? null) : null, sourceOrganizationId: n.sourceOrganizationId, sourceDepartmentId: n.sourceDepartmentId, plannedOnly: n.plannedOnly, sortOrder: n.sortOrder } });
        map.set(n.id, created.id); remaining.splice(remaining.indexOf(n), 1);
      }
      const positions = await tx.organizationDesignPosition.findMany({ where: { scenarioId: id } });
      if (positions.length) await tx.organizationDesignPosition.createMany({ data: positions.map((p) => ({ scenarioId: copy.id, nodeId: map.get(p.nodeId)!, jobId: p.jobId, plannedJobTitle: p.plannedJobTitle, plannedHeadcount: p.plannedHeadcount, reportsToNodeId: p.reportsToNodeId ? (map.get(p.reportsToNodeId) ?? null) : null, notes: p.notes })) });
      await auditService.log(workforceAudit(actor, AUDIT_ACTIONS.DUPLICATE_ORG_DESIGN_SCENARIO, 'OrganizationDesignScenario', copy.id, { duplicatedFromId: id, name, nodes: nodes.length, positions: positions.length }), tx);
      return copy.id;
    });
    return scenarioDto(prisma, await loadScenario(prisma, copyId), actor.auth);
  },

  // ---------- nodes ----------
  async createNode(scenarioId: string, input: CreateOrgDesignNodeInput, actor: Actor): Promise<{ id: string }> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      const s = await loadScenario(tx, scenarioId);
      assertDraft(s);
      if (input.parentNodeId && !(await tx.organizationDesignNode.findFirst({ where: { id: input.parentNodeId, scenarioId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Parent must belong to this scenario', [{ field: 'parentNodeId', message: 'Unknown parent' }]);
      if (input.sourceDepartmentId) {
        const d = await tx.department.findFirst({ where: { id: input.sourceDepartmentId, organizationId: s.organizationId }, select: { id: true } });
        if (!d) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown department in this organization', [{ field: 'sourceDepartmentId', message: 'Unknown department' }]);
        if (await tx.organizationDesignNode.findFirst({ where: { scenarioId, sourceDepartmentId: d.id }, select: { id: true } })) throw new AppError(409, 'ORG_DESIGN_NODE_EXISTS', 'That department is already in the scenario');
      }
      const parent = input.parentNodeId ?? (await tx.organizationDesignNode.findFirst({ where: { scenarioId, nodeType: 'ORGANIZATION' }, select: { id: true } }))?.id ?? null;
      // Default order = insertion order among siblings, so a tree reads the way it was built.
      const last = input.sortOrder === undefined ? await tx.organizationDesignNode.aggregate({ where: { scenarioId, parentNodeId: parent }, _max: { sortOrder: true } }) : null;
      const created = await tx.organizationDesignNode.create({ data: { scenarioId, nodeType: input.nodeType, name: input.name, code: input.code ?? null, parentNodeId: parent, sourceDepartmentId: input.sourceDepartmentId ?? null, plannedOnly: !input.sourceDepartmentId, sortOrder: input.sortOrder ?? ((last?._max.sortOrder ?? 0) + 1) } });
      await auditService.log(structureAudit(actor, scenarioId, { nodeCreated: created.id, nodeType: created.nodeType, plannedOnly: created.plannedOnly, sourceDepartmentId: created.sourceDepartmentId }), tx);
      return { id: created.id };
    });
  },
  async updateNode(scenarioId: string, nodeId: string, input: UpdateOrgDesignNodeInput, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      assertDraft(await loadScenario(tx, scenarioId));
      const node = await tx.organizationDesignNode.findFirst({ where: { id: nodeId, scenarioId } });
      if (!node) throw notFound('node');
      if (input.parentNodeId !== undefined && input.parentNodeId !== null) {
        // No cycles: walk up from the proposed parent and make sure we never meet the node itself.
        let cursor: string | null = input.parentNodeId;
        for (let i = 0; cursor && i < 100; i += 1) { if (cursor === nodeId) throw new AppError(422, 'ORG_DESIGN_CYCLE', 'A unit cannot be placed under itself'); const p: { parentNodeId: string | null; scenarioId: string } | null = await tx.organizationDesignNode.findUnique({ where: { id: cursor }, select: { parentNodeId: true, scenarioId: true } }); if (!p || p.scenarioId !== scenarioId) throw new AppError(422, 'VALIDATION_ERROR', 'Parent must belong to this scenario', [{ field: 'parentNodeId', message: 'Unknown parent' }]); cursor = p.parentNodeId; }
      }
      if (node.nodeType === 'ORGANIZATION' && input.parentNodeId) throw new AppError(422, 'VALIDATION_ERROR', 'The organization root stays at the top', [{ field: 'parentNodeId', message: 'Root cannot move' }]);
      await tx.organizationDesignNode.update({ where: { id: nodeId }, data: { name: input.name, code: input.code === undefined ? undefined : input.code, parentNodeId: input.parentNodeId === undefined ? undefined : input.parentNodeId, sortOrder: input.sortOrder, nodeType: input.nodeType } });
      await auditService.log(structureAudit(actor, scenarioId, { nodeUpdated: nodeId, fields: Object.keys(input) }), tx);
    });
  },
  async deleteNode(scenarioId: string, nodeId: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      assertDraft(await loadScenario(tx, scenarioId));
      const node = await tx.organizationDesignNode.findFirst({ where: { id: nodeId, scenarioId }, include: { _count: { select: { children: true } } } });
      if (!node) throw notFound('node');
      if (node.nodeType === 'ORGANIZATION') throw new AppError(409, 'ORG_DESIGN_ROOT', 'The organization root cannot be removed');
      if (node._count.children) throw new AppError(409, 'ORG_DESIGN_NODE_HAS_CHILDREN', 'Remove or move the units under this one first');
      await tx.organizationDesignPosition.deleteMany({ where: { nodeId } });
      await tx.organizationDesignPosition.updateMany({ where: { scenarioId, reportsToNodeId: nodeId }, data: { reportsToNodeId: null } });
      await tx.organizationDesignNode.delete({ where: { id: nodeId } });
      await auditService.log(structureAudit(actor, scenarioId, { nodeDeleted: nodeId }), tx);
    });
  },

  // ---------- planned positions ----------
  async createPosition(scenarioId: string, input: CreateOrgDesignPositionInput, actor: Actor): Promise<{ id: string }> {
    return prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      assertDraft(await loadScenario(tx, scenarioId));
      if (!(await tx.organizationDesignNode.findFirst({ where: { id: input.nodeId, scenarioId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unit must belong to this scenario', [{ field: 'nodeId', message: 'Unknown unit' }]);
      if (input.jobId && !(await tx.job.findUnique({ where: { id: input.jobId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field: 'jobId', message: 'Unknown job' }]);
      if (input.reportsToNodeId && !(await tx.organizationDesignNode.findFirst({ where: { id: input.reportsToNodeId, scenarioId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Reports-to unit must belong to this scenario', [{ field: 'reportsToNodeId', message: 'Unknown unit' }]);
      const created = await tx.organizationDesignPosition.create({ data: { scenarioId, nodeId: input.nodeId, jobId: input.jobId ?? null, plannedJobTitle: input.jobId ? null : (input.plannedJobTitle ?? null), plannedHeadcount: input.plannedHeadcount, reportsToNodeId: input.reportsToNodeId ?? null, notes: input.notes ?? null } });
      await auditService.log(structureAudit(actor, scenarioId, { positionCreated: created.id, nodeId: input.nodeId, jobId: created.jobId, plannedJobTitle: created.plannedJobTitle, plannedHeadcount: created.plannedHeadcount, ...textAudit('notes', null, created.notes) }), tx);
      return { id: created.id };
    });
  },
  async updatePosition(scenarioId: string, positionId: string, input: UpdateOrgDesignPositionInput, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      assertDraft(await loadScenario(tx, scenarioId));
      const before = await tx.organizationDesignPosition.findFirst({ where: { id: positionId, scenarioId } });
      if (!before) throw notFound('planned position');
      if (input.jobId && !(await tx.job.findUnique({ where: { id: input.jobId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown job', [{ field: 'jobId', message: 'Unknown job' }]);
      const after = await tx.organizationDesignPosition.update({ where: { id: positionId }, data: { jobId: input.jobId === undefined ? undefined : input.jobId, plannedJobTitle: input.plannedJobTitle === undefined ? undefined : input.plannedJobTitle, plannedHeadcount: input.plannedHeadcount, reportsToNodeId: input.reportsToNodeId === undefined ? undefined : input.reportsToNodeId, notes: input.notes === undefined ? undefined : input.notes } });
      await auditService.log(structureAudit(actor, scenarioId, { positionUpdated: positionId, plannedHeadcount: after.plannedHeadcount, jobId: after.jobId, ...textAudit('notes', before.notes, after.notes) }), tx);
    });
  },
  async deletePosition(scenarioId: string, positionId: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'organization_design_scenarios', scenarioId);
      assertDraft(await loadScenario(tx, scenarioId));
      const row = await tx.organizationDesignPosition.findFirst({ where: { id: positionId, scenarioId } });
      if (!row) throw notFound('planned position');
      await tx.organizationDesignPosition.delete({ where: { id: positionId } });
      await auditService.log(structureAudit(actor, scenarioId, { positionDeleted: positionId }), tx);
    });
  },

  /** Current vs planned for one scenario: by unit (planned-only → current 0) and by job across the scenario. */
  async compare(id: string): Promise<OrgDesignComparisonDto> {
    const s = await loadScenario(prisma, id);
    const t = await buildTree(prisma, s);
    const live = await currentHeadcountByGrain(prisma, s.organizationId);
    const linkedDepts = new Set(t.flat.map((n) => n.sourceDepartmentId).filter((x): x is string => !!x));
    const byJob = new Map<string, OrgDesignComparisonDto['byJob'][number]>();
    for (const n of t.flat) for (const p of n.positions) { const k = p.jobId ?? `title:${p.plannedJobTitle}`; const j = byJob.get(k) ?? { jobId: p.jobId, jobTitle: p.jobTitle ?? p.plannedJobTitle ?? '?', current: 0, planned: 0, delta: 0 }; j.planned += p.plannedHeadcount; byJob.set(k, j); }
    for (const c of live.values()) { if (!linkedDepts.has(c.departmentId)) continue; const k = c.jobId ?? 'title:?'; const j = byJob.get(k) ?? { jobId: c.jobId, jobTitle: c.jobId ? ((await prisma.job.findUnique({ where: { id: c.jobId }, select: { title: true } }))?.title ?? '?') : 'No job assigned', current: 0, planned: 0, delta: 0 }; j.current += c.count; byJob.set(k, j); }
    for (const j of byJob.values()) j.delta = j.planned - j.current;
    return {
      scenario: { id: s.id, name: s.name, status: s.status },
      totals: t.totals,
      byDepartment: t.flat.filter((n) => n.nodeType !== 'ORGANIZATION').map((n) => ({ name: n.name, sourceDepartmentId: n.sourceDepartmentId, plannedOnly: n.plannedOnly, current: n.currentHeadcount, planned: n.plannedHeadcount, delta: n.plannedHeadcount - n.currentHeadcount })),
      byJob: [...byJob.values()].sort((a, b) => a.jobTitle.localeCompare(b.jobTitle)),
    };
  },

  /** Two scenarios side by side. Totals and differences only; no verdict on which is better. */
  async compareScenarios(aId: string, bId: string): Promise<ScenarioComparisonDto> {
    const [a, b] = await Promise.all([this.compare(aId), this.compare(bId)]);
    const depts = new Map<string, { name: string; a: number; b: number; delta: number }>();
    for (const d of a.byDepartment) depts.set(d.name, { name: d.name, a: d.planned, b: 0, delta: 0 });
    for (const d of b.byDepartment) { const row = depts.get(d.name) ?? { name: d.name, a: 0, b: 0, delta: 0 }; row.b = d.planned; depts.set(d.name, row); }
    const jobs = new Map<string, { jobTitle: string; a: number; b: number; delta: number }>();
    for (const j of a.byJob) jobs.set(j.jobTitle, { jobTitle: j.jobTitle, a: j.planned, b: 0, delta: 0 });
    for (const j of b.byJob) { const row = jobs.get(j.jobTitle) ?? { jobTitle: j.jobTitle, a: 0, b: 0, delta: 0 }; row.b = j.planned; jobs.set(j.jobTitle, row); }
    for (const r of depts.values()) r.delta = r.b - r.a; for (const r of jobs.values()) r.delta = r.b - r.a;
    return { a: { id: a.scenario.id, name: a.scenario.name, planned: a.totals.planned }, b: { id: b.scenario.id, name: b.scenario.name, planned: b.totals.planned }, delta: b.totals.planned - a.totals.planned, byDepartment: [...depts.values()].sort((x, y) => x.name.localeCompare(y.name)), byJob: [...jobs.values()].sort((x, y) => x.jobTitle.localeCompare(y.jobTitle)) };
  },
};
