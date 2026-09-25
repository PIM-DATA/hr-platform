import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, PRIVACY_REQUEST_TERMINAL,
  type CreatePrivacyRequestInput, type PersonalDataExportDto, type PrivacyEmployeeOptionDto, type PrivacyRequestDto, type PrivacyRequestListQuery, type UpdatePrivacyRequestInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { Actor } from '../leave/leave-types.service';

/**
 * Privacy operations: a register of what data subjects asked for, and a tool to assemble one person's data.
 *
 * What this is NOT: an automated compliance engine. The system never decides that something must be erased — retention
 * periods and legal basis belong to the customer's policy — so a DELETION request is recorded for human review and
 * nothing is deleted. Exports are a point-in-time snapshot, generated on demand and never archived server-side.
 *
 * Authorization is deliberately deployment-wide (`privacy.export_data` / `privacy.manage_requests`), not the employee
 * data scope: a privacy administrator handles requests for anyone in the installation, including former employees.
 */
const employeeRef = { select: { id: true, employeeCode: true, firstName: true, lastName: true } } as const;
const userRef = { select: { id: true, email: true } } as const;
const requestInclude = { employee: employeeRef, user: userRef, assignedTo: userRef, createdBy: userRef } satisfies Prisma.PrivacyRequestInclude;
type RequestRow = Prisma.PrivacyRequestGetPayload<{ include: typeof requestInclude }>;

/** `notes` can hold sensitive free text, so it is only ever returned on the detail endpoint. */
function toDto(row: RequestRow, options: { includeNotes?: boolean } = {}): PrivacyRequestDto {
  return {
    id: row.id, requestType: row.requestType, status: row.status,
    subject: { employee: row.employee, user: row.user },
    requestedAt: row.requestedAt.toISOString(), dueAt: row.dueAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    assignedTo: row.assignedTo, createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    ...(options.includeNotes ? { notes: row.notes } : {}),
  };
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
  action: AUDIT_ACTIONS[action], module: 'privacy', recordType: 'PrivacyRequest', recordId, oldValue, newValue,
});

export const privacyService = {
  async listRequests(q: PrivacyRequestListQuery): Promise<{ data: PrivacyRequestDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.PrivacyRequestWhereInput = { status: q.status, requestType: q.requestType };
    const [total, rows] = await prisma.$transaction([
      prisma.privacyRequest.count({ where }),
      prisma.privacyRequest.findMany({ where, include: requestInclude, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map((r) => toDto(r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getRequest(id: string): Promise<PrivacyRequestDto> {
    const row = await prisma.privacyRequest.findUnique({ where: { id }, include: requestInclude });
    if (!row) throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'Privacy request not found');
    return toDto(row, { includeNotes: true });
  },

  async createRequest(input: CreatePrivacyRequestInput, actor: Actor): Promise<PrivacyRequestDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (input.employeeId && !(await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } }))) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      if (input.userId && !(await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } }))) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      if (input.assignedToUserId && !(await tx.user.findUnique({ where: { id: input.assignedToUserId }, select: { id: true } }))) throw new AppError(404, 'USER_NOT_FOUND', 'Assignee not found');
      const created = await tx.privacyRequest.create({
        data: {
          requestType: input.requestType, employeeId: input.employeeId ?? null, userId: input.userId ?? null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null, notes: input.notes ?? null, assignedToUserId: input.assignedToUserId ?? null,
          createdByUserId: actor.auth.userId,
        },
        include: requestInclude,
      });
      // The audit records the shape of the request, never the free-text note (it may quote the data subject).
      await auditService.log(audit(actor, 'CREATE_PRIVACY_REQUEST', created.id, {
        requestType: created.requestType, status: created.status, employeeId: created.employeeId, userId: created.userId, hasNotes: !!created.notes,
      }), tx);
      return created;
    });
    return toDto(row, { includeNotes: true });
  },

  /**
   * Status moves OPEN → IN_PROGRESS → COMPLETED | REJECTED. A completed or rejected request is never reopened:
   * record a new request instead, so each decision keeps its own history.
   */
  async updateRequest(id: string, input: UpdatePrivacyRequestInput, actor: Actor): Promise<PrivacyRequestDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.privacyRequest.findUnique({ where: { id }, include: requestInclude });
      if (!before) throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'Privacy request not found');
      if (PRIVACY_REQUEST_TERMINAL.includes(before.status as 'COMPLETED')) {
        throw new AppError(409, 'PRIVACY_REQUEST_CLOSED', `This request is ${before.status.toLowerCase()} and can no longer be changed. Record a new request instead.`);
      }
      if (input.assignedToUserId && !(await tx.user.findUnique({ where: { id: input.assignedToUserId }, select: { id: true } }))) throw new AppError(404, 'USER_NOT_FOUND', 'Assignee not found');
      const completing = input.status && PRIVACY_REQUEST_TERMINAL.includes(input.status as 'COMPLETED');
      const after = await tx.privacyRequest.update({
        where: { id },
        data: {
          status: input.status, notes: input.notes === undefined ? undefined : input.notes,
          dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
          assignedToUserId: input.assignedToUserId === undefined ? undefined : input.assignedToUserId,
          completedAt: completing ? new Date() : undefined,
        },
        include: requestInclude,
      });
      await auditService.log(audit(actor, 'UPDATE_PRIVACY_REQUEST', id,
        { status: after.status, assignedToUserId: after.assignedToUserId, dueAt: after.dueAt?.toISOString() ?? null, notesChanged: input.notes !== undefined },
        { status: before.status, assignedToUserId: before.assignedToUserId, dueAt: before.dueAt?.toISOString() ?? null }), tx);
      return after;
    });
    return toDto(row, { includeNotes: true });
  },

  /** Employees a privacy administrator can act for — including former employees, who may still submit a request. */
  async employeeOptions(search: string | undefined, limit = 20): Promise<PrivacyEmployeeOptionDto[]> {
    const term = search?.trim();
    return prisma.employee.findMany({
      where: term
        ? { OR: [{ employeeCode: { contains: term, mode: 'insensitive' } }, { firstName: { contains: term, mode: 'insensitive' } }, { lastName: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }] }
        : {},
      select: { id: true, employeeCode: true, firstName: true, lastName: true, employmentStatus: true },
      orderBy: { employeeCode: 'asc' },
      take: limit,
    });
  },

  /**
   * Assembles everything the system holds about one employee, as a point-in-time snapshot.
   *
   * Data minimisation: other people appear only where a record is meaningless without them (the approver of *your*
   * leave request, your manager's name) and then only as a name and code — never their email, profile or account.
   * Another person's notification inbox is never included, even when it concerns this employee's request, because
   * that inbox is *their* personal data. Secrets (password hashes, session and reset token hashes) are never selected.
   *
   * Collections that could grow without bound are capped and the cap is reported, so an export can never exhaust memory.
   */
  async exportEmployee(employeeId: string, actor: Actor): Promise<PersonalDataExportDto> {
    const MAX_ROWS = 5000;
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        organization: { select: { id: true, code: true, name: true } },
        department: { select: { id: true, code: true, name: true } },
        position: { select: { id: true, code: true, title: true } },
        manager: employeeRef,
        user: { select: { id: true, email: true, isActive: true, lastLoginAt: true, createdAt: true, userRoles: { select: { role: { select: { code: true, name: true } } } } } },
      },
    });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    const userId = employee.user?.id ?? null;

    // One consistent read: a profile change midway through must not produce a half-old, half-new export.
    const data = await prisma.$transaction(async (tx) => {
      const [positionHistory, managerHistory, leaveRequests, entitlements, privacyRequests] = await Promise.all([
        tx.employeePosition.findMany({ where: { employeeId }, select: { startDate: true, endDate: true, position: { select: { code: true, title: true } }, department: { select: { code: true, name: true } } }, orderBy: { startDate: 'asc' }, take: MAX_ROWS }),
        tx.employeeManager.findMany({ where: { employeeId }, select: { startDate: true, endDate: true, manager: employeeRef }, orderBy: { startDate: 'asc' }, take: MAX_ROWS }),
        tx.leaveRequest.findMany({
          where: { employeeId },
          select: {
            id: true, startDate: true, endDate: true, startPart: true, endPart: true, units: true, reason: true, attachmentRef: true, status: true,
            submittedAt: true, approvedAt: true, rejectedAt: true, cancelledAt: true, createdAt: true,
            leaveType: { select: { code: true, name: true } }, policy: { select: { name: true } }, workflowInstanceId: true,
          },
          orderBy: { createdAt: 'asc' }, take: MAX_ROWS,
        }),
        tx.leaveEntitlement.findMany({ where: { employeeId }, select: { id: true, periodStart: true, periodEnd: true, granted: true, carriedForward: true, adjustment: true, reserved: true, used: true, leaveType: { select: { code: true, name: true } } }, orderBy: { periodStart: 'asc' }, take: MAX_ROWS }),
        tx.privacyRequest.findMany({ where: { OR: [{ employeeId }, ...(userId ? [{ userId }] : [])] }, select: { id: true, requestType: true, status: true, requestedAt: true, dueAt: true, completedAt: true }, orderBy: { requestedAt: 'asc' }, take: MAX_ROWS }),
      ]);

      const entitlementIds = entitlements.map((e) => e.id);
      const ledger = entitlementIds.length
        ? await tx.leaveLedger.findMany({ where: { entitlementId: { in: entitlementIds } }, select: { entryType: true, units: true, note: true, referenceType: true, referenceId: true, createdAt: true, entitlement: { select: { leaveType: { select: { code: true } } } } }, orderBy: { createdAt: 'asc' }, take: MAX_ROWS })
        : [];

      // Workflow history for THIS employee's own requests: the approvers appear by name/role because the record is
      // meaningless without them, but nothing else about those approvers is exported.
      const workflows = await tx.workflowInstance.findMany({
        where: { requesterEmployeeId: employeeId },
        select: {
          id: true, module: true, entityType: true, entityId: true, status: true, submittedAt: true, completedAt: true,
          steps: { select: { stepOrder: true, name: true, status: true, skipReason: true, actedAt: true, comment: true, approverEmployee: employeeRef }, orderBy: { stepOrder: 'asc' } },
          actions: { select: { stepOrder: true, action: true, comment: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { submittedAt: 'asc' },
        take: MAX_ROWS,
      });

      // Only the subject's OWN inbox. An approver's notification about this employee's leave is that approver's data.
      const notifications = userId
        ? await tx.notification.findMany({ where: { userId }, select: { type: true, title: true, body: true, readAt: true, createdAt: true, sourceModule: true, sourceEntityType: true, sourceEntityId: true }, orderBy: { createdAt: 'asc' }, take: MAX_ROWS })
        : [];

      // Audit events the subject performed (actor = their user account). Events *about* them are not reliably
      // attributable from the audit schema, which is stated in `notIncluded` rather than guessed at.
      const auditEvents = userId
        ? await tx.auditLog.findMany({ where: { userId }, select: { action: true, module: true, recordType: true, recordId: true, createdAt: true, ipAddress: true }, orderBy: { createdAt: 'asc' }, take: MAX_ROWS })
        : [];

      // Employee relations: what was **issued to** the subject and what they acknowledged — the record as they received
      // it. Case narratives, HR's internal notes, refused proposals and drafts are not the subject's copy of anything
      // and stay out; so does every other person named anywhere in a case.
      const employeeRelations = await tx.disciplinaryAction.findMany({
        where: { employeeId: employee.id, status: { in: ['ISSUED', 'ACKNOWLEDGED'] } },
        select: {
          actionTypeNameSnapshot: true, issuedDate: true, validUntil: true, status: true, acknowledgedAt: true, acknowledgementDueDate: true,
          case: { select: { caseNumber: true, incidentDate: true, categoryNameSnapshot: true } },
          letter: { select: { letterNumber: true, subject: true, bodySnapshot: true, issuedAt: true, acknowledgementTextSnapshot: true } },
          acknowledgement: { select: { acknowledgedAt: true, acknowledgementTextSnapshot: true } },
        },
        orderBy: { issuedAt: 'asc' },
        take: MAX_ROWS,
      });

      // Career and talent (Task 28): the factual records that exist about the subject — that they were reviewed in a
      // cycle, belong to a pool, were nominated for a position — with the judgments left out. A potential level, a
      // 9-box cell, a reviewer's comment and a nominator's note are internal organizational assessments; whether they
      // are disclosed to the subject is a policy decision, stated in `notIncluded` rather than made here.
      const [talentReviews, talentPools, successionNominations] = await Promise.all([
        tx.talentReview.findMany({ where: { employeeId }, select: { status: true, submittedAt: true, finalizedAt: true, createdAt: true, jobTitleSnapshot: true, departmentNameSnapshot: true, performanceCycleNameSnapshot: true, performanceRatingLabelSnapshot: true, cycle: { select: { code: true, name: true, periodStart: true, periodEnd: true } } }, orderBy: { createdAt: 'asc' }, take: MAX_ROWS }),
        tx.talentPoolMember.findMany({ where: { employeeId }, select: { addedAt: true, status: true, removedAt: true, pool: { select: { code: true, name: true } } }, orderBy: { addedAt: 'asc' }, take: MAX_ROWS }),
        tx.successionCandidate.findMany({ where: { employeeId }, select: { readiness: true, targetReadinessDate: true, nominatedAt: true, status: true, removedAt: true, jobTitleSnapshot: true, plan: { select: { positionTitleSnapshot: true, departmentNameSnapshot: true, status: true } } }, orderBy: { nominatedAt: 'asc' }, take: MAX_ROWS }),
      ]);

      // Engagement (Task 33): identified-survey answers are the subject's own words and numbers, so they are exported with
      // the question text as asked. Anonymous responses are stored without any link to a person and are not reconstructed;
      // only the participation record (invited, completed) is exported for them.
      const [engagementParticipation, identifiedResponses] = await Promise.all([
        tx.engagementSurveyAssignment.findMany({ where: { employeeId }, select: { invitedAt: true, completedAt: true, survey: { select: { code: true, name: true, responseMode: true, status: true } } }, orderBy: { invitedAt: 'desc' } }),
        tx.engagementIdentifiedRespondent.findMany({ where: { employeeId }, select: { submittedAt: true, response: { select: { survey: { select: { code: true, name: true } }, answers: { select: { numericValue: true, booleanValue: true, textValue: true, choiceValues: true, question: { select: { questionTextSnapshot: true, questionType: true } } } } } } }, orderBy: { submittedAt: 'desc' } }),
      ]);
      const engagement = {
        participation: engagementParticipation.map((a) => ({ survey: a.survey, invitedAt: a.invitedAt, completed: !!a.completedAt, completedAt: a.completedAt })),
        identifiedResponses: identifiedResponses.map((r) => ({ survey: r.response.survey, submittedAt: r.submittedAt, answers: r.response.answers.map((x) => ({ question: x.question.questionTextSnapshot, questionType: x.question.questionType, numericValue: x.numericValue, booleanValue: x.booleanValue, textValue: x.textValue, choiceValues: x.choiceValues })) })),
      };
      // Lifecycle (Task 34): the subject's own process records — dates, statuses, outcomes and their own task list.
      // Reviewer comments, HR reason notes, exit-interview notes and other people's task notes are internal HR records and are not exported.
      const [onboardingPlans, probationCases, offboardingCases] = await Promise.all([
        tx.onboardingPlan.findMany({ where: { employeeId }, select: { startDate: true, hireDateSnapshot: true, status: true, activatedAt: true, completedAt: true, cancelledAt: true, templateNameSnapshot: true, tasks: { select: { titleSnapshot: true, categorySnapshot: true, assigneeType: true, dueDate: true, status: true, completedAt: true } } }, orderBy: { createdAt: 'desc' } }),
        tx.probationCase.findMany({ where: { employeeId }, select: { startDate: true, originalEndDate: true, currentEndDate: true, status: true, finalOutcome: true, finalizedAt: true, policyNameSnapshot: true, reviews: { select: { reviewDate: true, outcome: true, extensionEndDate: true, submittedAt: true } } }, orderBy: { createdAt: 'desc' } }),
        tx.offboardingCase.findMany({ where: { employeeId }, select: { reasonCode: true, plannedLastWorkingDate: true, actualLastWorkingDate: true, status: true, activatedAt: true, completedAt: true, cancelledAt: true, tasks: { where: { assigneeEmployeeId: employeeId }, select: { titleSnapshot: true, categorySnapshot: true, dueDate: true, status: true, completedAt: true } } }, orderBy: { createdAt: 'desc' } }),
      ]);
      const lifecycle = { onboardingPlans, probationCases, offboardingCases };
      // Learning (Task 35): the subject's own OJT participation and activity completion, their reflections, path
      // assignments and certifications. Trainer comments and observation comments are the trainer's and HR's words and are not exported.
      const [ojtPlans, pathAssignments, certifications, competencyEvidence] = await Promise.all([
        tx.ojtPlan.findMany({ where: { employeeId }, select: { planNumber: true, programNameSnapshot: true, status: true, startDate: true, targetEndDate: true, activatedAt: true, completedAt: true, activities: { select: { titleSnapshot: true, activityType: true, status: true, startedAt: true, completedAt: true, employeeReflection: true, observations: { select: { result: true, observedAt: true } } } }, assessments: { select: { outcome: true, submittedAt: true } } }, orderBy: { startDate: 'desc' } }),
        tx.learningPathAssignment.findMany({ where: { employeeId }, select: { pathNameSnapshot: true, status: true, assignedAt: true, targetDate: true, completedAt: true, steps: { select: { titleSnapshot: true, stepType: true, required: true, fulfilledAt: true } } }, orderBy: { assignedAt: 'desc' } }),
        tx.employeeCertification.findMany({ where: { employeeId }, select: { definitionNameSnapshot: true, certificateNumber: true, issuedDate: true, expiryDate: true, issuerName: true, revokedAt: true, note: true }, orderBy: { issuedDate: 'desc' } }),
        tx.competencyEvidence.findMany({ where: { employeeId }, select: { competencyId: true, sourceType: true, sourceLabel: true, objectiveLevelSnapshot: true, observedLevel: true, createdAt: true } }),
      ]);
      const learning = { ojtPlans, pathAssignments, certifications, competencyEvidence };
      return { positionHistory, managerHistory, leaveRequests, entitlements, ledger, workflows, notifications, privacyRequests, auditEvents, employeeRelations, talentReviews, talentPools, successionNominations, engagement, lifecycle, learning };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const result: PersonalDataExportDto = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      subject: { employeeId: employee.id, employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName, userId },
      data: {
        profile: {
          employeeCode: employee.employeeCode, firstName: employee.firstName, lastName: employee.lastName, nickname: employee.nickname,
          email: employee.email, phone: employee.phone, hireDate: employee.hireDate, employmentType: employee.employmentType, employmentStatus: employee.employmentStatus,
          organization: employee.organization, department: employee.department, position: employee.position,
          manager: employee.manager, createdAt: employee.createdAt, updatedAt: employee.updatedAt,
        },
        account: employee.user
          ? { email: employee.user.email, isActive: employee.user.isActive, lastLoginAt: employee.user.lastLoginAt, createdAt: employee.user.createdAt, roles: employee.user.userRoles.map((r) => r.role) }
          : null,
        ...data,
      },
      notIncluded: [
        { category: 'credentials', reason: 'Password hashes, session tokens and password-reset tokens are security material and are never exported.' },
        { category: 'other people’s notifications', reason: 'Notifications sent to approvers or colleagues are their personal data, even when they concern this employee.' },
        { category: 'audit events recorded by other actors', reason: 'The audit schema identifies who performed an action, not who every record is about, so events about this person performed by others cannot be attributed reliably.' },
        { category: 'database backups', reason: 'Backup archives are operational copies and are handled through the backup retention process, not this export.' },
        { category: 'potential assessments, 9-box placement, reviewer comments and succession notes', reason: 'These are internal organizational judgments about the subject made by named reviewers and nominators. The export carries the factual records (review participation, pool membership, nominations and recorded readiness); disclosing the judgments themselves is a policy decision made outside this export.' },
        { category: 'OJT trainer comments and observation comments', reason: 'These are the trainer\'s and HR\'s words about the subject\'s work; the export carries the observation results, the subject\'s own reflections, activity completion and the assessment outcomes.' },
        { category: 'probation review comments, offboarding reason notes and exit-interview notes', reason: 'These are internal HR and reviewer records about the subject; the export carries the dates, statuses and outcomes of each process and the subject\'s own task list.' },
        { category: 'anonymous survey answers', reason: 'Answers to anonymous surveys are stored with survey-local cohort tokens only — no employee, user, assignment, organization, department, job or position identifier — so they cannot be attributed to the subject and are not reconstructed. The participation record (invited, completed) is exported.' },
        { category: 'employee relations case narratives and internal notes', reason: 'The case description and HR investigation notes are HR working records that may concern other people; the export carries the documents issued to the subject and their acknowledgements.' },
      ],
    };

    // Audited as an event with counts — never the exported payload itself.
    await auditService.log({
      userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
      action: AUDIT_ACTIONS.EXPORT_EMPLOYEE_PERSONAL_DATA, module: 'privacy', recordType: 'Employee', recordId: employee.id,
      newValue: {
        employeeCode: employee.employeeCode, generatedAt: result.generatedAt,
        counts: {
          leaveRequests: data.leaveRequests.length, entitlements: data.entitlements.length, ledger: data.ledger.length,
          workflows: data.workflows.length, notifications: data.notifications.length, auditEvents: data.auditEvents.length, privacyRequests: data.privacyRequests.length,
          employeeRelations: data.employeeRelations.length,
          talentReviews: data.talentReviews.length, talentPools: data.talentPools.length, successionNominations: data.successionNominations.length,
          engagementParticipation: data.engagement.participation.length, identifiedSurveyResponses: data.engagement.identifiedResponses.length,
          onboardingPlans: data.lifecycle.onboardingPlans.length, probationCases: data.lifecycle.probationCases.length, offboardingCases: data.lifecycle.offboardingCases.length,
          ojtPlans: data.learning.ojtPlans.length, learningPathAssignments: data.learning.pathAssignments.length, certifications: data.learning.certifications.length,
        },
      },
    });
    return result;
  },
};
