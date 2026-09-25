import { AUDIT_ACTIONS, CERTIFICATION_EXPIRY_WINDOW_DAYS, addDaysIso, certificationStatus, daysUntil, type CertificationDefinitionDto, type CreateCertificationDefinitionInput, type EmployeeCertificationDto, type IssueCertificationInput, type RenewCertificationInput, type UpdateCertificationDefinitionInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { P, employeeSnapshot, has, learningAudit, lockRow, notFound, scopedEmployeeIds, textAudit, today, type Actor, type Db } from './learning.types';

/**
 * Certifications the organization tracks: a definition (internal or external issuer, validity) and one row per
 * issuance. Status is derived on read from the expiry date and the revocation flag — nothing is scheduled. A
 * renewal is a new row pointing at the old one; a revocation is a manual HR action with a reason. No claim of
 * legal licence or accreditation is made by the software.
 */
const defDto = async (db: Db, d: Prisma.CertificationDefinitionGetPayload<object>): Promise<CertificationDefinitionDto> => ({ id: d.id, code: d.code, name: d.name, description: d.description, issuerType: d.issuerType as CertificationDefinitionDto['issuerType'], issuerName: d.issuerName, organizationId: d.organizationId, validityDays: d.validityDays, expiryWindowDays: d.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS, isActive: d.isActive, activeCount: (await db.employeeCertification.findMany({ where: { definitionId: d.id, revokedAt: null }, select: { expiryDate: true } })).filter((c) => certificationStatus({ expiryDate: c.expiryDate, revokedAt: null }, today(), d.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS) !== 'EXPIRED').length, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString() });

const include = { definition: true } as const;
type Row = Prisma.EmployeeCertificationGetPayload<{ include: typeof include }>;
async function dto(db: Db, rows: Row[], withEmployee: boolean): Promise<EmployeeCertificationDto[]> {
  const t = today();
  const emps = withEmployee ? new Map((await db.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, employeeCode: true, firstName: true, lastName: true, department: { select: { name: true } } } })).map((e) => [e.id, e])) : new Map();
  const docIds = rows.map((r) => r.documentId).filter((x): x is string => !!x);
  const docs = new Map((docIds.length ? await db.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } }) : []).map((d) => [d.id, d.title]));
  const renewedBy = new Map((await db.employeeCertification.findMany({ where: { renewedFromId: { in: rows.map((r) => r.id) } }, select: { id: true, renewedFromId: true } })).map((x) => [x.renewedFromId!, x.id]));
  return rows.map((r) => { const e = emps.get(r.employeeId); return { id: r.id, employeeId: r.employeeId, employee: e ? { employeeCode: e.employeeCode, name: `${e.firstName} ${e.lastName}`, department: e.department.name } : null, definitionId: r.definitionId, definitionName: r.definitionNameSnapshot, definitionCode: r.definition.code, issuerType: r.definition.issuerType, certificateNumber: r.certificateNumber, issuedDate: r.issuedDate, expiryDate: r.expiryDate, issuerName: r.issuerName, status: certificationStatus({ expiryDate: r.expiryDate, revokedAt: r.revokedAt }, t, r.definition.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS), daysToExpiry: r.expiryDate ? daysUntil(t, r.expiryDate) : null, documentId: r.documentId, documentTitle: r.documentId ? (docs.get(r.documentId) ?? null) : null, renewedFromId: r.renewedFromId, renewedById: renewedBy.get(r.id) ?? null, revokedAt: r.revokedAt?.toISOString() ?? null, revokeReason: r.revokeReason, note: r.note, createdAt: r.createdAt.toISOString() }; });
}
async function linkDoc(tx: Prisma.TransactionClient, documentId: string, certId: string, actor: Actor) {
  const doc = await tx.document.findUnique({ where: { id: documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
  if (!doc || !canAccessDocument(actor.auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
  await linkDocumentWithTx(tx, documentId, { entityType: 'EMPLOYEE_CERTIFICATION', entityId: certId, relationType: 'CERTIFICATE' }, actor);
}

export const certificationService = {
  async definitions(includeInactive: boolean): Promise<CertificationDefinitionDto[]> { return Promise.all((await prisma.certificationDefinition.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' } })).map((d) => defDto(prisma, d))); },
  async createDefinition(input: CreateCertificationDefinitionInput, actor: Actor): Promise<CertificationDefinitionDto> {
    if (await prisma.certificationDefinition.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'CERTIFICATION_CODE_EXISTS', 'A certification with this code already exists');
    const d = await prisma.$transaction(async (tx) => {
      const created = await tx.certificationDefinition.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, issuerType: input.issuerType, issuerName: input.issuerName ?? null, organizationId: input.organizationId ?? null, validityDays: input.validityDays ?? null, expiryWindowDays: input.expiryWindowDays ?? null } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.CREATE_CERTIFICATION_DEFINITION, 'CertificationDefinition', created.id, { code: created.code, name: created.name, issuerType: created.issuerType, validityDays: created.validityDays }), tx);
      return created;
    });
    return defDto(prisma, d);
  },
  async updateDefinition(id: string, input: UpdateCertificationDefinitionInput, actor: Actor): Promise<CertificationDefinitionDto> {
    const d = await prisma.$transaction(async (tx) => {
      const before = await tx.certificationDefinition.findUnique({ where: { id } }); if (!before) throw notFound('certification');
      const after = await tx.certificationDefinition.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, issuerType: input.issuerType, issuerName: input.issuerName === undefined ? undefined : input.issuerName, organizationId: input.organizationId === undefined ? undefined : input.organizationId, validityDays: input.validityDays === undefined ? undefined : input.validityDays, expiryWindowDays: input.expiryWindowDays === undefined ? undefined : input.expiryWindowDays, isActive: input.isActive } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.UPDATE_CERTIFICATION_DEFINITION, 'CertificationDefinition', id, { fields: Object.keys(input), validityDays: after.validityDays, isActive: after.isActive }, { validityDays: before.validityDays }), tx);
      return after;
    });
    return defDto(prisma, d);
  },

  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; definitionId?: string; departmentId?: string; employeeId?: string }) {
    const ids = await scopedEmployeeIds(auth);
    const where: Prisma.EmployeeCertificationWhereInput = { ...(ids === null ? {} : { employeeId: { in: ids } }), definitionId: q.definitionId, ...(q.employeeId ? { employeeId: ids === null || ids.includes(q.employeeId) ? q.employeeId : '__none__' } : {}), ...(q.departmentId ? { employeeId: { in: (await prisma.employee.findMany({ where: { departmentId: q.departmentId, ...(ids === null ? {} : { id: { in: ids } }) }, select: { id: true } })).map((e) => e.id) } } : {}) };
    const rows = await prisma.employeeCertification.findMany({ where, include, orderBy: [{ issuedDate: 'desc' }] });
    const all = (await dto(prisma, rows, true)).filter((c) => !q.status || c.status === q.status);
    const start = (q.page - 1) * q.pageSize;
    return { data: all.slice(start, start + q.pageSize), meta: { page: q.page, pageSize: q.pageSize, total: all.length } };
  },
  async forEmployee(employeeId: string): Promise<EmployeeCertificationDto[]> { return dto(prisma, await prisma.employeeCertification.findMany({ where: { employeeId }, include, orderBy: { issuedDate: 'desc' } }), false); },
  async get(auth: AuthContext, id: string): Promise<EmployeeCertificationDto> {
    const r = await prisma.employeeCertification.findUnique({ where: { id }, include }); if (!r) throw notFound('certification');
    const ids = await scopedEmployeeIds(auth); if (ids !== null && !ids.includes(r.employeeId)) throw notFound('certification');
    return (await dto(prisma, [r], true))[0];
  },

  /** Issue. The same employee, definition and issue date cannot be inserted twice (unique), so a double submit is one row. */
  async issue(input: IssueCertificationInput, actor: Actor): Promise<EmployeeCertificationDto> {
    const def = await prisma.certificationDefinition.findUnique({ where: { id: input.definitionId } });
    if (!def || !def.isActive) throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active certification', [{ field: 'definitionId', message: 'Not an active certification' }]);
    const { employee, data } = await employeeSnapshot(prisma, input.employeeId);
    if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Certifications are issued to active employees');
    const expiryDate = input.expiryDate === undefined ? (def.validityDays ? addDaysIso(input.issuedDate, def.validityDays) : null) : input.expiryDate;
    if (expiryDate && expiryDate < input.issuedDate) throw new AppError(422, 'VALIDATION_ERROR', 'Expiry must not be before issue', [{ field: 'expiryDate', message: 'Before the issue date' }]);
    const id = await prisma.$transaction(async (tx) => {
      const existing = await tx.employeeCertification.findUnique({ where: { employeeId_definitionId_issuedDate: { employeeId: employee.id, definitionId: def.id, issuedDate: input.issuedDate } }, select: { id: true } });
      if (existing) throw new AppError(409, 'CERTIFICATION_ALREADY_ISSUED', 'This certification was already recorded for that issue date');
      const c = await tx.employeeCertification.create({ data: { employeeId: employee.id, definitionId: def.id, definitionNameSnapshot: def.name, certificateNumber: input.certificateNumber ?? null, issuedDate: input.issuedDate, expiryDate, issuerName: input.issuerName ?? def.issuerName, note: input.note ?? null, createdByUserId: actor.auth.userId } });
      if (input.documentId) { await linkDoc(tx, input.documentId, c.id, actor); await tx.employeeCertification.update({ where: { id: c.id }, data: { documentId: input.documentId } }); }
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.ISSUE_EMPLOYEE_CERTIFICATION, 'EmployeeCertification', c.id, { employeeCode: data.employeeCodeSnapshot, definitionId: def.id, issuedDate: input.issuedDate, expiryDate, documentLinked: !!input.documentId, hasCertificateNumber: !!input.certificateNumber }), tx);
      return c.id;
    });
    return this.get(actor.auth, id);
  },
  /** Renewal: a new issuance linked to the old one. The old row stays as history and is never overwritten. */
  async renew(id: string, input: RenewCertificationInput, actor: Actor): Promise<EmployeeCertificationDto> {
    const newId = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'employee_certifications', id);
      const old = await tx.employeeCertification.findUnique({ where: { id }, include }); if (!old) throw notFound('certification');
      if (await tx.employeeCertification.findUnique({ where: { renewedFromId: id }, select: { id: true } })) throw new AppError(409, 'CERTIFICATION_ALREADY_RENEWED', 'This certification was already renewed');
      const def = old.definition;
      const expiryDate = input.expiryDate === undefined ? (def.validityDays ? addDaysIso(input.issuedDate, def.validityDays) : null) : input.expiryDate;
      if (input.issuedDate < old.issuedDate) throw new AppError(422, 'VALIDATION_ERROR', 'A renewal is issued after the original', [{ field: 'issuedDate', message: 'Before the original issue' }]);
      const c = await tx.employeeCertification.create({ data: { employeeId: old.employeeId, definitionId: old.definitionId, definitionNameSnapshot: def.name, certificateNumber: input.certificateNumber ?? null, issuedDate: input.issuedDate, expiryDate, issuerName: input.issuerName ?? old.issuerName, note: input.note ?? null, renewedFromId: id, createdByUserId: actor.auth.userId } });
      if (input.documentId) { await linkDoc(tx, input.documentId, c.id, actor); await tx.employeeCertification.update({ where: { id: c.id }, data: { documentId: input.documentId } }); }
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.RENEW_EMPLOYEE_CERTIFICATION, 'EmployeeCertification', c.id, { renewedFromId: id, issuedDate: input.issuedDate, expiryDate }), tx);
      return c.id;
    });
    return this.get(actor.auth, newId);
  },
  async revoke(id: string, reason: string | null | undefined, actor: Actor): Promise<EmployeeCertificationDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'employee_certifications', id);
      const c = await tx.employeeCertification.findUnique({ where: { id } }); if (!c) throw notFound('certification');
      if (c.revokedAt) throw new AppError(409, 'CERTIFICATION_ALREADY_REVOKED', 'Already revoked');
      await tx.employeeCertification.update({ where: { id }, data: { revokedAt: new Date(), revokedByUserId: actor.auth.userId, revokeReason: reason ?? null } });
      await auditService.log(learningAudit(actor, AUDIT_ACTIONS.REVOKE_EMPLOYEE_CERTIFICATION, 'EmployeeCertification', id, { ...textAudit('reason', null, reason ?? null) }), tx);
    });
    return this.get(actor.auth, id);
  },
  canView: (auth: AuthContext) => has(auth, P.CERTIFICATION_VIEW, P.CERTIFICATION_MANAGE),
};
