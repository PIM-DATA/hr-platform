import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, BENEFIT_WORKFLOW, NOTIFICATION_TYPES, benefitOperationKeys, type BenefitClaimDetailDto, type BenefitClaimDto, type BenefitClaimHistoryDto, type ClaimReviewDto, type CreateBenefitClaimInput, type MyBenefitsDto, type RecordBenefitPaymentInput, type SendClaimToPayrollInput, type UpdateBenefitClaimInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { notificationService } from '../../services/notification';
import { workflowEngine, type WorkflowCallbackContext, type WorkflowStepPendingContext } from '../../services/workflow';
import type { AuthContext } from '../auth/auth.types';
import { canAccessDocument, linkDocumentWithTx } from '../documents/documents.service';
import { dec, toMoneyString } from '../payroll/money';
import { addManualAdjustmentWithTx, findPayrollResultForEmployee } from '../payroll/payroll-run.service';
import { appendLedger, balanceDto, loadEntitlementForMutation, sumsOf } from './benefit-ledger';
import { type Actor, type Db, type Tx, adminScope, benefitsAudit, canSeeEmployee, employeeSnapshot, has, lockRow, nextClaimNumber, notFound, P, snapshotDto, textAudit, today, userNames, visibleEmployeeWhere } from './benefits.types';
import { activeOverride, evaluateRules } from './eligibility.service';
import { enrollmentService, entitlementService } from './enrollment.service';

/**
 * Benefit claims. A claim is money the employee asks back against an entitlement. Submitting RESERVES the amount on
 * the ledger inside the same transaction that starts the approval workflow; final approval converts the reservation
 * into CONSUME; rejection or cancellation RELEASES it. Every movement carries a deterministic operation key, so a
 * retried callback can never settle twice. The claimed amount is immutable once submitted. APPROVED means "ready for
 * payment" — not "paid": payment is a separate human record, and a payroll handoff is a separate explicit act.
 */
const claimInclude = { plan: { select: { sensitivity: true, workflowDefinitionCode: true, allowPostEmploymentClaims: true, status: true, planType: true } }, period: { select: { status: true, periodStart: true, periodEnd: true, perClaimMaximumSnapshot: true, requiresDocumentSnapshot: true, currencySnapshot: true } }, entitlement: true, history: { orderBy: { createdAt: 'asc' as const } } } as const;
type ClaimRow = Prisma.BenefitClaimGetPayload<{ include: typeof claimInclude }>;
const OPEN_STATUSES = ['DRAFT', 'PENDING_APPROVAL'];

export async function loadClaimForMutation(tx: Tx, id: string): Promise<ClaimRow> {
  await lockRow(tx, 'benefit_claims', id);
  const r = await tx.benefitClaim.findUnique({ where: { id }, include: claimInclude }); if (!r) throw notFound('benefit claim');
  return r;
}
const docCount = (db: Db, claimId: string) => db.documentLink.count({ where: { entityType: 'BENEFIT_CLAIM', entityId: claimId } });
async function isApprover(db: Db, auth: AuthContext, workflowInstanceId: string | null): Promise<{ any: boolean; pendingNow: boolean }> {
  if (!workflowInstanceId) return { any: false, pendingNow: false };
  const steps = await db.workflowInstanceStep.findMany({ where: { instanceId: workflowInstanceId, approverUserId: auth.userId }, select: { status: true } });
  return { any: steps.length > 0, pendingNow: steps.some((s) => s.status === 'PENDING') };
}
/** Blockers a draft would hit at submit, so the screen can say them before the button is pressed. */
function submitBlockers(r: ClaimRow, docs: number, employeeActive: boolean): string[] {
  const b: string[] = [];
  if (r.period.status !== 'OPEN') b.push('The benefit period is not open');
  if (r.serviceDate < r.period.periodStart || r.serviceDate > r.period.periodEnd) b.push('The service date is outside the benefit period');
  if (r.serviceDate > today()) b.push('The service date is in the future');
  if (r.period.currencySnapshot && r.currency !== r.period.currencySnapshot) b.push('The claim currency does not match the plan');
  if (dec(r.claimedAmount).lte(0)) b.push('The amount must be greater than zero');
  if (r.period.perClaimMaximumSnapshot && dec(r.claimedAmount).gt(r.period.perClaimMaximumSnapshot)) b.push(`The amount exceeds the per-claim maximum of ${toMoneyString(r.period.perClaimMaximumSnapshot)}`);
  if (r.period.requiresDocumentSnapshot && docs === 0) b.push('A supporting document is required');
  if (!r.entitlement) b.push('No entitlement exists for this period');
  if (!employeeActive && !r.plan.allowPostEmploymentClaims) b.push('Claims need an active employee');
  return b;
}
async function claimDto(db: Db, auth: AuthContext, r: ClaimRow, extra?: { docs?: number }): Promise<BenefitClaimDto> {
  const own = !!auth.employeeId && r.employeeId === auth.employeeId;
  const manage = has(auth, P.BENEFITS_MANAGE); const admin = adminScope(auth);
  const docs = extra?.docs ?? (await docCount(db, r.id));
  const open = r.status === 'DRAFT';
  return {
    id: r.id, claimNumber: r.claimNumber, employeeId: r.employeeId, planId: r.planId, periodId: r.periodId, entitlementId: r.entitlementId, planName: r.planNameSnapshot, planCode: r.planCodeSnapshot, categoryName: r.categorySnapshot, snapshot: snapshotDto(r),
    currency: r.currency, claimedAmount: toMoneyString(r.claimedAmount), approvedAmount: r.approvedAmount ? toMoneyString(r.approvedAmount) : null, serviceDate: r.serviceDate, submittedDate: r.submittedDate, description: own || admin ? r.description : null, status: r.status as BenefitClaimDto['status'],
    workflowInstanceId: r.workflowInstanceId, approvedAt: r.approvedAt?.toISOString() ?? null, rejectedAt: r.rejectedAt?.toISOString() ?? null, cancelledAt: r.cancelledAt?.toISOString() ?? null, paymentMethod: r.paymentMethod, paymentReference: admin ? r.paymentReference : null, paidDate: r.paidDate, paidAt: r.paidAt?.toISOString() ?? null, payrollResultItemId: admin ? r.payrollResultItemId : null,
    requiresDocument: r.period.requiresDocumentSnapshot, documentCount: docs, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    can: { edit: open && (own && has(auth, P.BENEFITS_CLAIM) || manage), submit: open && (own && has(auth, P.BENEFITS_CLAIM) || manage), cancel: OPEN_STATUSES.includes(r.status) && (own && has(auth, P.BENEFITS_CLAIM) || manage), recordPayment: (r.status === 'READY_FOR_PAYMENT' || r.status === 'SENT_TO_PAYROLL') && has(auth, P.BENEFITS_RECORD_PAYMENT), sendToPayroll: r.status === 'READY_FOR_PAYMENT' && has(auth, P.BENEFITS_RECORD_PAYMENT) && has(auth, P.PAYROLL_MANAGE), review: has(auth, P.BENEFITS_REVIEW_CLAIMS, P.BENEFITS_MANAGE) },
  };
}
async function claimDetailDto(db: Db, auth: AuthContext, r: ClaimRow): Promise<BenefitClaimDetailDto> {
  const links = await db.documentLink.findMany({ where: { entityType: 'BENEFIT_CLAIM', entityId: r.id }, select: { documentId: true } });
  const docs = links.length ? await db.document.findMany({ where: { id: { in: links.map((l) => l.documentId) } }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } }) : [];
  const names = await userNames(db, r.history.map((h) => h.actorUserId));
  const employee = await db.employee.findUnique({ where: { id: r.employeeId }, select: { employmentStatus: true } });
  const history: BenefitClaimHistoryDto[] = r.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, actorName: names.get(h.actorUserId ?? '') ?? null, reasonCode: h.reasonCode, at: h.createdAt.toISOString() }));
  return { ...(await claimDto(db, auth, r, { docs: docs.length })), documents: docs.map((d) => ({ documentId: d.id, title: d.title, documentNumber: d.documentNumber, accessible: canAccessDocument(auth, d) })), history, balance: r.entitlement ? balanceDto(r.entitlement.currency, sumsOf(r.entitlement)) : null, perClaimMaximum: r.period.perClaimMaximumSnapshot ? toMoneyString(r.period.perClaimMaximumSnapshot) : null, blockers: r.status === 'DRAFT' ? submitBlockers(r, docs.length, employee?.employmentStatus === 'ACTIVE') : [] };
}
async function history(tx: Tx, claimId: string, from: string | null, to: string, actorUserId: string | null, reasonCode: string | null = null) {
  await tx.benefitClaimStatusHistory.create({ data: { claimId, fromStatus: from, toStatus: to, actorUserId, reasonCode } });
}
async function notifyClaimant(tx: Tx, r: { id: string; employeeId: string; claimNumber: string; planNameSnapshot: string; status: string }, type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES]) {
  const emp = await tx.employee.findUnique({ where: { id: r.employeeId }, select: { user: { select: { id: true } } } });
  if (!emp?.user) return;
  await notificationService.publish({ userId: emp.user.id, type, source: { module: 'benefits', entityType: 'BENEFIT_CLAIM', entityId: r.id }, data: { claimId: r.id, status: r.status }, dedupeKey: `benefits:claim:${r.id}:${type}` }, { claimNumber: r.claimNumber, planName: r.planNameSnapshot }, tx);
}

export const claimService = {
  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: string; planId?: string; periodId?: string; employeeId?: string; search?: string }) {
    const scope = visibleEmployeeWhere(auth);
    const where: Prisma.BenefitClaimWhereInput = { ...scope, status: q.status, planId: q.planId, periodId: q.periodId, ...(q.employeeId ? { employeeId: scope.employeeId ?? q.employeeId } : {}), ...(q.search ? { OR: [{ claimNumber: { contains: q.search, mode: 'insensitive' } }, { employeeNameSnapshot: { contains: q.search, mode: 'insensitive' } }, { employeeCodeSnapshot: { contains: q.search, mode: 'insensitive' } }] } : {}) };
    const [total, rows] = await prisma.$transaction([prisma.benefitClaim.count({ where }), prisma.benefitClaim.findMany({ where, include: claimInclude, orderBy: [{ createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const counts = new Map((await prisma.documentLink.groupBy({ by: ['entityId'], where: { entityType: 'BENEFIT_CLAIM', entityId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })).map((g) => [g.entityId, g._count._all]));
    return { data: await Promise.all(rows.map((r) => claimDto(prisma, auth, r, { docs: counts.get(r.id) ?? 0 }))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
  async get(auth: AuthContext, id: string): Promise<BenefitClaimDetailDto> {
    const r = await prisma.benefitClaim.findUnique({ where: { id }, include: claimInclude }); if (!r || !canSeeEmployee(auth, r.employeeId)) throw notFound('benefit claim');
    return claimDetailDto(prisma, auth, r);
  },
  /** The approver's purpose-specific view: the claim, its authorized documents, and — if the plan allows — the description. Nothing else about the person. */
  async review(auth: AuthContext, id: string): Promise<ClaimReviewDto> {
    const r = await prisma.benefitClaim.findUnique({ where: { id }, include: claimInclude }); if (!r) throw notFound('benefit claim');
    const approver = await isApprover(prisma, auth, r.workflowInstanceId);
    const reviewer = has(auth, P.BENEFITS_REVIEW_CLAIMS, P.BENEFITS_MANAGE) && adminScope(auth);
    if (!(reviewer || (approver.any && has(auth, P.WORKFLOW_APPROVE)))) throw notFound('benefit claim');
    const detail = await claimDetailDto(prisma, auth, r);
    const descriptionVisible = reviewer || r.sensitivitySnapshot === 'NORMAL';
    return { claim: { ...detail, description: descriptionVisible ? r.description : null, paymentReference: reviewer ? r.paymentReference : null }, workflowInstanceId: r.workflowInstanceId, myStepPending: approver.pendingNow, descriptionVisible };
  },
  async myBenefits(auth: AuthContext): Promise<MyBenefitsDto> {
    const employeeId = auth.employeeId;
    if (!employeeId) return { enrollments: [], entitlements: [], claims: [], coverage: [], selectablePlans: [] };
    const [enrollments, entitlements, claims, plans, employee] = await Promise.all([
      enrollmentService.forEmployee(employeeId), entitlementService.forEmployee(employeeId), this.list(auth, { page: 1, pageSize: 100, employeeId }),
      prisma.benefitPlan.findMany({ where: { status: 'ACTIVE', employeeSelectable: true }, include: { rules: true, category: { select: { name: true } } }, orderBy: { name: 'asc' } }), prisma.employee.findUnique({ where: { id: employeeId }, include: { organization: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, position: { select: { id: true, title: true, jobId: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } } } }),
    ]);
    const t = today();
    const selectablePlans = employee ? await Promise.all(plans.map(async (p) => { const e = evaluateRules(employee, p.rules, await activeOverride(prisma, p.id, employeeId), t); return { id: p.id, code: p.code, name: p.name, planType: p.planType as MyBenefitsDto['selectablePlans'][number]['planType'], categoryName: p.category.name, requiresDocument: p.requiresDocument, eligible: e.eligible, reasons: e.reasons.map((x) => x.message), enrollmentStatus: enrollments.find((en) => en.planId === p.id)?.status ?? null }; })) : [];
    return { enrollments: enrollments.filter((e) => e.planType !== 'COVERAGE_ONLY'), entitlements, claims: claims.data, coverage: enrollments.filter((e) => e.planType === 'COVERAGE_ONLY'), selectablePlans };
  },
  /** A draft: no reservation, no workflow. Only for the caller's own employee record. */
  async create(input: CreateBenefitClaimInput, actor: Actor): Promise<BenefitClaimDetailDto> {
    const { auth } = actor;
    if (!auth.employeeId) throw new AppError(409, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
    const employeeId = auth.employeeId;
    const id = await prisma.$transaction(async (tx) => {
      const period = await tx.benefitPeriod.findUnique({ where: { id: input.periodId }, include: { plan: { include: { category: { select: { name: true } } } } } }); if (!period || period.planId !== input.planId) throw notFound('benefit period');
      if (period.plan.planType === 'COVERAGE_ONLY') throw new AppError(409, 'BENEFIT_PLAN_NOT_MONETARY', 'A coverage-only benefit has no claims');
      if (period.plan.status !== 'ACTIVE') throw new AppError(409, 'BENEFIT_PLAN_NOT_ACTIVE', 'This plan is not active');
      if (period.status !== 'OPEN') throw new AppError(409, 'BENEFIT_PERIOD_NOT_OPEN', 'Claims are made in an open period');
      const { employee, data } = await employeeSnapshot(tx, employeeId);
      if (employee.employmentStatus !== 'ACTIVE' && !period.plan.allowPostEmploymentClaims) throw new AppError(409, 'EMPLOYEE_NOT_ACTIVE', 'Claims need an active employee');
      const entitlement = await tx.benefitEntitlement.findUnique({ where: { employeeId_planId_periodId: { employeeId, planId: period.planId, periodId: period.id } } });
      if (!entitlement) throw new AppError(409, 'BENEFIT_NO_ENTITLEMENT', 'You have no entitlement for this period');
      const claim = await tx.benefitClaim.create({ data: {
        claimNumber: await nextClaimNumber(tx), employeeId, planId: period.planId, periodId: period.id, entitlementId: entitlement.id, planCodeSnapshot: period.plan.code, planNameSnapshot: period.plan.name, categorySnapshot: period.plan.category.name, ...data,
        currency: period.currencySnapshot ?? entitlement.currency, claimedAmount: dec(input.claimedAmount), perClaimMaximumSnapshot: period.perClaimMaximumSnapshot, requiresDocumentSnapshot: period.requiresDocumentSnapshot, sensitivitySnapshot: period.plan.sensitivity, serviceDate: input.serviceDate, description: input.description ?? null, status: 'DRAFT', createdByUserId: auth.userId,
      } });
      await history(tx, claim.id, null, 'DRAFT', auth.userId);
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CREATE_BENEFIT_CLAIM, 'BenefitClaim', claim.id, { claimNumber: claim.claimNumber, planId: period.planId, periodId: period.id, claimedAmount: toMoneyString(claim.claimedAmount), currency: claim.currency, serviceDate: claim.serviceDate, ...textAudit('description', null, claim.description) }), tx);
      return claim.id;
    });
    return this.get(auth, id);
  },
  async update(id: string, input: UpdateBenefitClaimInput, actor: Actor): Promise<BenefitClaimDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      const own = !!actor.auth.employeeId && r.employeeId === actor.auth.employeeId && has(actor.auth, P.BENEFITS_CLAIM);
      if (!own && !has(actor.auth, P.BENEFITS_MANAGE)) throw notFound('benefit claim');
      if (r.status !== 'DRAFT') throw new AppError(409, 'BENEFIT_CLAIM_NOT_DRAFT', 'A submitted claim cannot be edited; cancel it and make a new one');
      let periodData = {};
      if (input.periodId && input.periodId !== r.periodId) {
        const period = await tx.benefitPeriod.findUnique({ where: { id: input.periodId } }); if (!period || period.planId !== r.planId || period.status !== 'OPEN') throw notFound('benefit period');
        const ent = await tx.benefitEntitlement.findUnique({ where: { employeeId_planId_periodId: { employeeId: r.employeeId, planId: r.planId, periodId: period.id } } }); if (!ent) throw new AppError(409, 'BENEFIT_NO_ENTITLEMENT', 'No entitlement for that period');
        periodData = { periodId: period.id, entitlementId: ent.id, perClaimMaximumSnapshot: period.perClaimMaximumSnapshot, requiresDocumentSnapshot: period.requiresDocumentSnapshot, currency: period.currencySnapshot ?? ent.currency };
      }
      const after = await tx.benefitClaim.update({ where: { id }, data: { ...periodData, claimedAmount: input.claimedAmount === undefined ? undefined : dec(input.claimedAmount), serviceDate: input.serviceDate, description: input.description === undefined ? undefined : input.description } });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.UPDATE_BENEFIT_CLAIM, 'BenefitClaim', id, { fields: Object.keys(input), claimedAmount: toMoneyString(after.claimedAmount), serviceDate: after.serviceDate, ...textAudit('description', r.description, after.description) }), tx);
    });
    return this.get(actor.auth, id);
  },
  /** §36: lock claim → verify DRAFT → lock entitlement → balance → RESERVE → workflow → PENDING_APPROVAL → audit → notify. One transaction. */
  async submit(id: string, actor: Actor): Promise<BenefitClaimDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.BENEFITS_CLAIM);
      if (!own && !has(auth, P.BENEFITS_MANAGE)) throw notFound('benefit claim');
      if (r.status !== 'DRAFT') throw new AppError(409, 'BENEFIT_CLAIM_NOT_DRAFT', `This claim is ${r.status.toLowerCase().replace(/_/g, ' ')}`);
      if (!r.plan.workflowDefinitionCode) throw new AppError(409, 'BENEFIT_PLAN_NO_WORKFLOW', 'The plan has no claim approval workflow');
      const [employee, enrollment, docs] = await Promise.all([tx.employee.findUnique({ where: { id: r.employeeId }, include: { organization: { select: { id: true, name: true } }, department: { select: { id: true, name: true } }, position: { select: { id: true, title: true, jobId: true, job: { select: { title: true } } } }, user: { select: { id: true, isActive: true } } } }), tx.benefitEnrollment.findUnique({ where: { employeeId_planId: { employeeId: r.employeeId, planId: r.planId } } }), docCount(tx, r.id)]);
      if (!employee) throw notFound('employee');
      const blockers = submitBlockers(r, docs, employee.employmentStatus === 'ACTIVE');
      if (enrollment?.status !== 'ENROLLED') blockers.push('Not enrolled in this plan');
      const plan = await tx.benefitPlan.findUnique({ where: { id: r.planId }, include: { rules: true } });
      if (plan && !evaluateRules(employee, plan.rules, await activeOverride(tx, r.planId, r.employeeId), today()).eligible && enrollment?.status === 'ENROLLED') { /* an existing enrolment stands: eligibility was snapshotted at enrolment (§28) */ }
      if (blockers.length) throw new AppError(422, 'BENEFIT_CLAIM_INVALID', blockers.join('; '), blockers.map((b) => ({ field: 'claim', message: b })));
      const ent = await loadEntitlementForMutation(tx, r.entitlementId!);
      if (ent.currency !== r.currency) throw new AppError(422, 'BENEFIT_CURRENCY_MISMATCH', 'The claim currency does not match the entitlement');
      const reserve = await appendLedger(tx, { entitlementId: ent.id, entryType: 'RESERVE', amount: dec(r.claimedAmount), claimId: r.id, operationKey: benefitOperationKeys.claim(r.id, 'reserve'), actorUserId: auth.userId }, { guardAvailable: true });
      const now = new Date();
      await tx.benefitClaim.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedDate: today() } });
      await history(tx, id, 'DRAFT', 'PENDING_APPROVAL', auth.userId);
      const instance = await workflowEngine.submit({ definitionCode: r.plan.workflowDefinitionCode, module: BENEFIT_WORKFLOW.module, entityType: BENEFIT_WORKFLOW.entityType, entityId: r.id, requesterEmployeeId: r.employeeId }, actor, tx);
      const after = await tx.benefitClaim.update({ where: { id }, data: { workflowInstanceId: instance.id } });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.SUBMIT_BENEFIT_CLAIM, 'BenefitClaim', id, { claimNumber: r.claimNumber, claimedAmount: toMoneyString(r.claimedAmount), currency: r.currency, reserved: toMoneyString(reserve.sums.reserved), available: toMoneyString(reserve.available), workflowInstanceId: instance.id, workflowStatus: instance.status, documents: docs, submittedAt: now.toISOString() }), tx);
      if (after.status === 'PENDING_APPROVAL') await notifyClaimant(tx, after, NOTIFICATION_TYPES.BENEFIT_CLAIM_SUBMITTED);
    });
    return this.get(auth, id);
  },
  /** The claimant attaches a document they can already read (their own receipt). A Task 30 link: no bytes here, no wider access anywhere. */
  async attachDocument(id: string, documentId: string, actor: Actor): Promise<BenefitClaimDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.BENEFITS_CLAIM);
      if (!own && !has(auth, P.BENEFITS_MANAGE)) throw notFound('benefit claim');
      if (!OPEN_STATUSES.includes(r.status)) throw new AppError(409, 'BENEFIT_CLAIM_CLOSED', 'Documents are attached while a claim is open');
      const doc = await tx.document.findUnique({ where: { id: documentId }, include: { category: true, links: true, ownerEmployee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, managerId: true } } } });
      if (!doc || !canAccessDocument(auth, doc)) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document not found');
      const link = await linkDocumentWithTx(tx, documentId, { entityType: 'BENEFIT_CLAIM', entityId: id, relationType: 'CLAIM_RECEIPT' }, actor);
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.UPDATE_BENEFIT_CLAIM, 'BenefitClaim', id, { documentLinked: true, created: link.created }), tx);
    });
    return this.get(auth, id);
  },
  /** DRAFT → CANCELLED directly; PENDING_APPROVAL → through the workflow, whose callback releases the reservation exactly once. */
  async cancel(id: string, actor: Actor): Promise<BenefitClaimDetailDto> {
    const { auth } = actor;
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      const own = !!auth.employeeId && r.employeeId === auth.employeeId && has(auth, P.BENEFITS_CLAIM);
      if (!own && !has(auth, P.BENEFITS_MANAGE)) throw notFound('benefit claim');
      if (r.status === 'DRAFT') {
        await tx.benefitClaim.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        await history(tx, id, 'DRAFT', 'CANCELLED', auth.userId);
        await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CANCEL_BENEFIT_CLAIM, 'BenefitClaim', id, { from: 'DRAFT', reserved: '0.00' }), tx);
        return;
      }
      if (r.status !== 'PENDING_APPROVAL' || !r.workflowInstanceId) throw new AppError(409, 'BENEFIT_CLAIM_NOT_CANCELLABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} claim cannot be cancelled`);
      await workflowEngine.cancel(r.workflowInstanceId, actor, tx); // → onCancelled below
    });
    return this.get(auth, id);
  },
  /** Bookkeeping: HR records that the money went out (externally, through payroll, or otherwise). No transfer happens here. */
  async recordPayment(id: string, input: RecordBenefitPaymentInput, actor: Actor): Promise<BenefitClaimDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      if (r.status !== 'READY_FOR_PAYMENT' && r.status !== 'SENT_TO_PAYROLL') throw new AppError(409, 'BENEFIT_CLAIM_NOT_PAYABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} claim cannot be recorded as paid`);
      // Task 48 (T44-P1-15): a claim handed to payroll is paid by payroll — recording another payment would pay it twice.
      if (r.status === 'SENT_TO_PAYROLL' && input.paymentMethod !== 'PAYROLL') throw new AppError(409, 'BENEFIT_CLAIM_IN_PAYROLL', 'This claim was handed over to payroll; it can only be recorded as paid through payroll');
      const after = await tx.benefitClaim.update({ where: { id }, data: { status: 'PAID', paymentMethod: input.paymentMethod, paymentReference: input.paymentReference ?? null, paidDate: input.paidDate, paidAt: new Date(), paidByUserId: actor.auth.userId } });
      await history(tx, id, r.status, 'PAID', actor.auth.userId, input.paymentMethod);
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.RECORD_BENEFIT_PAYMENT, 'BenefitClaim', id, { claimNumber: r.claimNumber, amount: toMoneyString(r.approvedAmount ?? r.claimedAmount), currency: r.currency, paymentMethod: input.paymentMethod, paidDate: input.paidDate, referenceLength: input.paymentReference?.length ?? 0 }, { status: r.status }), tx);
      await notifyClaimant(tx, after, NOTIFICATION_TYPES.BENEFIT_CLAIM_PAID);
    });
    return this.get(actor.auth, id);
  },
  /**
   * Explicit handoff to payroll: one manual EARNING line on the employee's result in the chosen period's run, through
   * payroll's own composable helper (its lock and "run in review" rules apply). Idempotent by claim id. The claim
   * becomes SENT_TO_PAYROLL — not PAID: payroll closing is payroll's business, and taxability is nobody's here.
   */
  async sendToPayroll(id: string, input: SendClaimToPayrollInput, actor: Actor): Promise<BenefitClaimDetailDto> {
    await prisma.$transaction(async (tx) => {
      const r = await loadClaimForMutation(tx, id);
      if (r.status === 'SENT_TO_PAYROLL' && r.payrollResultItemId) return; // idempotent
      if (r.status !== 'READY_FOR_PAYMENT') throw new AppError(409, 'BENEFIT_CLAIM_NOT_PAYABLE', `A ${r.status.toLowerCase().replace(/_/g, ' ')} claim cannot be sent to payroll`);
      const component = await tx.payComponent.findUnique({ where: { id: input.componentId }, select: { type: true } });
      if (!component || component.type !== 'EARNING') throw new AppError(422, 'VALIDATION_ERROR', 'Choose an earning component for the reimbursement line', [{ field: 'componentId', message: 'Must be an active EARNING component' }]);
      const target = await findPayrollResultForEmployee(tx, input.payrollPeriodId, r.employeeId);
      if (!target) throw new AppError(409, 'PAYROLL_RESULT_NOT_FOUND', 'Calculate the payroll period first; the employee has no result in it');
      const line = await addManualAdjustmentWithTx(tx, target.resultId, { componentId: input.componentId, amount: toMoneyString(r.approvedAmount ?? r.claimedAmount), note: `Benefit claim ${r.claimNumber} (${r.planCodeSnapshot})`, reference: { type: 'BENEFIT_CLAIM', id: r.id, currency: r.currency } }, actor);
      await tx.benefitClaim.update({ where: { id }, data: { status: 'SENT_TO_PAYROLL', paymentMethod: 'PAYROLL', payrollResultItemId: line.itemId } });
      await history(tx, id, r.status, 'SENT_TO_PAYROLL', actor.auth.userId, 'PAYROLL');
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.SEND_BENEFIT_TO_PAYROLL, 'BenefitClaim', id, { claimNumber: r.claimNumber, amount: toMoneyString(r.approvedAmount ?? r.claimedAmount), payrollPeriodId: input.payrollPeriodId, payrollResultId: target.resultId, payrollResultItemId: line.itemId, created: line.created }), tx);
    });
    return this.get(actor.auth, id);
  },
};

// ---------- workflow handlers (run inside the engine's transaction; engine holds the instance lock) ----------
async function pendingClaim(tx: Tx, ctx: WorkflowCallbackContext) {
  const r = await loadClaimForMutation(tx, ctx.entityId);
  if (r.status !== 'PENDING_APPROVAL' || !r.entitlementId) throw new AppError(409, 'BENEFIT_CLAIM_NOT_PENDING', `Claim is ${r.status}`);
  return r as ClaimRow & { entitlementId: string };
}
const ctxActor = (ctx: WorkflowCallbackContext): Actor => ctx.actor;
export const benefitsWorkflowHandlers = {
  /** Final approval: RELEASE the reservation, CONSUME the approved amount (= claimed; partial approval is not offered), READY_FOR_PAYMENT. */
  async onApproved(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pendingClaim(tx, ctx);
    await loadEntitlementForMutation(tx, r.entitlementId);
    const amount = dec(r.claimedAmount);
    await appendLedger(tx, { entitlementId: r.entitlementId, entryType: 'RELEASE', amount, claimId: r.id, operationKey: benefitOperationKeys.claim(r.id, 'release'), actorUserId: ctx.actor.auth.userId });
    const consumed = await appendLedger(tx, { entitlementId: r.entitlementId, entryType: 'CONSUME', amount, claimId: r.id, operationKey: benefitOperationKeys.claim(r.id, 'consume'), actorUserId: ctx.actor.auth.userId });
    const now = new Date();
    const after = await tx.benefitClaim.update({ where: { id: r.id }, data: { status: 'READY_FOR_PAYMENT', approvedAmount: amount, approvedAt: now } });
    await history(tx, r.id, 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', ctx.actor.auth.userId, 'APPROVED');
    await auditService.log(benefitsAudit(ctxActor(ctx), AUDIT_ACTIONS.APPROVE_BENEFIT_CLAIM, 'BenefitClaim', r.id, { claimNumber: r.claimNumber, approvedAmount: toMoneyString(amount), consumed: toMoneyString(consumed.sums.consumed), reserved: toMoneyString(consumed.sums.reserved), available: toMoneyString(consumed.available), workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyClaimant(tx, after, NOTIFICATION_TYPES.BENEFIT_CLAIM_APPROVED);
  },
  async onRejected(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pendingClaim(tx, ctx);
    await loadEntitlementForMutation(tx, r.entitlementId);
    const rel = await appendLedger(tx, { entitlementId: r.entitlementId, entryType: 'RELEASE', amount: dec(r.claimedAmount), claimId: r.id, operationKey: benefitOperationKeys.claim(r.id, 'release'), actorUserId: ctx.actor.auth.userId });
    const after = await tx.benefitClaim.update({ where: { id: r.id }, data: { status: 'REJECTED', rejectedAt: new Date() } });
    await history(tx, r.id, 'PENDING_APPROVAL', 'REJECTED', ctx.actor.auth.userId, 'REJECTED');
    // the reviewer's comment stays on the workflow timeline; the audit records only that one was written
    await auditService.log(benefitsAudit(ctxActor(ctx), AUDIT_ACTIONS.REJECT_BENEFIT_CLAIM, 'BenefitClaim', r.id, { claimNumber: r.claimNumber, released: toMoneyString(r.claimedAmount), available: toMoneyString(rel.available), workflowInstanceId: ctx.instanceId, ...textAudit('comment', null, ctx.comment) }, { status: 'PENDING_APPROVAL' }), tx);
    await notifyClaimant(tx, after, NOTIFICATION_TYPES.BENEFIT_CLAIM_REJECTED);
  },
  async onCancelled(ctx: WorkflowCallbackContext, tx: Tx) {
    const r = await pendingClaim(tx, ctx);
    await loadEntitlementForMutation(tx, r.entitlementId);
    const rel = await appendLedger(tx, { entitlementId: r.entitlementId, entryType: 'RELEASE', amount: dec(r.claimedAmount), claimId: r.id, operationKey: benefitOperationKeys.claim(r.id, 'release'), actorUserId: ctx.actor.auth.userId });
    await tx.benefitClaim.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await history(tx, r.id, 'PENDING_APPROVAL', 'CANCELLED', ctx.actor.auth.userId);
    await auditService.log(benefitsAudit(ctxActor(ctx), AUDIT_ACTIONS.CANCEL_BENEFIT_CLAIM, 'BenefitClaim', r.id, { from: 'PENDING_APPROVAL', released: toMoneyString(r.claimedAmount), available: toMoneyString(rel.available), workflowInstanceId: ctx.instanceId }), tx);
  },
  async onStepPending(ctx: WorkflowStepPendingContext, tx: Tx) {
    if (!ctx.step.approverUserId) return;
    const r = await tx.benefitClaim.findUnique({ where: { id: ctx.entityId }, select: { id: true, claimNumber: true, planNameSnapshot: true, employeeNameSnapshot: true } }); if (!r) return;
    await notificationService.publish({ userId: ctx.step.approverUserId, type: NOTIFICATION_TYPES.BENEFIT_CLAIM_APPROVAL_REQUIRED, source: { module: BENEFIT_WORKFLOW.module, entityType: BENEFIT_WORKFLOW.entityType, entityId: r.id }, data: { claimId: r.id, workflowInstanceId: ctx.instanceId }, dedupeKey: `workflow:${ctx.instanceId}:step:${ctx.step.id}:benefit-approval-required` }, { claimNumber: r.claimNumber, planName: r.planNameSnapshot, employeeName: r.employeeNameSnapshot }, tx);
  },
};
export function registerBenefitsWorkflowHandlers() { workflowEngine.registerHandler(BENEFIT_WORKFLOW.module, benefitsWorkflowHandlers); }
