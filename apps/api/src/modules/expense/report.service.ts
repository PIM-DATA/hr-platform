import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, EXPENSE_WORKFLOW, NOTIFICATION_TYPES, type ExpensePolicyResolutionDto, type CreateExpenseReportInput, type ExpenseItemDto, type ExpenseItemInput, type ExpenseReportDetailDto, type ExpenseReportDto, type ExpenseReviewDto, type MyExpensesDto, type RecordExpensePaymentInput, type SendExpenseToPayrollInput, type UpdateExpenseItemInput, type UpdateExpenseReportInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import { workflowEngine, type WorkflowCallbackContext } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { ZERO, dec, money, toMoneyString } from '../payroll/money';
import { addManualAdjustmentWithTx, findPayrollResultForEmployee } from '../payroll/payroll-run.service';
import { type Actor, type Db, type Tx, adminScope, canSeeEmployee, employeeInclude, employeeSnapshot, expenseAudit, has, history, historyDto, isApprover, lockRow, nextNumber, notFound, P, snapshotDto, textAudit, today, visibleEmployeeWhere } from './expense.types';
import { expensePolicyService, type PolicyResolution } from './policy.service';
import { loadTravelForMutation, travelDto, travelForReviewer } from './travel.service';

/**
 * Expense reports: a set of items reimbursed against a policy. The items are the truth of the total (Σ Decimal, never a
 * figure from the client). Submitting freezes the limits that judged the items; final approval makes the report ready
 * for payment; payment is a human record; a payroll handoff is a separate explicit act ending in SENT_TO_PAYROLL.
 */
const include = { policy: { select: { code: true, name: true, status: true, currency: true, workflowCode: true, effectiveFrom: true, effectiveTo: true, maximumReportAmount: true, rules: true } }, travelRequest: { select: { requestNumber: true, destination: true, startDate: true, endDate: true, estimatedAmount: true, status: true, employeeId: true } }, items: { include: { category: { select: { code: true, name: true } } }, orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }] } } satisfies Prisma.ExpenseReportInclude;
type Row = Prisma.ExpenseReportGetPayload<{ include: typeof include }>;
type ItemRow = Row['items'][number];
const OPEN = ['DRAFT', 'PENDING_APPROVAL'];
export async function loadReportForMutation(tx: Tx, id: string): Promise<Row> {
  await lockRow(tx, 'expense_reports', id);
  const r = await tx.expenseReport.findUnique({ where: { id }, include }); if (!r) throw notFound('expense report');
  return r;
}
const sumItems = (items: { amount: Prisma.Decimal }[]) => money(items.reduce((a, i) => a.plus(i.amount), ZERO));
async function recomputeTotal(tx: Tx, reportId: string) { const items = await tx.expenseItem.findMany({ where: { reportId }, select: { amount: true } }); await tx.expenseReport.update({ where: { id: reportId }, data: { totalAmount: sumItems(items) } }); }
async function receiptCounts(db: Db, itemIds: string[]): Promise<Map<string, number>> {
  if (!itemIds.length) return new Map();
  const g = await db.documentLink.groupBy({ by: ['entityId'], where: { entityType: 'EXPENSE_ITEM', entityId: { in: itemIds } }, _count: { _all: true } });
  return new Map(g.map((x) => [x.entityId, x._count._all]));
}
/** The rule that judges an item: the policy's rule for its category, or "no receipt, no maximum" when the policy names none. */
const ruleFor = (r: Row, categoryId: string) => r.policy.rules.find((x) => x.categoryId === categoryId) ?? null;
/** Receipt required when the rule says so and (no threshold, or amount >= threshold — inclusive, exact Decimal). */
const receiptRequired = (rule: Row['policy']['rules'][number] | null, amount: Prisma.Decimal) => !!rule && rule.requiresReceipt && (!rule.receiptRequiredAbove || dec(amount).gte(rule.receiptRequiredAbove));
function itemBlockers(r: Row, i: ItemRow, receipts: number, hasTravel: boolean): string[] {
  const b: string[] = [];
  const rule = ruleFor(r, i.categoryId);
  const required = r.status === 'DRAFT' ? receiptRequired(rule, i.amount) : i.receiptRequiredSnapshot;
  const max = r.status === 'DRAFT' ? rule?.perItemMaximum ?? null : i.perItemMaximumSnapshot;
  if (dec(i.amount).lte(0)) b.push('Amount must be greater than zero');
  if (max && dec(i.amount).gt(max)) b.push(`Exceeds the per-item maximum of ${toMoneyString(max)}`);
  if (required && receipts === 0) b.push('A receipt is required');
  if (rule?.descriptionRequired && !i.description) b.push('A description is required for this category');
  if (rule?.allowedForTravelOnly && !hasTravel) b.push('This category is allowed on travel expense reports only');
  if (rule?.maximumAgeDays) { const age = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${i.expenseDate}T00:00:00Z`)) / 86_400_000); if (age > rule.maximumAgeDays) b.push(`Older than the ${rule.maximumAgeDays}-day limit`); }
  if (i.expenseDate > today()) b.push('The expense date is in the future');
  return b;
}
async function itemDtos(db: Db, auth: AuthContext, r: Row): Promise<ExpenseItemDto[]> {
  const links = await db.documentLink.findMany({ where: { entityType: 'EXPENSE_ITEM', entityId: { in: r.items.map((i) => i.id) } }, select: { entityId: true, documentId: true } });
  const docs = links.length ? await db.document.findMany({ where: { id: { in: [...new Set(links.map((l) => l.documentId))] } }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } }) : [];
  const dm = new Map(docs.map((d) => [d.id, d]));
  return r.items.map((i) => {
    const mine = links.filter((l) => l.entityId === i.id).map((l) => dm.get(l.documentId)).filter((d): d is NonNullable<typeof d> => !!d);
    const rule = ruleFor(r, i.categoryId);
    return { id: i.id, categoryId: i.categoryId, categoryCode: i.categoryCodeSnapshot, categoryName: i.categoryNameSnapshot, expenseDate: i.expenseDate, amount: toMoneyString(i.amount), merchant: i.merchant, description: i.description, originalAmount: i.originalAmount ? toMoneyString(i.originalAmount) : null, originalCurrency: i.originalCurrency,
      receiptRequired: r.status === 'DRAFT' ? receiptRequired(rule, i.amount) : i.receiptRequiredSnapshot, perItemMaximum: r.status === 'DRAFT' ? (rule?.perItemMaximum ? toMoneyString(rule.perItemMaximum) : null) : (i.perItemMaximumSnapshot ? toMoneyString(i.perItemMaximumSnapshot) : null),
      documents: mine.map((d) => ({ documentId: d.id, title: d.title, documentNumber: d.documentNumber, accessible: canAccessDocument(auth, d) })), blockers: r.status === 'DRAFT' ? itemBlockers(r, i, mine.length, !!r.travelRequestId) : [] };
  });
}
function reportBlockers(r: Row, items: ExpenseItemDto[]): string[] {
  const b: string[] = [];
  if (r.items.length === 0) b.push('Add at least one item');
  if (r.policy.status !== 'ACTIVE') b.push('The expense policy is not active');
  const t = today(); if (r.policy.effectiveFrom > t || (r.policy.effectiveTo && r.policy.effectiveTo < t)) b.push('The expense policy is not in effect today');
  if (r.policy.maximumReportAmount && sumItems(r.items).gt(r.policy.maximumReportAmount)) b.push(`The total exceeds the policy maximum of ${toMoneyString(r.policy.maximumReportAmount)}`);
  if (r.travelRequest && r.travelRequest.employeeId !== r.employeeId) b.push('The travel request belongs to another employee');
  if (r.travelRequest && !['APPROVED', 'COMPLETED'].includes(r.travelRequest.status)) b.push('The travel request is not approved');
  for (const i of items) for (const x of i.blockers) b.push(`${i.categoryName} ${i.expenseDate}: ${x}`);
  return b;
}
function dto(auth: AuthContext, r: Row): ExpenseReportDto {
  const own = !!auth.employeeId && r.employeeId === auth.employeeId; const manage = has(auth, P.EXPENSE_MANAGE); const admin = adminScope(auth);
  return {
    id: r.id, reportNumber: r.reportNumber, title: r.title, employeeId: r.employeeId, policyId: r.policyId, policyCode: r.policyCodeSnapshot, policyName: r.policyNameSnapshot, travelRequestId: r.travelRequestId, travelRequestNumber: r.travelRequest?.requestNumber ?? null, snapshot: snapshotDto(r), currency: r.currency, total: toMoneyString(sumItems(r.items)), itemCount: r.items.length,
    status: r.status as ExpenseReportDto['status'], workflowInstanceId: r.workflowInstanceId, submittedAt: r.submittedAt?.toISOString() ?? null, approvedAt: r.approvedAt?.toISOString() ?? null, rejectedAt: r.rejectedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, paymentMethod: r.paymentMethod, paymentReference: admin ? r.paymentReference : null, paidDate: r.paidDate, paidAt: r.paidAt?.toISOString() ?? null, payrollResultItemId: admin ? r.payrollResultItemId : null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { edit: r.status === 'DRAFT' && (own && has(auth, P.EXPENSE_SUBMIT) || manage), submit: r.status === 'DRAFT' && (own && has(auth, P.EXPENSE_SUBMIT) || manage), cancel: OPEN.includes(r.status) && (own && has(auth, P.EXPENSE_SUBMIT) || manage), recordPayment: (r.status === 'READY_FOR_PAYMENT' || r.status === 'SENT_TO_PAYROLL') && has(auth, P.EXPENSE_RECORD_PAYMENT), sendToPayroll: r.status === 'READY_FOR_PAYMENT' && has(auth, P.EXPENSE_RECORD_PAYMENT) && has(auth, P.PAYROLL_MANAGE) },
  };
}
export async function reportDetail(db: Db, auth: AuthContext, r: Row): Promise<ExpenseReportDetailDto> {
  const items = await itemDtos(db, auth, r);
  return { ...dto(auth, r), items, history: await historyDto(db, 'EXPENSE_REPORT', r.id), blockers: r.status === 'DRAFT' ? reportBlockers(r, items) : [], travel: r.travelRequest ? { requestNumber: r.travelRequest.requestNumber, destination: r.travelRequest.destination, startDate: r.travelRequest.startDate, endDate: r.travelRequest.endDate, estimatedAmount: toMoneyString(r.travelRequest.estimatedAmount) } : null, maximumReportAmount: r.maximumReportAmountSnapshot ? toMoneyString(r.maximumReportAmountSnapshot) : r.policy.maximumReportAmount ? toMoneyString(r.policy.maximumReportAmount) : null };
}
async function notifyOwner(tx: Tx, r: { id: string; employeeId: string; reportNumber: string; status: string }, type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES]) {
  const emp = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { user: { select: { id: true } } } });
  if (!emp?.user) return;
  await notificationService.publish({ userId: emp.user.id, type, source: { module: 'expense', entityType: 'EXPENSE_REPORT', entityId: r.id }, data: { expenseReportId: r.id, status: r.status }, dedupeKey: `expense:report:${r.id}:${type}` }, { referenceNumber: r.reportNumber }, tx);
}
async function ownOrManage(tx: Tx, auth: AuthContext, id: string) {
  const r = await loadReportForMutation(tx, id);
  const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.EXPENSE_SUBMIT);
  if (!own && !has(auth, P.EXPENSE_MANAGE)) throw notFound('expense report');
  return r;
}

const resolutionDto = (r: PolicyResolution): ExpensePolicyResolutionDto => r.kind === 'RESOLVED' || r.kind === 'LINKED'
  ? { kind: 'RESOLVED', policy: { id: r.policy.id, code: r.policy.code, name: r.policy.name, currency: r.policy.currency }, conflicting: [], message: `Your expenses are checked against ${r.policy.name}.` }
  : r.kind === 'AMBIGUOUS' ? { kind: 'AMBIGUOUS', policy: null, conflicting: r.policies.map((p) => ({ id: p.id, code: p.code, name: p.name })), message: 'Multiple expense policies apply to you at the same priority. HR must update policy applicability before you can submit expenses.' }
  : { kind: 'NONE', policy: null, conflicting: [], message: 'No active expense policy applies to you. Ask HR.' };

export const expenseReportService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; policyId?: string; employeeId?: string; search?: string }) {
    const scope = visibleEmployeeWhere(auth);
    const where: Prisma.ExpenseReportWhereInput = { ...scope, status: q.status, policyId: q.policyId, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}), ...(q.search ? { OR: [{ reportNumber: { contains: q.search, mode: 'insensitive' } }, { title: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.expenseReport.count({ where }), prisma.expenseReport.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { data: rows.map((r) => dto(auth, r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<ExpenseReportDetailDto> {
    const r = await prisma.expenseReport.findUnique({ where: { id }, include }); if (!r || !canSeeEmployee(auth, r.employeeId)) throw notFound('expense report');
    return reportDetail(prisma, auth, r);
  },
  /** The approver's purpose-specific view: the report (or travel request), its items, receipts marked accessible or not, the travel context. Nothing else about the person. */
  async review(auth: AuthContext, kind: 'report' | 'travel', id: string): Promise<ExpenseReviewDto> {
    const reviewer = has(auth, P.EXPENSE_REVIEW, P.EXPENSE_MANAGE) && adminScope(auth);
    if (kind === 'report') {
      const r = await prisma.expenseReport.findUnique({ where: { id }, include }); if (!r) throw notFound('expense report');
      const a = await isApprover(prisma, auth, r.workflowInstanceId);
      if (!(reviewer || (a.any && has(auth, P.WORKFLOW_APPROVE)))) throw notFound('expense report');
      return { report: await reportDetail(prisma, auth, r), travel: null, workflowInstanceId: r.workflowInstanceId, myStepPending: a.pendingNow };
    }
    const t = await prisma.travelRequest.findUnique({ where: { id }, include: { travelPolicy: { select: { name: true, workflowCode: true, status: true, currency: true, maximumEstimatedAmount: true, effectiveFrom: true, effectiveTo: true } }, reports: { select: { id: true, reportNumber: true, status: true, totalAmount: true } } } }); if (!t) throw notFound('travel request');
    const a = await isApprover(prisma, auth, t.workflowInstanceId);
    if (!(reviewer || (a.any && has(auth, P.WORKFLOW_APPROVE)))) throw notFound('travel request');
    return { report: null, travel: await travelForReviewer(prisma, auth, t), workflowInstanceId: t.workflowInstanceId, myStepPending: a.pendingNow };
  },
  async myExpenses(auth: AuthContext): Promise<MyExpensesDto> {
    const employeeId = auth.employeeId;
    const queueRows = has(auth, P.WORKFLOW_APPROVE) ? await workflowEngine.inbox(auth, { page: 1, pageSize: 50, module: EXPENSE_WORKFLOW.module }) : { data: [] };
    const queue = queueRows.data.map((i) => ({ instanceId: i.instanceId, entityType: i.entityType, entityId: i.entityId, stepName: i.stepName, requesterName: `${i.requesterEmployee.firstName} ${i.requesterEmployee.lastName}`, submittedAt: i.submittedAt }));
    if (!employeeId) return { policyResolution: resolutionDto({ kind: 'NONE', policies: [] }), travelRequests: [], reports: [], policies: [], travelPolicies: [], queue };
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, include: employeeInclude });
    const [travel, reports, applicable, travelPolicies] = await Promise.all([
      prisma.travelRequest.findMany({ where: { employeeId }, include: { travelPolicy: { select: { name: true, workflowCode: true, status: true, currency: true, maximumEstimatedAmount: true, effectiveFrom: true, effectiveTo: true } }, reports: { select: { id: true, reportNumber: true, status: true, totalAmount: true } } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.expenseReport.findMany({ where: { employeeId }, include, orderBy: { createdAt: 'desc' }, take: 50 }),
      employee ? expensePolicyService.resolve(prisma, employee, today()) : Promise.resolve<PolicyResolution>({ kind: 'NONE', policies: [] }),
      employee ? prisma.travelPolicy.findMany({ where: { status: 'ACTIVE', OR: [{ organizationId: null }, { organizationId: employee.organizationId }] }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
    ]);
    return { travelRequests: await Promise.all(travel.map((t) => travelDto(prisma, auth, t))), reports: reports.map((r) => dto(auth, r)), policyResolution: resolutionDto(applicable), policies: applicable.kind === 'RESOLVED' || applicable.kind === 'LINKED' ? [{ id: applicable.policy.id, code: applicable.policy.code, name: applicable.policy.name, currency: applicable.policy.currency, isDefault: true }] : [], travelPolicies: travelPolicies.map((p) => ({ id: p.id, code: p.code, name: p.name, currency: p.currency })), queue };
  },
  /** A draft against an applicable policy, optionally linked to the employee's own approved trip. Nothing is frozen yet. */
  async create(input: CreateExpenseReportInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    const { auth } = actor;
    if (!auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const employeeId = auth.employeeId;
    const id = await prisma.$transaction(async (tx) => {
      const { employee, data } = await employeeSnapshot(tx, employeeId);
      if (employee.employmentStatus !== 'ACTIVE') throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Expense reports need an active employee');
      let linkedPolicyId: string | null = null;
      if (input.travelRequestId) {
        const t = await tx.travelRequest.findUnique({ where: { id: input.travelRequestId }, include: { travelPolicy: { select: { expensePolicyId: true } } } }); if (!t || t.employeeId !== employeeId) throw notFound('travel request');
        if (!['APPROVED', 'COMPLETED'].includes(t.status)) throw new AppError(409, 'TRAVEL_REQUEST_NOT_APPROVED', 'An expense report links to an approved trip');
        linkedPolicyId = t.travelPolicy.expensePolicyId;
      }
      // Server authority: the policy is resolved here, never chosen by the claimant. A travel policy's explicit expense
      // policy is business configuration and wins; otherwise the unique most-specific applicable policy; ties are refused.
      const resolution = await expensePolicyService.resolve(tx, employee, today(), linkedPolicyId);
      if (linkedPolicyId && resolution.kind === 'NONE') throw new AppError(422, 'EXPENSE_POLICY_NOT_APPLICABLE', 'The expense policy linked to this trip\'s travel policy is not active or does not apply to you. Ask HR.');
      const policy = expensePolicyService.require(resolution, input.policyId);
      const r = await tx.expenseReport.create({ data: { reportNumber: await nextNumber(tx, 'report'), title: input.title, employeeId, policyId: policy.id, travelRequestId: input.travelRequestId ?? null, policyCodeSnapshot: policy.code, policyNameSnapshot: policy.name, maximumReportAmountSnapshot: policy.maximumReportAmount, ...data, currency: policy.currency, createdByUserId: auth.userId } });
      await history(tx, 'EXPENSE_REPORT', r.id, null, 'DRAFT', auth.userId);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CREATE_EXPENSE_REPORT, 'ExpenseReport', r.id, { reportNumber: r.reportNumber, policyId: policy.id, travelRequestId: r.travelRequestId, currency: r.currency, titleLength: r.title.length }), tx);
      return r.id;
    });
    return this.get(auth, id);
  },
  async update(id: string, input: UpdateExpenseReportInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, actor.auth, id);
      if (r.status !== 'DRAFT') throw new AppError(409, 'EXPENSE_REPORT_NOT_DRAFT', 'A submitted report cannot be edited; cancel it and make a new one');
      if (input.travelRequestId) { const t = await tx.travelRequest.findUnique({ where: { id: input.travelRequestId } }); if (!t || t.employeeId !== r.employeeId) throw notFound('travel request'); if (!['APPROVED', 'COMPLETED'].includes(t.status)) throw new AppError(409, 'TRAVEL_REQUEST_NOT_APPROVED', 'An expense report links to an approved trip'); }
      await tx.expenseReport.update({ where: { id }, data: { title: input.title, travelRequestId: input.travelRequestId === undefined ? undefined : input.travelRequestId } });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_EXPENSE_REPORT, 'ExpenseReport', id, { fields: Object.keys(input) }), tx);
    });
    return this.get(actor.auth, id);
  },
  async addItem(id: string, input: ExpenseItemInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, actor.auth, id);
      if (r.status !== 'DRAFT') throw new AppError(409, 'EXPENSE_REPORT_NOT_DRAFT', 'Items are edited on a draft');
      const cat = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, isActive: true } }); if (!cat) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive category', [{ field: 'categoryId', message: 'Unknown category' }]);
      const item = await tx.expenseItem.create({ data: { reportId: id, categoryId: cat.id, categoryCodeSnapshot: cat.code, categoryNameSnapshot: cat.name, expenseDate: input.expenseDate, amount: dec(input.amount), merchant: input.merchant ?? null, description: input.description ?? null, originalAmount: input.originalAmount ? dec(input.originalAmount) : null, originalCurrency: input.originalCurrency ?? null } });
      await recomputeTotal(tx, id);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_EXPENSE_ITEM, 'ExpenseItem', item.id, { reportId: id, categoryCode: cat.code, expenseDate: item.expenseDate, amount: toMoneyString(item.amount), added: true, ...textAudit('description', null, item.description), ...textAudit('merchant', null, item.merchant) }), tx);
    });
    return this.get(actor.auth, id);
  },
  async updateItem(id: string, itemId: string, input: UpdateExpenseItemInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, actor.auth, id);
      if (r.status !== 'DRAFT') throw new AppError(409, 'EXPENSE_REPORT_NOT_DRAFT', 'Items are edited on a draft');
      const before = r.items.find((i) => i.id === itemId); if (!before) throw notFound('expense item');
      let catData = {};
      if (input.categoryId && input.categoryId !== before.categoryId) { const cat = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, isActive: true } }); if (!cat) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive category', [{ field: 'categoryId', message: 'Unknown category' }]); catData = { categoryId: cat.id, categoryCodeSnapshot: cat.code, categoryNameSnapshot: cat.name }; }
      const after = await tx.expenseItem.update({ where: { id: itemId }, data: { ...catData, expenseDate: input.expenseDate, amount: input.amount === undefined ? undefined : dec(input.amount), merchant: input.merchant === undefined ? undefined : input.merchant, description: input.description === undefined ? undefined : input.description, originalAmount: input.originalAmount === undefined ? undefined : input.originalAmount === null ? null : dec(input.originalAmount), originalCurrency: input.originalCurrency === undefined ? undefined : input.originalCurrency } });
      await recomputeTotal(tx, id);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_EXPENSE_ITEM, 'ExpenseItem', itemId, { reportId: id, fields: Object.keys(input), amount: toMoneyString(after.amount), ...textAudit('description', before.description, after.description) }), tx);
    });
    return this.get(actor.auth, id);
  },
  async removeItem(id: string, itemId: string, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, actor.auth, id);
      if (r.status !== 'DRAFT') throw new AppError(409, 'EXPENSE_REPORT_NOT_DRAFT', 'Items are edited on a draft');
      if (!r.items.some((i) => i.id === itemId)) throw notFound('expense item');
      await tx.documentLink.deleteMany({ where: { entityType: 'EXPENSE_ITEM', entityId: itemId } });
      await tx.expenseItem.delete({ where: { id: itemId } });
      await recomputeTotal(tx, id);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_EXPENSE_ITEM, 'ExpenseItem', itemId, { reportId: id, removed: true }), tx);
    });
    return this.get(actor.auth, id);
  },
  /** A receipt is a Task 30 link on the item: the owner attaches a document they can already read. The link widens nothing. */
  async attachReceipt(id: string, itemId: string, documentId: string, actor: Actor): Promise<ExpenseReportDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, auth, id);
      if (!OPEN.includes(r.status)) throw new AppError(409, 'EXPENSE_REPORT_CLOSED', 'Receipts are attached while a report is open');
      if (!r.items.some((i) => i.id === itemId)) throw notFound('expense item');
      const doc = await tx.document.findUnique({ where: { id: documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
      if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const link = await linkDocumentWithTx(tx, documentId, { entityType: 'EXPENSE_ITEM', entityId: itemId, relationType: 'RECEIPT' }, actor);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.LINK_EXPENSE_RECEIPT, 'ExpenseItem', itemId, { reportId: id, created: link.created }), tx);
    });
    return this.get(auth, id);
  },
  /**
   * §27: lock → DRAFT → items ≥ 1 → policy active → validate items and receipts against the policy → freeze the rule
   * snapshots and the total → PENDING_APPROVAL → workflow → audit → notify. All or nothing.
   */
  async submit(id: string, actor: Actor): Promise<ExpenseReportDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, auth, id);
      if (r.status !== 'DRAFT') throw new AppError(409, 'EXPENSE_REPORT_NOT_DRAFT', `This report is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      const employee = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { employmentStatus: true } });
      const items = await itemDtos(tx, auth, r);
      const blockers = reportBlockers(r, items);
      if (employee?.employmentStatus !== 'ACTIVE') blockers.push('Expense reports need an active employee');
      // Independent re-resolution at submit: a crafted or stale draft cannot bypass the policy the server assigns today.
      const { employee: emp } = await employeeSnapshot(tx, r.employeeId);
      const resolution = await expensePolicyService.resolve(tx, emp, today(), r.travelRequest ? (await tx.travelRequest.findUniqueOrThrow({ where: { id: r.travelRequestId! }, include: { travelPolicy: { select: { expensePolicyId: true } } } })).travelPolicy.expensePolicyId : null);
      if (resolution.kind === 'AMBIGUOUS') expensePolicyService.require(resolution);
      else if (resolution.kind === 'NONE') blockers.push('No active expense policy applies to you today');
      else if (resolution.policy.id !== r.policyId) blockers.push(`Your expense policy is now ${resolution.policy.name}; create a new report`);
      if (blockers.length) throw new AppError(422, 'EXPENSE_REPORT_INVALID', blockers.join('; '), blockers.map((b) => ({ field: 'report', message: b })));
      for (const i of r.items) { const rule = ruleFor(r, i.categoryId); await tx.expenseItem.update({ where: { id: i.id }, data: { receiptRequiredSnapshot: receiptRequired(rule, i.amount), perItemMaximumSnapshot: rule?.perItemMaximum ?? null } }); }
      const total = sumItems(r.items);
      await tx.expenseReport.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), totalAmount: total, policyCodeSnapshot: r.policy.code, policyNameSnapshot: r.policy.name, maximumReportAmountSnapshot: r.policy.maximumReportAmount } });
      await history(tx, 'EXPENSE_REPORT', id, 'DRAFT', 'PENDING_APPROVAL', auth.userId);
      const instance = await workflowEngine.submit({ definitionCode: r.policy.workflowCode, module: EXPENSE_WORKFLOW.module, entityType: EXPENSE_WORKFLOW.report, entityId: id, requesterEmployeeId: r.employeeId }, actor, tx);
      const after = await tx.expenseReport.update({ where: { id }, data: { workflowInstanceId: instance.id } });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.SUBMIT_EXPENSE_REPORT, 'ExpenseReport', id, { reportNumber: r.reportNumber, total: toMoneyString(total), currency: r.currency, items: r.items.length, workflowInstanceId: instance.id, workflowStatus: instance.status }), tx);
      if (after.status === 'PENDING_APPROVAL') await notifyOwner(tx, after, NOTIFICATION_TYPES.EXPENSE_REPORT_SUBMITTED);
    });
    return this.get(auth, id);
  },
  async cancel(id: string, actor: Actor): Promise<ExpenseReportDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await ownOrManage(tx, auth, id);
      if (r.status === 'DRAFT') {
        await tx.expenseReport.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await history(tx, 'EXPENSE_REPORT', id, 'DRAFT', 'CANCELLED', auth.userId);
        await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CANCEL_EXPENSE_REPORT, 'ExpenseReport', id, { from: 'DRAFT' }), tx);
        return;
      }
      if (r.status !== 'PENDING_APPROVAL' || !r.workflowInstanceId) throw new AppError(409, 'EXPENSE_REPORT_NOT_CANCELLABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} report cannot be cancelled`);
      await workflowEngine.cancel(r.workflowInstanceId, actor, tx);
    });
    return this.get(auth, id);
  },
  /** Bookkeeping: the reimbursement was paid outside. No transfer happens here. */
  async recordPayment(id: string, input: RecordExpensePaymentInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadReportForMutation(tx, id);
      if (r.status !== 'READY_FOR_PAYMENT' && r.status !== 'SENT_TO_PAYROLL') throw new AppError(409, 'EXPENSE_REPORT_NOT_PAYABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} report cannot be recorded as paid`);
      const after = await tx.expenseReport.update({ where: { id }, data: { status: 'PAID', paymentMethod: input.paymentMethod, paymentReference: input.paymentReference ?? null, paidDate: input.paidDate, paidAt: new Date(), paidByUserId: actor.auth.userId } });
      await history(tx, 'EXPENSE_REPORT', id, r.status, 'PAID', actor.auth.userId, input.paymentMethod);
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.RECORD_EXPENSE_PAYMENT, 'ExpenseReport', id, { reportNumber: r.reportNumber, total: toMoneyString(r.totalAmount), currency: r.currency, paymentMethod: input.paymentMethod, paidDate: input.paidDate, referenceLength: input.paymentReference?.length ?? 0 }, { status: r.status }), tx);
      await notifyOwner(tx, after, NOTIFICATION_TYPES.EXPENSE_PAID);
    });
    return this.get(actor.auth, id);
  },
  /** Explicit handoff through payroll's own composable helper; idempotent by report id; ends in SENT_TO_PAYROLL, never PAID. Payroll's period and run rules apply. */
  async sendToPayroll(id: string, input: SendExpenseToPayrollInput, actor: Actor): Promise<ExpenseReportDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadReportForMutation(tx, id);
      if (r.status === 'SENT_TO_PAYROLL' && r.payrollResultItemId) return;
      if (r.status !== 'READY_FOR_PAYMENT') throw new AppError(409, 'EXPENSE_REPORT_NOT_PAYABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} report cannot be sent to payroll`);
      const component = await tx.payComponent.findUnique({ where: { id: input.componentId }, select: { type: true } });
      if (!component || component.type !== 'EARNING') throw new AppError(422, 'VALIDATION_ERROR', 'Choose an earning component for the reimbursement line', [{ field: 'componentId', message: 'Must be an active EARNING component' }]);
      const target = await findPayrollResultForEmployee(tx, input.payrollPeriodId, r.employeeId);
      if (!target) throw new AppError(409, 'PAYROLL_RESULT_NOT_FOUND', 'Calculate the payroll period first; the employee has no result in it');
      const line = await addManualAdjustmentWithTx(tx, target.resultId, { componentId: input.componentId, amount: toMoneyString(r.totalAmount), note: `Expense report ${r.reportNumber}`, reference: { type: 'EXPENSE_REPORT', id: r.id } }, actor);
      await tx.expenseReport.update({ where: { id }, data: { status: 'SENT_TO_PAYROLL', paymentMethod: 'PAYROLL', payrollResultItemId: line.itemId } });
      await history(tx, 'EXPENSE_REPORT', id, r.status, 'SENT_TO_PAYROLL', actor.auth.userId, 'PAYROLL');
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.SEND_EXPENSE_TO_PAYROLL, 'ExpenseReport', id, { reportNumber: r.reportNumber, total: toMoneyString(r.totalAmount), payrollPeriodId: input.payrollPeriodId, payrollResultId: target.resultId, payrollResultItemId: line.itemId, created: line.created }), tx);
    });
    return this.get(actor.auth, id);
  },
};

// ---------- workflow callbacks ----------
async function pending(tx: Tx, ctx: WorkflowCallbackContext) {
  const r = await loadReportForMutation(tx, ctx.entityId);
  if (r.status !== 'PENDING_APPROVAL') throw new AppError(409, 'EXPENSE_REPORT_NOT_PENDING', `Report is ${r.status}`);
  return r;
}
export const reportWorkflowHandlers = {
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    const after = await tx.expenseReport.update({ where: { id: r.id }, data: { status: 'READY_FOR_PAYMENT', approvedAt: new Date() } });
    await history(tx, 'EXPENSE_REPORT', r.id, 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', ctx.actor.auth.userId, 'APPROVED');
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.APPROVE_EXPENSE_REPORT, 'ExpenseReport', r.id, { reportNumber: r.reportNumber, total: toMoneyString(r.totalAmount), workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyOwner(tx, after, NOTIFICATION_TYPES.EXPENSE_REPORT_APPROVED);
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    const after = await tx.expenseReport.update({ where: { id: r.id }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    await history(tx, 'EXPENSE_REPORT', r.id, 'PENDING_APPROVAL', 'REJECTED', ctx.actor.auth.userId, 'REJECTED');
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.REJECT_EXPENSE_REPORT, 'ExpenseReport', r.id, { reportNumber: r.reportNumber, workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyOwner(tx, after, NOTIFICATION_TYPES.EXPENSE_REPORT_REJECTED);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pending(tx, ctx);
    await tx.expenseReport.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await history(tx, 'EXPENSE_REPORT', r.id, 'PENDING_APPROVAL', 'CANCELLED', ctx.actor.auth.userId);
    await auditService.log(expenseAudit(ctx.actor, AUDIT_ACTIONS.CANCEL_EXPENSE_REPORT, 'ExpenseReport', r.id, { from: 'PENDING_APPROVAL', workflowInstanceId: ctx.instanceId }), tx);
  },
  async notifyApprover(ctx: { instanceId: string; entityId: string; step: { id: string; approverUserId: string | null } }, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const r = await tx.expenseReport.findUnique({ where: { id: ctx.entityId }, select: { id: true, reportNumber: true, employeeNameSnapshot: true } }); if (!r) return;
    await notificationService.publish({ userId: ctx.step.approverUserId, type: NOTIFICATION_TYPES.EXPENSE_APPROVAL_REQUIRED, source: { module: EXPENSE_WORKFLOW.module, entityType: EXPENSE_WORKFLOW.report, entityId: r.id }, data: { expenseReportId: r.id, workflowInstanceId: ctx.instanceId }, dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:expense-approval-required` }, { referenceNumber: r.reportNumber, employeeName: r.employeeNameSnapshot }, tx);
  },
};
export { loadTravelForMutation };
