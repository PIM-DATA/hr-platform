import type { Prisma } from '@prisma/client';
import { APPROVER_TYPES, AUDIT_ACTIONS, ON_SELF, ON_UNRESOLVED, SUPPORTED_APPROVER_TYPES, type ApproverOptionDto, type CreateWorkflowDefinitionInput, type WorkflowDefinitionDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../audit/audit.service';
import type { Actor, Tx } from './workflow.types';

const include = {
  steps: { orderBy: { stepOrder: 'asc' }, include: { approverUser: { select: { id: true, email: true } } } },
  _count: { select: { instances: true } },
} satisfies Prisma.WorkflowDefinitionInclude;
type Row = Prisma.WorkflowDefinitionGetPayload<{ include: typeof include }>;

const toDto = (d: Row): WorkflowDefinitionDto => ({
  id: d.id, code: d.code, version: d.version, name: d.name, description: d.description, module: d.module, entityType: d.entityType,
  isActive: d.isActive, instanceCount: d._count.instances,
  steps: d.steps.map((s) => ({ id: s.id, stepOrder: s.stepOrder, name: s.name, approverType: s.approverType, approverUser: s.approverUser, onSelf: s.onSelf, onUnresolved: s.onUnresolved })),
  createdAt: d.createdAt.toISOString(), activatedAt: d.activatedAt?.toISOString() ?? null,
});

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
  action: AUDIT_ACTIONS[action], module: 'workflow', recordType: 'WorkflowDefinition', recordId, oldValue, newValue,
});

/**
 * Validates a version before it can be activated: ≥1 step, contiguous 1..n, no duplicates,
 * approver config matches type, only supported approver types, valid onSelf/onUnresolved.
 */
export async function validateDefinitionSteps(tx: Tx, steps: { stepOrder: number; approverType: string; approverUserId: string | null; onSelf: string; onUnresolved: string }[]) {
  const problems: { field?: string; message: string }[] = [];
  if (steps.length === 0) problems.push({ field: 'steps', message: 'At least one step is required' });
  const orders = [...steps].map((s) => s.stepOrder).sort((a, b) => a - b);
  orders.forEach((o, i) => { if (o !== i + 1) problems.push({ field: 'steps', message: `Step orders must be contiguous 1..${steps.length} (found ${orders.join(',')})` }); });
  for (const s of steps) {
    const f = `steps[${s.stepOrder}]`;
    if (!(SUPPORTED_APPROVER_TYPES as string[]).includes(s.approverType)) problems.push({ field: f, message: `Approver type ${s.approverType} is not supported` });
    if (s.approverType === APPROVER_TYPES.SPECIFIC_USER) {
      if (!s.approverUserId) problems.push({ field: f, message: 'SPECIFIC_USER step needs approverUserId' });
      else if (!(await tx.user.findUnique({ where: { id: s.approverUserId }, select: { id: true } }))) problems.push({ field: f, message: 'Approver user does not exist' });
    } else if (s.approverUserId) problems.push({ field: f, message: `${s.approverType} step must not set approverUserId` });
    if (!(ON_SELF as readonly string[]).includes(s.onSelf)) problems.push({ field: f, message: `Invalid onSelf ${s.onSelf}` });
    if (!(ON_UNRESOLVED as readonly string[]).includes(s.onUnresolved)) problems.push({ field: f, message: `Invalid onUnresolved ${s.onUnresolved}` });
  }
  const unique = [...new Set(problems.map((p) => JSON.stringify(p)))].map((p) => JSON.parse(p) as { field?: string; message: string });
  if (unique.length) throw new AppError(400, 'INVALID_WORKFLOW_DEFINITION', 'Workflow definition is invalid', unique);
}

export const workflowDefinitionsService = {
  /** Candidates for SPECIFIC_USER steps: active users only, minimal fields (workflow.manage_definitions, no users.view needed). */
  async approverOptions(q: { search?: string; limit: number }): Promise<ApproverOptionDto[]> {
    const terms = (q.search ?? '').split(/\s+/).filter(Boolean);
    const rows = await prisma.user.findMany({
      where: {
        isActive: true,
        AND: terms.map((t) => ({ OR: [{ email: { contains: t, mode: 'insensitive' } }, { employee: { employeeCode: { contains: t, mode: 'insensitive' } } }, { employee: { firstName: { contains: t, mode: 'insensitive' } } }, { employee: { lastName: { contains: t, mode: 'insensitive' } } }] })),
      },
      select: { id: true, email: true, employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true } } },
      orderBy: { email: 'asc' },
      take: q.limit,
    });
    return rows;
  },

  async list(filter: { code?: string; module?: string } = {}): Promise<WorkflowDefinitionDto[]> {
    const rows = await prisma.workflowDefinition.findMany({ where: { code: filter.code, module: filter.module }, include, orderBy: [{ code: 'asc' }, { version: 'desc' }] });
    return rows.map(toDto);
  },

  async getById(id: string): Promise<WorkflowDefinitionDto> {
    const row = await prisma.workflowDefinition.findUnique({ where: { id }, include });
    if (!row) throw new AppError(404, 'WORKFLOW_DEFINITION_NOT_FOUND', 'Workflow definition not found');
    return toDto(row);
  },

  /** Returns the single active version of a code (used by the engine at submit). */
  async getActive(tx: Tx, code: string) {
    const row = await tx.workflowDefinition.findFirst({ where: { code, isActive: true }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    if (!row) throw new AppError(409, 'WORKFLOW_DEFINITION_NOT_ACTIVE', `No active workflow definition for ${code}`);
    return row;
  },

  /**
   * Creates the next version of `code` (version = max + 1, inactive). Existing versions are never modified —
   * this is the only way to "edit" a definition. Steps are validated here as well as on activate.
   */
  async createVersion(input: CreateWorkflowDefinitionInput, actor: Actor): Promise<WorkflowDefinitionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const steps = input.steps.map((s, i) => ({ stepOrder: i + 1, name: s.name, approverType: s.approverType, approverUserId: s.approverUserId ?? null, onSelf: s.onSelf, onUnresolved: s.onUnresolved }));
      await validateDefinitionSteps(tx, steps);
      const latest = await tx.workflowDefinition.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } });
      if (latest && (latest.module !== input.module || latest.entityType !== input.entityType)) {
        throw new AppError(409, 'WORKFLOW_CODE_MODULE_MISMATCH', `Code ${input.code} belongs to ${latest.module}/${latest.entityType}`);
      }
      const created = await tx.workflowDefinition.create({
        data: { code: input.code, version: (latest?.version ?? 0) + 1, name: input.name, description: input.description ?? null, module: input.module, entityType: input.entityType, createdBy: actor.auth.userId, steps: { create: steps } },
        include,
      });
      await auditService.log(audit(actor, 'CREATE_WORKFLOW_DEFINITION', created.id, undefined, { code: created.code, version: created.version, module: created.module, entityType: created.entityType, steps: steps.map((s) => ({ stepOrder: s.stepOrder, approverType: s.approverType, onSelf: s.onSelf, onUnresolved: s.onUnresolved })) }), tx);
      return created;
    });
    return toDto(row);
  },

  /** Activates a version and deactivates every other version of the same code (one active version per code). */
  async activate(id: string, actor: Actor): Promise<WorkflowDefinitionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const def = await tx.workflowDefinition.findUnique({ where: { id }, include });
      if (!def) throw new AppError(404, 'WORKFLOW_DEFINITION_NOT_FOUND', 'Workflow definition not found');
      if (def.isActive) return def;
      await validateDefinitionSteps(tx, def.steps);
      const previous = await tx.workflowDefinition.findMany({ where: { code: def.code, isActive: true }, select: { id: true, version: true } });
      await tx.workflowDefinition.updateMany({ where: { code: def.code, isActive: true }, data: { isActive: false } });
      const after = await tx.workflowDefinition.update({ where: { id }, data: { isActive: true, activatedAt: new Date() }, include });
      await auditService.log(audit(actor, 'ACTIVATE_WORKFLOW_DEFINITION', id, { activeVersions: previous.map((p) => p.version) }, { code: def.code, version: def.version }), tx);
      return after;
    });
    return toDto(row);
  },

  /** Deactivates a version; running instances keep their snapshot and finish normally. */
  async deactivate(id: string, actor: Actor): Promise<WorkflowDefinitionDto> {
    const row = await prisma.$transaction(async (tx) => {
      const def = await tx.workflowDefinition.findUnique({ where: { id }, include });
      if (!def) throw new AppError(404, 'WORKFLOW_DEFINITION_NOT_FOUND', 'Workflow definition not found');
      if (!def.isActive) return def;
      const after = await tx.workflowDefinition.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_WORKFLOW_DEFINITION', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },
};
