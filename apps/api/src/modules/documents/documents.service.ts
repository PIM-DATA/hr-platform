import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, DOCUMENT_ALLOWED_EXTENSIONS, DOCUMENT_FILE_TYPES, PERMISSIONS, expiryState, fileExtension, formatDocumentNumber,
  type AuditAction, type AuditModule, type CreateDocumentCategoryInput, type CreateDocumentInput, type DocumentCategoryDto, type DocumentDetailDto, type DocumentDto,
  type DocumentLinkDto, type DocumentListQuery, type DocumentLinkEntityType, type DocumentVersionDto, type LinkDocumentInput, type UpdateDocumentCategoryInput, type UpdateDocumentInput,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { hasPermission } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { employeeScopeWhere } from '../employees/employees.scope';
import { documentStorage } from './storage';
import type { DocumentUpload } from './upload';
import { platformMaxBytes } from './upload';

type Tx = Prisma.TransactionClient;
type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };

/**
 * Documents — metadata here, bytes in the storage adapter, and an authorization made of four things:
 *
 *   permission (documents.view_own / view / manage)  ×  classification  ×  the linked module's authority  ×  ownership.
 *
 * `documents.view` is not a key to every file: an EMPLOYEE_PRIVATE contract is the employee's and HR's, never their
 * manager's; HR_CONFIDENTIAL is HR's; RESTRICTED needs `documents.manage` plus the linked module's permission; and a
 * document filed under a payroll, recruitment or employee-relations category, or attached to one of their records,
 * needs that module's authorization on top of everything else. Bytes never move without this check, and every
 * download of a non-public document is audited with the actor, document and version.
 */
const audit = (actor: Actor, action: AuditAction, recordType: string, recordId: string, newValue: unknown, oldValue?: unknown) => ({
  userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'documents' as AuditModule, recordType, recordId, oldValue, newValue,
});
const today = () => new Date().toISOString().slice(0, 10);

const include = {
  category: { select: { id: true, code: true, name: true, scopeType: true } },
  ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } },
  organization: { select: { id: true, name: true } },
  currentVersion: true,
  links: { orderBy: { createdAt: 'asc' as const } },
  _count: { select: { versions: true } },
} satisfies Prisma.DocumentInclude;
type Row = Prisma.DocumentGetPayload<{ include: typeof include }>;

// ---------- authorization ----------
/** The module whose authority a scope type or link entity type adds on top of the classification. */
const DOMAIN_PERMISSIONS: Record<string, { anyOf: string[]; selfWaivable: boolean }> = {
  PAYROLL: { anyOf: [PERMISSIONS.PAYROLL_MANAGE], selfWaivable: true },
  RECRUITMENT: { anyOf: [PERMISSIONS.RECRUITMENT_MANAGE], selfWaivable: false },
  RECRUITMENT_CANDIDATE: { anyOf: [PERMISSIONS.RECRUITMENT_MANAGE], selfWaivable: false },
  RECRUITMENT_APPLICATION: { anyOf: [PERMISSIONS.RECRUITMENT_MANAGE], selfWaivable: false },
  EMPLOYEE_RELATIONS: { anyOf: [PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], selfWaivable: false },
  EMPLOYEE_RELATION_CASE: { anyOf: [PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], selfWaivable: false },
  DISCIPLINARY_ACTION: { anyOf: [PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], selfWaivable: false },
  TRAINING: { anyOf: [PERMISSIONS.TRAINING_VIEW, PERMISSIONS.TRAINING_MANAGE], selfWaivable: true },
  TRAINING_ENROLLMENT: { anyOf: [PERMISSIONS.TRAINING_VIEW, PERMISSIONS.TRAINING_MANAGE], selfWaivable: true },
  IDP: { anyOf: [PERMISSIONS.IDP_VIEW, PERMISSIONS.IDP_MANAGE], selfWaivable: true },
};

export function canAccessDocument(auth: AuthContext, doc: Pick<Row, 'classification' | 'ownerEmployeeId' | 'ownerEmployee' | 'category' | 'links'>): boolean {
  const manage = hasPermission(auth, PERMISSIONS.DOCUMENTS_MANAGE);
  const view = hasPermission(auth, PERMISSIONS.DOCUMENTS_VIEW);
  const isOwner = !!auth.employeeId && doc.ownerEmployeeId === auth.employeeId && hasPermission(auth, PERMISSIONS.DOCUMENTS_VIEW_OWN);
  const hrScope = view && auth.dataScope === 'ALL';
  const inEmployeeScope = view && (!doc.ownerEmployeeId || auth.dataScope === 'ALL' || (auth.dataScope === 'TEAM' && doc.ownerEmployee?.managerId === auth.employeeId) || doc.ownerEmployeeId === auth.employeeId);

  let classificationOk: boolean;
  switch (doc.classification) {
    case 'PUBLIC_INTERNAL': classificationOk = manage || isOwner || inEmployeeScope; break;
    case 'EMPLOYEE_PRIVATE': classificationOk = manage || isOwner || hrScope; break;
    case 'HR_CONFIDENTIAL': classificationOk = manage || hrScope; break;
    case 'RESTRICTED': classificationOk = manage; break;
    default: classificationOk = false;
  }
  if (!classificationOk) return false;

  // The linked module's authority is a requirement, never a shortcut. RESTRICTED gets no owner waiver at all.
  const domains = [doc.category.scopeType, ...doc.links.map((l) => l.entityType)].map((d) => DOMAIN_PERMISSIONS[d]).filter((d): d is NonNullable<typeof d> => !!d);
  for (const d of domains) {
    const waived = isOwner && d.selfWaivable && doc.classification !== 'RESTRICTED';
    if (!waived && !d.anyOf.some((p) => hasPermission(auth, p))) return false;
  }
  return true;
}

/** Who may attach a document to a record: the module that owns the record. */
async function assertLinkAuthority(tx: Db, auth: AuthContext, entityType: DocumentLinkEntityType, entityId: string): Promise<string> {
  const need = (...perms: string[]) => { if (!perms.some((p) => hasPermission(auth, p))) throw new AppError(403, 'FORBIDDEN', `Attaching to a ${entityType.toLowerCase().replace(/_/g, ' ')} needs the owning module's permission`); };
  switch (entityType) {
    case 'EMPLOYEE': {
      need(PERMISSIONS.DOCUMENTS_MANAGE);
      const e = await tx.employee.findFirst({ where: { AND: [{ id: entityId }, employeeScopeWhere(auth)] }, select: { employeeCode: true, firstName: true, lastName: true } });
      if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      return `${e.firstName} ${e.lastName} (${e.employeeCode})`;
    }
    case 'TRAINING_ENROLLMENT': {
      need(PERMISSIONS.TRAINING_MANAGE, PERMISSIONS.TRAINING_RECORD_RESULT);
      const r = await tx.trainingEnrollment.findUnique({ where: { id: entityId }, select: { employeeNameSnapshot: true, session: { select: { course: { select: { title: true } } } } } });
      if (!r) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Enrollment not found');
      return `${r.session.course.title} — ${r.employeeNameSnapshot}`;
    }
    case 'IDP': {
      need(PERMISSIONS.IDP_MANAGE);
      const r = await tx.individualDevelopmentPlan.findUnique({ where: { id: entityId }, select: { title: true } });
      if (!r) throw new AppError(404, 'IDP_NOT_FOUND', 'Development plan not found');
      return r.title;
    }
    case 'RECRUITMENT_CANDIDATE': {
      need(PERMISSIONS.RECRUITMENT_MANAGE);
      const r = await tx.recruitmentCandidate.findUnique({ where: { id: entityId }, select: { candidateNumber: true } });
      if (!r) throw new AppError(404, 'CANDIDATE_NOT_FOUND', 'Candidate not found');
      return r.candidateNumber;
    }
    case 'ONBOARDING_TASK': case 'OFFBOARDING_TASK': {
      // The lifecycle module owns the task: its assignee (with the complete-tasks permission) or a lifecycle manager may attach.
      const task = entityType === 'ONBOARDING_TASK' ? await tx.onboardingTask.findUnique({ where: { id: entityId }, select: { titleSnapshot: true, assigneeUserId: true } }) : await tx.offboardingTask.findUnique({ where: { id: entityId }, select: { titleSnapshot: true, assigneeUserId: true } });
      if (!task) throw new AppError(404, 'LIFECYCLE_TASK_NOT_FOUND', 'Task not found');
      const manage = entityType === 'ONBOARDING_TASK' ? PERMISSIONS.ONBOARDING_MANAGE : PERMISSIONS.OFFBOARDING_MANAGE;
      const complete = entityType === 'ONBOARDING_TASK' ? PERMISSIONS.ONBOARDING_COMPLETE_TASKS : PERMISSIONS.OFFBOARDING_COMPLETE_TASKS;
      if (!(hasPermission(auth, manage) || (task.assigneeUserId === auth.userId && hasPermission(auth, complete)))) throw new AppError(403, 'FORBIDDEN', 'Only the task assignee or a lifecycle manager may attach a document to this task');
      return task.titleSnapshot;
    }
    case 'OJT_ACTIVITY': {
      // The learning module owns the activity: the trainee, the assigned trainer or an OJT manager may attach evidence.
      const a = await tx.ojtPlanActivity.findUnique({ where: { id: entityId }, select: { titleSnapshot: true, plan: { select: { employeeId: true, trainerUserId: true } } } });
      if (!a) throw new AppError(404, 'OJT_ACTIVITY_NOT_FOUND', 'OJT activity not found');
      const trainee = !!auth.employeeId && a.plan.employeeId === auth.employeeId && hasPermission(auth, PERMISSIONS.OJT_VIEW);
      const trainer = a.plan.trainerUserId === auth.userId && hasPermission(auth, PERMISSIONS.OJT_TRAIN);
      if (!(trainee || trainer || hasPermission(auth, PERMISSIONS.OJT_MANAGE))) throw new AppError(403, 'FORBIDDEN', 'Only the trainee, the assigned trainer or an OJT manager may attach evidence to this activity');
      return a.titleSnapshot;
    }
    case 'EMPLOYEE_CERTIFICATION': {
      need(PERMISSIONS.CERTIFICATION_MANAGE);
      const c = await tx.employeeCertification.findUnique({ where: { id: entityId }, select: { definitionNameSnapshot: true } });
      if (!c) throw new AppError(404, 'CERTIFICATION_NOT_FOUND', 'Certification not found');
      return c.definitionNameSnapshot;
    }
    case 'BENEFIT_CLAIM': {
      // The claimant attaches a receipt to their own draft or pending claim; a benefits manager may attach on their behalf.
      const c = await tx.benefitClaim.findUnique({ where: { id: entityId }, select: { claimNumber: true, employeeId: true, status: true } });
      if (!c) throw new AppError(404, 'BENEFIT_CLAIM_NOT_FOUND', 'Benefit claim not found');
      const own = !!auth.employeeId && c.employeeId === auth.employeeId && hasPermission(auth, PERMISSIONS.BENEFITS_CLAIM);
      if (!(own || hasPermission(auth, PERMISSIONS.BENEFITS_MANAGE))) throw new AppError(403, 'FORBIDDEN', 'Only the claimant or a benefits manager may attach documents to a claim');
      if (c.status !== 'DRAFT' && c.status !== 'PENDING_APPROVAL') throw new AppError(409, 'BENEFIT_CLAIM_CLOSED', 'Documents are attached while a claim is open');
      return c.claimNumber;
    }
    case 'RECRUITMENT_APPLICATION': {
      need(PERMISSIONS.RECRUITMENT_MANAGE);
      const r = await tx.recruitmentApplication.findUnique({ where: { id: entityId }, select: { applicationNumber: true } });
      if (!r) throw new AppError(404, 'APPLICATION_NOT_FOUND', 'Application not found');
      return r.applicationNumber;
    }
    case 'EMPLOYEE_RELATION_CASE': {
      need(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
      const r = await tx.employeeRelationCase.findUnique({ where: { id: entityId }, select: { caseNumber: true } });
      if (!r) throw new AppError(404, 'CASE_NOT_FOUND', 'Case not found');
      return r.caseNumber;
    }
    case 'DISCIPLINARY_ACTION': {
      need(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
      const r = await tx.disciplinaryAction.findUnique({ where: { id: entityId }, select: { actionTypeNameSnapshot: true, case: { select: { caseNumber: true } } } });
      if (!r) throw new AppError(404, 'ACTION_NOT_FOUND', 'Disciplinary action not found');
      return `${r.actionTypeNameSnapshot} — ${r.case.caseNumber}`;
    }
  }
}

// ---------- DTOs ----------
const versionDto = (v: Prisma.DocumentVersionGetPayload<object>, names: Map<string, string>): DocumentVersionDto => ({
  id: v.id, versionNumber: v.versionNumber, originalFilename: v.originalFilename, mimeType: v.mimeType, fileSize: v.fileSize, sha256: v.sha256,
  uploadedBy: names.get(v.uploadedByUserId) ?? null, uploadedAt: v.uploadedAt.toISOString(), note: v.note, inlinePreviewable: DOCUMENT_FILE_TYPES[fileExtension(v.originalFilename)]?.inline ?? false,
});
async function userNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
async function toDto(db: Db, auth: AuthContext, row: Row): Promise<DocumentDto> {
  const names = await userNames(db, row.currentVersion ? [row.currentVersion.uploadedByUserId] : []);
  return {
    id: row.id, documentNumber: row.documentNumber, title: row.title, description: row.description,
    category: row.category, owner: row.ownerEmployee ? { id: row.ownerEmployee.id, employeeCode: row.ownerEmployee.employeeCode, firstName: row.ownerEmployee.firstName, lastName: row.ownerEmployee.lastName } : null,
    organization: row.organization, classification: row.classification as DocumentDto['classification'], status: row.status as DocumentDto['status'],
    issuedDate: row.issuedDate, expiryDate: row.expiryDate, expiryState: expiryState(row.expiryDate, today()),
    currentVersion: row.currentVersion ? versionDto(row.currentVersion, names) : null, versionCount: row._count.versions,
    links: row.links.map((l): DocumentLinkDto => ({ id: l.id, entityType: l.entityType as DocumentLinkEntityType, entityId: l.entityId, relationType: l.relationType, label: null, createdAt: l.createdAt.toISOString() })),
    can: { download: canAccessDocument(auth, row) && !!row.currentVersion, manage: hasPermission(auth, PERMISSIONS.DOCUMENTS_MANAGE) },
    archivedAt: row.archivedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}
const categoryDto = (c: Prisma.DocumentCategoryGetPayload<object>): DocumentCategoryDto => ({
  id: c.id, code: c.code, name: c.name, description: c.description, scopeType: c.scopeType as DocumentCategoryDto['scopeType'], defaultClassification: c.defaultClassification as DocumentCategoryDto['defaultClassification'],
  allowedExtensions: c.allowedExtensions ? c.allowedExtensions.split(',').filter(Boolean) : null, maxFileSizeBytes: c.maxFileSizeBytes, isActive: c.isActive,
});

async function load(db: Db, id: string): Promise<Row> {
  const row = await db.document.findUnique({ where: { id }, include });
  if (!row) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  return row;
}
/** Outside the caller's authorization the document does not exist. */
async function loadFor(auth: AuthContext, id: string): Promise<Row> {
  const row = await load(prisma, id);
  if (!canAccessDocument(auth, row)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  return row;
}
async function nextNumber(tx: Tx): Promise<string> {
  const year = new Date().getUTCFullYear();
  await tx.documentSequence.upsert({ where: { year }, create: { year, next: 1 }, update: {} });
  await tx.$executeRaw`SELECT "year" FROM "document_sequences" WHERE "year" = ${year} FOR UPDATE`;
  const row = await tx.documentSequence.findUniqueOrThrow({ where: { year } });
  await tx.documentSequence.update({ where: { year }, data: { next: row.next + 1 } });
  return formatDocumentNumber(year, row.next);
}
function assertUploadFitsCategory(upload: DocumentUpload, category: Prisma.DocumentCategoryGetPayload<object>) {
  const allowed = category.allowedExtensions ? category.allowedExtensions.split(',').filter(Boolean) : DOCUMENT_ALLOWED_EXTENSIONS;
  if (!allowed.includes(upload.extension)) throw new AppError(415, 'DOCUMENT_TYPE_NOT_ALLOWED', `This category accepts ${allowed.join(', ')}`);
  const max = Math.min(category.maxFileSizeBytes ?? Number.MAX_SAFE_INTEGER, platformMaxBytes());
  if (upload.fileSize > max) throw new AppError(413, 'DOCUMENT_TOO_LARGE', `This category accepts files up to ${Math.round(max / 1024 / 1024)} MB`);
}

export const documentCategoryService = {
  async list(includeInactive: boolean): Promise<DocumentCategoryDto[]> { return (await prisma.documentCategory.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' } })).map(categoryDto); },
  async create(input: CreateDocumentCategoryInput, actor: Actor): Promise<DocumentCategoryDto> {
    if (await prisma.documentCategory.findUnique({ where: { code: input.code } })) throw new AppError(409, 'DOCUMENT_CATEGORY_EXISTS', `Category ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.documentCategory.create({ data: { code: input.code, name: input.name, description: input.description ?? null, scopeType: input.scopeType, defaultClassification: input.defaultClassification, allowedExtensions: input.allowedExtensions?.join(',') ?? null, maxFileSizeBytes: input.maxFileSizeBytes ?? null, isActive: input.isActive } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.CREATE_DOCUMENT_CATEGORY, 'DocumentCategory', created.id, { code: created.code, scopeType: created.scopeType, defaultClassification: created.defaultClassification }), tx);
      return created;
    });
    return categoryDto(row);
  },
  async update(id: string, input: UpdateDocumentCategoryInput, actor: Actor): Promise<DocumentCategoryDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.documentCategory.findUnique({ where: { id } });
      if (!before) throw new AppError(404, 'DOCUMENT_CATEGORY_NOT_FOUND', 'Category not found');
      const updated = await tx.documentCategory.update({ where: { id }, data: { name: input.name, description: input.description, scopeType: input.scopeType, defaultClassification: input.defaultClassification, allowedExtensions: input.allowedExtensions === undefined ? undefined : input.allowedExtensions?.join(',') ?? null, maxFileSizeBytes: input.maxFileSizeBytes, isActive: input.isActive } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.UPDATE_DOCUMENT_CATEGORY, 'DocumentCategory', id, { fields: Object.keys(input), scopeType: updated.scopeType, defaultClassification: updated.defaultClassification, isActive: updated.isActive }, { scopeType: before.scopeType, defaultClassification: before.defaultClassification, isActive: before.isActive }), tx);
      return updated;
    });
    return categoryDto(row);
  },
};

/**
 * Attach a document to a record inside the caller's transaction. The owning module's authority is checked here
 * (`assertLinkAuthority`), the link is idempotent for the same record, and the link is audited. Other modules call
 * this rather than writing `document_links` themselves.
 */
export async function linkDocumentWithTx(tx: Tx, documentId: string, input: LinkDocumentInput, actor: Actor): Promise<{ linkId: string; label: string; created: boolean }> {
  const doc = await load(tx, documentId);
  const label = await assertLinkAuthority(tx, actor.auth, input.entityType, input.entityId);
  const existing = await tx.documentLink.findUnique({ where: { documentId_entityType_entityId: { documentId, entityType: input.entityType, entityId: input.entityId } } });
  if (existing) return { linkId: existing.id, label, created: false };
  const link = await tx.documentLink.create({ data: { documentId, entityType: input.entityType, entityId: input.entityId, relationType: input.relationType ?? null, createdByUserId: actor.auth.userId } });
  await auditService.log(audit(actor, AUDIT_ACTIONS.LINK_DOCUMENT, 'Document', documentId, { documentNumber: doc.documentNumber, classification: doc.classification, linkId: link.id, entityType: input.entityType, entityId: input.entityId, label }), tx);
  return { linkId: link.id, label, created: true };
}

export const documentService = {
  policy(category?: DocumentCategoryDto | null) {
    return { maxFileSizeBytes: Math.min(category?.maxFileSizeBytes ?? Number.MAX_SAFE_INTEGER, platformMaxBytes()), allowedExtensions: category?.allowedExtensions ?? DOCUMENT_ALLOWED_EXTENSIONS, inlineExtensions: Object.entries(DOCUMENT_FILE_TYPES).filter(([, v]) => v.inline).map(([k]) => k), malwareScanning: false as const };
  },

  /** The center's list: every document the caller could open, filtered. Archived are excluded unless asked for. */
  async list(auth: AuthContext, q: DocumentListQuery) {
    const where: Prisma.DocumentWhereInput = {
      ownerEmployeeId: q.ownerEmployeeId, categoryId: q.categoryId, classification: q.classification, status: q.status ?? 'ACTIVE',
      ...(q.issuedFrom ? { issuedDate: { gte: q.issuedFrom } } : {}), ...(q.issuedTo ? { issuedDate: { ...(q.issuedFrom ? { gte: q.issuedFrom } : {}), lte: q.issuedTo } } : {}),
      ...(q.entityType && q.entityId ? { links: { some: { entityType: q.entityType, entityId: q.entityId } } } : {}),
      ...(q.search ? { OR: [{ title: { contains: q.search, mode: 'insensitive' } }, { documentNumber: { contains: q.search, mode: 'insensitive' } }, { ownerEmployee: { OR: [{ employeeCode: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }] } }] } : {}),
    };
    if (q.expiry) {
      const t = today(); const soon = new Date(`${t}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 30); const s = soon.toISOString().slice(0, 10);
      where.expiryDate = q.expiry === 'EXPIRED' ? { lt: t } : q.expiry === 'EXPIRING_SOON' ? { gte: t, lte: s } : q.expiry === 'VALID' ? { gt: s } : null;
    }
    // The database narrows by scope first (a manager only ever sees their team's employee documents); the
    // classification and domain rules are then applied per row, which is why the page is read a little wide.
    if (!hasPermission(auth, PERMISSIONS.DOCUMENTS_MANAGE)) {
      const own = auth.employeeId ? [{ ownerEmployeeId: auth.employeeId }] : [];
      where.AND = [{ OR: [...own, ...(hasPermission(auth, PERMISSIONS.DOCUMENTS_VIEW) ? [{ ownerEmployeeId: null }, { ownerEmployee: employeeScopeWhere(auth) }] : [])] }];
    }
    const rows = await prisma.document.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 1000 });
    const allowed = rows.filter((r) => canAccessDocument(auth, r));
    const page = allowed.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return { data: await Promise.all(page.map((r) => toDto(prisma, auth, r))), meta: { page: q.page, pageSize: q.pageSize, total: allowed.length } };
  },

  /** The employee's own documents: theirs, active, and classified so they may see them. */
  async mine(auth: AuthContext) {
    if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record');
    const rows = await prisma.document.findMany({ where: { ownerEmployeeId: auth.employeeId, status: 'ACTIVE' }, include, orderBy: { createdAt: 'desc' }, take: 200 });
    return Promise.all(rows.filter((r) => canAccessDocument(auth, r)).map((r) => toDto(prisma, auth, r)));
  },

  async get(auth: AuthContext, id: string): Promise<DocumentDetailDto> {
    const row = await loadFor(auth, id);
    const versions = await prisma.documentVersion.findMany({ where: { documentId: id }, orderBy: { versionNumber: 'desc' } });
    const names = await userNames(prisma, versions.map((v) => v.uploadedByUserId));
    return { ...(await toDto(prisma, auth, row)), versions: versions.map((v) => versionDto(v, names)) };
  },

  async create(upload: DocumentUpload, input: CreateDocumentInput, actor: Actor): Promise<DocumentDetailDto> {
    const category = await prisma.documentCategory.findUnique({ where: { id: input.categoryId } });
    if (!category || !category.isActive) throw new AppError(404, 'DOCUMENT_CATEGORY_NOT_FOUND', 'Category not found or inactive');
    assertUploadFitsCategory(upload, category);
    if (input.ownerEmployeeId && !(await prisma.employee.findFirst({ where: { AND: [{ id: input.ownerEmployeeId }, employeeScopeWhere(actor.auth)] }, select: { id: true } }))) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const id = await prisma.$transaction(async (tx) => {
      const documentNumber = await nextNumber(tx);
      const doc = await tx.document.create({ data: {
        documentNumber, title: input.title, description: input.description ?? null, categoryId: category.id, ownerEmployeeId: input.ownerEmployeeId ?? null, organizationId: input.organizationId ?? null,
        classification: input.classification ?? category.defaultClassification, issuedDate: input.issuedDate ?? null, expiryDate: input.expiryDate ?? null, createdByUserId: actor.auth.userId,
      } });
      const version = await tx.documentVersion.create({ data: { documentId: doc.id, versionNumber: 1, storageKey: upload.storageKey, originalFilename: upload.originalFilename, mimeType: upload.mimeType, fileSize: upload.fileSize, sha256: upload.sha256, uploadedByUserId: actor.auth.userId, note: input.note ?? null } });
      await tx.document.update({ where: { id: doc.id }, data: { currentVersionId: version.id } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.CREATE_DOCUMENT, 'Document', doc.id, { documentNumber, categoryCode: category.code, classification: doc.classification, ownerEmployeeId: doc.ownerEmployeeId, versionNumber: 1, fileSize: upload.fileSize, sha256: upload.sha256, extension: upload.extension }), tx);
      return doc.id;
    });
    return this.get(actor.auth, id);
  },

  /** Version N+1 under the document's row lock; the old object is never touched. */
  async addVersion(id: string, upload: DocumentUpload, note: string | null, actor: Actor): Promise<DocumentDetailDto> {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "id" FROM "documents" WHERE "id" = ${id} FOR UPDATE`;
      const doc = await tx.document.findUnique({ where: { id }, include: { category: true } });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      if (doc.status !== 'ACTIVE') throw new AppError(409, 'DOCUMENT_ARCHIVED', 'An archived document takes no new versions');
      assertUploadFitsCategory(upload, doc.category);
      const last = await tx.documentVersion.aggregate({ where: { documentId: id }, _max: { versionNumber: true } });
      const versionNumber = (last._max.versionNumber ?? 0) + 1;
      const version = await tx.documentVersion.create({ data: { documentId: id, versionNumber, storageKey: upload.storageKey, originalFilename: upload.originalFilename, mimeType: upload.mimeType, fileSize: upload.fileSize, sha256: upload.sha256, uploadedByUserId: actor.auth.userId, note } });
      await tx.document.update({ where: { id }, data: { currentVersionId: version.id } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.UPLOAD_DOCUMENT_VERSION, 'Document', id, { documentNumber: doc.documentNumber, classification: doc.classification, versionNumber, fileSize: upload.fileSize, sha256: upload.sha256, extension: upload.extension }), tx);
    });
    return this.get(actor.auth, id);
  },

  async update(id: string, input: UpdateDocumentInput, actor: Actor): Promise<DocumentDetailDto> {
    await prisma.$transaction(async (tx) => {
      const before = await load(tx, id);
      if (input.categoryId && !(await tx.documentCategory.findUnique({ where: { id: input.categoryId } }))) throw new AppError(404, 'DOCUMENT_CATEGORY_NOT_FOUND', 'Category not found');
      const updated = await tx.document.update({ where: { id }, data: { title: input.title, description: input.description, categoryId: input.categoryId, classification: input.classification, issuedDate: input.issuedDate, expiryDate: input.expiryDate } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.UPDATE_DOCUMENT_METADATA, 'Document', id, { documentNumber: before.documentNumber, fields: Object.keys(input), classification: updated.classification, categoryId: updated.categoryId, descriptionChanged: input.description !== undefined }, { classification: before.classification, categoryId: before.categoryId }), tx);
    });
    return this.get(actor.auth, id);
  },

  async archive(id: string, actor: Actor): Promise<DocumentDetailDto> {
    await prisma.$transaction(async (tx) => {
      const before = await load(tx, id);
      if (before.status === 'ARCHIVED') throw new AppError(409, 'DOCUMENT_ARCHIVED', 'Already archived');
      await tx.document.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.ARCHIVE_DOCUMENT, 'Document', id, { documentNumber: before.documentNumber, classification: before.classification, versions: before._count.versions }), tx);
    });
    return this.get(actor.auth, id);
  },

  async link(id: string, input: LinkDocumentInput, actor: Actor): Promise<DocumentDetailDto> {
    await prisma.$transaction(async (tx) => { const r = await linkDocumentWithTx(tx, id, input, actor); if (!r.created) throw new AppError(409, 'DOCUMENT_LINK_EXISTS', 'Already linked'); });
    return this.get(actor.auth, id);
  },
  async unlink(id: string, linkId: string, actor: Actor): Promise<DocumentDetailDto> {
    await prisma.$transaction(async (tx) => {
      const doc = await load(tx, id);
      const link = await tx.documentLink.findFirst({ where: { id: linkId, documentId: id } });
      if (!link) throw new AppError(404, 'DOCUMENT_LINK_NOT_FOUND', 'Link not found');
      await assertLinkAuthority(tx, actor.auth, link.entityType as DocumentLinkEntityType, link.entityId).catch((e) => { if (e instanceof AppError && e.statusCode === 404) return; throw e; });
      await tx.documentLink.delete({ where: { id: linkId } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.UNLINK_DOCUMENT, 'Document', id, { documentNumber: doc.documentNumber, linkId, entityType: link.entityType, entityId: link.entityId }), tx);
    });
    return this.get(actor.auth, id);
  },

  /** The bytes, after the full authorization, with an audit line for anything that is not public. */
  async openForDownload(auth: AuthContext, id: string, versionId: string | null, actor: Actor) {
    const row = await loadFor(auth, id);
    const version = versionId ? await prisma.documentVersion.findFirst({ where: { id: versionId, documentId: id } }) : row.currentVersion;
    if (!version) throw new AppError(404, 'DOCUMENT_VERSION_NOT_FOUND', 'Version not found');
    const storage = documentStorage();
    if (!(await storage.exists(version.storageKey))) throw new AppError(404, 'DOCUMENT_OBJECT_MISSING', 'The stored file is missing — restore the document storage alongside the database');
    if (row.classification !== 'PUBLIC_INTERNAL') {
      await auditService.log(audit(actor, AUDIT_ACTIONS.DOWNLOAD_DOCUMENT, 'Document', id, { documentNumber: row.documentNumber, classification: row.classification, versionId: version.id, versionNumber: version.versionNumber, ownerEmployeeId: row.ownerEmployeeId }));
    }
    return { row, version, stream: storage.getStream(version.storageKey), inline: DOCUMENT_FILE_TYPES[fileExtension(version.originalFilename)]?.inline ?? false };
  },
};
