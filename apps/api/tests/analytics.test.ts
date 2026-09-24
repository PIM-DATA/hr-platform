/**
 * Task 29 — Employee 360 and executive analytics.
 *
 * What these tests guard: that the 360 page grants nothing by itself (every section follows its source module's
 * rule, and an unauthorized one is absent from the payload); that salary, disciplinary summaries, potential
 * judgments and recruitment internals never leak to a manager, an executive or the employee; that executive
 * figures equal the source reports they are composed from; that historical attribution stays with the snapshot
 * while headcount follows today; and that a fresh organization returns zeros, not errors.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYTICS_METRICS, monthsSpan } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const A = '/api/v1/analytics';
const RANGE = 'from=2026-01-01&to=2026-12-31';

let hrAdmin: Session, hr: Session, mgr: Session, otherMgr: Session, emp: Session, emp2: Session, exec: Session;
let orgId: string, deptId: string, otherDeptId: string;
const employees: Record<string, string> = {};
let hiredAppId: string;

/** Walks any JSON value and reports keys / string values that would identify a person. */
function personalDataIn(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const forbiddenKeys = /^(employeeId|employeeCode|firstName|lastName|email|fullName|candidateId|candidateNumber|caseNumber|potentialComment|notes|comment|comments)$/;
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (forbiddenKeys.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); }
    else if (typeof v === 'string' && /EMP00\d|Person|@tal|Takes ownership|Needs SQL/.test(v)) hits.push(`${p}="${v}"`);
  };
  walk(value, path);
  return hits;
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A29', name: 'Analytics Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id; otherDeptId = otherDept.id;
  const job = await prisma.job.create({ data: { code: 'ENG', title: 'Engineer', level: 2 } });
  const mgrJob = await prisma.job.create({ data: { code: 'EM', title: 'Engineering Manager', level: 4 } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'ENG1', title: 'Engineer', jobId: job.id } });
  const opsPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OPS1', title: 'Operations Officer', jobId: job.id } });
  const mgrPosition = await prisma.position.create({ data: { departmentId: dept.id, code: 'EM1', title: 'Engineering Manager', jobId: mgrJob.id } });
  const mk = async (code: string, positionId: string, departmentId: string, managerId: string | null, hireDate = '2020-01-01') =>
    (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@a29.local`, hireDate: new Date(`${hireDate}T00:00:00Z`), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE', positionHistory: { create: { positionId, departmentId, startDate: new Date(`${hireDate}T00:00:00Z`) } } } })).id;
  employees.HRADM = await mk('HRADM', opsPosition.id, otherDept.id, null);
  employees.MGR = await mk('MGR', mgrPosition.id, dept.id, null);
  employees.OTHERMGR = await mk('OTHERMGR', opsPosition.id, otherDept.id, null);
  employees.EMP003 = await mk('EMP003', position.id, dept.id, employees.MGR, '2026-02-01');
  employees.EMP004 = await mk('EMP004', position.id, dept.id, employees.MGR);
  employees.EMP005 = await mk('EMP005', opsPosition.id, otherDept.id, employees.OTHERMGR, '2026-03-15');
  await createUser({ email: 'hradmin@a29.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  // The HR role holds payroll.manage by default; this file's HR user is the "HR without payroll" case of the spec.
  await prisma.rolePermission.deleteMany({ where: { role: { code: 'HR' }, permission: { code: 'payroll.manage' } } });
  await createUser({ email: 'hr@a29.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@a29.local', password: PW, role: 'MANAGER', employeeId: employees.MGR });
  await createUser({ email: 'othermgr@a29.local', password: PW, role: 'MANAGER', employeeId: employees.OTHERMGR });
  await createUser({ email: 'emp@a29.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp2@a29.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a29.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgr, otherMgr, emp, emp2, exec] = await Promise.all(['hradmin', 'hr', 'mgr', 'othermgr', 'emp', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@a29.local`, PW)));

  // Performance (Task 23): a CLOSED cycle with a FINALIZED plan for EMP003 at 3.95, snapshotted in Engineering.
  const pc = await prisma.performanceCycle.create({ data: { code: 'P2026', name: 'Performance 2026', organizationId: org.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED', ratingBands: { create: [{ code: 'MEETS', label: 'Meets', minScore: 1, maxScore: 3.79 }, { code: 'EXCEEDS', label: 'Exceeds', minScore: 3.8, maxScore: 5 }] } } });
  await prisma.performancePlan.create({ data: { cycleId: pc.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', departmentId: dept.id, departmentName: 'Engineering', status: 'FINALIZED', finalizedAt: new Date('2026-06-30T00:00:00Z'), weightedScore: 3.95, ratingCode: 'EXCEEDS', ratingLabelSnapshot: 'Exceeds', reviewerEmployeeId: employees.MGR, reviewerNameSnapshot: 'MGR Person', reviewerUserId: mgr.user.id } });
  await prisma.performancePlan.create({ data: { cycleId: pc.id, employeeId: employees.EMP004, employeeCodeSnapshot: 'EMP004', employeeNameSnapshot: 'EMP004 Person', departmentId: dept.id, departmentName: 'Engineering', status: 'ACTIVE', reviewerEmployeeId: employees.MGR, reviewerUserId: mgr.user.id } });
  // Competency (Task 24): SQL required 4 on Engineer, EMP003 assessed 3.
  const scale = await prisma.competencyScale.create({ data: { code: 'STD5', name: 'Five', levels: { create: [1, 2, 3, 4, 5].map((level) => ({ level, label: `L${level}` })) } } });
  const category = await prisma.competencyCategory.create({ data: { code: 'CORE', name: 'Core' } });
  const sql = await prisma.competency.create({ data: { code: 'SQL', name: 'SQL', categoryId: category.id, scaleId: scale.id } });
  await prisma.jobCompetencyRequirement.create({ data: { jobId: job.id, competencyId: sql.id, requiredLevel: 4 } });
  const ccycle = await prisma.competencyAssessmentCycle.create({ data: { code: 'C2026', name: 'Competency 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED' } });
  await prisma.competencyAssessment.create({ data: { cycleId: ccycle.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', status: 'FINALIZED', finalizedAt: new Date('2026-05-01T00:00:00Z'), items: { create: [{ competencyId: sql.id, competencyCodeSnapshot: 'SQL', competencyNameSnapshot: 'SQL', categorySnapshot: 'Core', requiredLevelSnapshot: 4, finalLevel: 3, managerLevel: 3 }] } } });
  // Payroll (Task 22): a CLOSED run with one result for EMP003 — the number that must never leak.
  const period = await prisma.payrollPeriod.create({ data: { organizationId: org.id, year: 2026, month: 3, periodStart: '2026-03-01', periodEnd: '2026-03-31', attendanceFrom: '2026-03-01', attendanceTo: '2026-03-31', currencyCode: 'THB', status: 'CLOSED' } });
  const run = await prisma.payrollRun.create({ data: { periodId: period.id, status: 'CLOSED', closedAt: new Date(), startedByUserId: hrAdmin.user.id, employeeCount: 1, grossTotal: 77777, deductionTotal: 0, netTotal: 77777, currencyCode: 'THB' } });
  await prisma.payrollResult.create({ data: { runId: run.id, employeeId: employees.EMP003, employeeCode: 'EMP003', employeeName: 'EMP003 Person', departmentId: dept.id, departmentName: 'Engineering', baseSalary: 77777, dailyRate: 2592.9, minuteRate: 5.4, grossPay: 77777, totalDeductions: 0, netPay: 77777, currencyCode: 'THB' } });
  // Employee relations (Task 26): an issued written warning for EMP003.
  const actionType = await prisma.disciplinaryActionType.create({ data: { code: 'WW', name: 'Written warning', severityOrder: 2, requiresWarningLetter: false, requiresAcknowledgement: true } });
  const erCase = await prisma.employeeRelationCase.create({ data: { caseNumber: 'ER-2026-000001', employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', incidentDate: '2026-04-01', title: 'Late reports', description: 'Reports were late three weeks running.', status: 'ACTION_ISSUED', createdByUserId: hrAdmin.user.id } });
  await prisma.disciplinaryAction.create({ data: { caseId: erCase.id, actionTypeId: actionType.id, actionTypeCodeSnapshot: 'WW', actionTypeNameSnapshot: 'Written warning', employeeId: employees.EMP003, reason: 'Repeated late reporting.', status: 'ISSUED', issuedDate: '2026-04-10', issuedAt: new Date('2026-04-10T00:00:00Z'), validUntil: '2027-04-10', requiresWarningLetter: false, requiresAcknowledgement: true, createdByUserId: hrAdmin.user.id } });
  // Recruitment (Task 27): EMP003 was hired from an application.
  const req = await prisma.recruitmentRequisition.create({ data: { requisitionNumber: 'REQ-2026-000001', organizationId: org.id, jobId: job.id, requestedOpenings: 1, reason: 'NEW_HEADCOUNT', status: 'APPROVED', createdByUserId: hrAdmin.user.id } });
  const opening = await prisma.recruitmentOpening.create({ data: { openingNumber: 'OPN-2026-000001', requisitionId: req.id, jobId: job.id, titleSnapshot: 'Engineer', openingsCount: 1, status: 'CLOSED', createdByUserId: hrAdmin.user.id } });
  const candidate = await prisma.recruitmentCandidate.create({ data: { candidateNumber: 'CND-2026-000001', firstName: 'EMP003', lastName: 'Person', email: 'cand@example.com', emailNormalized: 'cand@example.com', source: 'REFERRAL', status: 'HIRED', hiredEmployeeId: employees.EMP003, createdByUserId: hrAdmin.user.id } });
  const application = await prisma.recruitmentApplication.create({ data: { applicationNumber: 'APP-2026-000001', candidateId: candidate.id, openingId: opening.id, appliedAt: '2026-01-10', stage: 'HIRED', sourceSnapshot: 'REFERRAL', jobTitleSnapshot: 'Engineer', hiredEmployeeId: employees.EMP003, hiredAt: new Date('2026-02-01T00:00:00Z') } });
  hiredAppId = application.id;
  await prisma.recruitmentInterview.create({ data: { applicationId: application.id, title: 'Round 1', scheduledStart: new Date('2026-01-20T02:00:00Z'), scheduledEnd: new Date('2026-01-20T03:00:00Z'), timezone: 'Asia/Bangkok', status: 'COMPLETED', createdByUserId: hrAdmin.user.id, interviewers: { create: [{ userId: mgr.user.id }] }, feedback: { create: [{ interviewerUserId: mgr.user.id, recommendation: 'PROCEED', strengths: 'Clear thinking on interview' }] } } });
  await prisma.recruitmentOffer.create({ data: { offerNumber: 'OFR-2026-000001', applicationId: application.id, status: 'ACCEPTED', proposedStartDate: '2026-02-01', baseSalaryProposal: 66666, currencyCode: 'THB', createdByUserId: hrAdmin.user.id } });
  // Talent (Task 28): a finalized talent review with a comment, a pool membership and a succession nomination.
  const tc = await prisma.talentReviewCycle.create({ data: { code: 'TR2026', name: 'Talent 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', potentialLevels: [{ code: 'LOW', label: 'Low' }, { code: 'MEDIUM', label: 'Medium' }, { code: 'HIGH', label: 'High' }], status: 'CLOSED', createdByUserId: hrAdmin.user.id } });
  await prisma.talentReview.create({ data: { cycleId: tc.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', departmentNameSnapshot: 'Engineering', performanceBucket: 'HIGH', reviewerEmployeeId: employees.MGR, reviewerUserId: mgr.user.id, potentialLevel: 'HIGH', potentialComment: 'Takes ownership beyond the role.', potentialBucket: 'HIGH', nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL', status: 'FINALIZED', submittedAt: new Date(), finalizedAt: new Date('2026-07-01T00:00:00Z') } });
  const pool = await prisma.talentPool.create({ data: { code: 'LEAD', name: 'Leadership Pipeline' } });
  await prisma.talentPoolMember.create({ data: { poolId: pool.id, employeeId: employees.EMP003, addedByUserId: hrAdmin.user.id } });
  const plan = await prisma.successionPlan.create({ data: { positionId: mgrPosition.id, positionTitleSnapshot: 'Engineering Manager', departmentIdSnapshot: dept.id, departmentNameSnapshot: 'Engineering', jobIdSnapshot: mgrJob.id, criticality: 'CRITICAL', status: 'ACTIVE', createdByUserId: hrAdmin.user.id } });
  await prisma.successionCandidate.create({ data: { planId: plan.id, employeeId: employees.EMP003, readiness: 'DEVELOPING', notes: 'Needs SQL depth.', nominatedByUserId: hrAdmin.user.id } });
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

const open = (s: Session, id: string) => as(s, 'get', `${A}/employee-360/${id}`);
const text = (v: unknown) => JSON.stringify(v);

describe('Employee 360 — who sees what', () => {
  it('the employee sees their own self-service sections and none of the organization’s judgments about them', async () => {
    const r = await open(emp, employees.EMP003);
    expect(err(r)).toBe('200');
    const d = r.body.data;
    expect(d.profile.employeeCode).toBe('EMP003');
    expect(d.sections.employment.timeline[0]).toMatchObject({ type: 'JOINED', date: '2026-02-01' });
    expect(d.sections.leave).not.toBeNull();
    expect(d.sections.attendance).not.toBeNull();
    expect(d.sections.performance.latest).toMatchObject({ weightedScore: '3.95', ratingLabel: 'Exceeds' });
    expect(d.sections.competency.summary.withGap).toBe(1);
    expect(d.sections.development).not.toBeNull();
    expect(d.sections.career).not.toBeNull();
    expect(d.sections.payroll).toMatchObject({ mode: 'SELF' });
    expect(d.sections.employeeRelations).toBeNull();
    expect(d.sections.recruitment).toBeNull();
    expect(d.sections.talent).toBeNull();
    expect(d.visibleSections).not.toEqual(expect.arrayContaining(['employeeRelations', 'recruitment', 'talent']));
    expect(text(d)).not.toMatch(/nineBoxCell|potential|Leadership Pipeline|succession|nominat|Clear thinking|66666|Late reports|Repeated late/i);
  });

  it('an employee cannot open a colleague; an unrelated manager gets 404; a manager opens a direct report', async () => {
    expect(err(await open(emp2, employees.EMP003))).toBe('404 EMPLOYEE_NOT_FOUND');
    expect(err(await open(otherMgr, employees.EMP003))).toBe('404 EMPLOYEE_NOT_FOUND');
    expect(err(await open(mgr, employees.EMP003))).toBe('200');
  });

  it('a manager (TEAM scope) gets team-safe sections only: no payroll, no relations, no recruitment internals, no talent judgment', async () => {
    const d = (await open(mgr, employees.EMP003)).body.data;
    expect(d.sections.leave).not.toBeNull();
    expect(d.sections.attendance).not.toBeNull();
    expect(d.sections.performance.latest.weightedScore).toBe('3.95'); // the manager is the snapshot reviewer
    expect(d.sections.competency).not.toBeNull();
    expect(d.sections.development).not.toBeNull();
    expect(d.sections.payroll).toBeNull();
    expect(d.sections.employeeRelations).toBeNull();
    expect(d.sections.recruitment).toBeNull();
    // talent.view + TEAM: the summary carries the finalized cell, never the comment or the notes.
    expect(d.sections.talent).toMatchObject({ latestTalentReview: { nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL' } });
    expect(text(d)).not.toMatch(/77777|netPay|baseSalary|Takes ownership|Needs SQL|Late reports|Repeated late|Clear thinking|66666|caseNumber/i);
  });

  it('HR without payroll or relations permissions gets the 360 with those sections absent — not hidden', async () => {
    const r = await open(hr, employees.EMP003);
    expect(err(r)).toBe('200');
    const d = r.body.data;
    expect(d.sections.payroll).toBeNull();
    expect(d.sections.performance).not.toBeNull();
    expect(d.sections.employeeRelations).toMatchObject({ activeWarnings: 1, totalIssued: 1 }); // HR holds employee_relations.view
    expect(d.sections.recruitment).toMatchObject({ source: 'REFERRAL', openingTitle: 'Engineer', applicationNumber: 'APP-2026-000001' });
    expect(text(d)).not.toMatch(/77777|salaryHidden|Takes ownership|Needs SQL|Late reports|Repeated late|Clear thinking|66666/i);
    expect(d.sections.talent).toBeNull(); // HR has talent.view but is not the manager and does not manage talent
  });

  it('HR admin with payroll sees closed results; the ER summary is counts and a date; recruitment origin is minimal', async () => {
    const d = (await open(hrAdmin, employees.EMP003)).body.data;
    expect(d.sections.payroll).toMatchObject({ mode: 'ADMIN' });
    expect(d.sections.payroll.payslips[0]).toMatchObject({ periodLabel: '2026-03', netPay: '77777.00' });
    expect(Object.keys(d.sections.employeeRelations).sort()).toEqual(['activeWarnings', 'awaitingAcknowledgement', 'employeeId', 'latestActionDate', 'totalIssued']);
    expect(Object.keys(d.sections.recruitment).sort()).toEqual(['applicationNumber', 'appliedAt', 'candidateNumber', 'hiredAt', 'openingTitle', 'source']);
    expect(d.sections.talent).toMatchObject({ talentPoolCount: 1, activeSuccessionNominations: 1 });
    expect(text(d.sections.talent)).not.toMatch(/Takes ownership|Needs SQL|potentialLevel/);
    expect(d.activity.some((a: { domain: string }) => a.domain === 'performance')).toBe(true);
    expect(d.activity.some((a: { domain: string }) => a.domain === 'employee_relations')).toBe(true);
    expect(text(d.activity)).not.toMatch(/Late reports|Repeated late/);
  });

  it('the executive opens a 360 under employee permissions but gets no payroll, relations or talent judgment', async () => {
    const d = (await open(exec, employees.EMP003)).body.data;
    expect(d.sections.payroll).toBeNull();
    expect(d.sections.employeeRelations).toBeNull();
    expect(d.sections.talent).toBeNull();
    expect(d.sections.recruitment).toBeNull();
    expect(text(d)).not.toMatch(/77777|Takes ownership|Needs SQL|66666/);
  });

  it('the 360 is read-only: nothing changed in any source table', async () => {
    expect(await prisma.auditLog.count({ where: { module: { in: ['payroll', 'employee_relations', 'talent', 'recruitment', 'performance'] } } })).toBe(0);
  });
});

describe('Executive analytics', () => {
  it('needs analytics.view_executive; the executive gets aggregates and never a person', async () => {
    expect(err(await as(mgr, 'get', `${A}/executive/overview?${RANGE}`))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'get', `${A}/executive/overview?${RANGE}`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${A}/executive/overview?${RANGE}`))).toBe('403 FORBIDDEN');
    const r = await as(exec, 'get', `${A}/executive/overview?${RANGE}`);
    expect(err(r)).toBe('200');
    const d = r.body.data;
    expect(d.sections.workforce.headcount.active).toBe(6);
    expect(d.sections.workforce.newHires).toBe(2);
    expect(d.sections.payroll).toBeNull();
    expect(d.sections.employeeRelations.actions.issued).toBe(1);
    expect(d.sections.talent.succession.plans.withSuccessor).toBe(1);
    expect(personalDataIn(d)).toEqual([]);
    expect(text(d)).not.toMatch(/77777|66666|Takes ownership|Needs SQL|Late reports|rank/i);
  });

  it('payroll totals need the extra permission and are organization-level only', async () => {
    const d = (await as(hrAdmin, 'get', `${A}/executive/overview?${RANGE}`)).body.data;
    expect(d.sections.payroll, JSON.stringify(d.sections.payroll)).toMatchObject({ runs: 1, employeesPaid: 1, netTotal: '77777.00' });
    expect(Object.keys(d.sections.payroll)).not.toContain('byDepartment');
    expect(personalDataIn(d)).toEqual([]);
  });

  it('every headline figure equals the source report it is composed from', async () => {
    const d = (await as(hrAdmin, 'get', `${A}/executive/overview?${RANGE}`)).body.data;
    const training = (await as(hrAdmin, 'get', `/api/v1/training/reports/overview?${RANGE}`)).body.data;
    expect(d.sections.training.completionRate).toBe(training.completionRate);
    expect(d.sections.training.enrollments).toEqual(training.enrollments);
    const cycles = (await as(hrAdmin, 'get', '/api/v1/performance/cycles?pageSize=50')).body.data;
    const perf = (await as(hrAdmin, 'get', `/api/v1/performance/cycles/${cycles[0].id}/report`)).body.data;
    expect(d.sections.performance.cycles[0].completion).toEqual(perf.completion);
    expect(d.sections.performance.cycles[0].averageFinalScore).toBe(perf.averageFinalScore);
    const gaps = (await as(hrAdmin, 'get', '/api/v1/competency/reports/gaps')).body.data;
    expect(d.sections.competency.totals).toEqual(gaps.totals);
    const rec = (await as(hrAdmin, 'get', `/api/v1/recruitment/reports/summary?${RANGE}`)).body.data;
    expect(d.sections.recruitment.hires).toBe(rec.hires);
    expect(d.sections.recruitment.averageTimeToHireDays).toBe(rec.averageTimeToHireDays);
    const er = (await as(hrAdmin, 'get', `/api/v1/employee-relations/reports/overview?${RANGE}`)).body.data;
    expect(d.sections.employeeRelations.actions).toEqual(er.actions);
    const leave = (await as(hrAdmin, 'get', `/api/v1/leave/reports/overview?${RANGE}`)).body.data;
    expect(d.sections.leave.summary).toEqual(leave.summary);
    const talent = (await as(hrAdmin, 'get', '/api/v1/talent/reports/succession')).body.data;
    expect(d.sections.talent.succession.plans).toEqual(talent.plans);
  });

  it('historical attribution: after a department move the performance report keeps Engineering while headcount follows today', async () => {
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { departmentId: otherDeptId, positionId: (await prisma.position.findFirstOrThrow({ where: { code: 'OPS1' } })).id } });
    const d = (await as(exec, 'get', `${A}/executive/overview?${RANGE}`)).body.data;
    expect(d.sections.workforce.byDepartment.find((x: { name: string }) => x.name === 'Operations').active).toBe(4);
    expect(d.sections.performance.cycles[0].byDepartment.find((x: { departmentName: string }) => x.departmentName === 'Engineering').finalized).toBe(1);
    const filtered = (await as(exec, 'get', `${A}/executive/overview?${RANGE}&departmentId=${deptId}`)).body.data;
    expect(filtered.sections.workforce.headcount.active).toBe(2);
    expect(filtered.sections.performance.cycles[0].completion.finalized).toBe(1);
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { departmentId: deptId, positionId: (await prisma.position.findFirstOrThrow({ where: { code: 'ENG1' } })).id } });
  });

  it('filters and range limits are validated; the metric dictionary is served', async () => {
    expect(err(await as(exec, 'get', `${A}/executive/overview?from=2020-01-01&to=2026-12-31`))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(exec, 'get', `${A}/executive/overview?from=2026-12-01&to=2026-01-01`))).toBe('400 VALIDATION_ERROR');
    expect(monthsSpan('2024-01-01', '2026-12-31')).toBe(36);
    const metrics = await as(exec, 'get', `${A}/metrics`);
    expect(metrics.body.data.length).toBe(ANALYTICS_METRICS.length);
    expect(metrics.body.data.some((m: { key: string }) => m.key === 'training.completionRate')).toBe(true);
  });

  it('a fresh organization returns zeros and empty arrays, never an error', async () => {
    const fresh = await prisma.organization.create({ data: { code: 'EMPTY', name: 'Empty Co', timezone: 'Asia/Bangkok' } });
    const r = await as(exec, 'get', `${A}/executive/overview?${RANGE}&organizationId=${fresh.id}`);
    expect(err(r)).toBe('200');
    const d = r.body.data;
    expect(d.sections.workforce.headcount).toEqual({ active: 0, inactive: 0, terminated: 0, total: 0 });
    expect(d.sections.workforce.byDepartment).toEqual([]);
    expect(d.sections.attendance.totals.presentDays).toBe(0);
    expect(text(d)).not.toMatch(/NaN|Infinity/);
  });

  it('CSV export is aggregate, escaped and needs the same permission', async () => {
    expect((await as(mgr, 'get', `${A}/executive/export?${RANGE}`)).status).toBe(403);
    const evil = await prisma.department.create({ data: { organizationId: orgId, code: 'EVIL', name: '=HYPERLINK("x")' } });
    const evilPos = await prisma.position.create({ data: { departmentId: evil.id, code: 'EVIL1', title: 'Evil Officer', jobId: (await prisma.job.findFirstOrThrow({ where: { code: 'ENG' } })).id } });
    await prisma.employee.create({ data: { employeeCode: 'EVIL01', firstName: 'Evil', lastName: 'Row', email: 'evil@a29.local', hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: orgId, departmentId: evil.id, positionId: evilPos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } });
    const r = await as(exec, 'get', `${A}/executive/export?${RANGE}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('"Active headcount"');
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(r.text).not.toMatch(/EMP00\d|Person|77777|Takes ownership/);
  });
});
