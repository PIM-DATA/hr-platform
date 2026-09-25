import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, EXPENSE_RULE_SPECIFICITY, type CreateExpenseCategoryInput, type CreateExpensePolicyInput, type CreateTravelPolicyInput, type ExpenseApplicabilityDto, type ExpenseCategoryDto, type ExpensePolicyDto, type ExpensePolicyRuleDto, type TravelPolicyDto, type UpdateExpenseCategoryInput, type UpdateExpensePolicyInput, type UpdateTravelPolicyInput } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { workflowDefinitionsService } from '../../services/workflow';
import { dec, toMoneyString } from '../payroll/money';
import { type Actor, type Db, type EmployeeRow, expenseAudit, lockRow, notFound, textAudit } from './expense.types';

const m = (v: Prisma.Decimal | null | undefined) => (v ? toMoneyString(v) : null);
const moneyOrNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : dec(v));

// ---------- categories ----------
const catDto = (c: { id: string; code: string; name: string; description: string | null; type: string; isActive: boolean }): ExpenseCategoryDto => ({ id: c.id, code: c.code, name: c.name, description: c.description, type: c.type as ExpenseCategoryDto['type'], isActive: c.isActive });
export const expenseCategoryService = {
  async list(includeInactive = false): Promise<ExpenseCategoryDto[]> { return (await prisma.expenseCategory.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' } })).map(catDto); },
  async create(input: CreateExpenseCategoryInput, actor: Actor): Promise<ExpenseCategoryDto> {
    return prisma.$transaction(async (tx) => {
      if (await tx.expenseCategory.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'EXPENSE_CATEGORY_CODE_EXISTS', 'A category with that code exists');
      const c = await tx.expenseCategory.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, type: input.type ?? 'GENERAL' } });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CREATE_EXPENSE_CATEGORY, 'ExpenseCategory', c.id, { code: c.code, name: c.name, type: c.type }), tx);
      return catDto(c);
    });
  },
  async update(id: string, input: UpdateExpenseCategoryInput, actor: Actor): Promise<ExpenseCategoryDto> {
    return prisma.$transaction(async (tx) => {
      const before = await tx.expenseCategory.findUnique({ where: { id } }); if (!before) throw notFound('expense category');
      const c = await tx.expenseCategory.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, type: input.type, isActive: input.isActive } });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_EXPENSE_CATEGORY, 'ExpenseCategory', id, { name: c.name, type: c.type, isActive: c.isActive }, { name: before.name, type: before.type, isActive: before.isActive }), tx);
      return catDto(c);
    });
  },
};

// ---------- expense policies ----------
const policyInclude = { rules: { include: { category: { select: { code: true, name: true } } } }, applicability: true, _count: { select: { reports: true } } } as const;
type PolicyRow = Prisma.ExpensePolicyGetPayload<{ include: typeof policyInclude }>;
async function labels(db: Db, rules: { id: string; ruleType: string; value: string }[]): Promise<ExpenseApplicabilityDto[]> {
  const ids = (t: string) => rules.filter((r) => r.ruleType === t).map((r) => r.value);
  const [orgs, depts, jobs, positions] = await Promise.all([
    ids('ORGANIZATION').length ? db.organization.findMany({ where: { id: { in: ids('ORGANIZATION') } }, select: { id: true, name: true } }) : [],
    ids('DEPARTMENT').length ? db.department.findMany({ where: { id: { in: ids('DEPARTMENT') } }, select: { id: true, name: true } }) : [],
    ids('JOB').length ? db.job.findMany({ where: { id: { in: ids('JOB') } }, select: { id: true, title: true } }) : [],
    ids('POSITION').length ? db.position.findMany({ where: { id: { in: ids('POSITION') } }, select: { id: true, title: true } }) : [],
  ]);
  const name = new Map<string, string>([...orgs.map((x) => [x.id, x.name] as const), ...depts.map((x) => [x.id, x.name] as const), ...jobs.map((x) => [x.id, x.title] as const), ...positions.map((x) => [x.id, x.title] as const)]);
  return rules.map((r) => ({ id: r.id, ruleType: r.ruleType as ExpenseApplicabilityDto['ruleType'], value: r.value, label: name.get(r.value) ?? r.value }));
}
const ruleDto = (r: PolicyRow['rules'][number]): ExpensePolicyRuleDto => ({ id: r.id, categoryId: r.categoryId, categoryCode: r.category.code, categoryName: r.category.name, requiresReceipt: r.requiresReceipt, receiptRequiredAbove: m(r.receiptRequiredAbove), perItemMaximum: m(r.perItemMaximum), maximumAgeDays: r.maximumAgeDays, allowedForTravelOnly: r.allowedForTravelOnly, descriptionRequired: r.descriptionRequired });
export async function policyDto(db: Db, p: PolicyRow): Promise<ExpensePolicyDto> {
  const org = p.organizationId ? await db.organization.findUnique({ where: { id: p.organizationId }, select: { name: true } }) : null;
  return { id: p.id, code: p.code, name: p.name, description: p.description, organizationId: p.organizationId, organizationName: org?.name ?? null, currency: p.currency, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, workflowCode: p.workflowCode, maximumReportAmount: m(p.maximumReportAmount), status: p.status as ExpensePolicyDto['status'], rules: p.rules.map(ruleDto), applicability: await labels(db, p.applicability), reportCount: p._count.reports, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() };
}
async function validateRefs(tx: Db, input: { organizationId?: string | null; workflowCode?: string; entityType: 'EXPENSE_REPORT' | 'TRAVEL_REQUEST'; rules?: { categoryId: string }[]; applicability?: { ruleType: string; value: string }[] }) {
  if (input.organizationId && !(await tx.organization.findUnique({ where: { id: input.organizationId } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
  if (input.workflowCode) {
    const def = await workflowDefinitionsService.getActive(tx as Prisma.TransactionClient, input.workflowCode).catch(() => null);
    if (!def || def.module !== 'expense' || def.entityType !== input.entityType) throw new AppError(422, 'VALIDATION_ERROR', `The workflow must be an active definition for expense / ${input.entityType}`, [{ field: 'workflowCode', message: 'Unknown or wrong workflow definition' }]);
  }
  const seen = new Set<string>();
  for (const r of input.rules ?? []) {
    if (seen.has(r.categoryId)) throw new AppError(422, 'VALIDATION_ERROR', 'A category may appear once per policy', [{ field: 'rules', message: 'Duplicate category' }]);
    seen.add(r.categoryId);
    if (!(await tx.expenseCategory.findFirst({ where: { id: r.categoryId, isActive: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive category', [{ field: 'rules', message: `Unknown category ${r.categoryId}` }]);
  }
  for (const a of input.applicability ?? []) {
    const ok = a.ruleType === 'ORGANIZATION' ? !!(await tx.organization.findUnique({ where: { id: a.value } })) : a.ruleType === 'DEPARTMENT' ? !!(await tx.department.findUnique({ where: { id: a.value } })) : a.ruleType === 'JOB' ? !!(await tx.job.findUnique({ where: { id: a.value } })) : a.ruleType === 'POSITION' ? !!(await tx.position.findUnique({ where: { id: a.value } })) : /^[A-Z_]{2,40}$/.test(a.value);
    if (!ok) throw new AppError(422, 'VALIDATION_ERROR', `Invalid ${a.ruleType} value`, [{ field: 'applicability', message: `Invalid value for ${a.ruleType}` }]);
  }
}
const ruleData = (r: CreateExpensePolicyInput['rules'] extends (infer T)[] | undefined ? T : never) => ({ categoryId: r.categoryId, requiresReceipt: r.requiresReceipt ?? false, receiptRequiredAbove: r.receiptRequiredAbove ? dec(r.receiptRequiredAbove) : null, perItemMaximum: r.perItemMaximum ? dec(r.perItemMaximum) : null, maximumAgeDays: r.maximumAgeDays ?? null, allowedForTravelOnly: r.allowedForTravelOnly ?? false, descriptionRequired: r.descriptionRequired ?? false });

export const expensePolicyService = {
  async list(q: { status?: string; includeInactive?: boolean }): Promise<ExpensePolicyDto[]> {
    const rows = await prisma.expensePolicy.findMany({ where: { status: q.status ?? (q.includeInactive ? undefined : { in: ['DRAFT', 'ACTIVE'] }) }, include: policyInclude, orderBy: [{ status: 'asc' }, { name: 'asc' }] });
    return Promise.all(rows.map((r) => policyDto(prisma, r)));
  },
  async get(id: string): Promise<ExpensePolicyDto> { const r = await prisma.expensePolicy.findUnique({ where: { id }, include: policyInclude }); if (!r) throw notFound('expense policy'); return policyDto(prisma, r); },
  async create(input: CreateExpensePolicyInput, actor: Actor): Promise<ExpensePolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (await tx.expensePolicy.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'EXPENSE_POLICY_CODE_EXISTS', 'A policy with that code exists');
      await validateRefs(tx, { ...input, entityType: 'EXPENSE_REPORT' });
      const created = await tx.expensePolicy.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, currency: input.currency, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, workflowCode: input.workflowCode, maximumReportAmount: input.maximumReportAmount ? dec(input.maximumReportAmount) : null, createdByUserId: actor.auth.userId, rules: { create: (input.rules ?? []).map(ruleData) }, applicability: { create: (input.applicability ?? []).map((a) => ({ ruleType: a.ruleType, value: a.value })) } }, include: policyInclude });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CREATE_EXPENSE_POLICY, 'ExpensePolicy', created.id, { code: created.code, currency: created.currency, workflowCode: created.workflowCode, rules: created.rules.length, applicability: created.applicability.length, maximumReportAmount: m(created.maximumReportAmount) }), tx);
      return created;
    });
    return policyDto(prisma, row);
  },
  /** Edits change nothing in submitted reports: they carry their own snapshots of the limits that judged them. */
  async update(id: string, input: UpdateExpensePolicyInput, actor: Actor): Promise<ExpensePolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'expense_policies', id);
      const before = await tx.expensePolicy.findUnique({ where: { id }, include: policyInclude }); if (!before) throw notFound('expense policy');
      if (before.status === 'ARCHIVED') throw new AppError(409, 'EXPENSE_POLICY_ARCHIVED', 'An archived policy is history');
      await validateRefs(tx, { ...input, entityType: 'EXPENSE_REPORT' });
      if (input.rules) await tx.expensePolicyRule.deleteMany({ where: { policyId: id } });
      if (input.applicability) await tx.expensePolicyApplicability.deleteMany({ where: { policyId: id } });
      const after = await tx.expensePolicy.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, organizationId: input.organizationId === undefined ? undefined : input.organizationId, currency: input.currency, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo, workflowCode: input.workflowCode, maximumReportAmount: moneyOrNull(input.maximumReportAmount), status: input.status, ...(input.rules ? { rules: { create: input.rules.map(ruleData) } } : {}), ...(input.applicability ? { applicability: { create: input.applicability.map((a) => ({ ruleType: a.ruleType, value: a.value })) } } : {}) }, include: policyInclude });
      const action = input.status === 'ACTIVE' && before.status !== 'ACTIVE' ? AUDIT_ACTIONS.ACTIVATE_EXPENSE_POLICY : AUDIT_ACTIONS.UPDATE_EXPENSE_POLICY;
      await auditService.log(expenseAudit(actor, action, 'ExpensePolicy', id, { fields: Object.keys(input), status: after.status, currency: after.currency, rules: after.rules.length, applicability: after.applicability.length, maximumReportAmount: m(after.maximumReportAmount), ...textAudit('description', before.description, after.description) }, { status: before.status, currency: before.currency }), tx);
      return after;
    });
    return policyDto(prisma, row);
  },
  /**
   * The policies that apply to one employee on one date, most specific first. Specificity is the highest rule type the
   * policy carries (POSITION > JOB > DEPARTMENT > ORGANIZATION > EMPLOYMENT_TYPE / STATUS > none). Two applicable policies
   * at the same specificity are an ambiguous configuration: the resolver reports it and the default is refused.
   */
  async applicable(db: Db, employee: EmployeeRow, asOf: string): Promise<{ policies: PolicyRow[]; ambiguous: boolean }> {
    const rows = await db.expensePolicy.findMany({ where: { status: 'ACTIVE', effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }], AND: [{ OR: [{ organizationId: null }, { organizationId: employee.organizationId }] }] }, include: policyInclude });
    const matches = rows.filter((p) => matchesApplicability(employee, p.applicability));
    const spec = (p: PolicyRow) => Math.max(0, ...p.applicability.map((a) => EXPENSE_RULE_SPECIFICITY[a.ruleType as keyof typeof EXPENSE_RULE_SPECIFICITY] ?? 0));
    matches.sort((a, b) => spec(b) - spec(a) || a.code.localeCompare(b.code));
    const ambiguous = matches.length > 1 && spec(matches[0]) === spec(matches[1]);
    return { policies: matches, ambiguous };
  },
};
export function matchesApplicability(e: EmployeeRow, rules: { ruleType: string; value: string }[]): boolean {
  const groups = new Map<string, string[]>();
  for (const r of rules) groups.set(r.ruleType, [...(groups.get(r.ruleType) ?? []), r.value]);
  for (const [type, values] of groups) {
    const ok = type === 'ORGANIZATION' ? values.includes(e.organizationId) : type === 'DEPARTMENT' ? values.includes(e.departmentId) : type === 'JOB' ? !!e.position?.jobId && values.includes(e.position.jobId) : type === 'POSITION' ? !!e.positionId && values.includes(e.positionId) : type === 'EMPLOYMENT_TYPE' ? values.includes(e.employmentType) : type === 'EMPLOYMENT_STATUS' ? values.includes(e.employmentStatus) : false;
    if (!ok) return false;
  }
  return true;
}
export type { PolicyRow };

// ---------- travel policies ----------
const travelInclude = { expensePolicy: { select: { name: true } }, _count: { select: { requests: true } } } as const;
type TravelPolicyRow = Prisma.TravelPolicyGetPayload<{ include: typeof travelInclude }>;
async function travelDto(db: Db, p: TravelPolicyRow): Promise<TravelPolicyDto> {
  const org = p.organizationId ? await db.organization.findUnique({ where: { id: p.organizationId }, select: { name: true } }) : null;
  return { id: p.id, code: p.code, name: p.name, description: p.description, organizationId: p.organizationId, organizationName: org?.name ?? null, currency: p.currency, workflowCode: p.workflowCode, expensePolicyId: p.expensePolicyId, expensePolicyName: p.expensePolicy?.name ?? null, maximumEstimatedAmount: m(p.maximumEstimatedAmount), status: p.status as TravelPolicyDto['status'], effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, requestCount: p._count.requests };
}
export const travelPolicyService = {
  async list(q: { includeInactive?: boolean }): Promise<TravelPolicyDto[]> { return Promise.all((await prisma.travelPolicy.findMany({ where: q.includeInactive ? {} : { status: { in: ['DRAFT', 'ACTIVE'] } }, include: travelInclude, orderBy: { name: 'asc' } })).map((r) => travelDto(prisma, r))); },
  async create(input: CreateTravelPolicyInput, actor: Actor): Promise<TravelPolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (await tx.travelPolicy.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'TRAVEL_POLICY_CODE_EXISTS', 'A travel policy with that code exists');
      await validateRefs(tx, { organizationId: input.organizationId, workflowCode: input.workflowCode, entityType: 'TRAVEL_REQUEST' });
      if (input.expensePolicyId && !(await tx.expensePolicy.findUnique({ where: { id: input.expensePolicyId } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown expense policy', [{ field: 'expensePolicyId', message: 'Unknown expense policy' }]);
      const created = await tx.travelPolicy.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, currency: input.currency, workflowCode: input.workflowCode, expensePolicyId: input.expensePolicyId ?? null, maximumEstimatedAmount: input.maximumEstimatedAmount ? dec(input.maximumEstimatedAmount) : null, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, createdByUserId: actor.auth.userId }, include: travelInclude });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.CREATE_TRAVEL_POLICY, 'TravelPolicy', created.id, { code: created.code, currency: created.currency, workflowCode: created.workflowCode, maximumEstimatedAmount: m(created.maximumEstimatedAmount) }), tx);
      return created;
    });
    return travelDto(prisma, row);
  },
  async update(id: string, input: UpdateTravelPolicyInput, actor: Actor): Promise<TravelPolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.travelPolicy.findUnique({ where: { id } }); if (!before) throw notFound('travel policy');
      await validateRefs(tx, { organizationId: input.organizationId, workflowCode: input.workflowCode, entityType: 'TRAVEL_REQUEST' });
      if (input.expensePolicyId && !(await tx.expensePolicy.findUnique({ where: { id: input.expensePolicyId } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown expense policy', [{ field: 'expensePolicyId', message: 'Unknown expense policy' }]);
      const after = await tx.travelPolicy.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, organizationId: input.organizationId === undefined ? undefined : input.organizationId, currency: input.currency, workflowCode: input.workflowCode, expensePolicyId: input.expensePolicyId === undefined ? undefined : input.expensePolicyId, maximumEstimatedAmount: moneyOrNull(input.maximumEstimatedAmount), effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo === undefined ? undefined : input.effectiveTo, status: input.status }, include: travelInclude });
      await auditService.log(expenseAudit(actor, AUDIT_ACTIONS.UPDATE_TRAVEL_POLICY, 'TravelPolicy', id, { fields: Object.keys(input), status: after.status }, { status: before.status }), tx);
      return after;
    });
    return travelDto(prisma, row);
  },
};
