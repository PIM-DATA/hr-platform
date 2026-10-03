import { CERTIFICATION_EXPIRY_WINDOW_DAYS, certificationStatus, type LearningDashboardDto, type LearningReportDto } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import type { AuthContext } from '../auth/auth.types';
import { scopedEmployeeIds } from './learning.types';
import { businessRange, employeeTodays, referenceToday, referenceZone } from '../../services/business-time/business-time';

/**
 * Learning reporting: counts by department, program, path and certification. Nothing here names a person or
 * repeats a comment. Definitions are stated in the payload so a dashboard number is never a mystery.
 */
const DEFINITIONS = {
  openNeeds: 'Training needs in OPEN, PLANNED or IN_PROGRESS (Task 25).',
  completedEnrollments: 'Enrolments recorded COMPLETED in the last 90 days (Task 25).',
  ojtActive: 'OJT plans in ACTIVE status.', ojtCompleted: 'OJT plans completed in the last 90 days.', awaitingAssessment: 'Active OJT plans whose required activities are all done and that have no final assessment yet.',
  activitiesNeedingObservation: 'Open activities on active plans with at least one required criterion not yet observed as MEETS by the assigned trainer.',
  pathsActive: 'Learning path assignments in ACTIVE status.', pathProgress: 'Average of fulfilled steps ÷ steps over active assignments.',
  certActive: 'Certifications not revoked, with no expiry or an expiry after the window.', expiringSoon: 'Certifications whose expiry falls within the definition\'s window (default 30 days).', expired: 'Certifications past their expiry date and not revoked.',
};
/**
 * A certification row has no organization snapshot (Task 35), and this report already attributes certifications to
 * the employee's *current* department — so the organization filter uses the employee's current organization too.
 * OJT plans and path assignments keep their own organization snapshots. The id list comes from one indexed query
 * on the employee master: no page cap, no first-N.
 */
export async function certOrganizationWhere(organizationId: string | undefined): Promise<Prisma.EmployeeCertificationWhereInput> {
  if (!organizationId) return {};
  const ids = (await prisma.employee.findMany({ where: { organizationId }, select: { id: true } })).map((e) => e.id);
  return { employeeId: { in: ids } };
}
async function scope(auth: AuthContext) { const ids = await scopedEmployeeIds(auth); return ids === null ? {} : { employeeId: { in: ids } }; }

export const learningReportService = {
  async dashboard(auth: AuthContext): Promise<LearningDashboardDto> {
    const s = await scope(auth); const ago90 = new Date(Date.now() - 90 * 86_400_000);
    const [openNeeds, completedEnrollments, upcoming, activeIdps, ojtActiveRows, ojtCompleted, paths, certs] = await Promise.all([
      prisma.trainingNeed.count({ where: { ...s, status: { in: ['OPEN', 'PLANNED', 'IN_PROGRESS'] } } }),
      prisma.trainingEnrollment.count({ where: { ...s, status: 'COMPLETED', updatedAt: { gte: ago90 } } }),
      prisma.trainingEnrollment.count({ where: { ...s, status: 'ENROLLED', session: { startAt: { gte: new Date() } } } }),
      prisma.individualDevelopmentPlan.count({ where: { ...s, status: 'ACTIVE' } }),
      prisma.ojtPlan.findMany({ where: { ...s, status: 'ACTIVE' }, select: { trainerUserId: true, activities: { select: { status: true, required: true, criteria: { select: { id: true, required: true } }, observations: { select: { criterionId: true, observerUserId: true, result: true } } } }, assessments: { select: { id: true } } } }),
      prisma.ojtPlan.count({ where: { ...s, status: 'COMPLETED', completedAt: { gte: ago90 } } }),
      prisma.learningPathAssignment.findMany({ where: { ...s, OR: [{ status: 'ACTIVE' }, { status: 'COMPLETED', completedAt: { gte: ago90 } }] }, select: { status: true, steps: { select: { fulfilledAt: true } } } }),
      prisma.employeeCertification.findMany({ where: s, select: { employeeId: true, expiryDate: true, revokedAt: true, definition: { select: { expiryWindowDays: true } } } }),
    ]);
    const awaiting = ojtActiveRows.filter((p) => p.activities.filter((a) => a.required).every((a) => a.status === 'COMPLETED' || a.status === 'SKIPPED') && p.assessments.length === 0).length;
    const needObs = ojtActiveRows.reduce((n, p) => n + p.activities.filter((a) => (a.status === 'PENDING' || a.status === 'IN_PROGRESS') && a.criteria.some((c) => c.required && !a.observations.some((o) => o.criterionId === c.id && o.observerUserId === p.trainerUserId && o.result === 'MEETS'))).length, 0);
    const activePaths = paths.filter((p) => p.status === 'ACTIVE');
    const pcts = activePaths.map((p) => (p.steps.length ? (p.steps.filter((x) => x.fulfilledAt).length / p.steps.length) * 100 : 0));
    const certTodays = await employeeTodays(prisma, certs.map((c) => c.employeeId)); // Task 53: each holder's own today
    const statuses = certs.map((c) => certificationStatus({ expiryDate: c.expiryDate, revokedAt: c.revokedAt }, certTodays.get(c.employeeId)!, c.definition.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS));
    return {
      training: { openNeeds, completedEnrollmentsLast90Days: completedEnrollments, upcomingSessions: upcoming, activeIdps },
      ojt: { active: ojtActiveRows.length, completedLast90Days: ojtCompleted, awaitingAssessment: awaiting, activitiesNeedingObservation: needObs },
      paths: { active: activePaths.length, completedLast90Days: paths.filter((p) => p.status === 'COMPLETED').length, avgProgressPct: pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null },
      certifications: { active: statuses.filter((x) => x === 'ACTIVE').length, expiringSoon: statuses.filter((x) => x === 'EXPIRING_SOON').length, expired: statuses.filter((x) => x === 'EXPIRED').length, revoked: statuses.filter((x) => x === 'REVOKED').length },
      definitions: DEFINITIONS, generatedAt: new Date().toISOString(),
    };
  },
  async report(auth: AuthContext, q: { from?: string; to?: string; organizationId?: string }): Promise<LearningReportDto> {
    // Task 53: default range from the filtered (or reference) organization's today; instant filters use its day boundaries.
    const zone = await referenceZone(prisma, q.organizationId);
    const s = await scope(auth); const t = await referenceToday(prisma, q.organizationId); const from = q.from ?? `${t.slice(0, 4)}-01-01`; const to = q.to ?? t;
    const org: Prisma.OjtPlanWhereInput = q.organizationId ? { organizationSnapshot: (await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?' } : {};
    const [plans, asgs, certs] = await Promise.all([
      prisma.ojtPlan.findMany({ where: { ...s, ...org, OR: [{ startDate: { gte: from, lte: to } }, { status: 'ACTIVE' }] }, select: { status: true, startDate: true, completedAt: true, departmentSnapshot: true, programNameSnapshot: true, activities: { select: { status: true } } } }),
      prisma.learningPathAssignment.findMany({ where: { ...s, ...(org as Prisma.LearningPathAssignmentWhereInput), OR: [{ assignedAt: businessRange(from, to, zone) }, { status: 'ACTIVE' }] }, select: { status: true, pathNameSnapshot: true, departmentSnapshot: true, steps: { select: { fulfilledAt: true } } } }),
      prisma.employeeCertification.findMany({ where: { AND: [s, await certOrganizationWhere(q.organizationId)] }, select: { employeeId: true, expiryDate: true, revokedAt: true, definitionNameSnapshot: true, definition: { select: { expiryWindowDays: true } } } }),
    ]);
    const group = <T, K extends string>(rows: T[], key: (r: T) => K) => { const m = new Map<K, T[]>(); for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); } return m; };
    const completedPlans = plans.filter((p) => p.status === 'COMPLETED' && p.completedAt);
    const durations = completedPlans.map((p) => Math.round((p.completedAt!.getTime() - Date.parse(`${p.startDate}T00:00:00Z`)) / 86_400_000)).filter((d) => d >= 0);
    const deptOf = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(certs.map((c) => c.employeeId))] } }, select: { id: true, department: { select: { name: true } } } })).map((e) => [e.id, e.department.name]));
    const certTodays = await employeeTodays(prisma, certs.map((c) => c.employeeId));
    const certRows = certs.map((c) => ({ ...c, st: certificationStatus({ expiryDate: c.expiryDate, revokedAt: c.revokedAt }, certTodays.get(c.employeeId)!, c.definition.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS), department: deptOf.get(c.employeeId) ?? '—' }));
    const count = (rows: { st: string }[], st: string) => rows.filter((x) => x.st === st).length;
    return {
      range: { from, to },
      ojt: { plans: plans.length, completed: completedPlans.length, active: plans.filter((p) => p.status === 'ACTIVE').length, cancelled: plans.filter((p) => p.status === 'CANCELLED').length, avgCompletionDays: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
        byDepartment: [...group(plans, (p) => p.departmentSnapshot ?? '—')].map(([department, rows]) => ({ department, plans: rows.length, completed: rows.filter((p) => p.status === 'COMPLETED').length })).sort((a, b) => a.department.localeCompare(b.department)),
        byProgram: [...group(plans, (p) => p.programNameSnapshot)].map(([program, rows]) => ({ program, plans: rows.length, completed: rows.filter((p) => p.status === 'COMPLETED').length, activities: rows.reduce((n, p) => n + p.activities.length, 0), activitiesCompleted: rows.reduce((n, p) => n + p.activities.filter((a) => a.status === 'COMPLETED').length, 0) })).sort((a, b) => a.program.localeCompare(b.program)) },
      paths: { assigned: asgs.length, inProgress: asgs.filter((a) => a.status === 'ACTIVE').length, completed: asgs.filter((a) => a.status === 'COMPLETED').length,
        byPath: [...group(asgs, (a) => a.pathNameSnapshot)].map(([path, rows]) => { const total = rows.reduce((n, a) => n + a.steps.length, 0); const done = rows.reduce((n, a) => n + a.steps.filter((x) => x.fulfilledAt).length, 0); return { path, assigned: rows.length, completed: rows.filter((a) => a.status === 'COMPLETED').length, stepsFulfilledPct: total ? Math.round((done / total) * 1000) / 10 : null }; }).sort((a, b) => a.path.localeCompare(b.path)),
        byDepartment: [...group(asgs, (a) => a.departmentSnapshot ?? '—')].map(([department, rows]) => ({ department, assigned: rows.length, completed: rows.filter((a) => a.status === 'COMPLETED').length })).sort((a, b) => a.department.localeCompare(b.department)) },
      certifications: { active: count(certRows, 'ACTIVE'), expiringSoon: count(certRows, 'EXPIRING_SOON'), expired: count(certRows, 'EXPIRED'), revoked: count(certRows, 'REVOKED'),
        byDefinition: [...group(certRows, (c) => c.definitionNameSnapshot)].map(([certification, rows]) => ({ certification, active: count(rows, 'ACTIVE'), expiringSoon: count(rows, 'EXPIRING_SOON'), expired: count(rows, 'EXPIRED'), revoked: count(rows, 'REVOKED') })).sort((a, b) => a.certification.localeCompare(b.certification)),
        byDepartment: [...group(certRows, (c) => c.department)].map(([department, rows]) => ({ department, active: count(rows, 'ACTIVE'), expiringSoon: count(rows, 'EXPIRING_SOON'), expired: count(rows, 'EXPIRED') })).sort((a, b) => a.department.localeCompare(b.department)) },
    };
  },
};
