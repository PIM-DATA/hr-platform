/**
 * Task 28 — Career, talent and succession MVP.
 *
 * What these tests guard: that readiness is a fact about competency requirements and never a verdict, that
 * potential is written once by the named reviewer and nobody else, that the 9-box is a distribution with no rank,
 * that pools and nominations are people's acts with history, that snapshots outlive transfers and later cycles,
 * and that an employee never sees a cell, a comment or a nomination about themselves.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { careerReadinessStatus, nineBoxCell, nineBoxLabel, validateBucketRules } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { developmentService } from '../src/modules/talent/development.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const T = '/api/v1/talent';

let hrAdmin: Session, hr: Session, mgr: Session, otherMgr: Session, emp: Session, emp2: Session, exec: Session;
let orgId: string, deptId: string;
const job: Record<string, string> = {};
const position: Record<string, string> = {};
const employees: Record<string, string> = {};
const comp: Record<string, string> = {};
let perfCycleId: string, pathId: string, cycleId: string, reviewId: string, poolId: string, planId: string, candidateId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'TAL', name: 'Talent Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'ANALYTICS', name: 'Analytics' } });
  deptId = dept.id;
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  for (const [code, title] of [['DA', 'Data Analyst'], ['SDA', 'Senior Data Analyst'], ['AM', 'Analytics Manager'], ['OPS', 'Operations Officer']]) job[code] = (await prisma.job.create({ data: { code, title, level: 2 } })).id;
  position.DA = (await prisma.position.create({ data: { departmentId: dept.id, code: 'DA1', title: 'Data Analyst', jobId: job.DA } })).id;
  position.SDA = (await prisma.position.create({ data: { departmentId: dept.id, code: 'SDA1', title: 'Senior Data Analyst', jobId: job.SDA } })).id;
  position.AM = (await prisma.position.create({ data: { departmentId: dept.id, code: 'AM1', title: 'Analytics Manager', jobId: job.AM } })).id;
  position.OPS = (await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OPS1', title: 'Operations Officer', jobId: job.OPS } })).id;
  const mk = async (code: string, positionId: string, departmentId: string, managerId: string | null) =>
    (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@tal.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  employees.HRADM = await mk('HRADM', position.OPS, otherDept.id, null);
  employees.MGR = await mk('MGR', position.AM, dept.id, null);
  employees.OTHERMGR = await mk('OTHERMGR', position.OPS, otherDept.id, null);
  employees.EMP003 = await mk('EMP003', position.DA, dept.id, employees.MGR);
  employees.EMP004 = await mk('EMP004', position.DA, dept.id, employees.MGR);
  employees.EMP005 = await mk('EMP005', position.OPS, otherDept.id, employees.OTHERMGR);

  await createUser({ email: 'hradmin@tal.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@tal.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@tal.local', password: PW, role: 'MANAGER', employeeId: employees.MGR });
  await createUser({ email: 'othermgr@tal.local', password: PW, role: 'MANAGER', employeeId: employees.OTHERMGR });
  await createUser({ email: 'emp@tal.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp2@tal.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@tal.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgr, otherMgr, emp, emp2, exec] = await Promise.all(['hradmin', 'hr', 'mgr', 'othermgr', 'emp', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@tal.local`, PW)));

  // Competency framework (Task 24): SQL / Visualization / Communication; Senior Data Analyst asks 5 / 4 / 4.
  const scale = await prisma.competencyScale.create({ data: { code: 'STD5', name: 'Standard five', levels: { create: [1, 2, 3, 4, 5].map((level) => ({ level, label: `Level ${level}` })) } } });
  const category = await prisma.competencyCategory.create({ data: { code: 'CORE', name: 'Core' } });
  for (const [code, name] of [['SQL', 'SQL'], ['VIZ', 'Visualization'], ['COMM', 'Communication']]) comp[code] = (await prisma.competency.create({ data: { code, name, categoryId: category.id, scaleId: scale.id } })).id;
  for (const [c, level] of [['SQL', 5], ['VIZ', 4], ['COMM', 4]] as const) await prisma.jobCompetencyRequirement.create({ data: { jobId: job.SDA, competencyId: comp[c], requiredLevel: level } });
  for (const [c, level] of [['SQL', 3], ['VIZ', 3], ['COMM', 3]] as const) await prisma.jobCompetencyRequirement.create({ data: { jobId: job.DA, competencyId: comp[c], requiredLevel: level } });
  await prisma.jobCompetencyRequirement.create({ data: { jobId: job.AM, competencyId: comp.COMM, requiredLevel: 5 } });
  // EMP003 assessed 3 / 4 / 3 in a finalized cycle; EMP004 never assessed.
  const ccycle = await prisma.competencyAssessmentCycle.create({ data: { code: 'C2025', name: 'Competency 2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'CLOSED' } });
  await prisma.competencyAssessment.create({ data: {
    cycleId: ccycle.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', status: 'FINALIZED', finalizedAt: new Date('2025-12-15T00:00:00Z'),
    items: { create: [['SQL', 3], ['VIZ', 4], ['COMM', 3]].map(([c, level]) => ({ competencyId: comp[c as string], competencyCodeSnapshot: c as string, competencyNameSnapshot: c as string, categorySnapshot: 'Core', requiredLevelSnapshot: 3, finalLevel: level as number, managerLevel: level as number })) },
  } });
  // Performance (Task 23): a REVIEW-stage cycle with bands and a FINALIZED plan for EMP003 at 3.95 = EXCEEDS.
  const pc = await prisma.performanceCycle.create({ data: { code: 'P2025', name: 'Performance 2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'REVIEW', ratingBands: { create: [{ code: 'BELOW', label: 'Below', minScore: 1, maxScore: 2.49 }, { code: 'MEETS', label: 'Meets', minScore: 2.5, maxScore: 3.79 }, { code: 'EXCEEDS', label: 'Exceeds', minScore: 3.8, maxScore: 5 }] } } });
  perfCycleId = pc.id;
  await prisma.performancePlan.create({ data: { cycleId: pc.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', status: 'FINALIZED', finalizedAt: new Date('2025-12-20T00:00:00Z'), weightedScore: 3.95, ratingCode: 'EXCEEDS', ratingLabelSnapshot: 'Exceeds' } });
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('pure rules', () => {
  it('readiness is a fact about requirements; the 9-box is a label; bucket rules must be unambiguous', () => {
    expect(careerReadinessStatus([])).toBe('NO_REQUIREMENTS_DEFINED');
    expect(careerReadinessStatus([{ gapStatus: 'NO_GAP' }, { gapStatus: 'UNASSESSED' }])).toBe('ASSESSMENT_REQUIRED');
    expect(careerReadinessStatus([{ gapStatus: 'GAP' }, { gapStatus: 'UNASSESSED' }])).toBe('GAPS_EXIST');
    expect(careerReadinessStatus([{ gapStatus: 'NO_GAP' }, { gapStatus: 'EXCEEDS_REQUIREMENT' }])).toBe('READY_REQUIREMENTS_MET');
    expect(nineBoxCell('HIGH', 'MEDIUM')).toBe('HIGH_PERFORMANCE_MEDIUM_POTENTIAL');
    expect(nineBoxCell(null, 'HIGH')).toBeNull();
    expect(nineBoxLabel('HIGH_PERFORMANCE_HIGH_POTENTIAL')).toBe('High performance / High potential');
    expect(validateBucketRules(['A', 'B'], [{ ratingCode: 'A', bucket: 'HIGH' }, { ratingCode: 'A', bucket: 'LOW' }])).toMatchObject({ ok: false, missing: ['B'], duplicated: ['A'] });
    expect(validateBucketRules(['A', 'B'], [{ ratingCode: 'A', bucket: 'HIGH' }, { ratingCode: 'B', bucket: 'LOW' }])).toEqual({ ok: true });
  });
});

describe('career paths and readiness', () => {
  it('HR admin defines a path; a step must join two different jobs and appears once', async () => {
    expect(err(await as(mgr, 'post', `${T}/career/paths`).send({ code: 'ANALYTICS', name: 'Analytics track' }))).toBe('403 FORBIDDEN');
    const created = await as(hrAdmin, 'post', `${T}/career/paths`).send({ code: 'ANALYTICS', name: 'Analytics track', organizationId: orgId, description: 'Analyst to manager' });
    expect(err(created)).toBe('201');
    pathId = created.body.data.id;
    expect(err(await as(hrAdmin, 'post', `${T}/career/paths/${pathId}/steps`).send({ fromJobId: job.DA, toJobId: job.DA }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${T}/career/paths/${pathId}/steps`).send({ fromJobId: job.DA, toJobId: job.SDA, stepOrder: 1 }))).toBe('201');
    expect(err(await as(hrAdmin, 'post', `${T}/career/paths/${pathId}/steps`).send({ fromJobId: job.DA, toJobId: job.SDA }))).toBe('409 CAREER_STEP_EXISTS');
    const withSecond = await as(hrAdmin, 'post', `${T}/career/paths/${pathId}/steps`).send({ fromJobId: job.SDA, toJobId: job.AM, stepOrder: 2 });
    expect(withSecond.body.data.steps).toHaveLength(2);
    expect(withSecond.body.data.steps[0].toJob.title).toBe('Senior Data Analyst');
  });

  it('the employee sees their own paths and readiness: gaps SQL 2 and Communication 1, requirements met on Visualization — and no verdict', async () => {
    const mine = await as(emp, 'get', `${T}/career/me`);
    expect(err(mine)).toBe('200');
    expect(mine.body.data.currentJob.title).toBe('Data Analyst');
    expect(mine.body.data.paths.map((p: { code: string }) => p.code)).toEqual(['ANALYTICS']);
    expect(mine.body.data.nextJobs).toHaveLength(1);
    const next = mine.body.data.nextJobs[0];
    expect(next.targetJob.title).toBe('Senior Data Analyst');
    expect(next.status).toBe('GAPS_EXIST');
    const byCode = Object.fromEntries(next.competencies.map((c: { competencyCode: string }) => [c.competencyCode, c]));
    expect(byCode.SQL).toMatchObject({ currentLevel: 3, requiredLevel: 5, gapNeeded: 2, status: 'GAP' });
    expect(byCode.VIZ).toMatchObject({ currentLevel: 4, requiredLevel: 4, gapNeeded: 0, status: 'NO_GAP' });
    expect(byCode.COMM).toMatchObject({ currentLevel: 3, requiredLevel: 4, gapNeeded: 1, status: 'GAP' });
    expect(next.summary).toEqual({ requirements: 3, assessed: 3, met: 1, gaps: 2, unassessed: 0 });
    expect(JSON.stringify(mine.body.data)).not.toMatch(/promot|eligible|best|rank|potential|nineBox/i);
  });

  it('unassessed is not zero: an unassessed employee needs an assessment, not development', async () => {
    const r = await as(emp2, 'get', `${T}/career/me`);
    const next = r.body.data.nextJobs[0];
    expect(next.status).toBe('ASSESSMENT_REQUIRED');
    expect(next.summary).toMatchObject({ unassessed: 3, gaps: 0 });
    expect(next.competencies.every((c: { currentLevel: number | null; gapNeeded: number | null }) => c.currentLevel === null && c.gapNeeded === null)).toBe(true);
  });

  it('a changed requirement changes readiness from today; a job with no profile says so', async () => {
    await prisma.jobCompetencyRequirement.update({ where: { jobId_competencyId: { jobId: job.SDA, competencyId: comp.SQL } }, data: { requiredLevel: 3 } });
    await prisma.jobCompetencyRequirement.update({ where: { jobId_competencyId: { jobId: job.SDA, competencyId: comp.COMM } }, data: { requiredLevel: 3 } });
    const r = await as(emp, 'get', `${T}/career/readiness?targetJobId=${job.SDA}`);
    expect(r.body.data.status).toBe('READY_REQUIREMENTS_MET');
    await prisma.jobCompetencyRequirement.update({ where: { jobId_competencyId: { jobId: job.SDA, competencyId: comp.SQL } }, data: { requiredLevel: 5 } });
    await prisma.jobCompetencyRequirement.update({ where: { jobId_competencyId: { jobId: job.SDA, competencyId: comp.COMM } }, data: { requiredLevel: 4 } });
    expect((await as(emp, 'get', `${T}/career/readiness?targetJobId=${job.SDA}`)).body.data.status).toBe('GAPS_EXIST');
    expect((await as(emp, 'get', `${T}/career/readiness?targetJobId=${job.OPS}`)).body.data.status).toBe('NO_REQUIREMENTS_DEFINED');
  });

  it('readiness of somebody else needs a reason to see them: manager of the employee yes, unrelated manager no, employee no', async () => {
    expect(err(await as(mgr, 'get', `${T}/career/readiness?employeeId=${employees.EMP003}&targetJobId=${job.SDA}`))).toBe('200');
    expect(err(await as(otherMgr, 'get', `${T}/career/readiness?employeeId=${employees.EMP003}&targetJobId=${job.SDA}`))).toBe('404 EMPLOYEE_NOT_FOUND');
    expect(err(await as(emp2, 'get', `${T}/career/readiness?employeeId=${employees.EMP003}&targetJobId=${job.SDA}`))).toBe('404 EMPLOYEE_NOT_FOUND');
    const team = await as(mgr, 'get', `${T}/career/team`);
    expect(team.body.data.map((t: { employee: { employeeCode: string } }) => t.employee.employeeCode).sort()).toEqual(['EMP003', 'EMP004']);
    expect(err(await as(emp, 'get', `${T}/career/team`))).toBe('403 FORBIDDEN');
  });
});

describe('talent review cycle, potential and the 9-box', () => {
  it('creates a cycle on a finalized performance cycle; bucket rules must cover every rating exactly once', async () => {
    expect(err(await as(hr, 'post', `${T}/cycles`).send({ code: 'TR2026', name: 'Talent Review 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' }))).toBe('403 FORBIDDEN');
    const created = await as(hrAdmin, 'post', `${T}/cycles`).send({ code: 'TR2026', name: 'Talent Review 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', organizationId: orgId, performanceCycleId: perfCycleId });
    expect(err(created)).toBe('201');
    cycleId = created.body.data.id;
    expect(created.body.data.potentialLevels.map((l: { code: string }) => l.code)).toEqual(['LOW', 'MEDIUM', 'HIGH']);
    expect(err(await as(hrAdmin, 'post', `${T}/cycles/${cycleId}/activate`))).toBe('422 BUCKET_RULES_REQUIRED');
    expect(err(await as(hrAdmin, 'put', `${T}/cycles/${cycleId}/bucket-rules`).send({ rules: [{ ratingCode: 'EXCEEDS', bucket: 'HIGH' }] }))).toBe('422 BUCKET_RULES_AMBIGUOUS');
    expect(err(await as(hrAdmin, 'put', `${T}/cycles/${cycleId}/bucket-rules`).send({ rules: [{ ratingCode: 'EXCEEDS', bucket: 'HIGH' }, { ratingCode: 'EXCEEDS', bucket: 'MEDIUM' }, { ratingCode: 'MEETS', bucket: 'MEDIUM' }, { ratingCode: 'BELOW', bucket: 'LOW' }] }))).toBe('422 BUCKET_RULES_AMBIGUOUS');
    const rules = await as(hrAdmin, 'put', `${T}/cycles/${cycleId}/bucket-rules`).send({ rules: [{ ratingCode: 'EXCEEDS', bucket: 'HIGH' }, { ratingCode: 'MEETS', bucket: 'MEDIUM' }, { ratingCode: 'BELOW', bucket: 'LOW' }] });
    expect(err(rules)).toBe('200');
    expect((await as(hrAdmin, 'post', `${T}/cycles/${cycleId}/activate`)).body.data.status).toBe('ACTIVE');
  });

  it('assigning snapshots performance (3.95 → EXCEEDS → HIGH) and the direct manager as reviewer, and notifies them', async () => {
    const assigned = await as(hrAdmin, 'post', `${T}/cycles/${cycleId}/assign`).send({ departmentId: deptId });
    expect(err(assigned)).toBe('200');
    expect(assigned.body.data.created).toBe(3); // MGR, EMP003, EMP004
    const again = await as(hrAdmin, 'post', `${T}/cycles/${cycleId}/assign`).send({ employeeIds: [employees.EMP003] });
    expect(again.body.data).toMatchObject({ created: 0 });
    expect(again.body.data.skipped[0].reason).toBe('ALREADY_ASSIGNED');
    const reviews = await as(hrAdmin, 'get', `${T}/reviews?cycleId=${cycleId}`);
    const r3 = reviews.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP003');
    reviewId = r3.id;
    expect(r3.performance).toMatchObject({ score: '3.95', ratingCode: 'EXCEEDS', ratingLabel: 'Exceeds', bucket: 'HIGH', cycleName: 'Performance 2025' });
    expect(r3.reviewer.userId).toBe(mgr.user.id);
    expect(r3.snapshot.jobTitle).toBe('Data Analyst');
    const r4 = reviews.body.data.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP004');
    expect(r4.performance.bucket).toBeNull();
    const note = await prisma.notification.findFirst({ where: { userId: mgr.user.id, type: 'TALENT_REVIEW_REQUIRED' } });
    expect(note?.body).toContain('Talent Review 2026');
    expect(note?.body).not.toMatch(/HIGH|potential level|cell/);
  });

  it('only the assigned reviewer submits potential; TEAM scope alone, HR, or an unrelated manager cannot; the employee cannot see it', async () => {
    const body = { potentialLevel: 'HIGH', potentialComment: 'Takes ownership beyond the role.' };
    expect(err(await as(otherMgr, 'post', `${T}/reviews/${reviewId}/potential`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'post', `${T}/reviews/${reviewId}/potential`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'post', `${T}/reviews/${reviewId}/potential`).send(body))).toBe('403 FORBIDDEN');
    // MGR is the reviewer of EMP003 — but also a direct report is not enough: EMP005's review does not exist for MGR.
    const ctx = await as(mgr, 'get', `${T}/reviews/${reviewId}/context`);
    expect(err(ctx)).toBe('200');
    expect(ctx.body.data.competencySummary).toMatchObject({ requirements: 3, gaps: 0 });
    expect(ctx.body.data.review.performance.score).toBe('3.95');
    expect(JSON.stringify(ctx.body.data)).not.toMatch(/promot|rank/i);
    const race = await Promise.all([as(mgr, 'post', `${T}/reviews/${reviewId}/potential`).send(body), as(mgr, 'post', `${T}/reviews/${reviewId}/potential`).send(body)]);
    expect(race.map((r) => `${r.status} ${r.body?.error?.code ?? ''} ${r.body?.error?.message ?? ''}`).sort()).toEqual(['200  ', '409 TALENT_REVIEW_SUBMITTED This assessment has already been submitted']);
    const after = await as(mgr, 'get', `${T}/reviews/${reviewId}`);
    expect(after.body.data).toMatchObject({ status: 'SUBMITTED', potentialLevel: 'HIGH', nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL', commentVisible: true });
    expect(after.body.data.potentialComment).toBe('Takes ownership beyond the role.');
    expect(err(await as(emp, 'get', `${T}/reviews/${reviewId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(otherMgr, 'get', `${T}/reviews/${reviewId}`))).toBe('404 TALENT_REVIEW_NOT_FOUND');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'SUBMIT_POTENTIAL_ASSESSMENT', recordId: reviewId } });
    expect(JSON.stringify(audit?.newValue)).not.toMatch(/ownership/i);
    expect(JSON.stringify(audit?.newValue)).toContain('potentialCommentLength');
  });

  it('the 9-box is counts per cell with no ranking; the employee is refused; the executive sees counts only', async () => {
    const box = await as(hrAdmin, 'get', `${T}/cycles/${cycleId}/nine-box`);
    expect(err(box)).toBe('200');
    expect(box.body.data.cells).toHaveLength(9);
    expect(box.body.data.cells.find((c: { cell: string }) => c.cell === 'HIGH_PERFORMANCE_HIGH_POTENTIAL').count).toBe(1);
    expect(box.body.data.total).toBe(3);
    expect(JSON.stringify(box.body.data)).not.toMatch(/rank|EMP003|Person/);
    expect(err(await as(emp, 'get', `${T}/cycles/${cycleId}/nine-box`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${T}/cycles/${cycleId}/nine-box`))).toBe('200');
    expect(err(await as(exec, 'get', `${T}/reviews?cycleId=${cycleId}`))).toBe('403 FORBIDDEN');
    // The 9-box list for a cell, for HR: names appear, comments do not for anybody but the reviewer/managers.
    const cellList = await as(hrAdmin, 'get', `${T}/reviews?cycleId=${cycleId}&nineBoxCell=HIGH_PERFORMANCE_HIGH_POTENTIAL`);
    expect(cellList.body.data.map((r: { employee: { employeeCode: string } }) => r.employee.employeeCode)).toEqual(['EMP003']);
    expect(JSON.stringify(cellList.body.data)).not.toMatch(/"rank"/);
  });

  it('closing finalizes submitted reviews and makes the cycle immutable; a later performance cycle does not rewrite the snapshot', async () => {
    const closed = await as(hrAdmin, 'post', `${T}/cycles/${cycleId}/close`);
    expect(closed.body.data.status).toBe('CLOSED');
    expect(closed.body.data.counts).toMatchObject({ finalized: 1, assigned: 2 });
    expect(err(await as(hrAdmin, 'patch', `${T}/cycles/${cycleId}`).send({ name: 'Renamed' }))).toBe('409 TALENT_CYCLE_CLOSED');
    expect(err(await as(hrAdmin, 'put', `${T}/cycles/${cycleId}/bucket-rules`).send({ rules: [{ ratingCode: 'EXCEEDS', bucket: 'LOW' }, { ratingCode: 'MEETS', bucket: 'LOW' }, { ratingCode: 'BELOW', bucket: 'LOW' }] }))).toBe('409 TALENT_CYCLE_CLOSED');
    // Performance cycle B with a lower result for EMP003; the finalized talent review still says 3.95 / EXCEEDS.
    const pcB = await prisma.performanceCycle.create({ data: { code: 'P2026', name: 'Performance 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED', ratingBands: { create: [{ code: 'MEETS', label: 'Meets', minScore: 1, maxScore: 5 }] } } });
    await prisma.performancePlan.create({ data: { cycleId: pcB.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', status: 'FINALIZED', finalizedAt: new Date(), weightedScore: 2.1, ratingCode: 'MEETS', ratingLabelSnapshot: 'Meets' } });
    const review = await as(hrAdmin, 'get', `${T}/reviews/${reviewId}`);
    expect(review.body.data).toMatchObject({ status: 'FINALIZED', performance: { score: '3.95', ratingCode: 'EXCEEDS', cycleName: 'Performance 2025' }, nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL' });
    // A manager with TEAM scope sees the cell for their report, not the comment.
    const teamView = await as(mgr, 'get', `${T}/reviews?view=team&cycleId=${cycleId}`);
    expect(teamView.body.data.length).toBe(2);
  });
});

describe('talent pools', () => {
  it('membership is manual, idempotent, and removal keeps history; nothing was added by the 9-box', async () => {
    expect(await prisma.talentPoolMember.count()).toBe(0);
    const pool = await as(hrAdmin, 'post', `${T}/pools`).send({ code: 'LEADERSHIP', name: 'Leadership Pipeline', organizationId: orgId });
    expect(err(pool)).toBe('201');
    poolId = pool.body.data.id;
    expect(err(await as(mgr, 'post', `${T}/pools/${poolId}/members`).send({ employeeId: employees.EMP003 }))).toBe('403 FORBIDDEN');
    const pair = await Promise.all([
      as(hrAdmin, 'post', `${T}/pools/${poolId}/members`).send({ employeeId: employees.EMP003, reason: 'High/High in 2026 review', sourceTalentReviewId: reviewId }),
      as(hrAdmin, 'post', `${T}/pools/${poolId}/members`).send({ employeeId: employees.EMP003, reason: 'High/High in 2026 review', sourceTalentReviewId: reviewId }),
    ]);
    expect(pair.every((r) => r.status === 201)).toBe(true);
    expect(pair[0].body.data.id).toBe(pair[1].body.data.id);
    expect(await prisma.talentPoolMember.count({ where: { poolId, employeeId: employees.EMP003, status: 'ACTIVE' } })).toBe(1);
    const members = await as(hrAdmin, 'get', `${T}/pools/${poolId}/members`);
    expect(members.body.data[0]).toMatchObject({ employee: { employeeCode: 'EMP003' }, status: 'ACTIVE', sourceTalentReview: { cycleName: 'Talent Review 2026' } });
    const removed = await as(hrAdmin, 'post', `${T}/pools/${poolId}/members/${pair[0].body.data.id}/remove`).send({ reason: 'Moved to another track' });
    expect(removed.body.data).toMatchObject({ status: 'REMOVED', removalReason: 'Moved to another track' });
    expect(removed.body.data.removedAt).toBeTruthy();
    expect(await prisma.talentPoolMember.count({ where: { poolId } })).toBe(1);
    expect((await as(hrAdmin, 'get', `${T}/pools/${poolId}/members?includeRemoved=true`)).body.data).toHaveLength(1);
    expect((await as(hrAdmin, 'get', `${T}/pools/${poolId}/members`)).body.data).toHaveLength(0);
    const readd = await as(hrAdmin, 'post', `${T}/pools/${poolId}/members`).send({ employeeId: employees.EMP003 });
    expect(readd.body.data.id).not.toBe(pair[0].body.data.id);
    expect(err(await as(emp, 'get', `${T}/pools`))).toBe('403 FORBIDDEN');
  });
});

describe('succession', () => {
  it('one open plan per position; criticality is set by a person; nominations are people’s acts with snapshots', async () => {
    expect(err(await as(mgr, 'post', `${T}/succession/plans`).send({ positionId: position.AM }))).toBe('403 FORBIDDEN');
    const plan = await as(hrAdmin, 'post', `${T}/succession/plans`).send({ positionId: position.AM, criticality: 'CRITICAL', notes: 'Single incumbent.' });
    expect(err(plan)).toBe('201');
    planId = plan.body.data.id;
    expect(plan.body.data.snapshot).toMatchObject({ positionTitle: 'Analytics Manager', jobTitle: 'Analytics Manager', departmentName: 'Analytics' });
    expect(plan.body.data.incumbents.map((i: { employeeCode: string }) => i.employeeCode)).toEqual(['MGR']);
    expect(err(await as(hrAdmin, 'post', `${T}/succession/plans`).send({ positionId: position.AM }))).toBe('409 SUCCESSION_PLAN_EXISTS');
    await as(hrAdmin, 'patch', `${T}/succession/plans/${planId}`).send({ status: 'ACTIVE' });
    const race = await Promise.all([
      as(hrAdmin, 'post', `${T}/succession/plans/${planId}/candidates`).send({ employeeId: employees.EMP003, readiness: 'DEVELOPING', notes: 'Needs SQL depth and leadership exposure.' }),
      as(hrAdmin, 'post', `${T}/succession/plans/${planId}/candidates`).send({ employeeId: employees.EMP003, readiness: 'DEVELOPING', notes: 'Needs SQL depth and leadership exposure.' }),
    ]);
    expect(race.every((r) => r.status === 201)).toBe(true);
    expect(race[0].body.data.id).toBe(race[1].body.data.id);
    candidateId = race[0].body.data.id;
    expect(await prisma.successionCandidate.count({ where: { planId, employeeId: employees.EMP003, status: 'ACTIVE' } })).toBe(1);
    expect(race[0].body.data.snapshot).toMatchObject({ jobTitle: 'Data Analyst', departmentName: 'Analytics' });
    expect(JSON.stringify(race[0].body.data)).not.toMatch(/score|rank/i);
  });

  it('the HR viewer sees the plan without notes; the employee and an executive see nothing; readiness is edited by hand', async () => {
    const hrView = await as(hr, 'get', `${T}/succession/plans/${planId}`);
    expect(err(hrView)).toBe('200');
    expect(hrView.body.data.notes).toBeNull();
    expect(hrView.body.data.candidates[0].notes).toBeNull();
    expect((await as(hrAdmin, 'get', `${T}/succession/plans/${planId}`)).body.data.candidates[0].notes).toBe('Needs SQL depth and leadership exposure.');
    expect(err(await as(emp, 'get', `${T}/succession/plans/${planId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${T}/succession/plans`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'patch', `${T}/succession/candidates/${candidateId}`).send({ readiness: 'READY_NOW' }))).toBe('403 FORBIDDEN');
    const updated = await as(hrAdmin, 'patch', `${T}/succession/candidates/${candidateId}`).send({ readiness: 'READY_SOON', targetReadinessDate: '2027-01-01' });
    expect(updated.body.data).toMatchObject({ readiness: 'READY_SOON', targetReadinessDate: '2027-01-01' });
    expect(await prisma.notification.count({ where: { userId: emp.user.id } })).toBe(0);
  });

  it('candidate context shows readiness against the target job, performance and talent review — separately, with no composite', async () => {
    const ctx = await as(hrAdmin, 'get', `${T}/succession/candidates/${candidateId}/context`);
    expect(err(ctx)).toBe('200');
    expect(ctx.body.data.readiness.targetJob.title).toBe('Analytics Manager');
    expect(ctx.body.data.readiness.status).toBe('GAPS_EXIST'); // COMM 3 vs 5
    expect(ctx.body.data.performance).toMatchObject({ cycleName: 'Performance 2026', score: '2.10' });
    expect(ctx.body.data.talentReview).toMatchObject({ cycleName: 'Talent Review 2026', nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL' });
    expect(JSON.stringify(ctx.body.data)).not.toMatch(/overall|composite|rank|promot/i);
  });

  it('a transfer does not rewrite the nomination; removal keeps the row; remove vs readiness update stays consistent', async () => {
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { positionId: position.SDA } });
    const plan = await as(hrAdmin, 'get', `${T}/succession/plans/${planId}`);
    expect(plan.body.data.candidates[0].snapshot.jobTitle).toBe('Data Analyst');
    expect((await as(hrAdmin, 'get', `${T}/succession/candidates/${candidateId}/context`)).body.data.currentJob.title).toBe('Senior Data Analyst');
    const race = await Promise.all([
      as(hrAdmin, 'post', `${T}/succession/candidates/${candidateId}/remove`).send({ reason: 'Declined the track' }),
      as(hrAdmin, 'patch', `${T}/succession/candidates/${candidateId}`).send({ readiness: 'READY_NOW' }),
    ]);
    const statuses = race.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    const row = await prisma.successionCandidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(row.status).toBe('REMOVED');
    expect(row.removedByUserId).toBe(hrAdmin.user.id);
    if (statuses[1] === 409) expect(row.readiness).toBe('READY_SOON');
    expect(await prisma.successionCandidate.count({ where: { planId } })).toBe(1);
    expect((await as(hrAdmin, 'get', `${T}/succession/plans/${planId}`)).body.data.counts.active).toBe(0);
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { positionId: position.DA } });
  });
});

describe('development handoff, summary, reports and privacy', () => {
  it('HR creates a development need from a succession gap through the Task 25 service; competency levels are untouched', async () => {
    const nominee = await as(hrAdmin, 'post', `${T}/succession/plans/${planId}/candidates`).send({ employeeId: employees.EMP004, readiness: 'DEVELOPING' });
    expect(err(await as(mgr, 'post', `${T}/development-actions`).send({ employeeId: employees.EMP004, title: 'x', source: { type: 'SUCCESSION' } }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${T}/development-actions`).send({ employeeId: employees.EMP003, title: 'x', source: { type: 'SUCCESSION', id: nominee.body.data.id } }))).toBe('422 DEVELOPMENT_SOURCE_MISMATCH');
    const action = await as(hrAdmin, 'post', `${T}/development-actions`).send({ employeeId: employees.EMP004, title: 'Communication to level 5', competencyId: comp.COMM, priority: 'HIGH', source: { type: 'SUCCESSION', id: nominee.body.data.id } });
    expect(err(action)).toBe('201');
    expect(action.body.data).toMatchObject({ status: 'OPEN', source: 'MANUAL', priority: 'HIGH' });
    const need = await prisma.trainingNeed.findUniqueOrThrow({ where: { id: action.body.data.id } });
    expect(need.competencyId).toBe(comp.COMM);
    expect(await prisma.competencyAssessmentItem.count({ where: { assessment: { employeeId: employees.EMP004 } } })).toBe(0);
    expect(await prisma.trainingEnrollment.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_DEVELOPMENT_ACTION_FROM_TALENT', recordId: need.id } })).toBe(1);
    expect((await as(hrAdmin, 'get', `${T}/succession/candidates/${nominee.body.data.id}/context`)).body.data.development.openNeeds).toBe(1);
  });

  it('getTalentSummary is minimal and comment-free; the employee cannot read anybody’s summary', async () => {
    const summary = await developmentService.getTalentSummary(employees.EMP003);
    expect(summary).toMatchObject({ careerTargetCount: 1, talentPoolCount: 1, activeSuccessionNominations: 0, latestTalentReview: { cycleName: 'Talent Review 2026', nineBoxCell: 'HIGH_PERFORMANCE_HIGH_POTENTIAL' } });
    expect(JSON.stringify(summary)).not.toMatch(/ownership|potentialLevel|notes/);
    expect(err(await as(emp, 'get', `${T}/summary/${employees.EMP004}`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `${T}/summary/${employees.EMP004}`))).toBe('200');
    expect(err(await as(otherMgr, 'get', `${T}/summary/${employees.EMP004}`))).toBe('404 EMPLOYEE_NOT_FOUND');
  });

  it('reports are aggregate: the executive reads counts and never a name, a comment or a rank', async () => {
    const talent = await as(exec, 'get', `${T}/reports/talent`);
    expect(err(talent)).toBe('200');
    expect(talent.body.data.cycles[0]).toMatchObject({ name: 'Talent Review 2026', assigned: 3, submitted: 1, finalized: 1 });
    expect(talent.body.data.nineBox.find((c: { cell: string }) => c.cell === 'HIGH_PERFORMANCE_HIGH_POTENTIAL').count).toBe(1);
    expect(talent.body.data.pools).toEqual([{ name: 'Leadership Pipeline', activeMembers: 1 }]);
    const succession = await as(exec, 'get', `${T}/reports/succession`);
    expect(succession.body.data.plans).toMatchObject({ total: 1, active: 1, withSuccessor: 1, withReadyNow: 0, withoutSuccessor: 0 });
    expect(succession.body.data.byCriticality.find((c: { criticality: string }) => c.criticality === 'CRITICAL')).toMatchObject({ plans: 1, withSuccessor: 1 });
    expect(JSON.stringify(talent.body.data) + JSON.stringify(succession.body.data)).not.toMatch(/EMP00|Person|ownership|rank/);
    expect(err(await as(emp, 'get', `${T}/reports/talent`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `${T}/reports/succession`))).toBe('403 FORBIDDEN');
  });

  it('the personal-data export carries factual own records and excludes judgments; nothing sensitive reached notifications or logs', async () => {
    const exported = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    expect(exported.status).toBe(200);
    const payload = exported.body && Object.keys(exported.body).length ? exported.body : JSON.parse(exported.text);
    const dto = 'formatVersion' in payload ? payload : payload.data;
    expect(dto.data.talentReviews).toHaveLength(1);
    expect(dto.data.talentPools).toHaveLength(2);
    expect(dto.data.successionNominations).toHaveLength(1);
    expect(JSON.stringify(dto.data)).not.toMatch(/ownership|HIGH_PERFORMANCE|potentialLevel|Needs SQL/);
    expect(dto.notIncluded.some((n: { category: string }) => /potential assessments/.test(n.category))).toBe(true);
    const notes = await prisma.notification.findMany({ select: { body: true, title: true } });
    expect(JSON.stringify(notes)).not.toMatch(/ownership|HIGH|successor|nominat|pool/i);
    const audit = await prisma.auditLog.findMany({ where: { module: 'talent' }, select: { newValue: true, oldValue: true } });
    expect(JSON.stringify(audit)).not.toMatch(/ownership|Needs SQL|Single incumbent|Moved to another/i);
  });
});
