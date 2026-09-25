import { AUDIT_ACTIONS, tenureMonths, type EligibilityOverrideDto, type EligibilityPreviewDto, type EligibilityResultDto, type SetEligibilityOverrideInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { type Actor, type Db, type EmployeeRow, benefitsAudit, employeeInclude, notFound, textAudit, today, userNames } from './benefits.types';

/**
 * Deterministic eligibility from allow-listed employee-master facts. The rule vocabulary has no field for a protected
 * attribute, so none can be configured. Eligible means "meets the plan's criteria" — never "enrolled", "paid" or "approved".
 */
type Rule = { ruleType: string; value: string };
type Override = { mode: string; reasonCode: string } | null;
const RULE_LABEL: Record<string, string> = { ORGANIZATION: 'organization', DEPARTMENT: 'department', JOB: 'job', POSITION: 'position', EMPLOYMENT_TYPE: 'employment type', EMPLOYMENT_STATUS: 'employment status', MIN_TENURE_MONTHS: 'minimum tenure (months)' };

export function evaluateRules(e: EmployeeRow, rules: Rule[], override: Override, asOfDate: string): EligibilityResultDto {
  const reasons: { code: string; message: string }[] = []; const matched: string[] = [];
  if (override) {
    return override.mode === 'INCLUDE'
      ? { eligible: true, reasons: [{ code: 'OVERRIDE_INCLUDE', message: 'Included by an explicit HR decision' }], matchedRules: [], override: { mode: 'INCLUDE', reasonCode: override.reasonCode }, asOfDate }
      : { eligible: false, reasons: [{ code: 'OVERRIDE_EXCLUDE', message: 'Excluded by an explicit HR decision' }], matchedRules: [], override: { mode: 'EXCLUDE', reasonCode: override.reasonCode }, asOfDate };
  }
  const groups = new Map<string, string[]>();
  for (const r of rules) groups.set(r.ruleType, [...(groups.get(r.ruleType) ?? []), r.value]);
  const hire = e.hireDate.toISOString().slice(0, 10);
  for (const [type, values] of groups) {
    let ok = false;
    switch (type) {
      case 'ORGANIZATION': ok = values.includes(e.organizationId); break;
      case 'DEPARTMENT': ok = values.includes(e.departmentId); break;
      case 'JOB': ok = !!e.position?.jobId && values.includes(e.position.jobId); break;
      case 'POSITION': ok = !!e.positionId && values.includes(e.positionId); break;
      case 'EMPLOYMENT_TYPE': ok = values.includes(e.employmentType); break;
      case 'EMPLOYMENT_STATUS': ok = values.includes(e.employmentStatus); break;
      case 'MIN_TENURE_MONTHS': ok = values.some((v) => tenureMonths(hire, asOfDate) >= Number(v)); break;
    }
    if (ok) matched.push(type); else reasons.push({ code: `RULE_${type}`, message: `Does not meet the ${RULE_LABEL[type] ?? type.toLowerCase()} criteria` });
  }
  if (!groups.has('EMPLOYMENT_STATUS') && e.employmentStatus !== 'ACTIVE') reasons.push({ code: 'NOT_ACTIVE', message: 'Not an active employee' });
  return { eligible: reasons.length === 0, reasons, matchedRules: matched, override: null, asOfDate };
}

export async function activeOverride(db: Db, planId: string, employeeId: string): Promise<Override> {
  const o = await db.benefitEligibilityOverride.findFirst({ where: { planId, employeeId, supersededAt: null }, orderBy: { createdAt: 'desc' }, select: { mode: true, reasonCode: true } });
  return o ?? null;
}

export const eligibilityService = {
  async evaluate(db: Db, employeeId: string, planId: string, asOfDate = today()): Promise<EligibilityResultDto> {
    const [plan, employee, override] = await Promise.all([db.benefitPlan.findUnique({ where: { id: planId }, include: { rules: true } }), db.employee.findUnique({ where: { id: employeeId }, include: employeeInclude }), activeOverride(db, planId, employeeId)]);
    if (!plan) throw notFound('benefit plan');
    if (!employee) throw notFound('employee');
    return evaluateRules(employee, plan.rules, override, asOfDate);
  },
  /** Counts (and, when asked and authorized, the list). Creates nothing. */
  async preview(planId: string, q: { asOfDate?: string; includeEmployees?: boolean }): Promise<EligibilityPreviewDto> {
    const plan = await prisma.benefitPlan.findUnique({ where: { id: planId }, include: { rules: true, overrides: { where: { supersededAt: null } } } });
    if (!plan) throw notFound('benefit plan');
    const asOfDate = q.asOfDate ?? today();
    const employees = await prisma.employee.findMany({ where: { employmentStatus: 'ACTIVE', ...(plan.organizationId ? { organizationId: plan.organizationId } : {}) }, include: employeeInclude, orderBy: { employeeCode: 'asc' } });
    const overrides = new Map(plan.overrides.map((o) => [o.employeeId, { mode: o.mode, reasonCode: o.reasonCode }]));
    const rows = employees.map((e) => ({ e, r: evaluateRules(e, plan.rules, overrides.get(e.id) ?? null, asOfDate) }));
    const eligible = rows.filter((x) => x.r.eligible).length;
    return { planId, asOfDate, eligible, ineligible: rows.length - eligible, ...(q.includeEmployees ? { employees: rows.map((x) => ({ employeeId: x.e.id, employeeCode: x.e.employeeCode, name: `${x.e.firstName} ${x.e.lastName}`, department: x.e.department.name, eligible: x.r.eligible, reasons: x.r.reasons.map((y) => y.message) })) } : {}) };
  },
  async overrides(planId: string): Promise<EligibilityOverrideDto[]> {
    const rows = await prisma.benefitEligibilityOverride.findMany({ where: { planId }, orderBy: { createdAt: 'desc' } });
    const [names, emps] = await Promise.all([userNames(prisma, rows.map((r) => r.createdByUserId)), prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, employeeCode: true, firstName: true, lastName: true } })]);
    const em = new Map(emps.map((e) => [e.id, e]));
    return rows.map((r) => ({ id: r.id, employeeId: r.employeeId, employeeCode: em.get(r.employeeId)?.employeeCode ?? '?', employeeName: em.get(r.employeeId) ? `${em.get(r.employeeId)!.firstName} ${em.get(r.employeeId)!.lastName}` : '?', mode: r.mode as EligibilityOverrideDto['mode'], reasonCode: r.reasonCode, note: r.note, supersededAt: r.supersededAt?.toISOString() ?? null, createdByName: names.get(r.createdByUserId) ?? null, createdAt: r.createdAt.toISOString() }));
  },
  /** A manual decision. The previous override is superseded, never edited or deleted. */
  async setOverride(planId: string, input: SetEligibilityOverrideInput, actor: Actor): Promise<EligibilityOverrideDto[]> {
    await prisma.$transaction(async (tx) => {
      const plan = await tx.benefitPlan.findUnique({ where: { id: planId }, select: { id: true } }); if (!plan) throw notFound('benefit plan');
      const emp = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } }); if (!emp) throw notFound('employee');
      await tx.benefitEligibilityOverride.updateMany({ where: { planId, employeeId: input.employeeId, supersededAt: null }, data: { supersededAt: new Date() } });
      const row = await tx.benefitEligibilityOverride.create({ data: { planId, employeeId: input.employeeId, mode: input.mode, reasonCode: input.reasonCode, note: input.note ?? null, createdByUserId: actor.auth.userId } });
      await auditService.log(benefitsAudit(actor, AUDIT_ACTIONS.SET_BENEFIT_ELIGIBILITY_OVERRIDE, 'BenefitEligibilityOverride', row.id, { planId, employeeId: input.employeeId, mode: input.mode, reasonCode: input.reasonCode, ...textAudit('note', null, input.note ?? null) }), tx);
    });
    return this.overrides(planId);
  },
};
