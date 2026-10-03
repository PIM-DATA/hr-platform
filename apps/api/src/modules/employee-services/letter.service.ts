import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, HR_LETTER_TOKENS, NOTIFICATION_TYPES, isSensitiveToken, renderHrLetter, scanLetterTemplate,
  type CreateHrLetterTemplateInput, type HrLetterDto, type HrLetterSummaryDto, type HrLetterTemplateDto, type HrLetterToken, type HrLetterType, type IssueHrLetterInput, type ServiceDocumentDto, type UpdateHrLetterTemplateInput, type VoidHrLetterInput,
} from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification/notification.service';
import { toMoneyString } from '../payroll/money';
import { canAccessDocument } from '../documents/documents.service';
import type { AuthContext } from '../auth/auth.types';
import {
  type Actor, type Db, type EmployeeRow, type Tx, P, canIssueSalaryLetter, employeeInclude, has, isOwner, letterAdminScope, lockRow, nextNumber, notFound, servicesAudit, snapshotData, snapshotDto, textAudit, today, userNames, visibleLetterWhere,
} from './services.types';
import { isSelf } from '../../services/authorization/self-dealing';

const letterInclude = { template: { select: { code: true, name: true } }, serviceRequest: { select: { requestNumber: true } } } satisfies Prisma.HrLetterInclude;
type LetterRow = Prisma.HrLetterGetPayload<{ include: typeof letterInclude }>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Reads a template exactly as the renderer will. An unknown `{{token}}` is refused rather than silently emptied,
 * a stray brace pair is refused as malformed, and whether the template touches salary is derived here, never
 * supplied by the caller.
 */
function scanOrThrow(body: string, subject: string | null | undefined): { tokens: HrLetterToken[]; requiresSalaryAccess: boolean } {
  const scans = [scanLetterTemplate(body), scanLetterTemplate(subject ?? '')];
  const unknown = [...new Set(scans.flatMap((s) => s.unknown))];
  if (unknown.length) throw new AppError(422, 'HR_LETTER_UNKNOWN_TOKEN', `Unknown letter token: ${unknown.join(', ')}`, unknown.map((u) => ({ field: 'bodyTemplate', message: `Unknown token ${u}` })));
  if (scans.some((s) => s.malformed)) throw new AppError(422, 'HR_LETTER_TEMPLATE_MALFORMED', 'The template has an unclosed {{ or }}', [{ field: 'bodyTemplate', message: 'Unclosed braces' }]);
  const tokens = [...new Set(scans.flatMap((s) => s.tokens))];
  return { tokens, requiresSalaryAccess: tokens.some(isSensitiveToken) };
}

async function templateDto(db: Db, t: Prisma.HrLetterTemplateGetPayload<{ include: { _count: { select: { letters: true } } } }>): Promise<HrLetterTemplateDto> {
  const org = t.organizationId ? await db.organization.findUnique({ where: { id: t.organizationId }, select: { name: true } }) : null;
  return {
    id: t.id, code: t.code, name: t.name, organizationId: t.organizationId, organizationName: org?.name ?? null, letterType: t.letterType as HrLetterType,
    subjectTemplate: t.subjectTemplate, bodyTemplate: t.bodyTemplate, requiresSalaryAccess: t.requiresSalaryAccess,
    tokens: scanOrThrow(t.bodyTemplate, t.subjectTemplate).tokens, isActive: t.isActive, letterCount: t._count.letters,
    createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
  };
}

export const hrLetterTemplateService = {
  async list(db: Db, includeInactive: boolean): Promise<HrLetterTemplateDto[]> {
    const rows = await db.hrLetterTemplate.findMany({ where: includeInactive ? {} : { isActive: true }, include: { _count: { select: { letters: true } } }, orderBy: [{ letterType: 'asc' }, { name: 'asc' }] });
    return Promise.all(rows.map((t) => templateDto(db, t)));
  },
  async get(id: string): Promise<HrLetterTemplateDto> {
    const t = await prisma.hrLetterTemplate.findUnique({ where: { id }, include: { _count: { select: { letters: true } } } });
    if (!t) throw notFound('hr letter template');
    return templateDto(prisma, t);
  },
  async create(input: CreateHrLetterTemplateInput, actor: Actor): Promise<HrLetterTemplateDto> {
    const scan = scanOrThrow(input.bodyTemplate, input.subjectTemplate);
    const row = await prisma.$transaction(async (tx) => {
      if (await tx.hrLetterTemplate.findUnique({ where: { code: input.code } })) throw new AppError(409, 'HR_LETTER_TEMPLATE_CODE_EXISTS', 'That code is already used');
      if (input.organizationId && !(await tx.organization.findUnique({ where: { id: input.organizationId } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown' }]);
      const t = await tx.hrLetterTemplate.create({
        data: { code: input.code, name: input.name, organizationId: input.organizationId ?? null, letterType: input.letterType, subjectTemplate: input.subjectTemplate ?? null, bodyTemplate: input.bodyTemplate, requiresSalaryAccess: scan.requiresSalaryAccess, createdByUserId: actor.auth.userId },
        include: { _count: { select: { letters: true } } },
      });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.CREATE_HR_LETTER_TEMPLATE, 'HrLetterTemplate', t.id, { code: t.code, letterType: t.letterType, requiresSalaryAccess: t.requiresSalaryAccess, tokens: scan.tokens, bodyLength: t.bodyTemplate.length }), tx);
      return t;
    });
    return templateDto(prisma, row);
  },
  async update(id: string, input: UpdateHrLetterTemplateInput, actor: Actor): Promise<HrLetterTemplateDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.hrLetterTemplate.findUnique({ where: { id }, include: { _count: { select: { letters: true } } } });
      if (!before) throw notFound('hr letter template');
      const body = input.bodyTemplate ?? before.bodyTemplate;
      const subject = input.subjectTemplate === undefined ? before.subjectTemplate : input.subjectTemplate;
      const scan = scanOrThrow(body, subject);
      const after = await tx.hrLetterTemplate.update({
        where: { id },
        data: {
          name: input.name, organizationId: input.organizationId === undefined ? undefined : input.organizationId, letterType: input.letterType,
          subjectTemplate: input.subjectTemplate === undefined ? undefined : input.subjectTemplate, bodyTemplate: input.bodyTemplate, requiresSalaryAccess: scan.requiresSalaryAccess, isActive: input.isActive,
        },
        include: { _count: { select: { letters: true } } },
      });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.UPDATE_HR_LETTER_TEMPLATE, 'HrLetterTemplate', id, {
        fields: Object.keys(input), letterType: after.letterType, requiresSalaryAccess: after.requiresSalaryAccess, tokens: scan.tokens, isActive: after.isActive, ...textAudit('bodyTemplate', before.bodyTemplate, after.bodyTemplate),
      }), tx);
      return after;
    });
    return templateDto(prisma, row);
  },
};

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Resolves the allow-listed tokens a template actually uses, and nothing else. The letter service asks the source
 * domains for exactly the fields it needs: the employee master for identity and employment, and authoritative
 * compensation only when a salary token is present. Values live in a Map, so a hostile key cannot reach a prototype.
 */
async function resolveTokens(db: Db, employee: EmployeeRow, tokens: HrLetterToken[], letterNumber: string, issueDate: string, auth: AuthContext): Promise<{ values: Map<string, string>; salary: { amount: Prisma.Decimal; currency: string } | null }> {
  const values = new Map<string, string>();
  const need = (t: HrLetterToken) => tokens.includes(t);
  if (need('employee.fullName')) values.set('employee.fullName', `${employee.firstName} ${employee.lastName}`);
  if (need('employee.firstName')) values.set('employee.firstName', employee.firstName);
  if (need('employee.lastName')) values.set('employee.lastName', employee.lastName);
  if (need('employee.employeeCode')) values.set('employee.employeeCode', employee.employeeCode);
  if (need('employment.hireDate')) values.set('employment.hireDate', employee.hireDate.toISOString().slice(0, 10));
  if (need('employment.status')) values.set('employment.status', employee.employmentStatus);
  if (need('employment.type')) values.set('employment.type', employee.employmentType);
  if (need('organization.name')) values.set('organization.name', employee.organization.name);
  if (need('department.name')) values.set('department.name', employee.department.name);
  if (need('job.title')) values.set('job.title', employee.position?.job?.title ?? '');
  if (need('position.title')) values.set('position.title', employee.position?.title ?? '');
  if (need('letter.number')) values.set('letter.number', letterNumber);
  if (need('letter.issueDate')) values.set('letter.issueDate', issueDate);

  let salary: { amount: Prisma.Decimal; currency: string } | null = null;
  if (tokens.some(isSensitiveToken)) {
    // The payroll authority is required as well as the letter permission: fulfilling tickets is not salary access.
    if (!canIssueSalaryLetter(auth)) throw new AppError(403, 'FORBIDDEN', 'A salary-bearing letter needs the payroll authority as well as the letter permission');
    // Authoritative compensation in effect on the issue date. Never a payslip, never a derived or inferred figure.
    const comp = await db.employeeCompensation.findFirst({
      where: { employeeId: employee.id, effectiveFrom: { lte: issueDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: issueDate } }] },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!comp) throw new AppError(409, 'COMPENSATION_NOT_FOUND', 'No authoritative compensation is in effect on the issue date for this employee');
    salary = { amount: comp.baseSalary, currency: comp.currencyCode };
    if (need('compensation.baseSalary')) values.set('compensation.baseSalary', toMoneyString(comp.baseSalary));
    if (need('compensation.currency')) values.set('compensation.currency', comp.currencyCode);
    if (need('compensation.salaryType')) values.set('compensation.salaryType', comp.salaryType);
  }
  return { values, salary };
}

/**
 * Issues one letter inside the caller's transaction. Everything is resolved and rendered here, on the server, and
 * written once: the row is the letter. Nothing in the employee master, payroll or any other domain is touched.
 */
export async function issueLetterWithTx(tx: Tx, input: IssueHrLetterInput & { serviceRequestId?: string | null }, actor: Actor): Promise<LetterRow> {
  const { auth } = actor;
  if (!has(auth, P.HR_LETTER_ISSUE)) throw new AppError(403, 'FORBIDDEN', 'You may not issue HR letters');
  // Task 51 (T44-P1-19): nobody certifies themselves (an employment or salary letter about the issuer).
  if (isSelf(auth, input.employeeId)) throw new AppError(403, 'HR_LETTER_SELF_ISSUE_NOT_ALLOWED', 'You cannot issue an HR letter about yourself; another issuer must do it');
  const employee = await tx.employee.findUnique({ where: { id: input.employeeId }, include: employeeInclude });
  if (!employee) throw notFound('employee');
  const template = await tx.hrLetterTemplate.findUnique({ where: { id: input.templateId } });
  if (!template) throw notFound('hr letter template');
  if (!template.isActive) throw new AppError(409, 'HR_LETTER_TEMPLATE_NOT_ACTIVE', 'This letter template is not active');
  const issueDate = input.issueDate ?? today();
  const scan = scanOrThrow(template.bodyTemplate, template.subjectTemplate);
  const letterNumber = await nextNumber(tx, 'letter');
  const { values, salary } = await resolveTokens(tx, employee, scan.tokens, letterNumber, issueDate, auth);
  const body = renderHrLetter(template.bodyTemplate, values);
  const subject = template.subjectTemplate ? renderHrLetter(template.subjectTemplate, values) : null;
  const row = await tx.hrLetter.create({
    data: {
      letterNumber, employeeId: employee.id, serviceRequestId: input.serviceRequestId ?? null, templateId: template.id,
      templateCodeSnapshot: template.code, templateNameSnapshot: template.name, letterTypeSnapshot: template.letterType, ...snapshotData(employee),
      renderedSubjectSnapshot: subject, renderedBodySnapshot: body, salaryAmountSnapshot: salary?.amount ?? null, salaryCurrencySnapshot: salary?.currency ?? null,
      issuedDate: issueDate, issuedByUserId: auth.userId, status: 'ISSUED',
    },
    include: letterInclude,
  });
  // Audit records that a letter exists, not what it says: no body, no subject, no salary amount.
  await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.ISSUE_HR_LETTER, 'HrLetter', row.id, {
    letterNumber, letterType: template.letterType, templateId: template.id, employeeId: employee.id, serviceRequestId: row.serviceRequestId, issuedDate: issueDate, salaryIncluded: !!salary, bodyLength: body.length,
  }), tx);
  if (employee.user?.id) {
    await notificationService.publish(
      { userId: employee.user.id, type: NOTIFICATION_TYPES.HR_LETTER_ISSUED, source: { module: 'employee_services', entityType: 'HR_LETTER', entityId: row.id }, data: { hrLetterId: row.id, letterType: template.letterType }, dedupeKey: `hr-letter:${row.id}:issued` },
      { referenceNumber: letterNumber }, tx,
    );
  }
  return row;
}

async function letterDocuments(db: Db, auth: AuthContext, letterId: string): Promise<ServiceDocumentDto[]> {
  const links = await db.documentLink.findMany({
    where: { entityType: 'HR_LETTER', entityId: letterId },
    select: { document: { select: { id: true, documentNumber: true, title: true, classification: true, ownerEmployeeId: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } }, category: true, links: true } } },
  });
  return links.map((l) => ({ documentId: l.document.id, documentNumber: l.document.documentNumber, title: l.document.title, accessible: canAccessDocument(auth, l.document) }));
}

/**
 * Task 47 (T44-P1-20): reading a salary-bearing letter is salary access. Issuing one already needs the payroll authority
 * (`canIssueSalaryLetter`); reading one now does too, unless it is your own letter. Organization-wide service and letter
 * scope alone shows that the letter exists, not what it says.
 */
export const letterContentRestricted = (auth: AuthContext, r: { employeeId: string; salaryAmountSnapshot: unknown }): boolean =>
  r.salaryAmountSnapshot !== null && r.salaryAmountSnapshot !== undefined && !isOwner(auth, r.employeeId) && !has(auth, P.PAYROLL_MANAGE);

export async function letterDto(db: Db, auth: AuthContext, r: LetterRow): Promise<HrLetterDto> {
  const names = await userNames(db, [r.issuedByUserId]);
  const restricted = letterContentRestricted(auth, r);
  return {
    id: r.id, letterNumber: r.letterNumber, letterType: r.letterTypeSnapshot as HrLetterType, status: r.status as 'ISSUED' | 'VOID', issuedDate: r.issuedDate, subject: restricted ? null : r.renderedSubjectSnapshot, contentRestricted: restricted,
    employeeId: r.employeeId, serviceRequestId: r.serviceRequestId, serviceRequestNumber: r.serviceRequest?.requestNumber ?? null, templateId: r.templateId, templateCode: r.templateCodeSnapshot, templateName: r.templateNameSnapshot,
    snapshot: snapshotDto(r), body: restricted ? null : r.renderedBodySnapshot, salaryAmount: !restricted && r.salaryAmountSnapshot ? toMoneyString(r.salaryAmountSnapshot) : null, salaryCurrency: restricted ? null : r.salaryCurrencySnapshot,
    issuedByName: names.get(r.issuedByUserId) ?? null, voidedAt: r.voidedAt?.toISOString() ?? null, voidReasonCode: r.voidReasonCode,
    documents: await letterDocuments(db, auth, r.id), organizationName: r.organizationSnapshot, createdAt: r.createdAt.toISOString(),
    can: { void: r.status === 'ISSUED' && has(auth, P.HR_LETTER_ISSUE) },
  };
}
export const letterSummary = (auth: AuthContext) => (r: { id: string; employeeId: string; letterNumber: string; letterTypeSnapshot: string; status: string; issuedDate: string; renderedSubjectSnapshot: string | null; salaryAmountSnapshot: unknown }): HrLetterSummaryDto => {
  const restricted = letterContentRestricted(auth, r);
  return { id: r.id, letterNumber: r.letterNumber, letterType: r.letterTypeSnapshot as HrLetterType, status: r.status as 'ISSUED' | 'VOID', issuedDate: r.issuedDate, subject: restricted ? null : r.renderedSubjectSnapshot, contentRestricted: restricted };
};

export const hrLetterService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; letterType?: string; status?: string; employeeId?: string; from?: string; to?: string; search?: string }) {
    const scope = visibleLetterWhere(auth);
    const where: Prisma.HrLetterWhereInput = {
      ...scope, letterTypeSnapshot: q.letterType, status: q.status, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}),
      ...(q.from || q.to ? { issuedDate: { gte: q.from, lte: q.to } } : {}),
      ...(q.search ? { OR: [{ letterNumber: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.hrLetter.findMany({ where, include: letterInclude, orderBy: [{ issuedDate: 'desc' }, { letterNumber: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.hrLetter.count({ where }),
    ]);
    return { data: await Promise.all(rows.map((r) => letterDto(prisma, auth, r))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<HrLetterDto> {
    const r = await prisma.hrLetter.findUnique({ where: { id }, include: letterInclude });
    if (!r || !(letterAdminScope(auth) || isOwner(auth, r.employeeId))) throw notFound('hr letter');
    if (isOwner(auth, r.employeeId) && !letterAdminScope(auth) && !has(auth, P.HR_LETTER_VIEW_OWN)) throw notFound('hr letter');
    return letterDto(prisma, auth, r);
  },
  async issue(input: IssueHrLetterInput, actor: Actor): Promise<HrLetterDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (input.serviceRequestId) { await lockRow(tx, 'service_requests', input.serviceRequestId); }
      return issueLetterWithTx(tx, input, actor);
    });
    return letterDto(prisma, actor.auth, row);
  },
  /** An issued letter is never edited or deleted. A mistake is voided with a reason and a corrected letter is issued. */
  async void(id: string, input: VoidHrLetterInput, actor: Actor): Promise<HrLetterDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'hr_letters', id);
      const before = await tx.hrLetter.findUnique({ where: { id }, include: letterInclude });
      if (!before) throw notFound('hr letter');
      if (before.status !== 'ISSUED') throw new AppError(409, 'HR_LETTER_NOT_ISSUED', 'This letter is already void');
      if (isSelf(actor.auth, before.employeeId)) throw new AppError(403, 'HR_LETTER_SELF_ISSUE_NOT_ALLOWED', 'You cannot void an HR letter about yourself'); // Task 51
      const after = await tx.hrLetter.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidedByUserId: actor.auth.userId, voidReasonCode: input.reasonCode }, include: letterInclude });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.VOID_HR_LETTER, 'HrLetter', id, { letterNumber: after.letterNumber, letterType: after.letterTypeSnapshot, reasonCode: input.reasonCode }), tx);
      const employee = await tx.employee.findUnique({ where: { id: after.employeeId }, select: { user: { select: { id: true } } } });
      if (employee?.user?.id) {
        await notificationService.publish(
          { userId: employee.user.id, type: NOTIFICATION_TYPES.HR_LETTER_VOIDED, source: { module: 'employee_services', entityType: 'HR_LETTER', entityId: id }, data: { hrLetterId: id, reasonCode: input.reasonCode }, dedupeKey: `hr-letter:${id}:voided` },
          { referenceNumber: after.letterNumber }, tx,
        );
      }
      return after;
    });
    return letterDto(prisma, actor.auth, row);
  },
  /** The token registry, for the template editor. Sensitive tokens are labelled so the author knows what they cost. */
  tokens(auth: AuthContext) {
    return Object.entries(HR_LETTER_TOKENS).map(([token, meta]) => ({ token, label: meta.label, sensitive: meta.sensitive, available: !meta.sensitive || canIssueSalaryLetter(auth) }));
  },
};
