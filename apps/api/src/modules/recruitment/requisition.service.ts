import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, RECRUITMENT_WORKFLOW, type CreateRequisitionInput, type RequisitionDto, type RequisitionListQuery, type UpdateRequisitionInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { recruitmentPolicyService } from './policy.service';
import { fullName, isRecruitmentAdmin, lockRow, nextNumber, notFound, recruitmentAudit, requesterEmployeeId, textAudit, type Actor, type Db, type Tx } from './recruitment.types';

/**
 * Requisitions — a request for headcount.
 *
 * A requisition references the masters (organization, department, job, position, hiring manager) and, at submit,
 * freezes their names: the approver decides on what they saw, and a department rename next month does not rewrite
 * the record of that decision. Only APPROVED requisitions can carry openings, and the openings together never ask
 * for more heads than were approved.
 */
const include = {
  organization: { select: { id: true, name: true } },
  job: { select: { id: true, code: true, title: true } },
  hiringManagerEmployee: { select: { id: true, firstName: true, lastName: true } },
  openings: { select: { id: true, openingNumber: true, status: true, openingsCount: true, applications: { where: { stage: 'HIRED' }, select: { id: true } } }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.RecruitmentRequisitionInclude;
type Row = Prisma.RecruitmentRequisitionGetPayload<{ include: typeof include }>;

async function toDto(db: Db, row: Row): Promise<RequisitionDto> {
  const [department, position] = await Promise.all([
    row.departmentId ? db.department.findUnique({ where: { id: row.departmentId }, select: { id: true, name: true } }) : null,
    row.positionId ? db.position.findUnique({ where: { id: row.positionId }, select: { id: true, code: true, title: true } }) : null,
  ]);
  return {
    id: row.id,
    requisitionNumber: row.requisitionNumber,
    organization: row.organization,
    department,
    job: row.job,
    position,
    hiringManager: { employeeId: row.hiringManagerEmployeeId, userId: row.hiringManagerUserId, name: fullName(row.hiringManagerEmployee) },
    requestedOpenings: row.requestedOpenings,
    employmentType: row.employmentType,
    reason: row.reason as RequisitionDto['reason'],
    desiredStartDate: row.desiredStartDate,
    justification: row.justification,
    status: row.status as RequisitionDto['status'],
    workflowInstanceId: row.workflowInstanceId,
    snapshot: row.submittedAt
      ? { organizationName: row.organizationNameSnapshot, departmentName: row.departmentNameSnapshot, jobTitle: row.jobTitleSnapshot, positionTitle: row.positionTitleSnapshot, hiringManagerName: row.hiringManagerNameSnapshot }
      : null,
    openings: row.openings.map((o) => ({ id: o.id, openingNumber: o.openingNumber, status: o.status, openingsCount: o.openingsCount, filledCount: o.applications.length })),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every reference must exist and hang together: the department in the organization, the position in the department. */
async function validateReferences(db: Db, input: { organizationId?: string; departmentId?: string | null; jobId?: string; positionId?: string | null; hiringManagerEmployeeId?: string | null }) {
  const out: { hiringManagerUserId?: string | null } = {};
  if (input.organizationId && !(await db.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  if (input.jobId && !(await db.job.findUnique({ where: { id: input.jobId }, select: { id: true } }))) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found');
  if (input.departmentId) {
    const dept = await db.department.findUnique({ where: { id: input.departmentId }, select: { organizationId: true } });
    if (!dept) throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
    if (input.organizationId && dept.organizationId !== input.organizationId) throw new AppError(422, 'DEPARTMENT_ORGANIZATION_MISMATCH', 'That department belongs to a different organization');
  }
  if (input.positionId) {
    const pos = await db.position.findUnique({ where: { id: input.positionId }, select: { departmentId: true, jobId: true } });
    if (!pos) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
    if (input.departmentId && pos.departmentId !== input.departmentId) throw new AppError(422, 'POSITION_DEPARTMENT_MISMATCH', 'That position belongs to a different department');
    if (input.jobId && pos.jobId !== input.jobId) throw new AppError(422, 'POSITION_JOB_MISMATCH', 'That position belongs to a different job');
  }
  if (input.hiringManagerEmployeeId !== undefined) {
    if (input.hiringManagerEmployeeId === null) out.hiringManagerUserId = null;
    else {
      const hm = await db.employee.findUnique({ where: { id: input.hiringManagerEmployeeId }, select: { user: { select: { id: true } } } });
      if (!hm) throw new AppError(404, 'HIRING_MANAGER_NOT_FOUND', 'Hiring manager not found');
      out.hiringManagerUserId = hm.user?.id ?? null;
    }
  }
  return out;
}

async function load(db: Db, id: string) {
  const row = await db.recruitmentRequisition.findUnique({ where: { id }, include });
  if (!row) throw notFound('requisition');
  return row;
}

const scopeWhere = (auth: AuthContext): Prisma.RecruitmentRequisitionWhereInput => (isRecruitmentAdmin(auth) ? {} : { hiringManagerUserId: auth.userId });

export const requisitionService = {
  async list(auth: AuthContext, q: RequisitionListQuery) {
    const where: Prisma.RecruitmentRequisitionWhereInput = { ...scopeWhere(auth), status: q.status, organizationId: q.organizationId, departmentId: q.departmentId };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentRequisition.count({ where }),
      prisma.recruitmentRequisition.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: await Promise.all(rows.map((r) => toDto(prisma, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<RequisitionDto> {
    const row = await prisma.recruitmentRequisition.findFirst({ where: { id, ...scopeWhere(auth) }, include });
    if (!row) throw notFound('requisition');
    return toDto(prisma, row);
  },

  async create(input: CreateRequisitionInput, actor: Actor): Promise<RequisitionDto> {
    const refs = await validateReferences(prisma, input);
    const row = await prisma.$transaction(async (tx) => {
      const requisitionNumber = await nextNumber(tx, 'requisition');
      const created = await tx.recruitmentRequisition.create({
        data: {
          requisitionNumber, organizationId: input.organizationId, departmentId: input.departmentId ?? null, jobId: input.jobId, positionId: input.positionId ?? null,
          hiringManagerEmployeeId: input.hiringManagerEmployeeId ?? null, hiringManagerUserId: refs.hiringManagerUserId ?? null,
          requestedOpenings: input.requestedOpenings, employmentType: input.employmentType ?? null, reason: input.reason,
          desiredStartDate: input.desiredStartDate ?? null, justification: input.justification ?? null, createdByUserId: actor.auth.userId,
        },
        include,
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CREATE_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', created.id,
        { requisitionNumber, organizationId: input.organizationId, jobId: input.jobId, requestedOpenings: input.requestedOpenings, reason: input.reason, ...textAudit('justification', null, input.justification) }), tx);
      return created;
    });
    return toDto(prisma, row);
  },

  async update(id: string, input: UpdateRequisitionInput, actor: Actor): Promise<RequisitionDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_requisitions', id);
      const before = await load(tx, id);
      if (before.status !== 'DRAFT') throw new AppError(409, 'REQUISITION_NOT_DRAFT', `A ${before.status.toLowerCase().replace('_', ' ')} requisition cannot be edited`);
      const merged = { organizationId: input.organizationId ?? before.organizationId, departmentId: input.departmentId === undefined ? before.departmentId : input.departmentId, jobId: input.jobId ?? before.jobId, positionId: input.positionId === undefined ? before.positionId : input.positionId, hiringManagerEmployeeId: input.hiringManagerEmployeeId };
      const refs = await validateReferences(tx, merged);
      const updated = await tx.recruitmentRequisition.update({
        where: { id },
        data: {
          organizationId: merged.organizationId, departmentId: merged.departmentId, jobId: merged.jobId, positionId: merged.positionId,
          ...(input.hiringManagerEmployeeId !== undefined ? { hiringManagerEmployeeId: input.hiringManagerEmployeeId, hiringManagerUserId: refs.hiringManagerUserId ?? null } : {}),
          requestedOpenings: input.requestedOpenings, employmentType: input.employmentType, reason: input.reason, desiredStartDate: input.desiredStartDate, justification: input.justification,
        },
        include,
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id,
        { fields: Object.keys(input).filter((k) => k !== 'justification'), requestedOpenings: updated.requestedOpenings, ...textAudit('justification', before.justification, updated.justification) },
        { requestedOpenings: before.requestedOpenings }), tx);
      return updated;
    });
    return toDto(prisma, row);
  },

  /** Snapshots the masters and hands the requisition to the organization's requisition workflow. */
  async submit(id: string, actor: Actor): Promise<RequisitionDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_requisitions', id);
      const row = await load(tx, id);
      if (row.status !== 'DRAFT') throw new AppError(409, 'REQUISITION_NOT_DRAFT', `This requisition is already ${row.status.toLowerCase().replace('_', ' ')}`);
      const policy = await recruitmentPolicyService.resolve(tx, row.organizationId);
      const requester = await requesterEmployeeId(tx, actor.auth.userId);
      const [department, position] = await Promise.all([
        row.departmentId ? tx.department.findUnique({ where: { id: row.departmentId }, select: { name: true } }) : null,
        row.positionId ? tx.position.findUnique({ where: { id: row.positionId }, select: { title: true } }) : null,
      ]);
      const instance = await workflowEngine.submit(
        { definitionCode: policy.requisitionWorkflowCode, module: RECRUITMENT_WORKFLOW.module, entityType: RECRUITMENT_WORKFLOW.requisition, entityId: id, requesterEmployeeId: requester },
        actor, tx,
      );
      await tx.recruitmentRequisition.update({
        where: { id },
        data: {
          status: 'PENDING_APPROVAL', submittedAt: new Date(), workflowInstanceId: instance.id,
          organizationNameSnapshot: row.organization.name, departmentNameSnapshot: department?.name ?? null, jobTitleSnapshot: row.job.title,
          positionTitleSnapshot: position?.title ?? null, hiringManagerNameSnapshot: fullName(row.hiringManagerEmployee),
        },
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.SUBMIT_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id, { requisitionNumber: row.requisitionNumber, workflowInstanceId: instance.id }), tx);
    });
    return toDto(prisma, await load(prisma, id));
  },

  /** Workflow callbacks — inside the engine's transaction. */
  async approveFromWorkflow(tx: Tx, id: string, actor: Actor) {
    await lockRow(tx, 'recruitment_requisitions', id);
    const row = await load(tx, id);
    if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, 'REQUISITION_NOT_PENDING', `This requisition is ${row.status.toLowerCase().replace('_', ' ')}`);
    await tx.recruitmentRequisition.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.APPROVE_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id, { requisitionNumber: row.requisitionNumber, requestedOpenings: row.requestedOpenings }), tx);
  },
  async rejectFromWorkflow(tx: Tx, id: string, actor: Actor) {
    await lockRow(tx, 'recruitment_requisitions', id);
    const row = await load(tx, id);
    if (row.status !== 'PENDING_APPROVAL') throw new AppError(409, 'REQUISITION_NOT_PENDING', `This requisition is ${row.status.toLowerCase().replace('_', ' ')}`);
    await tx.recruitmentRequisition.update({ where: { id }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.REJECT_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id, { requisitionNumber: row.requisitionNumber }), tx);
  },
  async cancelFromWorkflow(tx: Tx, id: string) {
    await lockRow(tx, 'recruitment_requisitions', id);
    const row = await load(tx, id);
    if (row.status === 'PENDING_APPROVAL') await tx.recruitmentRequisition.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  },

  /** Cancel a draft; close an approved requisition once hiring against it is over. Openings still open block closing. */
  async cancel(id: string, actor: Actor): Promise<RequisitionDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_requisitions', id);
      const row = await load(tx, id);
      if (row.status !== 'DRAFT') throw new AppError(409, 'REQUISITION_NOT_DRAFT', 'Only a draft can be cancelled here; a submitted requisition is withdrawn through its workflow');
      await tx.recruitmentRequisition.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id, { status: 'CANCELLED' }, { status: 'DRAFT' }), tx);
    });
    return toDto(prisma, await load(prisma, id));
  },
  async close(id: string, actor: Actor): Promise<RequisitionDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_requisitions', id);
      const row = await load(tx, id);
      if (row.status !== 'APPROVED') throw new AppError(409, 'REQUISITION_NOT_APPROVED', `A ${row.status.toLowerCase().replace('_', ' ')} requisition cannot be closed`);
      if (row.openings.some((o) => o.status === 'OPEN' || o.status === 'ON_HOLD' || o.status === 'DRAFT')) throw new AppError(409, 'OPENINGS_STILL_ACTIVE', 'Close or cancel its openings first');
      await tx.recruitmentRequisition.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_REQUISITION, 'RecruitmentRequisition', id, { status: 'CLOSED' }, { status: 'APPROVED' }), tx);
    });
    return toDto(prisma, await load(prisma, id));
  },
};
