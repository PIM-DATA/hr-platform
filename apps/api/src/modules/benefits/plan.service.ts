import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type BenefitCategoryDto, type BenefitPeriodDto, type BenefitPlanDto, type BenefitRuleDto, type CreateBenefitCategoryInput, type CreateBenefitPeriodInput, type CreateBenefitPlanInput, type UpdateBenefitCategoryInput, type UpdateBenefitPeriodInput, type UpdateBenefitPlanInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { workflowDefinitionsService } from '../../services/workflow';
import { dec, toMoneyString } from '../payroll/money';
import { type Actor, type Db, benefitsAudit, lockRow, notFound, textAudit } from './benefits.types';

// ---------- categories ----------
const catDto = (c: { id: string; code: string; name: string; description: string | null; isActive: boolean; _count: { plans: number } }): BenefitCategoryDto => ({ id: c.id, code: c.code, name: c.name, description: c.description, isActive: c.isActive, planCount: c._count.plans });
export const benefitCategoryService = {
  async list(includeInactive = false): Promise<BenefitCategoryDto[]> { return (await prisma.benefitCategory.findMany({ where: includeInactive ? {} : { isActive: true }, include: { _count: { select: { plans: true } } }, orderBy: { name: 'asc' } })).map(catDto); },
  async create(input: CreateBenefitCategoryInput, actor: Actor): Promise<BenefitCategoryDto> {
    return prisma.$transaction(async (tx) => {
      if (await tx.benefitCategory.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'BENEFIT_CATEGORY_CODE_EXISTS', 'A category with that code exists');
      const c = await tx.benefitCategory.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null }, include: { _count: { select: { plans: true } } } });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CREATE_BENEFIT_CATEGORY, 'BenefitCategory', c.id, { code: c.code, name: c.name }), tx);
      return catDto(c);
    });
  },
  async update(id: string, input: UpdateBenefitCategoryInput, actor: Actor): Promise<BenefitCategoryDto> {
    return prisma.$transaction(async (tx) => {
      const before = await tx.benefitCategory.findUnique({ where: { id } }); if (!before) throw notFound('benefit category');
      const c = await tx.benefitCategory.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, isActive: input.isActive }, include: { _count: { select: { plans: true } } } });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.UPDATE_BENEFIT_CATEGORY, 'BenefitCategory', id, { name: c.name, isActive: c.isActive }, { name: before.name, isActive: before.isActive }), tx);
      return catDto(c);
    });
  },
};

// ---------- plans ----------
const planInclude = { category: { select: { name: true } }, rules: true, _count: { select: { enrollments: true, periods: true } } } as const;
type PlanRow = Prisma.BenefitPlanGetPayload<{ include: typeof planInclude }>;
async function ruleLabels(db: Db, rules: { id: string; ruleType: string; value: string }[]): Promise<BenefitRuleDto[]> {
  const ids = (t: string) => rules.filter((r) => r.ruleType === t).map((r) => r.value);
  const [orgs, depts, jobs, positions] = await Promise.all([
    ids('ORGANIZATION').length ? db.organization.findMany({ where: { id: { in: ids('ORGANIZATION') } }, select: { id: true, name: true } }) : [],
    ids('DEPARTMENT').length ? db.department.findMany({ where: { id: { in: ids('DEPARTMENT') } }, select: { id: true, name: true } }) : [],
    ids('JOB').length ? db.job.findMany({ where: { id: { in: ids('JOB') } }, select: { id: true, title: true } }) : [],
    ids('POSITION').length ? db.position.findMany({ where: { id: { in: ids('POSITION') } }, select: { id: true, title: true } }) : [],
  ]);
  const name = new Map<string, string>([...orgs.map((x) => [x.id, x.name] as const), ...depts.map((x) => [x.id, x.name] as const), ...jobs.map((x) => [x.id, x.title] as const), ...positions.map((x) => [x.id, x.title] as const)]);
  return rules.map((r) => ({ id: r.id, ruleType: r.ruleType as BenefitRuleDto['ruleType'], value: r.value, label: r.ruleType === 'MIN_TENURE_MONTHS' ? `${r.value} months` : r.ruleType === 'EMPLOYMENT_TYPE' || r.ruleType === 'EMPLOYMENT_STATUS' ? r.value : (name.get(r.value) ?? r.value) }));
}
async function planDto(db: Db, p: PlanRow): Promise<BenefitPlanDto> {
  const org = p.organizationId ? await db.organization.findUnique({ where: { id: p.organizationId }, select: { name: true } }) : null;
  return {
    id: p.id, code: p.code, name: p.name, description: p.description, categoryId: p.categoryId, categoryName: p.category.name, organizationId: p.organizationId, organizationName: org?.name ?? null,
    planType: p.planType as BenefitPlanDto['planType'], currency: p.currency, defaultEntitlementAmount: p.defaultEntitlementAmount ? toMoneyString(p.defaultEntitlementAmount) : null, perClaimMaximum: p.perClaimMaximum ? toMoneyString(p.perClaimMaximum) : null,
    requiresDocument: p.requiresDocument, employeeSelectable: p.employeeSelectable, allowPostEmploymentClaims: p.allowPostEmploymentClaims, sensitivity: p.sensitivity as BenefitPlanDto['sensitivity'], workflowDefinitionCode: p.workflowDefinitionCode, status: p.status as BenefitPlanDto['status'],
    effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, rules: await ruleLabels(db, p.rules), counts: { enrollments: p._count.enrollments, periods: p._count.periods }, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}
async function validateRefs(tx: Db, input: { categoryId?: string; organizationId?: string | null; workflowDefinitionCode?: string | null; rules?: { ruleType: string; value: string }[] }) {
  if (input.categoryId && !(await tx.benefitCategory.findFirst({ where: { id: input.categoryId, isActive: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive category', [{ field: 'categoryId', message: 'Unknown or inactive category' }]);
  if (input.organizationId && !(await tx.organization.findUnique({ where: { id: input.organizationId } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
  if (input.workflowDefinitionCode) {
    const def = await workflowDefinitionsService.getActive(tx as Prisma.TransactionClient, input.workflowDefinitionCode).catch(() => null);
    if (!def || def.module !== 'benefits' || def.entityType !== 'BENEFIT_CLAIM') throw new AppError(422, 'VALIDATION_ERROR', 'The workflow must be an active definition for benefits / BENEFIT_CLAIM', [{ field: 'workflowDefinitionCode', message: 'Unknown or wrong workflow definition' }]);
  }
  for (const r of input.rules ?? []) {
    const exists = r.ruleType === 'ORGANIZATION' ? !!(await tx.organization.findUnique({ where: { id: r.value } })) : r.ruleType === 'DEPARTMENT' ? !!(await tx.department.findUnique({ where: { id: r.value } })) : r.ruleType === 'JOB' ? !!(await tx.job.findUnique({ where: { id: r.value } })) : r.ruleType === 'POSITION' ? !!(await tx.position.findUnique({ where: { id: r.value } })) : r.ruleType === 'MIN_TENURE_MONTHS' ? /^\d{1,3}$/.test(r.value) : r.ruleType === 'EMPLOYMENT_TYPE' ? /^[A-Z_]{2,40}$/.test(r.value) : ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'].includes(r.value) || /^[A-Z_]{2,40}$/.test(r.value);
    if (!exists) throw new AppError(422, 'VALIDATION_ERROR', `Invalid ${r.ruleType} rule value`, [{ field: 'rules', message: `Invalid value for ${r.ruleType}` }]);
  }
}
const moneyOrNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : dec(v));

export const benefitPlanService = {
  async list(q: { status?: string; categoryId?: string; planType?: string; includeInactive?: boolean }): Promise<BenefitPlanDto[]> {
    const rows = await prisma.benefitPlan.findMany({ where: { status: q.status ?? (q.includeInactive ? undefined : { in: ['DRAFT', 'ACTIVE'] }), categoryId: q.categoryId, planType: q.planType }, include: planInclude, orderBy: [{ status: 'asc' }, { name: 'asc' }] });
    return Promise.all(rows.map((r) => planDto(prisma, r)));
  },
  async get(id: string): Promise<BenefitPlanDto> { const r = await prisma.benefitPlan.findUnique({ where: { id }, include: planInclude }); if (!r) throw notFound('benefit plan'); return planDto(prisma, r); },
  async create(input: CreateBenefitPlanInput, actor: Actor): Promise<BenefitPlanDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (await tx.benefitPlan.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'BENEFIT_PLAN_CODE_EXISTS', 'A plan with that code exists');
      await validateRefs(tx, input);
      const created = await tx.benefitPlan.create({ data: {
        code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, categoryId: input.categoryId, organizationId: input.organizationId ?? null, planType: input.planType,
        currency: input.planType === 'COVERAGE_ONLY' ? null : input.currency ?? null, defaultEntitlementAmount: input.planType === 'COVERAGE_ONLY' ? null : moneyOrNull(input.defaultEntitlementAmount) ?? null, perClaimMaximum: input.planType === 'COVERAGE_ONLY' ? null : moneyOrNull(input.perClaimMaximum) ?? null,
        requiresDocument: input.requiresDocument ?? false, employeeSelectable: input.employeeSelectable ?? false, allowPostEmploymentClaims: input.allowPostEmploymentClaims ?? false, sensitivity: input.sensitivity ?? 'NORMAL', workflowDefinitionCode: input.planType === 'COVERAGE_ONLY' ? null : input.workflowDefinitionCode ?? null,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, createdByUserId: actor.auth.userId, rules: { create: (input.rules ?? []).map((r) => ({ ruleType: r.ruleType, value: r.value })) },
      }, include: planInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CREATE_BENEFIT_PLAN, 'BenefitPlan', created.id, { code: created.code, planType: created.planType, currency: created.currency, defaultEntitlementAmount: created.defaultEntitlementAmount ? toMoneyString(created.defaultEntitlementAmount) : null, perClaimMaximum: created.perClaimMaximum ? toMoneyString(created.perClaimMaximum) : null, requiresDocument: created.requiresDocument, rules: created.rules.length }), tx);
      return created;
    });
    return planDto(prisma, row);
  },
  /**
   * DRAFT plans are freely editable. An ACTIVE plan's money rules may change for FUTURE periods only: every OPEN or
   * CLOSED period already carries its own snapshot, so nothing historical moves. Status changes go through here too
   * (ACTIVATE is audited as its own action).
   */
  async update(id: string, input: UpdateBenefitPlanInput, actor: Actor): Promise<BenefitPlanDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_plans', id);
      const before = await tx.benefitPlan.findUnique({ where: { id }, include: planInclude }); if (!before) throw notFound('benefit plan');
      if (before.status === 'ARCHIVED') throw new AppError(409, 'BENEFIT_PLAN_ARCHIVED', 'An archived plan is history');
      await validateRefs(tx, input);
      if (input.status === 'ACTIVE' && before.planType !== 'COVERAGE_ONLY') {
        const currency = input.currency === undefined ? before.currency : input.currency; const wf = input.workflowDefinitionCode === undefined ? before.workflowDefinitionCode : input.workflowDefinitionCode;
        if (!currency) throw new AppError(422, 'VALIDATION_ERROR', 'A monetary plan needs a currency before activation', [{ field: 'currency', message: 'Required' }]);
        if (!wf) throw new AppError(422, 'VALIDATION_ERROR', 'A monetary plan needs a claim approval workflow before activation', [{ field: 'workflowDefinitionCode', message: 'Required' }]);
      }
      if (input.rules) { await tx.benefitEligibilityRule.deleteMany({ where: { planId: id } }); }
      const after = await tx.benefitPlan.update({ where: { id }, data: {
        name: input.name, description: input.description === undefined ? undefined : input.description, categoryId: input.categoryId, organizationId: input.organizationId === undefined ? undefined : input.organizationId,
        currency: input.currency === undefined ? undefined : input.currency, defaultEntitlementAmount: moneyOrNull(input.defaultEntitlementAmount), perClaimMaximum: moneyOrNull(input.perClaimMaximum),
        requiresDocument: input.requiresDocument, employeeSelectable: input.employeeSelectable, allowPostEmploymentClaims: input.allowPostEmploymentClaims, sensitivity: input.sensitivity, workflowDefinitionCode: input.workflowDefinitionCode === undefined ? undefined : input.workflowDefinitionCode,
        effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo, status: input.status,
        ...(input.rules ? { rules: { create: input.rules.map((r) => ({ ruleType: r.ruleType, value: r.value })) } } : {}),
      }, include: planInclude });
      const action = input.status === 'ACTIVE' && before.status !== 'ACTIVE' ? AUDIT_ACTIONS.ACTIVATE_BENEFIT_PLAN : AUDIT_ACTIONS.UPDATE_BENEFIT_PLAN;
      await auditService.log(benefitsAudit(actor, action, 'BenefitPlan', id, { fields: Object.keys(input), status: after.status, currency: after.currency, defaultEntitlementAmount: after.defaultEntitlementAmount ? toMoneyString(after.defaultEntitlementAmount) : null, perClaimMaximum: after.perClaimMaximum ? toMoneyString(after.perClaimMaximum) : null, rules: after.rules.length, ...textAudit('description', before.description, after.description) }, { status: before.status, currency: before.currency, defaultEntitlementAmount: before.defaultEntitlementAmount ? toMoneyString(before.defaultEntitlementAmount) : null, perClaimMaximum: before.perClaimMaximum ? toMoneyString(before.perClaimMaximum) : null }), tx);
      return after;
    });
    return planDto(prisma, row);
  },
};

// ---------- periods ----------
const periodInclude = { plan: { select: { name: true, code: true } }, _count: { select: { entitlements: true } } } as const;
type PeriodRow = Prisma.BenefitPeriodGetPayload<{ include: typeof periodInclude }>;
export const periodDto = (r: PeriodRow): BenefitPeriodDto => ({ id: r.id, planId: r.planId, planName: r.plan.name, planCode: r.plan.code, name: r.name, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status as BenefitPeriodDto['status'], entitlementAmountSnapshot: r.entitlementAmountSnapshot ? toMoneyString(r.entitlementAmountSnapshot) : null, perClaimMaximumSnapshot: r.perClaimMaximumSnapshot ? toMoneyString(r.perClaimMaximumSnapshot) : null, currencySnapshot: r.currencySnapshot, requiresDocumentSnapshot: r.requiresDocumentSnapshot, openedAt: r.openedAt?.toISOString() ?? null, closedAt: r.closedAt?.toISOString() ?? null, entitlementCount: r._count.entitlements, createdAt: r.createdAt.toISOString() });
export const benefitPeriodService = {
  async list(q: { planId?: string; status?: string }): Promise<BenefitPeriodDto[]> { return (await prisma.benefitPeriod.findMany({ where: { planId: q.planId, status: q.status }, include: periodInclude, orderBy: [{ periodStart: 'desc' }] })).map(periodDto); },
  async get(id: string): Promise<BenefitPeriodDto> { const r = await prisma.benefitPeriod.findUnique({ where: { id }, include: periodInclude }); if (!r) throw notFound('benefit period'); return periodDto(r); },
  async create(input: CreateBenefitPeriodInput, actor: Actor): Promise<BenefitPeriodDto> {
    const row = await prisma.$transaction(async (tx) => {
      const plan = await tx.benefitPlan.findUnique({ where: { id: input.planId } }); if (!plan) throw notFound('benefit plan');
      if (plan.planType === 'COVERAGE_ONLY') throw new AppError(409, 'BENEFIT_PLAN_NOT_MONETARY', 'A coverage-only plan has no entitlement periods');
      const overlap = await tx.benefitPeriod.findFirst({ where: { planId: plan.id, status: { not: 'CLOSED' }, periodStart: { lte: input.periodEnd }, periodEnd: { gte: input.periodStart } } });
      if (overlap) throw new AppError(409, 'BENEFIT_PERIOD_OVERLAP', `Overlaps ${overlap.name}`);
      const created = await tx.benefitPeriod.create({ data: { planId: plan.id, name: input.name, periodStart: input.periodStart, periodEnd: input.periodEnd, entitlementAmountSnapshot: input.entitlementAmount ? dec(input.entitlementAmount) : plan.defaultEntitlementAmount, createdByUserId: actor.auth.userId }, include: periodInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CREATE_BENEFIT_PERIOD, 'BenefitPeriod', created.id, { planId: plan.id, periodStart: created.periodStart, periodEnd: created.periodEnd, entitlementAmount: created.entitlementAmountSnapshot ? toMoneyString(created.entitlementAmountSnapshot) : null }), tx);
      return created;
    });
    return periodDto(row);
  },
  async update(id: string, input: UpdateBenefitPeriodInput, actor: Actor): Promise<BenefitPeriodDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_periods', id);
      const before = await tx.benefitPeriod.findUnique({ where: { id }, include: periodInclude }); if (!before) throw notFound('benefit period');
      if (before.status !== 'DRAFT') throw new AppError(409, 'BENEFIT_PERIOD_NOT_DRAFT', 'Only a draft period can be edited; an open period is frozen');
      const after = await tx.benefitPeriod.update({ where: { id }, data: { name: input.name, periodStart: input.periodStart, periodEnd: input.periodEnd, entitlementAmountSnapshot: moneyOrNull(input.entitlementAmount) }, include: periodInclude });
      if (after.periodEnd < after.periodStart) throw new AppError(422, 'VALIDATION_ERROR', 'Period end must not be before period start', [{ field: 'periodEnd', message: 'Before start' }]);
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CREATE_BENEFIT_PERIOD, 'BenefitPeriod', id, { fields: Object.keys(input), entitlementAmount: after.entitlementAmountSnapshot ? toMoneyString(after.entitlementAmountSnapshot) : null, edited: true }), tx);
      return after;
    });
    return periodDto(row);
  },
  /** OPEN freezes the money rules (currency, entitlement, per-claim maximum, document requirement) as they stand on the plan now. */
  async open(id: string, actor: Actor): Promise<BenefitPeriodDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_periods', id);
      const p = await tx.benefitPeriod.findUnique({ where: { id }, include: { plan: true } }); if (!p) throw notFound('benefit period');
      if (p.status !== 'DRAFT') throw new AppError(409, 'BENEFIT_PERIOD_NOT_DRAFT', `This period is ${p.status.toLowerCase()}`);
      if (p.plan.status !== 'ACTIVE') throw new AppError(409, 'BENEFIT_PLAN_NOT_ACTIVE', 'Activate the plan before opening a period');
      if (!p.plan.currency) throw new AppError(409, 'BENEFIT_PLAN_NO_CURRENCY', 'The plan has no currency');
      const after = await tx.benefitPeriod.update({ where: { id }, data: { status: 'OPEN', openedAt: new Date(), currencySnapshot: p.plan.currency, perClaimMaximumSnapshot: p.plan.perClaimMaximum, requiresDocumentSnapshot: p.plan.requiresDocument, entitlementAmountSnapshot: p.entitlementAmountSnapshot ?? p.plan.defaultEntitlementAmount }, include: periodInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.OPEN_BENEFIT_PERIOD, 'BenefitPeriod', id, { currency: after.currencySnapshot, entitlementAmount: after.entitlementAmountSnapshot ? toMoneyString(after.entitlementAmountSnapshot) : null, perClaimMaximum: after.perClaimMaximumSnapshot ? toMoneyString(after.perClaimMaximumSnapshot) : null, requiresDocument: after.requiresDocumentSnapshot }), tx);
      return after;
    });
    return periodDto(row);
  },
  /** CLOSED: no new claims. Pending claims keep going; balances stay readable. */
  async close(id: string, actor: Actor): Promise<BenefitPeriodDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'benefit_periods', id);
      const p = await tx.benefitPeriod.findUnique({ where: { id } }); if (!p) throw notFound('benefit period');
      if (p.status !== 'OPEN') throw new AppError(409, 'BENEFIT_PERIOD_NOT_OPEN', `This period is ${p.status.toLowerCase()}`);
      const after = await tx.benefitPeriod.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() }, include: periodInclude });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.CLOSE_BENEFIT_PERIOD, 'BenefitPeriod', id, { pendingClaims: await tx.benefitClaim.count({ where: { periodId: id, status: 'PENDING_APPROVAL' } }) }), tx);
      return after;
    });
    return periodDto(row);
  },
};
