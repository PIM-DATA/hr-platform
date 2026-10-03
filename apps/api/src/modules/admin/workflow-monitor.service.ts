import type { Prisma } from '@prisma/client';
import { WORKFLOW_SOURCE_MODULES, type WorkflowMonitorDetailDto, type WorkflowMonitorQuery, type WorkflowMonitorRowDto, type WorkflowMonitorStepDto, type WorkflowMonitorSummaryDto } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { hasPermission } from '../../services/authorization/authorization.service';
import { addDays, businessDayStart } from '@hr/shared';
import { referenceZone } from '../../services/business-time/business-time';
import type { AuthContext } from '../auth/auth.types';

/**
 * The workflow monitor: a read-only operational view of the engine for an administrator who needs to know what is
 * waiting and on whom.
 *
 * It is deliberately generic. A row carries the definition, the module, the entity type, the entity **identifier**,
 * the requester, the status, the current step and how long it has been waiting. It never reads the business record
 * behind the instance, so no amount, claim description, relations narrative, survey answer or salary can appear
 * here however the monitor is queried.
 *
 * The one piece of text the engine itself holds is an approver's comment. That is the approver's confidential word
 * about a business record, so the monitor shows it only to a caller who already holds a permission that opens that
 * module; everybody else sees that a comment exists and how long it was. The same check decides whether the link to
 * the source record is offered at all — and the source route stays authoritative regardless.
 */
const instanceInclude = {
  definition: { select: { code: true, version: true, name: true } },
  requesterEmployee: { select: { employeeCode: true, firstName: true, lastName: true } },
  steps: {
    orderBy: { stepOrder: 'asc' },
    select: {
      stepOrder: true, name: true, approverType: true, status: true, skipReason: true, comment: true, actedAt: true,
      approverUser: { select: { email: true } }, approverEmployee: { select: { firstName: true, lastName: true } }, actedBy: { select: { email: true } },
    },
  },
} satisfies Prisma.WorkflowInstanceInclude;
type Row = Prisma.WorkflowInstanceGetPayload<{ include: typeof instanceInclude }>;

/** Whether this caller already holds a permission that opens the module the instance belongs to. */
export function canOpenModule(auth: AuthContext, module: string): boolean {
  const source = WORKFLOW_SOURCE_MODULES[module];
  if (!source) return false;
  return source.permissions.some((p) => hasPermission(auth, p));
}
const moduleLabel = (module: string) => WORKFLOW_SOURCE_MODULES[module]?.label ?? module;
const days = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
const personName = (s: Row['steps'][number]) => (s.approverEmployee ? `${s.approverEmployee.firstName} ${s.approverEmployee.lastName}` : (s.approverUser?.email ?? null));

function row(auth: AuthContext, r: Row, now: Date): WorkflowMonitorRowDto {
  const current = r.steps.find((s) => s.stepOrder === r.currentStepOrder && s.status === 'PENDING') ?? null;
  const canOpen = canOpenModule(auth, r.module);
  return {
    id: r.id, definition: { code: r.definition.code, version: r.definition.version, name: r.definition.name },
    module: r.module, moduleLabel: moduleLabel(r.module), entityType: r.entityType, entityId: r.entityId,
    requesterName: `${r.requesterEmployee.firstName} ${r.requesterEmployee.lastName}`, requesterEmployeeCode: r.requesterEmployee.employeeCode,
    status: r.status, currentStepName: current?.name ?? null, currentApproverName: current ? personName(current) : null,
    submittedAt: r.submittedAt.toISOString(), completedAt: r.completedAt?.toISOString() ?? null,
    waitingDays: r.status === 'PENDING' ? days(r.submittedAt, now) : null,
    canOpenSource: canOpen, sourcePath: canOpen ? (WORKFLOW_SOURCE_MODULES[r.module]?.path ?? null) : null,
  };
}

function stepDto(s: Row['steps'][number], showComment: boolean): WorkflowMonitorStepDto {
  return {
    stepOrder: s.stepOrder, name: s.name, approverType: s.approverType, approverName: personName(s), status: s.status,
    actedByName: s.actedBy?.email ?? null, actedAt: s.actedAt?.toISOString() ?? null, skipReason: s.skipReason,
    comment: showComment ? s.comment : null, commentRedacted: !showComment && !!s.comment, commentLength: s.comment?.length ?? 0,
  };
}

export const workflowMonitorService = {
  async list(auth: AuthContext, q: WorkflowMonitorQuery) {
    const now = new Date();
    const zone = q.from || q.to ? await referenceZone(prisma) : 'UTC'; // Task 53: business days in the reference organization's zone
    const where: Prisma.WorkflowInstanceWhereInput = {
      module: q.module, entityType: q.entityType, status: q.status,
      ...(q.definitionCode ? { definition: { code: q.definitionCode } } : {}),
      ...(q.from || q.to ? { submittedAt: { gte: q.from ? businessDayStart(q.from, zone) : undefined, lt: q.to ? businessDayStart(addDays(q.to, 1), zone) : undefined } } : {}),
      ...(q.stalledDays ? { status: 'PENDING', submittedAt: { lt: new Date(now.getTime() - q.stalledDays * 86_400_000) } } : {}),
      ...(q.search
        ? { OR: [{ entityId: q.search }, { requesterEmployee: { employeeCode: { contains: q.search, mode: 'insensitive' } } }, { requesterEmployee: { firstName: { contains: q.search, mode: 'insensitive' } } }, { requesterEmployee: { lastName: { contains: q.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.workflowInstance.findMany({ where, include: instanceInclude, orderBy: [{ submittedAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.workflowInstance.count({ where }),
    ]);
    return { data: rows.map((r) => row(auth, r, now)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<WorkflowMonitorDetailDto> {
    const r = await prisma.workflowInstance.findUnique({ where: { id }, include: instanceInclude });
    if (!r) throw new AppError(404, 'WORKFLOW_INSTANCE_NOT_FOUND', 'Workflow instance not found');
    const showComment = canOpenModule(auth, r.module);
    const actions = await prisma.workflowAction.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, action: true, stepOrder: true, comment: true, actor: { select: { email: true } } } });
    return {
      ...row(auth, r, new Date()),
      steps: r.steps.map((s) => stepDto(s, showComment)),
      history: actions.map((a) => ({ at: a.createdAt.toISOString(), action: a.action, stepOrder: a.stepOrder, actorName: a.actor?.email ?? null, comment: showComment ? a.comment : null, commentRedacted: !showComment && !!a.comment })),
    };
  },

  /** Counts for the monitor header: what is waiting, where, and how long the oldest has waited. */
  async summary(): Promise<WorkflowMonitorSummaryDto> {
    const now = new Date();
    const [byStatus, byModule, oldest] = await Promise.all([
      prisma.workflowInstance.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.workflowInstance.groupBy({ by: ['module', 'status'], _count: { _all: true } }),
      prisma.workflowInstance.groupBy({ by: ['module'], where: { status: 'PENDING' }, _min: { submittedAt: true } }),
    ]);
    const modules = [...new Set(byModule.map((m) => m.module))].sort();
    const oldestBy = new Map(oldest.map((o) => [o.module, o._min.submittedAt]));
    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })).sort((a, b) => a.status.localeCompare(b.status)),
      byModule: modules.map((module) => {
        const rows = byModule.filter((m) => m.module === module);
        const started = oldestBy.get(module);
        return {
          module, moduleLabel: moduleLabel(module),
          pending: rows.filter((r) => r.status === 'PENDING').reduce((a, r) => a + r._count._all, 0),
          total: rows.reduce((a, r) => a + r._count._all, 0),
          oldestPendingDays: started ? days(started, now) : null,
        };
      }),
      generatedAt: now.toISOString(),
    };
  },
};
