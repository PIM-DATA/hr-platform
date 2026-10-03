import {
  ACKNOWLEDGEMENT_STATEMENT, AUDIT_ACTIONS, EMPLOYEE_RELATIONS_WORKFLOW, NOTIFICATION_TYPES, PERMISSIONS, addDays,
  formatCaseNumber, renderLetterTemplate, toPlainText, validityState,
  type AcknowledgementDto, type ApprovalProjectionDto, type CaseDetailDto, type CaseListQuery, type CaseSummaryDto,
  type CreateActionInput, type CreateCaseInput, type DeclineAcknowledgementInput, type DisciplinaryActionDto,
  type ActionListQuery, type EmployeeRelationsSummaryDto, type MyDisciplinaryRecordDto, type PriorActionDto,
  type TimelineEntryDto, type UpdateActionInput, type UpdateCaseInput, type WarningLetterDto,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import { workflowEngine } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { actionTypeService, disciplinaryPolicyService } from './er-config.service';
import { erAudit, narrativeAudit, type Actor, type Db, type Tx } from './er.types';
import { businessYear, employeeTodays, perOrganizationToday, todayForEmployee } from '../../services/business-time/business-time';
import { isSelf } from '../../services/authorization/self-dealing';

/**
 * Employee relations cases and the disciplinary actions on them.
 *
 * Three commitments run through this file.
 *
 * **Nothing here is a legal conclusion.** A case records what was reported; an action records what a person chose to
 * propose and what an approver decided. The system shows what already stands against somebody so HR can decide, and
 * never decides for them — no escalation, no ladder, no "three strikes".
 *
 * **Issued means frozen.** An action reaches ISSUED only through a final workflow approval, and at that moment the
 * letter becomes its own immutable record with every fact snapshotted. Nobody edits it afterwards; a mistake is a new
 * action, not a corrected one.
 *
 * **Acknowledgement is receipt.** The statement an employee agrees to says so, and is frozen onto the acknowledgement
 * so it can never be reinterpreted.
 */
const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true } } as const;

const actionInclude = {
  employee: employeeRef,
  case: { select: { caseNumber: true } },
  letter: true,
} satisfies Prisma.DisciplinaryActionInclude;
type ActionRow = Prisma.DisciplinaryActionGetPayload<{ include: typeof actionInclude }>;

const caseInclude = {
  employee: employeeRef,
  category: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, email: true } },
  actions: { include: actionInclude, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.EmployeeRelationCaseInclude;
type CaseRow = Prisma.EmployeeRelationCaseGetPayload<{ include: typeof caseInclude }>;


const toLetterDto = (row: NonNullable<ActionRow['letter']>): WarningLetterDto => ({
  id: row.id,
  letterNumber: row.letterNumber,
  subject: row.subject,
  employeeName: row.employeeNameSnapshot,
  employeeCode: row.employeeCodeSnapshot,
  position: row.positionSnapshot,
  department: row.departmentSnapshot,
  organization: row.organizationSnapshot,
  incidentDate: row.incidentDateSnapshot,
  actionName: row.actionNameSnapshot,
  body: row.bodySnapshot,
  issuedAt: row.issuedAt.toISOString(),
  validUntil: row.validUntilSnapshot,
  acknowledgementText: row.acknowledgementTextSnapshot,
});

/** `today` is the subject employee's business date in their organization's zone (Task 53; ER used UTC). */
const toActionDto = (row: ActionRow, today: string): DisciplinaryActionDto => ({
  id: row.id,
  caseId: row.caseId,
  caseNumber: row.case.caseNumber,
  employee: row.employee,
  actionType: { id: row.actionTypeId, code: row.actionTypeCodeSnapshot, name: row.actionTypeNameSnapshot },
  requiresWarningLetter: row.requiresWarningLetter,
  requiresAcknowledgement: row.requiresAcknowledgement,
  reason: row.reason,
  effectiveDate: row.effectiveDate,
  validityDays: row.validityDays,
  issuedDate: row.issuedDate,
  validUntil: row.validUntil,
  validity: validityState(row.status, row.validUntil, today),
  status: row.status as DisciplinaryActionDto['status'],
  workflowInstanceId: row.workflowInstanceId,
  letterSubject: row.letterSubject,
  letterBody: row.letterBody,
  letter: row.letter ? toLetterDto(row.letter) : null,
  acknowledgementDueDate: row.acknowledgementDueDate,
  acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  declinedAt: row.declinedAt?.toISOString() ?? null,
  submittedAt: row.submittedAt?.toISOString() ?? null,
  issuedAt: row.issuedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** The proposal that is live on a case: anything not rejected or cancelled, most recent first. */
const currentActionOf = (row: CaseRow) =>
  [...row.actions].reverse().find((a) => !['REJECTED', 'CANCELLED'].includes(a.status)) ?? null;

function toSummaryDto(row: CaseRow, today: string): CaseSummaryDto {
  const current = currentActionOf(row);
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    employee: { id: row.employee.id, employeeCode: row.employeeCodeSnapshot, firstName: row.employee.firstName, lastName: row.employee.lastName },
    snapshot: { organizationName: row.organizationName, departmentName: row.departmentName, positionTitle: row.positionTitle, jobTitle: row.jobTitle },
    incidentDate: row.incidentDate,
    reportedAt: row.reportedAt.toISOString(),
    category: row.categoryNameSnapshot ? { id: row.categoryId ?? '', name: row.categoryNameSnapshot } : null,
    title: row.title,
    status: row.status as CaseSummaryDto['status'],
    currentAction: current
      ? {
          id: current.id, actionTypeName: current.actionTypeNameSnapshot, status: current.status, issuedDate: current.issuedDate,
          validUntil: current.validUntil, validity: validityState(current.status, current.validUntil, today),
          acknowledgedAt: current.acknowledgedAt?.toISOString() ?? null,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Task 51 (T44-P1-19): the subject of a case never handles it — not reading it as HR, not editing it, not deciding its
 * actions. To them it is indistinguishable from a case that does not exist (their own disciplinary records stay
 * reachable through /my/records, the employee's acknowledgement flow).
 */
async function loadCase(db: Db, id: string, auth?: AuthContext): Promise<CaseRow> {
  const row = await db.employeeRelationCase.findUnique({ where: { id }, include: caseInclude });
  if (!row || (auth && isSelf(auth, row.employeeId))) throw new AppError(404, 'ER_CASE_NOT_FOUND', 'Case not found');
  return row;
}

async function loadAction(db: Db, id: string, auth?: AuthContext): Promise<ActionRow> {
  const row = await db.disciplinaryAction.findUnique({ where: { id }, include: actionInclude });
  if (!row || (auth && isSelf(auth, row.employeeId))) throw new AppError(404, 'DISCIPLINARY_ACTION_NOT_FOUND', 'Disciplinary action not found');
  return row;
}

/** A workflow decision on an action about the approver themselves is refused (the engine only excludes the requester). */
function assertNotDecidingOwn(actor: Actor, employeeId: string) {
  if (isSelf(actor.auth, employeeId)) throw new AppError(409, 'ER_SUBJECT_CANNOT_DECIDE', 'This action concerns you; another approver must decide it');
}

const lockCase = async (tx: Tx, caseId: string) => {
  await tx.$executeRaw`SELECT "id" FROM "employee_relation_cases" WHERE "id" = ${caseId} FOR UPDATE`;
};

/** What currently stands against an employee — shown to a person deciding, never used to decide. */
async function priorActiveActions(db: Db, employeeId: string, excludeCaseId?: string): Promise<PriorActionDto[]> {
  const rows = await db.disciplinaryAction.findMany({
    where: { employeeId, status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, ...(excludeCaseId ? { caseId: { not: excludeCaseId } } : {}) },
    include: { case: { select: { caseNumber: true } } },
    orderBy: { issuedAt: 'desc' },
  });
  const now = await todayForEmployee(db, employeeId);
  return rows
    .map((a) => ({ actionId: a.id, caseNumber: a.case.caseNumber, actionTypeName: a.actionTypeNameSnapshot, issuedDate: a.issuedDate, validUntil: a.validUntil, validity: validityState(a.status, a.validUntil, now) }))
    .filter((a) => a.validity === 'ACTIVE');
}

/**
 * The case's story, assembled from the records that already exist — the case, its actions, the workflow and the
 * acknowledgement — rather than a second event store that could drift from them.
 */
async function timelineOf(db: Db, row: CaseRow): Promise<TimelineEntryDto[]> {
  const entries: TimelineEntryDto[] = [{ at: row.createdAt.toISOString(), kind: 'CREATED', label: 'Case opened', actor: null, comment: null }];
  for (const action of row.actions) {
    if (action.submittedAt) entries.push({ at: action.submittedAt.toISOString(), kind: 'SUBMITTED', label: `${action.actionTypeNameSnapshot} submitted for approval`, actor: null, comment: null });
    if (action.workflowInstanceId) {
      const steps = await db.workflowInstanceStep.findMany({ where: { instanceId: action.workflowInstanceId, actedAt: { not: null } }, include: { actedBy: { select: { email: true } } }, orderBy: { actedAt: 'asc' } });
      for (const step of steps) {
        entries.push({ at: step.actedAt!.toISOString(), kind: step.status, label: `${step.name}: ${step.status.toLowerCase()}`, actor: step.actedBy?.email ?? null, comment: step.comment });
      }
    }
    if (action.issuedAt) entries.push({ at: action.issuedAt.toISOString(), kind: 'ISSUED', label: `${action.actionTypeNameSnapshot} issued${action.letter ? ` (${action.letter.letterNumber})` : ''}`, actor: null, comment: null });
    if (action.acknowledgedAt) entries.push({ at: action.acknowledgedAt.toISOString(), kind: 'ACKNOWLEDGED', label: 'Receipt acknowledged by the employee', actor: null, comment: null });
    if (action.declinedAt) entries.push({ at: action.declinedAt.toISOString(), kind: 'DECLINED', label: 'Employee declined to acknowledge receipt (recorded by HR)', actor: null, comment: null });
    if (action.rejectedAt) entries.push({ at: action.rejectedAt.toISOString(), kind: 'REJECTED', label: `${action.actionTypeNameSnapshot} proposal rejected`, actor: null, comment: null });
    if (action.cancelledAt) entries.push({ at: action.cancelledAt.toISOString(), kind: 'CANCELLED', label: `${action.actionTypeNameSnapshot} proposal withdrawn`, actor: null, comment: null });
  }
  if (row.closedAt) entries.push({ at: row.closedAt.toISOString(), kind: 'CLOSED', label: 'Case closed', actor: null, comment: null });
  if (row.cancelledAt) entries.push({ at: row.cancelledAt.toISOString(), kind: 'CASE_CANCELLED', label: 'Case cancelled', actor: null, comment: null });
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

async function toDetailDto(db: Db, row: CaseRow, includeInternal: boolean): Promise<CaseDetailDto> {
  const today = await todayForEmployee(db, row.employeeId);
  return {
    ...toSummaryDto(row, today),
    description: row.description,
    ...(includeInternal ? { internalNotes: row.internalNotes } : {}),
    assignedTo: row.assignedTo,
    actions: row.actions.map((a) => toActionDto(a, today)),
    priorActiveActions: await priorActiveActions(db, row.employeeId, row.id),
    timeline: await timelineOf(db, row),
    closedAt: row.closedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

/** Case numbers come from a per-year counter taken under a row lock: two cases opened at once get two numbers. */
async function nextCaseNumber(tx: Tx, employeeId: string): Promise<string> {
  const year = await businessYear(tx, { employeeId }); // Task 53: the subject's business year
  await tx.employeeRelationCaseSequence.upsert({ where: { year }, create: { year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "year" FROM "employee_relation_case_sequences" WHERE "year" = ${year} FOR UPDATE`;
  const row = await tx.employeeRelationCaseSequence.findUniqueOrThrow({ where: { year } });
  await tx.employeeRelationCaseSequence.update({ where: { year }, data: { next: row.next + 1 } });
  return formatCaseNumber(year, row.next);
}

// ---------------------------------------------------------------------------
export const erCaseService = {
  async create(input: CreateCaseInput, actor: Actor): Promise<CaseDetailDto> {
    if (isSelf(actor.auth, input.employeeId)) throw new AppError(403, 'ER_SUBJECT_NOT_ALLOWED', 'You cannot open an employee-relations case about yourself');
    const row = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: input.employeeId },
        select: {
          id: true, employeeCode: true, firstName: true, lastName: true, organizationId: true, departmentId: true, positionId: true,
          organization: { select: { name: true } }, department: { select: { name: true } },
          position: { select: { title: true, jobId: true, job: { select: { title: true } } } },
        },
      });
      if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      const category = input.categoryId ? await tx.disciplinaryCaseCategory.findUnique({ where: { id: input.categoryId }, select: { id: true, name: true } }) : null;
      if (input.categoryId && !category) throw new AppError(404, 'CASE_CATEGORY_NOT_FOUND', 'Case category not found');

      const created = await tx.employeeRelationCase.create({
        data: {
          caseNumber: await nextCaseNumber(tx, employee.id),
          employeeId: employee.id,
          employeeCodeSnapshot: employee.employeeCode,
          employeeNameSnapshot: `${employee.firstName} ${employee.lastName}`,
          organizationId: employee.organizationId,
          organizationName: employee.organization?.name ?? null,
          departmentId: employee.departmentId,
          departmentName: employee.department?.name ?? null,
          positionId: employee.positionId,
          positionTitle: employee.position?.title ?? null,
          jobId: employee.position?.jobId ?? null,
          jobTitle: employee.position?.job?.title ?? null,
          incidentDate: input.incidentDate,
          categoryId: category?.id ?? null,
          categoryNameSnapshot: category?.name ?? null,
          title: input.title,
          description: toPlainText(input.description),
          internalNotes: input.internalNotes ? toPlainText(input.internalNotes) : null,
          status: 'DRAFT',
          createdByUserId: actor.auth.userId,
        },
        include: caseInclude,
      });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.CREATE_EMPLOYEE_RELATION_CASE, 'EmployeeRelationCase', created.id, {
        caseNumber: created.caseNumber, employee: created.employeeCodeSnapshot, category: created.categoryNameSnapshot, incidentDate: created.incidentDate,
        descriptionLength: created.description.length, hasInternalNotes: !!created.internalNotes,
      }), tx);
      return created;
    });
    return toDetailDto(prisma, row, true);
  },

  async update(id: string, input: UpdateCaseInput, actor: Actor): Promise<CaseDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockCase(tx, id);
      const before = await loadCase(tx, id, actor.auth);
      if (['CLOSED', 'CANCELLED'].includes(before.status)) throw new AppError(409, 'ER_CASE_FINISHED', `This case is ${before.status.toLowerCase()}`);
      // Once a proposal is with an approver, the facts it was based on do not move underneath them.
      const frozen = before.status === 'PENDING_APPROVAL' || before.status === 'ACTION_ISSUED';
      if (frozen && (input.incidentDate || input.description || input.title || input.categoryId !== undefined)) {
        throw new AppError(409, 'ER_CASE_FROZEN', 'The incident details are frozen once an action has been submitted; only notes and assignment can change');
      }
      let categoryName: string | null | undefined;
      if (input.categoryId !== undefined) {
        const category = input.categoryId ? await tx.disciplinaryCaseCategory.findUnique({ where: { id: input.categoryId }, select: { name: true } }) : null;
        if (input.categoryId && !category) throw new AppError(404, 'CASE_CATEGORY_NOT_FOUND', 'Case category not found');
        categoryName = category?.name ?? null;
      }
      const after = await tx.employeeRelationCase.update({
        where: { id },
        data: {
          incidentDate: input.incidentDate,
          categoryId: input.categoryId,
          categoryNameSnapshot: categoryName,
          title: input.title,
          description: input.description ? toPlainText(input.description) : undefined,
          internalNotes: input.internalNotes === undefined ? undefined : input.internalNotes ? toPlainText(input.internalNotes) : null,
          assignedToUserId: input.assignedToUserId,
        },
        include: caseInclude,
      });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_EMPLOYEE_RELATION_CASE, 'EmployeeRelationCase', id, {
        caseNumber: after.caseNumber, titleChanged: before.title !== after.title, titleLength: after.title.length, incidentDate: after.incidentDate, assignedToUserId: after.assignedToUserId,
        ...narrativeAudit('description', before.description, after.description),
        ...narrativeAudit('internalNotes', before.internalNotes, after.internalNotes),
      }, { titleLength: before.title.length, incidentDate: before.incidentDate }), tx);
      return after;
    });
    return toDetailDto(prisma, row, true);
  },

  async list(auth: AuthContext, q: CaseListQuery): Promise<{ data: CaseSummaryDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.EmployeeRelationCaseWhereInput = {
      ...(auth.employeeId ? { NOT: { employeeId: auth.employeeId } } : {}), // Task 51: never one's own case
      employeeId: q.employeeId,
      departmentId: q.departmentId,
      status: q.status,
      ...(q.actionTypeId ? { actions: { some: { actionTypeId: q.actionTypeId, status: { notIn: ['REJECTED', 'CANCELLED'] } } } } : {}),
      ...(q.from ? { incidentDate: { gte: q.from } } : {}),
      ...(q.to ? { incidentDate: { ...(q.from ? { gte: q.from } : {}), lte: q.to } } : {}),
      ...(q.search ? { OR: [{ caseNumber: { contains: q.search, mode: 'insensitive' } }, { title: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.employeeRelationCase.count({ where }),
      prisma.employeeRelationCase.findMany({ where, include: caseInclude, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const todays = await employeeTodays(prisma, rows.map((r) => r.employeeId));
    return { data: rows.map((r) => toSummaryDto(r, todays.get(r.employeeId)!)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<CaseDetailDto> {
    const row = await loadCase(prisma, id, auth);
    return toDetailDto(prisma, row, hasPermission(auth, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE));
  },

  /** Closing ends the operational work. The issued action stands; an acknowledgement may still be pending. */
  async close(id: string, actor: Actor): Promise<CaseDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockCase(tx, id);
      const before = await loadCase(tx, id, actor.auth);
      if (before.status === 'CLOSED') throw new AppError(409, 'ER_CASE_CLOSED', 'This case is already closed');
      if (before.status === 'PENDING_APPROVAL') throw new AppError(409, 'ER_CASE_PENDING', 'A proposal is with an approver; wait for the decision before closing');
      if (before.status === 'CANCELLED') throw new AppError(409, 'ER_CASE_FINISHED', 'This case is cancelled');
      const after = await tx.employeeRelationCase.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() }, include: caseInclude });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.CLOSE_EMPLOYEE_RELATION_CASE, 'EmployeeRelationCase', id, { caseNumber: after.caseNumber }, { status: before.status }), tx);
      return after;
    });
    return toDetailDto(prisma, row, true);
  },

  /** A case with nothing issued can be cancelled. One with an issued action cannot — that record stands. */
  async cancel(id: string, actor: Actor): Promise<CaseDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockCase(tx, id);
      const before = await loadCase(tx, id, actor.auth);
      if (!['DRAFT', 'UNDER_REVIEW'].includes(before.status)) throw new AppError(409, 'ER_CASE_NOT_CANCELLABLE', `A ${before.status.toLowerCase().replace('_', ' ')} case cannot be cancelled`);
      await tx.disciplinaryAction.updateMany({ where: { caseId: id, status: 'DRAFT' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      const after = await tx.employeeRelationCase.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() }, include: caseInclude });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_EMPLOYEE_RELATION_CASE, 'EmployeeRelationCase', id, { caseNumber: after.caseNumber, status: 'CANCELLED' }, { status: before.status }), tx);
      return after;
    });
    return toDetailDto(prisma, row, true);
  },

  // -------------------------------------------------------------------------
  // actions
  // -------------------------------------------------------------------------
  async createAction(caseId: string, input: CreateActionInput, actor: Actor): Promise<CaseDetailDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockCase(tx, caseId);
      const erCase = await loadCase(tx, caseId, actor.auth);
      if (!['DRAFT', 'UNDER_REVIEW'].includes(erCase.status)) throw new AppError(409, 'ER_CASE_NOT_OPEN', `A ${erCase.status.toLowerCase().replace('_', ' ')} case cannot take a new proposal`);
      if (currentActionOf(erCase)) throw new AppError(409, 'DISCIPLINARY_ACTION_EXISTS', 'This case already has a proposal; withdraw it first');
      const type = await actionTypeService.require(tx, input.actionTypeId);

      let subject = input.letterSubject ?? null;
      let body = input.letterBody ?? null;
      if (input.letterTemplateId) {
        const template = await tx.warningLetterTemplate.findUnique({ where: { id: input.letterTemplateId } });
        if (!template || !template.isActive) throw new AppError(404, 'LETTER_TEMPLATE_NOT_FOUND', 'Letter template not found');
        const values = {
          employeeName: erCase.employeeNameSnapshot, employeeCode: erCase.employeeCodeSnapshot, incidentDate: erCase.incidentDate,
          actionName: type.name, department: erCase.departmentName, position: erCase.positionTitle, organization: erCase.organizationName,
        };
        subject = subject ?? renderLetterTemplate(template.subjectTemplate, values);
        body = body ?? renderLetterTemplate(template.bodyTemplate, values);
      }

      const created = await tx.disciplinaryAction.create({
        data: {
          caseId, employeeId: erCase.employeeId, actionTypeId: type.id,
          actionTypeCodeSnapshot: type.code, actionTypeNameSnapshot: type.name,
          requiresWarningLetter: type.requiresWarningLetter, requiresAcknowledgement: type.requiresAcknowledgement,
          reason: toPlainText(input.reason), effectiveDate: input.effectiveDate ?? null,
          validityDays: input.validityDays === undefined ? type.defaultValidityDays : input.validityDays,
          letterTemplateId: input.letterTemplateId ?? null,
          letterSubject: subject ? toPlainText(subject) : null,
          letterBody: body ? toPlainText(body) : null,
          status: 'DRAFT', createdByUserId: actor.auth.userId,
        },
      });
      await tx.employeeRelationCase.update({ where: { id: caseId }, data: { status: 'UNDER_REVIEW' } });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.CREATE_DISCIPLINARY_ACTION, 'DisciplinaryAction', created.id, {
        caseNumber: erCase.caseNumber, actionType: type.code, validityDays: created.validityDays, hasLetterDraft: !!created.letterBody,
      }), tx);
      return loadCase(tx, caseId, actor.auth);
    });
    return toDetailDto(prisma, row, true);
  },

  async updateAction(actionId: string, input: UpdateActionInput, actor: Actor): Promise<CaseDetailDto> {
    const caseId = await prisma.$transaction(async (tx) => {
      const before = await loadAction(tx, actionId, actor.auth);
      await lockCase(tx, before.caseId);
      if (before.status !== 'DRAFT') throw new AppError(409, 'DISCIPLINARY_ACTION_FROZEN', `This proposal is ${before.status.toLowerCase().replace('_', ' ')} and can no longer be edited`);
      const after = await tx.disciplinaryAction.update({
        where: { id: actionId },
        data: {
          reason: input.reason ? toPlainText(input.reason) : undefined,
          effectiveDate: input.effectiveDate,
          validityDays: input.validityDays,
          letterSubject: input.letterSubject === undefined ? undefined : input.letterSubject ? toPlainText(input.letterSubject) : null,
          letterBody: input.letterBody === undefined ? undefined : input.letterBody ? toPlainText(input.letterBody) : null,
        },
      });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, {
        validityDays: after.validityDays, effectiveDate: after.effectiveDate,
        ...narrativeAudit('reason', before.reason, after.reason), ...narrativeAudit('letterBody', before.letterBody, after.letterBody),
      }, { validityDays: before.validityDays }), tx);
      return before.caseId;
    });
    return toDetailDto(prisma, await loadCase(prisma, caseId, actor.auth), true);
  },

  /** Withdrawing a draft proposal. A pending one is withdrawn through the workflow; an issued one cannot be. */
  async cancelAction(actionId: string, actor: Actor): Promise<CaseDetailDto> {
    const caseId = await prisma.$transaction(async (tx) => {
      const before = await loadAction(tx, actionId, actor.auth);
      await lockCase(tx, before.caseId);
      if (before.status !== 'DRAFT') throw new AppError(409, 'DISCIPLINARY_ACTION_NOT_DRAFT', before.status === 'ISSUED' || before.status === 'ACKNOWLEDGED' ? 'An issued action cannot be cancelled; this release has no correction flow' : `This proposal is ${before.status.toLowerCase().replace('_', ' ')}`);
      await tx.disciplinaryAction.update({ where: { id: actionId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, { status: 'CANCELLED' }, { status: before.status }), tx);
      return before.caseId;
    });
    return toDetailDto(prisma, await loadCase(prisma, caseId, actor.auth), true);
  },

  /**
   * Sending a proposal to its approver. The letter must be drafted when the action type needs one, and the case's
   * facts freeze from here: the approver decides on what they were shown.
   */
  async submit(actionId: string, actor: Actor): Promise<CaseDetailDto> {
    const caseId = await prisma.$transaction(async (tx) => {
      const action = await loadAction(tx, actionId, actor.auth);
      await lockCase(tx, action.caseId);
      const fresh = await loadAction(tx, actionId, actor.auth);
      if (fresh.status !== 'DRAFT') throw new AppError(409, 'DISCIPLINARY_ACTION_NOT_DRAFT', `This proposal is already ${fresh.status.toLowerCase().replace('_', ' ')}`);
      if (fresh.requiresWarningLetter && (!fresh.letterSubject || !fresh.letterBody)) {
        throw new AppError(422, 'WARNING_LETTER_REQUIRED', `${fresh.actionTypeNameSnapshot} requires a warning letter; draft its subject and body first`);
      }
      const erCase = await loadCase(tx, action.caseId, actor.auth);
      if (!erCase.organizationId) throw new AppError(409, 'DISCIPLINARY_POLICY_NOT_FOUND', 'The employee has no organization, so no policy applies');
      const policy = await disciplinaryPolicyService.resolve(tx, erCase.organizationId, erCase.incidentDate);
      const requester = await tx.employee.findFirst({ where: { user: { id: actor.auth.userId } }, select: { id: true } });
      if (!requester) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'Submitting for approval needs an account linked to an employee record');

      const instance = await workflowEngine.submit(
        { definitionCode: policy.workflowDefinitionCode, module: EMPLOYEE_RELATIONS_WORKFLOW.module, entityType: EMPLOYEE_RELATIONS_WORKFLOW.entityType, entityId: actionId, requesterEmployeeId: requester.id },
        actor,
        tx,
      );
      await tx.disciplinaryAction.update({ where: { id: actionId }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), workflowInstanceId: instance.id } });
      await tx.employeeRelationCase.update({ where: { id: action.caseId }, data: { status: 'PENDING_APPROVAL' } });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.SUBMIT_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, {
        caseNumber: erCase.caseNumber, actionType: fresh.actionTypeCodeSnapshot, workflowInstanceId: instance.id,
      }), tx);
      return action.caseId;
    });
    return toDetailDto(prisma, await loadCase(prisma, caseId, actor.auth), true);
  },

  /**
   * Issue — called only by the workflow's final approval, inside its transaction. This is the one place an action
   * becomes ISSUED and the letter becomes a frozen record.
   */
  async issueFromWorkflow(tx: Tx, actionId: string, actor: Actor, comment: string | null | undefined) {
    const action = await loadAction(tx, actionId);
    assertNotDecidingOwn(actor, action.employeeId); // Task 51
    await lockCase(tx, action.caseId);
    const fresh = await loadAction(tx, actionId);
    if (fresh.status !== 'PENDING_APPROVAL') throw new AppError(409, 'DISCIPLINARY_ACTION_NOT_PENDING', `This proposal is ${fresh.status.toLowerCase().replace('_', ' ')}`);
    const erCase = await loadCase(tx, action.caseId);

    const issuedDate = await todayForEmployee(tx, erCase.employeeId);
    const validUntil = fresh.validityDays ? addDays(issuedDate, fresh.validityDays) : null;
    const policy = erCase.organizationId ? await disciplinaryPolicyService.resolve(tx, erCase.organizationId, erCase.incidentDate).catch(() => null) : null;
    const dueDate = fresh.requiresAcknowledgement && policy?.defaultAcknowledgementDueDays ? addDays(issuedDate, policy.defaultAcknowledgementDueDays) : null;

    await tx.disciplinaryAction.update({
      where: { id: actionId },
      data: { status: 'ISSUED', approvedAt: new Date(), issuedAt: new Date(), issuedDate, validUntil, acknowledgementDueDate: dueDate, issuedByUserId: actor.auth.userId },
    });
    await tx.employeeRelationCase.update({ where: { id: action.caseId }, data: { status: 'ACTION_ISSUED' } });

    let letterNumber: string | null = null;
    if (fresh.requiresWarningLetter) {
      letterNumber = `WL-${erCase.caseNumber.replace(/^ER-/, '')}`;
      const values = {
        employeeName: erCase.employeeNameSnapshot, employeeCode: erCase.employeeCodeSnapshot, incidentDate: erCase.incidentDate,
        actionName: fresh.actionTypeNameSnapshot, department: erCase.departmentName, position: erCase.positionTitle,
        organization: erCase.organizationName, issuedDate, validUntil,
      };
      await tx.warningLetter.create({
        data: {
          disciplinaryActionId: actionId,
          letterNumber,
          subject: renderLetterTemplate(fresh.letterSubject ?? fresh.actionTypeNameSnapshot, values),
          employeeNameSnapshot: erCase.employeeNameSnapshot,
          employeeCodeSnapshot: erCase.employeeCodeSnapshot,
          positionSnapshot: erCase.positionTitle,
          departmentSnapshot: erCase.departmentName,
          organizationSnapshot: erCase.organizationName,
          incidentDateSnapshot: erCase.incidentDate,
          actionNameSnapshot: fresh.actionTypeNameSnapshot,
          bodySnapshot: renderLetterTemplate(fresh.letterBody ?? '', values),
          validUntilSnapshot: validUntil,
          acknowledgementTextSnapshot: ACKNOWLEDGEMENT_STATEMENT,
          issuedAt: new Date(),
        },
      });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.ISSUE_WARNING_LETTER, 'DisciplinaryAction', actionId, { caseNumber: erCase.caseNumber, letterNumber }), tx);
    }

    await auditService.log(erAudit(actor, AUDIT_ACTIONS.APPROVE_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, { caseNumber: erCase.caseNumber, commentLength: comment?.length ?? 0 }), tx);
    await auditService.log(erAudit(actor, AUDIT_ACTIONS.ISSUE_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, {
      caseNumber: erCase.caseNumber, actionType: fresh.actionTypeCodeSnapshot, issuedDate, validUntil, letterNumber, acknowledgementDueDate: dueDate,
    }), tx);

    // The employee is told that a document exists — and nothing about what it says.
    await notificationService.publish(
      {
        userId: (await tx.user.findFirst({ where: { employeeId: erCase.employeeId }, select: { id: true } }))?.id ?? null,
        type: NOTIFICATION_TYPES.DISCIPLINARY_ACTION_ISSUED,
        source: { module: 'employee_relations', entityType: 'DISCIPLINARY_ACTION', entityId: actionId },
        data: { actionId },
        dedupeKey: `er:${actionId}:issued`,
      },
      {},
      tx,
    );
  },

  async rejectFromWorkflow(tx: Tx, actionId: string, actor: Actor, comment: string | null | undefined) {
    const action = await loadAction(tx, actionId);
    assertNotDecidingOwn(actor, action.employeeId); // Task 51
    await lockCase(tx, action.caseId);
    // REJECTED is terminal for this proposal. HR drafts a new one rather than quietly editing the refused one.
    await tx.disciplinaryAction.update({ where: { id: actionId }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    await tx.employeeRelationCase.update({ where: { id: action.caseId }, data: { status: 'UNDER_REVIEW' } });
    await auditService.log(erAudit(actor, AUDIT_ACTIONS.REJECT_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, { caseNumber: action.case.caseNumber, commentLength: comment?.length ?? 0 }), tx);
  },

  async withdrawFromWorkflow(tx: Tx, actionId: string) {
    const action = await loadAction(tx, actionId);
    await lockCase(tx, action.caseId);
    await tx.disciplinaryAction.update({ where: { id: actionId }, data: { status: 'DRAFT', workflowInstanceId: null, submittedAt: null } });
    await tx.employeeRelationCase.update({ where: { id: action.caseId }, data: { status: 'UNDER_REVIEW' } });
  },

  /** What an approver may see: enough to decide, and no internal notes. Only the snapshot approver of the pending step. */
  async approvalProjection(auth: AuthContext, actionId: string): Promise<ApprovalProjectionDto> {
    const action = await loadAction(prisma, actionId, auth);
    if (!action.workflowInstanceId) throw AppError.forbidden();
    const step = await prisma.workflowInstanceStep.findFirst({ where: { instanceId: action.workflowInstanceId, approverUserId: auth.userId }, select: { name: true } });
    if (!step && !hasPermission(auth, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE)) throw AppError.forbidden();
    const erCase = await loadCase(prisma, action.caseId, auth);
    return {
      action: toActionDto(action, await todayForEmployee(prisma, action.employeeId)),
      caseSummary: { caseNumber: erCase.caseNumber, title: erCase.title, category: erCase.categoryNameSnapshot, incidentDate: erCase.incidentDate, description: erCase.description },
      priorActiveActions: await priorActiveActions(prisma, erCase.employeeId, erCase.id),
      workflowInstanceId: action.workflowInstanceId,
      stepName: step?.name ?? 'Approval',
    };
  },

  async listActions(auth: AuthContext, q: ActionListQuery): Promise<{ data: DisciplinaryActionDto[]; meta: { page: number; pageSize: number; total: number } }> {
    // Task 53: "still valid" is judged on each subject's own business today.
    const validFrom = await perOrganizationToday<Prisma.DisciplinaryActionWhereInput>(prisma, 'employeeId', (t) => ({ validUntil: { gte: t } }));
    const expiredBefore = await perOrganizationToday<Prisma.DisciplinaryActionWhereInput>(prisma, 'employeeId', (t) => ({ validUntil: { lt: t } }));
    const where: Prisma.DisciplinaryActionWhereInput = {
      ...(auth.employeeId ? { NOT: { employeeId: auth.employeeId } } : {}), // Task 51: never one's own actions
      employeeId: q.employeeId,
      actionTypeId: q.actionTypeId,
      status: q.status,
      ...(q.departmentId ? { case: { departmentId: q.departmentId } } : {}),
      ...(q.validity === 'ACTIVE' ? { status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, OR: [{ validUntil: null }, validFrom] } : {}),
      ...(q.validity === 'EXPIRED' ? { status: { in: ['ISSUED', 'ACKNOWLEDGED'] }, AND: [expiredBefore] } : {}),
      ...(q.awaitingAcknowledgement ? { status: 'ISSUED', requiresAcknowledgement: true, acknowledgedAt: null } : {}),
      ...(q.search ? { case: { OR: [{ caseNumber: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.disciplinaryAction.count({ where }),
      prisma.disciplinaryAction.findMany({ where, include: actionInclude, orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const todays = await employeeTodays(prisma, rows.map((r) => r.employeeId));
    return { data: rows.map((r) => toActionDto(r, todays.get(r.employeeId)!)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  // -------------------------------------------------------------------------
  // the employee's side
  // -------------------------------------------------------------------------
  /** Only what has been issued to the caller. No drafts, no case narrative, no proposals that were refused. */
  async myRecords(auth: AuthContext): Promise<MyDisciplinaryRecordDto[]> {
    if (!auth.employeeId) return [];
    const rows = await prisma.disciplinaryAction.findMany({ where: { employeeId: auth.employeeId, status: { in: ['ISSUED', 'ACKNOWLEDGED'] } }, include: actionInclude, orderBy: { issuedAt: 'desc' } });
    const now = await todayForEmployee(prisma, auth.employeeId);
    return rows.map((row) => ({
      id: row.id, caseNumber: row.case.caseNumber, actionTypeName: row.actionTypeNameSnapshot, issuedDate: row.issuedDate ?? '',
      validUntil: row.validUntil, validity: validityState(row.status, row.validUntil, now), requiresAcknowledgement: row.requiresAcknowledgement,
      acknowledgementDueDate: row.acknowledgementDueDate, acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      letter: row.letter ? toLetterDto(row.letter) : null,
    }));
  },

  async myRecord(auth: AuthContext, actionId: string): Promise<MyDisciplinaryRecordDto> {
    const record = (await erCaseService.myRecords(auth)).find((r) => r.id === actionId);
    // Somebody else's record, or a draft, is not found — the endpoint never confirms it exists.
    if (!record) throw new AppError(404, 'DISCIPLINARY_ACTION_NOT_FOUND', 'Record not found');
    return record;
  },

  /**
   * Acknowledging receipt. The employee is whoever is signed in — there is no target parameter to forge — and the
   * statement they agreed to is frozen with the record. Doing it twice returns the first acknowledgement unchanged.
   */
  async acknowledge(actor: Actor): Promise<(actionId: string) => Promise<AcknowledgementDto>> {
    return async (actionId: string) => {
      const auth = actor.auth;
      if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
      return prisma.$transaction(async (tx) => {
        const action = await tx.disciplinaryAction.findFirst({ where: { id: actionId, employeeId: auth.employeeId! }, include: { case: { select: { caseNumber: true, createdByUserId: true } }, acknowledgement: true } });
        if (!action || !['ISSUED', 'ACKNOWLEDGED'].includes(action.status)) throw new AppError(404, 'DISCIPLINARY_ACTION_NOT_FOUND', 'Record not found');
        if (!action.requiresAcknowledgement) throw new AppError(409, 'ACKNOWLEDGEMENT_NOT_REQUIRED', 'This record does not require an acknowledgement');
        await lockCase(tx, action.caseId);
        const existing = await tx.disciplinaryAcknowledgement.findUnique({ where: { actionId } });
        if (existing) return { id: existing.id, actionId, acknowledgedAt: existing.acknowledgedAt.toISOString(), acknowledgementText: existing.acknowledgementTextSnapshot };

        const at = new Date();
        const created = await tx.disciplinaryAcknowledgement.create({
          data: { actionId, employeeId: auth.employeeId!, userId: auth.userId, acknowledgedAt: at, acknowledgementTextSnapshot: ACKNOWLEDGEMENT_STATEMENT, ipAddress: actor.ipAddress, userAgent: actor.userAgent },
        });
        await tx.disciplinaryAction.update({ where: { id: actionId }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: at } });
        await auditService.log(erAudit(actor, AUDIT_ACTIONS.ACKNOWLEDGE_DISCIPLINARY_ACTION, 'DisciplinaryAction', actionId, { caseNumber: action.case.caseNumber, acknowledgedAt: at.toISOString() }), tx);
        await notificationService.publish(
          {
            userId: action.case.createdByUserId,
            type: NOTIFICATION_TYPES.DISCIPLINARY_ACTION_ACKNOWLEDGED,
            source: { module: 'employee_relations', entityType: 'DISCIPLINARY_ACTION', entityId: actionId },
            data: { actionId, caseId: action.caseId },
            dedupeKey: `er:${actionId}:acknowledged`,
          },
          {},
          tx,
        );
        return { id: created.id, actionId, acknowledgedAt: at.toISOString(), acknowledgementText: created.acknowledgementTextSnapshot };
      });
    };
  },

  /** HR records that the employee declined to sign. A refusal to acknowledge receipt is not an admission of anything either. */
  async recordDeclined(actionId: string, input: DeclineAcknowledgementInput, actor: Actor): Promise<CaseDetailDto> {
    const caseId = await prisma.$transaction(async (tx) => {
      const action = await loadAction(tx, actionId, actor.auth);
      await lockCase(tx, action.caseId);
      if (action.status !== 'ISSUED') throw new AppError(409, 'DISCIPLINARY_ACTION_NOT_ISSUED', 'Only an issued, unacknowledged record can be marked declined');
      await tx.disciplinaryAction.update({ where: { id: actionId }, data: { declinedAt: new Date(), declineNote: toPlainText(input.note) } });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.RECORD_ACKNOWLEDGEMENT_DECLINED, 'DisciplinaryAction', actionId, { caseNumber: action.case.caseNumber, noteLength: input.note.length }), tx);
      return action.caseId;
    });
    return toDetailDto(prisma, await loadCase(prisma, caseId, actor.auth), true);
  },

  /** The hand-off for a future Employee 360: counts, never narrative. */
  async summaryFor(auth: AuthContext, employeeId: string): Promise<EmployeeRelationsSummaryDto> {
    if (isSelf(auth, employeeId)) throw new AppError(404, 'ER_CASE_NOT_FOUND', 'Case not found'); // Task 51
    const rows = await prisma.disciplinaryAction.findMany({ where: { employeeId, status: { in: ['ISSUED', 'ACKNOWLEDGED'] } }, select: { status: true, validUntil: true, issuedAt: true, requiresAcknowledgement: true, acknowledgedAt: true } });
    const now = await todayForEmployee(prisma, employeeId);
    return {
      employeeId,
      activeWarnings: rows.filter((r) => validityState(r.status, r.validUntil, now) === 'ACTIVE').length,
      totalIssued: rows.length,
      latestActionDate: rows.reduce<string | null>((latest, r) => (r.issuedAt && (!latest || r.issuedAt.toISOString() > latest) ? r.issuedAt.toISOString() : latest), null),
      awaitingAcknowledgement: rows.filter((r) => r.requiresAcknowledgement && !r.acknowledgedAt).length,
    };
  },
};

export { priorActiveActions, toActionDto };
