import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, NOTIFICATION_TYPES, SERVICE_REQUEST_CLOSED, SERVICE_REQUEST_OPEN, SERVICE_WORKFLOW, serviceDueDate,
  type AssignServiceRequestInput, type CreateServiceRequestInput, type FulfillServiceRequestInput, type MyServicesDto, type RejectServiceRequestInput, type ServiceAnswerDto, type ServiceCategory, type ServiceDocumentDto,
  type ServiceFieldType, type ServiceMessageDto, type ServiceMessageInput, type ServiceRequestDetailDto, type ServiceRequestDto, type ServiceRequestStatus, type UpdateServiceRequestInput,
} from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { workflowEngine } from '../../services/workflow';
import type { WorkflowCallbackContext, WorkflowStepPendingContext } from '../../services/workflow';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import type { AuthContext } from '../auth/auth.types';
import { buildAnswerRows, fieldDto, missingRequired } from './catalog.service';
import { issueLetterWithTx, letterSummary } from './letter.service';
import {
  type Actor, type Db, type Tx, P, employeeSnapshot, fulfillerScope, has, history, historyDto, isApprover, isOwner, lockRow, nextNumber, notFound, servicesAudit, snapshotDto, textAudit, today, userNames, visibleRequestWhere,
} from './services.types';

const include = {
  requestType: { select: { id: true, code: true, name: true, category: true, fulfillmentType: true, workflowCode: true, targetDays: true, requiresAttachment: true, letterTemplateId: true, fields: { orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] } } },
  values: { orderBy: [{ displayOrderSnapshot: 'asc' }, { fieldKey: 'asc' }] },
  letters: { orderBy: { createdAt: 'asc' } },
  _count: { select: { messages: true } },
} satisfies Prisma.ServiceRequestInclude;
type Row = Prisma.ServiceRequestGetPayload<{ include: typeof include }>;

const isFulfiller = (auth: AuthContext) => fulfillerScope(auth) && has(auth, P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE);
const isOpen = (s: string) => (SERVICE_REQUEST_OPEN as readonly string[]).includes(s);
const isClosed = (s: string) => (SERVICE_REQUEST_CLOSED as readonly string[]).includes(s);

async function attachments(db: Db, auth: AuthContext, requestId: string): Promise<ServiceDocumentDto[]> {
  const links = await db.documentLink.findMany({
    where: { entityType: 'SERVICE_REQUEST', entityId: requestId },
    select: { document: { select: { id: true, documentNumber: true, title: true, classification: true, ownerEmployeeId: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } }, category: true, links: true } } },
  });
  return links.map((l) => ({ documentId: l.document.id, documentNumber: l.document.documentNumber, title: l.document.title, accessible: canAccessDocument(auth, l.document) }));
}

function dto(auth: AuthContext, r: Row, counts: { attachments: number; assignedToName: string | null }): ServiceRequestDto {
  const owner = isOwner(auth, r.employeeId);
  const fulfiller = isFulfiller(auth);
  const workflowPending = !!r.workflowInstanceId && r.workflowStatus !== 'APPROVED' && r.workflowStatus !== 'REJECTED';
  return {
    id: r.id, requestNumber: r.requestNumber, employeeId: r.employeeId, requestTypeId: r.requestTypeId, requestTypeCode: r.requestTypeCodeSnapshot, requestTypeName: r.requestTypeNameSnapshot,
    category: r.categorySnapshot as ServiceCategory, fulfillmentType: r.fulfillmentTypeSnapshot as 'GENERAL' | 'HR_LETTER', snapshot: snapshotDto(r), subject: r.subject, status: r.status as ServiceRequestStatus,
    assignedToUserId: r.assignedToUserId, assignedToName: counts.assignedToName, workflowInstanceId: r.workflowInstanceId, workflowStatus: r.workflowStatus,
    submittedAt: r.submittedAt?.toISOString() ?? null, dueDate: r.dueDate, overdue: !!r.dueDate && isOpen(r.status) && r.dueDate < today(),
    fulfilledAt: r.fulfilledAt?.toISOString() ?? null, letterCount: r.letters.length, attachmentCount: counts.attachments, messageCount: r._count.messages,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: {
      edit: owner && r.status === 'DRAFT', submit: owner && r.status === 'DRAFT', cancel: owner && (r.status === 'DRAFT' || r.status === 'SUBMITTED'),
      assign: fulfiller && !isClosed(r.status), message: (owner || fulfiller) && !isClosed(r.status), internalMessage: fulfiller,
      fulfill: fulfiller && isOpen(r.status) && !workflowPending, reject: fulfiller && isOpen(r.status),
    },
  };
}

/** A message the caller may read: the requester sees employee-visible ones, the fulfilment team sees everything. */
function visibleMessages(auth: AuthContext, r: Row, rows: { id: string; visibility: string; body: string; authorUserId: string; createdAt: Date }[], names: Map<string, string>): ServiceMessageDto[] {
  const fulfiller = isFulfiller(auth);
  return rows
    .filter((m) => fulfiller || (isOwner(auth, r.employeeId) && m.visibility === 'REQUESTER_VISIBLE'))
    .map((m) => ({ id: m.id, visibility: m.visibility as 'REQUESTER_VISIBLE' | 'INTERNAL', body: m.body, authorName: names.get(m.authorUserId) ?? null, isMine: m.authorUserId === auth.userId, createdAt: m.createdAt.toISOString() }));
}

const answerDto = (v: Row['values'][number]): ServiceAnswerDto => ({ key: v.fieldKey, label: v.labelSnapshot, fieldType: v.fieldTypeSnapshot as ServiceFieldType, value: v.value, employeeVisible: v.employeeVisibleSnapshot });

async function detail(db: Db, auth: AuthContext, r: Row): Promise<ServiceRequestDetailDto> {
  const messages = await db.serviceRequestMessage.findMany({ where: { requestId: r.id }, orderBy: { createdAt: 'asc' } });
  const names = await userNames(db, [...messages.map((m) => m.authorUserId), r.assignedToUserId]);
  const docs = await attachments(db, auth, r.id);
  const blockers = r.status === 'DRAFT' ? draftBlockers(r, docs.length) : [];
  return {
    ...dto(auth, r, { attachments: docs.length, assignedToName: r.assignedToUserId ? (names.get(r.assignedToUserId) ?? null) : null }),
    description: r.description, answers: r.values.map(answerDto), messages: visibleMessages(auth, r, messages, names), history: await historyDto(db, r.id), documents: docs,
    letters: r.letters.map(letterSummary(auth)), resultNote: r.resultNote, rejectReasonCode: r.rejectReasonCode, rejectExplanation: r.rejectExplanation, blockers,
  };
}

function draftBlockers(r: Row, attachmentCount: number): string[] {
  const b = missingRequired(r.requestType.fields, r.values);
  if (r.requestType.requiresAttachment && attachmentCount === 0) b.push('This request type needs at least one attachment');
  return b;
}

async function load(tx: Tx, auth: AuthContext, id: string, opts: { own?: boolean } = {}): Promise<Row> {
  const r = await tx.serviceRequest.findUnique({ where: { id }, include });
  if (!r) throw notFound('service request');
  if (opts.own ? !isOwner(auth, r.employeeId) : !(isFulfiller(auth) || isOwner(auth, r.employeeId))) throw notFound('service request');
  return r;
}

async function notifyEmployee(tx: Tx, r: Row, type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES]) {
  const emp = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { user: { select: { id: true } } } });
  if (!emp?.user?.id) return;
  // The number, the type and the status only: never the subject text, a field answer, a message or a letter body.
  await notificationService.publish(
    { userId: emp.user.id, type, source: { module: SERVICE_WORKFLOW.module, entityType: SERVICE_WORKFLOW.entityType, entityId: r.id }, data: { serviceRequestId: r.id, status: r.status }, dedupeKey: `service-request:${r.id}:${type}` },
    { referenceNumber: r.requestNumber, requestType: r.requestTypeNameSnapshot }, tx,
  );
}

export const serviceRequestService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; requestTypeId?: string; category?: string; assignedToUserId?: string; employeeId?: string; overdue?: boolean; from?: string; to?: string; search?: string }) {
    const scope = visibleRequestWhere(auth);
    const where: Prisma.ServiceRequestWhereInput = {
      ...scope, status: q.status, requestTypeId: q.requestTypeId, categorySnapshot: q.category, assignedToUserId: q.assignedToUserId,
      ...(q.employeeId ? { employeeId: scope.employeeId && scope.employeeId !== q.employeeId ? '__none__' : q.employeeId } : {}),
      ...(q.overdue ? { dueDate: { lt: today() }, status: { in: [...SERVICE_REQUEST_OPEN] } } : {}),
      ...(q.from || q.to ? { submittedDate: { gte: q.from, lte: q.to } } : {}),
      ...(q.search ? { OR: [{ requestNumber: { contains: q.search, mode: 'insensitive' } }, { subject: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.serviceRequest.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.serviceRequest.count({ where }),
    ]);
    const names = await userNames(prisma, rows.map((r) => r.assignedToUserId));
    const counts = await prisma.documentLink.groupBy({ by: ['entityId'], where: { entityType: 'SERVICE_REQUEST', entityId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const byId = new Map(counts.map((c) => [c.entityId, c._count._all]));
    return { data: rows.map((r) => dto(auth, r, { attachments: byId.get(r.id) ?? 0, assignedToName: r.assignedToUserId ? (names.get(r.assignedToUserId) ?? null) : null })), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<ServiceRequestDetailDto> {
    const r = await prisma.serviceRequest.findUnique({ where: { id }, include });
    if (!r || !(isFulfiller(auth) || isOwner(auth, r.employeeId))) throw notFound('service request');
    return detail(prisma, auth, r);
  },

  /**
   * The approver's purpose-specific view. A manager reaches a subordinate's request only here, only while they are
   * on its workflow, and sees the facts and the employee-visible answers: no internal notes, no other request.
   */
  async review(auth: AuthContext, id: string) {
    const r = await prisma.serviceRequest.findUnique({ where: { id }, include });
    if (!r) throw notFound('service request');
    const approver = await isApprover(prisma, auth, r.workflowInstanceId);
    if (!approver.any && !isFulfiller(auth)) throw notFound('service request');
    const docs = await attachments(prisma, auth, r.id);
    return {
      request: { ...dto(auth, r, { attachments: docs.length, assignedToName: null }), description: r.description, answers: r.values.filter((v) => v.employeeVisibleSnapshot).map(answerDto), documents: docs },
      workflowInstanceId: r.workflowInstanceId, myStepPending: approver.pendingNow,
    };
  },

  /** The employee self-service payload: own requests, own letters, the catalogue they may choose from, and the approver queue. */
  async myServices(auth: AuthContext): Promise<MyServicesDto> {
    const employeeId = auth.employeeId;
    const queue = has(auth, P.WORKFLOW_APPROVE)
      ? (await workflowEngine.inbox(auth, { page: 1, pageSize: 50, module: SERVICE_WORKFLOW.module })).data.map((i) => ({ instanceId: i.instanceId, entityId: i.entityId, stepName: i.stepName, requesterName: `${i.requesterEmployee.firstName} ${i.requesterEmployee.lastName}`, submittedAt: i.submittedAt }))
      : [];
    if (!employeeId) return { requests: [], letters: [], catalog: [], queue };
    const [rows, letters, catalog] = await Promise.all([
      prisma.serviceRequest.findMany({ where: { employeeId }, include, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.hrLetter.findMany({ where: { employeeId }, orderBy: [{ issuedDate: 'desc' }], take: 100 }),
      prisma.serviceRequestType.findMany({ where: { isActive: true, employeeSelectable: true }, include: { fields: { orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] } }, orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
    ]);
    const names = await userNames(prisma, rows.map((r) => r.assignedToUserId));
    const counts = await prisma.documentLink.groupBy({ by: ['entityId'], where: { entityType: 'SERVICE_REQUEST', entityId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const byId = new Map(counts.map((c) => [c.entityId, c._count._all]));
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { organizationId: true } });
    return {
      requests: rows.map((r) => dto(auth, r, { attachments: byId.get(r.id) ?? 0, assignedToName: r.assignedToUserId ? (names.get(r.assignedToUserId) ?? null) : null })),
      letters: letters.map(letterSummary(auth)),
      catalog: catalog.filter((t) => !t.organizationId || t.organizationId === employee?.organizationId).map((t) => ({ id: t.id, code: t.code, name: t.name, description: t.description, category: t.category as ServiceCategory, requiresAttachment: t.requiresAttachment, targetDays: t.targetDays, fields: t.fields.map(fieldDto) })),
      queue,
    };
  },

  async create(input: CreateServiceRequestInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    if (!auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const employeeId = auth.employeeId;
    const id = await prisma.$transaction(async (tx) => {
      const { employee, data } = await employeeSnapshot(tx, employeeId);
      if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Service requests need an active employee');
      const type = await tx.serviceRequestType.findUnique({ where: { id: input.requestTypeId }, include: { fields: true } });
      if (!type) throw notFound('service request type');
      if (!type.isActive) throw new AppError(409, 'SERVICE_REQUEST_TYPE_NOT_ACTIVE', 'This request type is not available');
      if (!type.employeeSelectable) throw new AppError(422, 'SERVICE_REQUEST_TYPE_NOT_SELECTABLE', 'This request type is opened by HR, not from self-service');
      if (type.organizationId && type.organizationId !== employee.organizationId) throw new AppError(422, 'SERVICE_REQUEST_TYPE_NOT_APPLICABLE', 'This request type does not apply to your organization');
      const rows = buildAnswerRows(type.fields, input.answers);
      const r = await tx.serviceRequest.create({
        data: {
          requestNumber: await nextNumber(tx, 'request'), requestTypeId: type.id, employeeId, requestTypeCodeSnapshot: type.code, requestTypeNameSnapshot: type.name, categorySnapshot: type.category,
          fulfillmentTypeSnapshot: type.fulfillmentType, targetDaysSnapshot: type.targetDays, ...data, subject: input.subject, description: input.description ?? null, status: 'DRAFT',
          createdByUserId: auth.userId, values: { create: rows },
        },
      });
      await history(tx, r.id, null, 'DRAFT', auth.userId);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.CREATE_SERVICE_REQUEST, 'ServiceRequest', r.id, { requestNumber: r.requestNumber, requestTypeId: type.id, category: type.category, answers: rows.length, subjectLength: r.subject.length, descriptionLength: r.description?.length ?? 0 }), tx);
      return r.id;
    });
    return this.get(auth, id);
  },

  async update(id: string, input: UpdateServiceRequestInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id, { own: true });
      if (r.status !== 'DRAFT') throw new AppError(409, 'SERVICE_REQUEST_NOT_DRAFT', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      if (input.answers) {
        await tx.serviceRequestValue.deleteMany({ where: { requestId: id } });
        const rows = buildAnswerRows(r.requestType.fields, input.answers);
        if (rows.length) await tx.serviceRequestValue.createMany({ data: rows.map((x) => ({ ...x, requestId: id })) });
      }
      const after = await tx.serviceRequest.update({ where: { id }, data: { subject: input.subject, description: input.description === undefined ? undefined : input.description } });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.UPDATE_SERVICE_REQUEST, 'ServiceRequest', id, { fields: Object.keys(input), ...textAudit('description', r.description, after.description), ...textAudit('subject', r.subject, after.subject) }), tx);
    });
    return this.get(auth, id);
  },

  /**
   * §16: lock, verify draft, validate the answers and the attachment rule, freeze the request-type semantics, start
   * the optional workflow, then SUBMITTED. All or nothing, so a double submit produces one transition and one workflow.
   */
  async submit(id: string, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id, { own: true });
      if (r.status !== 'DRAFT') throw new AppError(409, 'SERVICE_REQUEST_NOT_DRAFT', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      const employee = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { employmentStatus: true } });
      const docs = await tx.documentLink.count({ where: { entityType: 'SERVICE_REQUEST', entityId: id } });
      const blockers = draftBlockers(r, docs);
      if (employee?.employmentStatus !== 'ACTIVE') blockers.push('Service requests need an active employee');
      if (blockers.length) throw new AppError(422, 'SERVICE_REQUEST_INVALID', blockers.join('; '), blockers.map((b) => ({ field: 'request', message: b })));
      const submittedDate = today();
      await tx.serviceRequest.update({
        where: { id },
        data: {
          status: 'SUBMITTED', submittedAt: new Date(), submittedDate, dueDate: serviceDueDate(submittedDate, r.requestType.targetDays),
          requestTypeCodeSnapshot: r.requestType.code, requestTypeNameSnapshot: r.requestType.name, categorySnapshot: r.requestType.category, fulfillmentTypeSnapshot: r.requestType.fulfillmentType, targetDaysSnapshot: r.requestType.targetDays,
        },
      });
      await history(tx, id, 'DRAFT', 'SUBMITTED', auth.userId);
      if (r.requestType.workflowCode) {
        const instance = await workflowEngine.submit({ definitionCode: r.requestType.workflowCode, module: SERVICE_WORKFLOW.module, entityType: SERVICE_WORKFLOW.entityType, entityId: id, requesterEmployeeId: r.employeeId }, actor, tx);
        await tx.serviceRequest.update({ where: { id }, data: { workflowInstanceId: instance.id, workflowStatus: 'PENDING' } });
      }
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.SUBMIT_SERVICE_REQUEST, 'ServiceRequest', id, { requestNumber: r.requestNumber, requestTypeId: r.requestTypeId, workflowCode: r.requestType.workflowCode, dueDate: serviceDueDate(submittedDate, r.requestType.targetDays), answers: r.values.length, attachments: docs }), tx);
      const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id }, include });
      await notifyEmployee(tx, fresh, NOTIFICATION_TYPES.SERVICE_REQUEST_SUBMITTED);
    });
    return this.get(auth, id);
  },

  /** Assignment is a row-locked write, so two fulfillers racing produce one deterministic assignee and one trail. */
  async assign(id: string, input: AssignServiceRequestInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id);
      if (!isFulfiller(auth)) throw new AppError(403, 'FORBIDDEN', 'You may not assign service requests');
      if (isClosed(r.status)) throw new AppError(409, 'SERVICE_REQUEST_CLOSED', 'This request is closed');
      if (input.assignedToUserId) {
        const u = await tx.user.findFirst({ where: { id: input.assignedToUserId, isActive: true } });
        if (!u) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive user', [{ field: 'assignedToUserId', message: 'Unknown user' }]);
        // Being assigned a ticket grants nothing: the assignee still needs their own source-domain permissions.
        const canFulfil = await tx.userRole.count({ where: { userId: input.assignedToUserId, role: { rolePermissions: { some: { permission: { code: { in: [P.SERVICE_REQUEST_FULFILL, P.SERVICE_REQUEST_MANAGE] } } } } } } });
        if (!canFulfil) throw new AppError(422, 'VALIDATION_ERROR', 'That user cannot fulfil service requests', [{ field: 'assignedToUserId', message: 'Not a fulfiller' }]);
      }
      const after = await tx.serviceRequest.update({ where: { id }, data: { assignedToUserId: input.assignedToUserId, assignedAt: input.assignedToUserId ? new Date() : null, status: r.status === 'SUBMITTED' && input.assignedToUserId ? 'IN_PROGRESS' : undefined } });
      if (after.status !== r.status) await history(tx, id, r.status, after.status, auth.userId);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.ASSIGN_SERVICE_REQUEST, 'ServiceRequest', id, { requestNumber: r.requestNumber, assignedToUserId: input.assignedToUserId, status: after.status }, { assignedToUserId: r.assignedToUserId }), tx);
      if (input.assignedToUserId && input.assignedToUserId !== auth.userId) {
        await notificationService.publish(
          { userId: input.assignedToUserId, type: NOTIFICATION_TYPES.SERVICE_REQUEST_ASSIGNED, source: { module: SERVICE_WORKFLOW.module, entityType: SERVICE_WORKFLOW.entityType, entityId: id }, data: { serviceRequestId: id }, dedupeKey: `service-request:${id}:assigned:${input.assignedToUserId}` },
          { referenceNumber: r.requestNumber, requestType: r.requestTypeNameSnapshot }, tx,
        );
      }
    });
    return this.get(auth, id);
  },

  /** HR moves the ticket between working states. WAITING_EMPLOYEE tells the employee an answer is needed. */
  async setStatus(id: string, status: 'IN_PROGRESS' | 'WAITING_EMPLOYEE', actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id);
      if (!isFulfiller(auth)) throw new AppError(403, 'FORBIDDEN', 'You may not change the status of service requests');
      if (!isOpen(r.status)) throw new AppError(409, 'SERVICE_REQUEST_CLOSED', 'This request is closed');
      if (r.status === status) return;
      await tx.serviceRequest.update({ where: { id }, data: { status } });
      await history(tx, id, r.status, status, auth.userId);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.UPDATE_SERVICE_REQUEST_STATUS, 'ServiceRequest', id, { requestNumber: r.requestNumber, from: r.status, to: status }), tx);
      if (status === 'WAITING_EMPLOYEE') { const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id }, include }); await notifyEmployee(tx, fresh, NOTIFICATION_TYPES.SERVICE_REQUEST_WAITING_EMPLOYEE); }
    });
    return this.get(auth, id);
  },

  /** Append-only conversation. An employee may only write employee-visible messages on their own open request. */
  async addMessage(id: string, input: ServiceMessageInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await load(tx, auth, id);
      if (isClosed(r.status)) throw new AppError(409, 'SERVICE_REQUEST_CLOSED', 'This request is closed');
      const fulfiller = isFulfiller(auth);
      if (input.visibility === 'INTERNAL' && !fulfiller) throw new AppError(403, 'FORBIDDEN', 'Only the fulfilment team writes internal notes');
      if (!fulfiller && !isOwner(auth, r.employeeId)) throw new AppError(403, 'FORBIDDEN', 'You may not write on this request');
      const m = await tx.serviceRequestMessage.create({ data: { requestId: id, authorUserId: auth.userId, visibility: input.visibility, body: input.body } });
      // Audit records that a message exists and how long it was, never a word of it.
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.ADD_SERVICE_REQUEST_MESSAGE, 'ServiceRequestMessage', m.id, { serviceRequestId: id, requestNumber: r.requestNumber, visibility: input.visibility, bodyLength: input.body.length }), tx);
    });
    return this.get(auth, id);
  },

  /** The employee attaches a document they already own; Document Center decides who may open the file itself. */
  async attachDocument(id: string, documentId: string, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await load(tx, auth, id);
      if (isClosed(r.status)) throw new AppError(409, 'SERVICE_REQUEST_CLOSED', 'This request is closed');
      // You may only attach a document you can already open; linking never widens access to the file itself.
      const doc = await tx.document.findUnique({ where: { id: documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
      if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const link = await linkDocumentWithTx(tx, documentId, { entityType: 'SERVICE_REQUEST', entityId: id, relationType: 'ATTACHMENT' }, actor);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.LINK_SERVICE_REQUEST_DOCUMENT, 'ServiceRequest', id, { requestNumber: r.requestNumber, documentId, linkId: link.linkId, created: link.created }), tx);
    });
    return this.get(auth, id);
  },

  /**
   * §53: for a letter request type the letter is issued and the request is fulfilled in one transaction under the
   * request's row lock, so there is never a fulfilled request without its letter, and two concurrent calls produce
   * exactly one letter. Fulfilling records what HR did; it writes nothing to any source domain.
   */
  async fulfill(id: string, input: FulfillServiceRequestInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id);
      if (!isFulfiller(auth)) throw new AppError(403, 'FORBIDDEN', 'You may not fulfil service requests');
      if (!isOpen(r.status)) throw new AppError(409, 'SERVICE_REQUEST_NOT_OPEN', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      if (r.workflowInstanceId && r.workflowStatus !== 'APPROVED') throw new AppError(409, 'SERVICE_REQUEST_NOT_APPROVED', 'This request is still waiting for its approval');
      let letterId: string | null = null;
      if (r.fulfillmentTypeSnapshot === 'HR_LETTER') {
        const templateId = input.letterTemplateId ?? r.requestType.letterTemplateId;
        if (!templateId) throw new AppError(422, 'VALIDATION_ERROR', 'This request type has no letter template', [{ field: 'letterTemplateId', message: 'Required' }]);
        const letter = await issueLetterWithTx(tx, { employeeId: r.employeeId, templateId, serviceRequestId: id }, actor);
        letterId = letter.id;
      }
      await tx.serviceRequest.update({ where: { id }, data: { status: 'FULFILLED', fulfilledAt: new Date(), resultNote: input.resultNote ?? null } });
      await history(tx, id, r.status, 'FULFILLED', auth.userId);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.FULFILL_SERVICE_REQUEST, 'ServiceRequest', id, { requestNumber: r.requestNumber, fulfillmentType: r.fulfillmentTypeSnapshot, hrLetterId: letterId, resultNoteLength: input.resultNote?.length ?? 0 }), tx);
      const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id }, include });
      await notifyEmployee(tx, fresh, NOTIFICATION_TYPES.SERVICE_REQUEST_FULFILLED);
    });
    return this.get(auth, id);
  },

  async reject(id: string, input: RejectServiceRequestInput, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id);
      if (!isFulfiller(auth)) throw new AppError(403, 'FORBIDDEN', 'You may not reject service requests');
      if (!isOpen(r.status)) throw new AppError(409, 'SERVICE_REQUEST_NOT_OPEN', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      await tx.serviceRequest.update({ where: { id }, data: { status: 'REJECTED', rejectedAt: new Date(), rejectReasonCode: input.reasonCode, rejectExplanation: input.explanation ?? null } });
      await history(tx, id, r.status, 'REJECTED', auth.userId, input.reasonCode);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.REJECT_SERVICE_REQUEST, 'ServiceRequest', id, { requestNumber: r.requestNumber, reasonCode: input.reasonCode, explanationLength: input.explanation?.length ?? 0 }), tx);
      const fresh = await tx.serviceRequest.findUniqueOrThrow({ where: { id }, include });
      await notifyEmployee(tx, fresh, NOTIFICATION_TYPES.SERVICE_REQUEST_REJECTED);
    });
    return this.get(auth, id);
  },

  /** The employee withdraws their own request while it is a draft, or after submission before HR starts on it. */
  async cancel(id: string, actor: Actor): Promise<ServiceRequestDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'service_requests', id);
      const r = await load(tx, auth, id, { own: true });
      if (r.status !== 'DRAFT' && r.status !== 'SUBMITTED') throw new AppError(409, 'SERVICE_REQUEST_NOT_CANCELLABLE', `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      if (r.workflowInstanceId) await workflowEngine.cancel(r.workflowInstanceId, actor, tx);
      await tx.serviceRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await history(tx, id, r.status, 'CANCELLED', auth.userId);
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.CANCEL_SERVICE_REQUEST, 'ServiceRequest', id, { requestNumber: r.requestNumber, from: r.status }), tx);
    });
    return this.get(auth, id);
  },
};

/**
 * §19: the workflow authorises, HR fulfils. An approval records the workflow result and leaves the request in its
 * fulfilment status; a rejection or a cancellation closes the request, because there is nothing left to fulfil.
 */
export const serviceWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    await tx.serviceRequest.updateMany({ where: { id: ctx.entityId }, data: { workflowStatus: 'APPROVED' } });
    await tx.serviceRequestStatusHistory.create({ data: { requestId: ctx.entityId, fromStatus: null, toStatus: 'WORKFLOW_APPROVED', actorUserId: ctx.actor.auth.userId, reasonCode: 'WORKFLOW' } });
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await tx.serviceRequest.findUnique({ where: { id: ctx.entityId }, include });
    if (!r || isClosed(r.status)) return;
    await tx.serviceRequest.update({ where: { id: ctx.entityId }, data: { status: 'REJECTED', workflowStatus: 'REJECTED', rejectedAt: new Date(), rejectReasonCode: 'NOT_ELIGIBLE' } });
    await history(tx, ctx.entityId, r.status, 'REJECTED', ctx.actor.auth.userId, 'WORKFLOW');
    await notifyEmployee(tx, r, NOTIFICATION_TYPES.SERVICE_REQUEST_REJECTED);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await tx.serviceRequest.findUnique({ where: { id: ctx.entityId } });
    if (!r || isClosed(r.status)) return;
    await tx.serviceRequest.update({ where: { id: ctx.entityId }, data: { status: 'CANCELLED', workflowStatus: 'CANCELLED', cancelledAt: new Date() } });
    await history(tx, ctx.entityId, r.status, 'CANCELLED', ctx.actor.auth.userId, 'WORKFLOW');
  },
  async notifyApprover(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step?.approverUserId) return;
    const r = await tx.serviceRequest.findUnique({ where: { id: ctx.entityId } });
    if (!r) return;
    await notificationService.publish(
      { userId: ctx.step.approverUserId, type: NOTIFICATION_TYPES.APPROVAL_REQUIRED, source: { module: SERVICE_WORKFLOW.module, entityType: SERVICE_WORKFLOW.entityType, entityId: r.id }, data: { serviceRequestId: r.id, workflowInstanceId: ctx.instanceId }, dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}` },
      { referenceNumber: r.requestNumber, requestType: r.requestTypeNameSnapshot }, tx,
    );
  },
};
