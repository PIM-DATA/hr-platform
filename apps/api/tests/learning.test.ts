/**
 * Task 35 — OJT, learning paths, certifications.
 *
 * What these tests guard: a plan is a frozen copy of its program; the trainer is chosen by HR and acts only on
 * assigned plans; observations are evidence with one final row per criterion per observer; a required activity
 * cannot complete without the required MEETS results and evidence; plan completion is one transition under
 * concurrency and writes no competency level; the evidence handoff creates pointers and nothing else (SQL stays
 * level 3); a learning path assignment is a frozen copy whose progress is projected from real completions;
 * certification status is derived on read and renewal keeps history; employees see only their own records, trainer
 * comments stay with HR and the trainer, executives see counts only; the privacy export carries the subject's own
 * facts and reflections but never a trainer's comment.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysIso, certificationStatus, activityCompletionBlockers, ojtProgress } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const L = '/api/v1/learning';
const text = (v: unknown) => JSON.stringify(v);

let hrAdmin: Session, hr: Session, mgrA: Session, mgrB: Session, emp: Session, emp4: Session, exec: Session;
let orgId: string, dataDeptId: string, opsDeptId: string, daJobId: string, sdaJobId: string;
const employees: Record<string, string> = {};
const comp: Record<string, string> = {};
let courseId: string, needId: string, idpItemId: string, docId: string, docCatId: string;
let programId: string, planId: string, activities: { id: string; title: string; required: boolean; observations: { criterionId: string; required: boolean }[] }[] = [];
let pathId: string, assignmentId: string, certDefId: string, certId: string;

const sqlLevel = async () => (await prisma.competencyAssessmentItem.findFirstOrThrow({ where: { competencyId: comp.SQL, assessment: { employeeId: employees.EMP003 } }, select: { finalLevel: true, managerLevel: true, selfLevel: true } }));
const profileSql = async (s: Session) => (await as(s, 'get', '/api/v1/competency/profile/me')).body.data.entries.find((e: { competencyCode: string }) => e.competencyCode === 'SQL');
function forbiddenKeys(value: unknown, re: RegExp, path = ''): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (re.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } };
  walk(value, path); return hits;
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A35', name: 'Learning Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const data = await prisma.department.create({ data: { organizationId: org.id, code: 'DATA', name: 'Analytics' } });
  const ops = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  dataDeptId = data.id; opsDeptId = ops.id;
  const da = await prisma.job.create({ data: { code: 'DA', title: 'Data Analyst', level: 2 } });
  const sda = await prisma.job.create({ data: { code: 'SDA', title: 'Senior Data Analyst', level: 3 } });
  const mgrJob = await prisma.job.create({ data: { code: 'AM', title: 'Analytics Manager', level: 4 } });
  daJobId = da.id; sdaJobId = sda.id;
  const daPos = (await prisma.position.create({ data: { departmentId: data.id, code: 'DA1', title: 'Data Analyst', jobId: da.id } })).id;
  const amPos = (await prisma.position.create({ data: { departmentId: data.id, code: 'AM1', title: 'Analytics Manager', jobId: mgrJob.id } })).id;
  const opsPos = (await prisma.position.create({ data: { departmentId: ops.id, code: 'OPS1', title: 'Operations Officer', jobId: da.id } })).id;
  const mk = async (code: string, first: string, positionId: string, departmentId: string, managerId: string | null) => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a35.local`, hireDate: new Date('2024-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id);
  await mk('MGRA', 'Alice', amPos, data.id, null);
  await mk('MGRB', 'Bob', opsPos, ops.id, null);
  await mk('HRADM', 'Hana', opsPos, ops.id, null);
  await mk('EMP003', 'Emma', daPos, data.id, employees.MGRA);
  await mk('EMP004', 'Ed', daPos, data.id, employees.MGRA);
  await mk('EMP005', 'Olly', opsPos, ops.id, employees.MGRB);
  await mk('NOACCOUNT', 'Nia', daPos, data.id, employees.MGRA);
  await createUser({ email: 'hradmin@a35.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a35.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@a35.local', password: PW, role: 'MANAGER', employeeId: employees.MGRA });
  await createUser({ email: 'mgrb@a35.local', password: PW, role: 'MANAGER', employeeId: employees.MGRB });
  await createUser({ email: 'emp@a35.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp4@a35.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a35.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgrA, mgrB, emp, emp4, exec] = await Promise.all(['hradmin', 'hr', 'mgra', 'mgrb', 'emp', 'emp4', 'exec'].map((u) => loginAs(app, `${u}@a35.local`, PW)));

  // Competency library and a finalized assessment: SQL is level 3 against a requirement of 4. It must still be 3 at the end.
  const scale = await prisma.competencyScale.create({ data: { code: 'STD5', name: 'Five', levels: { create: [1, 2, 3, 4, 5].map((level) => ({ level, label: `L${level}` })) } } });
  const category = await prisma.competencyCategory.create({ data: { code: 'CORE', name: 'Core' } });
  for (const [code, name] of [['SQL', 'SQL'], ['VIZ', 'Visualization'], ['STAT', 'Statistics']]) comp[code] = (await prisma.competency.create({ data: { code, name, categoryId: category.id, scaleId: scale.id } })).id;
  await prisma.jobCompetencyRequirement.create({ data: { jobId: da.id, competencyId: comp.SQL, requiredLevel: 4, isMandatory: true } });
  const ccycle = await prisma.competencyAssessmentCycle.create({ data: { code: 'C2026', name: 'Competency 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED' } });
  await prisma.competencyAssessment.create({ data: { cycleId: ccycle.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'Emma Person', status: 'FINALIZED', finalizedAt: new Date('2026-05-01T00:00:00Z'), items: { create: [{ competencyId: comp.SQL, competencyCodeSnapshot: 'SQL', competencyNameSnapshot: 'SQL', categorySnapshot: 'Core', requiredLevelSnapshot: 4, finalLevel: 3, managerLevel: 3, selfLevel: 3 }] } } });
  // Training: a course EMP003 completed, an open need, an IDP item.
  const course = await prisma.trainingCourse.create({ data: { code: 'SQL201', title: 'Advanced SQL', deliveryMethod: 'CLASSROOM', durationMinutes: 240, createdByUserId: hrAdmin.user.id } });
  courseId = course.id;
  const session = await prisma.trainingSession.create({ data: { courseId: course.id, courseCodeSnapshot: 'SQL201', courseTitleSnapshot: 'Advanced SQL', startAt: new Date('2026-06-01T02:00:00Z'), endAt: new Date('2026-06-01T06:00:00Z'), timezone: 'Asia/Bangkok', capacity: 10, status: 'COMPLETED', createdByUserId: hrAdmin.user.id } });
  await prisma.trainingEnrollment.create({ data: { sessionId: session.id, employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'Emma Person', source: 'MANUAL', status: 'COMPLETED' } });
  needId = (await prisma.trainingNeed.create({ data: { employeeId: employees.EMP003, source: 'MANUAL', title: 'Senior analyst readiness', employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'Emma Person', competencyId: comp.SQL, competencyCodeSnapshot: 'SQL', competencyNameSnapshot: 'SQL', status: 'OPEN' } })).id;
  const idp = await prisma.individualDevelopmentPlan.create({ data: { employeeId: employees.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'Emma Person', title: 'Emma 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'ACTIVE', items: { create: [{ title: 'Shadow senior analyst', developmentType: 'OJT', status: 'COMPLETED', progressPercent: 100 }] } }, include: { items: true } });
  idpItemId = idp.items[0].id;
  // A document owned by EMP003 (Task 30) to use as evidence.
  docCatId = (await prisma.documentCategory.create({ data: { code: 'TRN', name: 'Training evidence', defaultClassification: 'EMPLOYEE_PRIVATE' } })).id;
  docId = (await prisma.document.create({ data: { documentNumber: 'DOC-2026-000901', title: 'Quality report v1', categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: employees.EMP003, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } })).id;
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('shared helpers', () => {
  it('derive certification status, OJT progress and completion blockers deterministically', () => {
    expect(certificationStatus({ expiryDate: null, revokedAt: null }, '2026-09-25', 30)).toBe('ACTIVE');
    expect(certificationStatus({ expiryDate: '2026-10-20', revokedAt: null }, '2026-09-25', 30)).toBe('EXPIRING_SOON');
    expect(certificationStatus({ expiryDate: '2026-09-24', revokedAt: null }, '2026-09-25', 30)).toBe('EXPIRED');
    expect(certificationStatus({ expiryDate: '2026-09-25', revokedAt: null }, '2026-09-25', 30)).toBe('EXPIRING_SOON'); // valid through its last day
    expect(certificationStatus({ expiryDate: '2027-09-25', revokedAt: new Date() }, '2026-09-25', 30)).toBe('REVOKED');
    expect(addDaysIso('2026-09-25', 365)).toBe('2027-09-25');
    expect(ojtProgress([{ status: 'COMPLETED', required: true }, { status: 'SKIPPED', required: true }, { status: 'PENDING', required: false }])).toMatchObject({ total: 3, completed: 1, requiredOpen: 0, ready: true });
    expect(ojtProgress([{ status: 'COMPLETED', required: true }, { status: 'IN_PROGRESS', required: true }]).ready).toBe(false);
    expect(activityCompletionBlockers({ requiresEvidence: true, documentId: null, criteria: [{ required: true, result: 'NEEDS_PRACTICE' }, { required: false, result: null }] })).toHaveLength(2);
    expect(activityCompletionBlockers({ requiresEvidence: true, documentId: 'd', criteria: [{ required: true, result: 'MEETS' }, { required: false, result: null }] })).toEqual([]);
  });
});

describe('OJT programs', () => {
  it('HR admin creates a program with competency objectives, activities and criteria; HR, managers and employees cannot; target level is validated on the scale', async () => {
    const body = {
      code: 'SDA-OJT', name: 'Senior Data Analyst OJT', organizationId: orgId, jobId: sdaJobId, durationDays: 60,
      competencies: [{ competencyId: comp.SQL, targetLevel: 4, importance: 'CORE' }, { competencyId: comp.VIZ, targetLevel: 3, importance: 'SUPPORTING' }],
      activities: [
        { title: 'Observe a data quality review', activityType: 'OBSERVE', required: true, expectedDays: 5, criteria: [{ criterion: 'Can describe the review checklist', required: true }] },
        { title: 'Build a quality report', activityType: 'PRACTICE', required: true, expectedDays: 15, documentEvidenceRequired: true, criteria: [{ criterion: 'Report reconciles to source counts', required: true }, { criterion: 'Uses the shared naming convention', required: false }] },
        { title: 'Present findings to the team', activityType: 'PERFORM', required: false, expectedDays: 5, criteria: [{ criterion: 'Answers questions on method', required: true }] },
      ],
    };
    expect(err(await as(hr, 'post', `${L}/ojt/programs`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'post', `${L}/ojt/programs`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'post', `${L}/ojt/programs`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/programs`).send({ ...body, competencies: [{ competencyId: comp.SQL, targetLevel: 9 }] }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/programs`).send({ ...body, activities: [] }))).toBe('400 VALIDATION_ERROR');
    const r = await as(hrAdmin, 'post', `${L}/ojt/programs`).send(body);
    expect(r.status).toBe(201);
    programId = r.body.data.id;
    expect(r.body.data.activities).toHaveLength(3);
    expect(r.body.data.activities[1].criteria).toHaveLength(2);
    expect(r.body.data.competencies.map((c: { competencyCode: string; targetLevel: number }) => [c.competencyCode, c.targetLevel])).toEqual([['SQL', 4], ['VIZ', 3]]);
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/programs`).send(body))).toBe('409 OJT_PROGRAM_CODE_EXISTS');
    expect((await as(emp, 'get', `${L}/ojt/programs`)).body.data).toHaveLength(1); // employees can read the catalogue
  });
});

describe('OJT plans', () => {
  it('a plan needs a trainer with an active account; the plan snapshots program, activities and criteria; one open plan per employee and program', async () => {
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP003, programId, trainerEmployeeId: employees.NOACCOUNT, startDate: '2026-09-28' }))).toBe('422 OJT_TRAINER_NO_ACCOUNT');
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP003, programId, trainerEmployeeId: employees.MGRA, startDate: '2026-09-28', trainingNeedId: 'nope' }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(mgrA, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP003, programId, trainerEmployeeId: employees.MGRA, startDate: '2026-09-28' }))).toBe('403 FORBIDDEN');
    const r = await as(hrAdmin, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP003, programId, trainerEmployeeId: employees.MGRA, startDate: '2026-09-28', targetEndDate: '2026-11-27', trainingNeedId: needId, idpItemId });
    expect(r.status).toBe(201);
    planId = r.body.data.id;
    expect(r.body.data.planNumber).toMatch(/^OJT-2026-\d{6}$/);
    expect(r.body.data.status).toBe('DRAFT');
    expect(r.body.data.trainer.name).toMatch(/Alice Person/);
    expect(r.body.data.snapshot).toMatchObject({ employeeCode: 'EMP003', department: 'Analytics', job: 'Data Analyst' });
    expect(r.body.data.activities).toHaveLength(3);
    expect(r.body.data.activities[1].requiresEvidence).toBe(true);
    expect(r.body.data.progress).toMatchObject({ total: 3, completed: 0, requiredOpen: 2, ready: false });
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP003, programId, trainerEmployeeId: employees.MGRA, startDate: '2026-10-01' }))).toBe('409 OJT_PLAN_EXISTS');
    // trainee cannot work a draft plan
    activities = r.body.data.activities;
    expect(err(await as(emp, 'patch', `${L}/ojt/activities/${activities[0].id}`).send({ status: 'IN_PROGRESS' }))).toBe('409 OJT_PLAN_NOT_ACTIVE');
  });

  it('changing the program after the plan was created does not change the plan (§64)', async () => {
    const before = (await as(hrAdmin, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    const upd = await as(hrAdmin, 'patch', `${L}/ojt/programs/${programId}`).send({ name: 'Senior Data Analyst OJT v2', activities: [{ title: 'Completely different activity', activityType: 'OTHER', required: true, criteria: [{ criterion: 'New criterion', required: true }] }], competencies: [{ competencyId: comp.STAT, targetLevel: 2 }] });
    expect(upd.status).toBe(200);
    expect(upd.body.data.activities).toHaveLength(1);
    const after = (await as(hrAdmin, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(after.programName).toBe(before.programName);
    expect(after.activities.map((a: { title: string }) => a.title)).toEqual(before.activities.map((a: { title: string }) => a.title));
    expect(after.activities[1].observations).toHaveLength(2);
    expect(after.competencies.map((c: { competencyCode: string }) => c.competencyCode)).toEqual(['SQL', 'VIZ']);
    // restore the program for later plans
    await as(hrAdmin, 'patch', `${L}/ojt/programs/${programId}`).send({ name: 'Senior Data Analyst OJT' });
  });

  it('activation needs a trainer, notifies trainee and trainer, and moves the linked need to IN_PROGRESS; the training need is untouched otherwise', async () => {
    expect((await prisma.trainingNeed.findUniqueOrThrow({ where: { id: needId } })).status).toBe('OPEN');
    expect(err(await as(mgrA, 'post', `${L}/ojt/plans/${planId}/activate`))).toBe('403 FORBIDDEN');
    const r = await as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/activate`);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('ACTIVE');
    expect(r.body.data.activatedAt).toBeTruthy();
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/activate`))).toBe('409 OJT_PLAN_NOT_DRAFT');
    expect((await prisma.trainingNeed.findUniqueOrThrow({ where: { id: needId } })).status).toBe('IN_PROGRESS');
    const notes = await prisma.notification.findMany({ where: { type: { in: ['OJT_PLAN_ASSIGNED', 'OJT_ACTIVITY_READY'] } }, select: { type: true, userId: true, body: true } });
    expect(notes.map((n) => n.type).sort()).toEqual(['OJT_ACTIVITY_READY', 'OJT_PLAN_ASSIGNED']);
    expect(notes.find((n) => n.type === 'OJT_PLAN_ASSIGNED')!.userId).toBe(mgrA.user.id);
    expect(notes.find((n) => n.type === 'OJT_ACTIVITY_READY')!.userId).toBe(emp.user.id);
  });

  it('the trainee marks activities in progress and writes a reflection; the trainer comment is trainer/HR-only; another employee or manager gets 404', async () => {
    const a0 = activities[0].id;
    const start = await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'IN_PROGRESS', employeeReflection: 'I now understand why the checklist starts with row counts.' });
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe('IN_PROGRESS');
    expect(start.body.data.startedAt).toBeTruthy();
    expect(err(await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ trainerComment: 'sneaky' }))).toBe('403 FORBIDDEN');
    expect(err(await as(emp4, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'IN_PROGRESS' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrB, 'get', `${L}/ojt/plans/${planId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    expect(err(await as(emp4, 'get', `${L}/ojt/plans/${planId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    const tc = await as(mgrA, 'patch', `${L}/ojt/activities/${a0}`).send({ trainerComment: 'Followed the review closely; ask about the reconciliation step next time.' });
    expect(tc.status).toBe(200);
    expect(tc.body.data.trainerComment).toMatch(/reconciliation/);
    expect(err(await as(mgrA, 'patch', `${L}/ojt/activities/${a0}`).send({ employeeReflection: 'not mine' }))).toBe('403 FORBIDDEN');
    const mine = (await as(emp, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(mine.activities[0].trainerComment).toBeNull(); // trainee never sees the trainer comment
    expect(mine.activities[0].employeeReflection).toMatch(/row counts/);
    expect(text(mine)).not.toMatch(/reconciliation step/);
    const hrView = (await as(hrAdmin, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(hrView.activities[0].trainerComment).toMatch(/reconciliation/);
    // the plan is visible to the line manager (scope) and the trainer; the manager of another team is not
    expect((await as(mgrA, 'get', `${L}/ojt/plans?mine=trainer`)).body.data.map((p: { id: string }) => p.id)).toEqual([planId]);
    expect((await as(mgrB, 'get', `${L}/ojt/plans`)).body.data).toEqual([]);
  });

  it('a required activity cannot complete until its required criteria are MEETS by the assigned trainer and evidence is linked; NEEDS_PRACTICE blocks but fails nobody', async () => {
    const a0 = activities[0].id; const a1 = activities[1].id;
    const c0 = activities[0].observations[0].criterionId;
    const blocked = await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'COMPLETED' });
    expect(err(blocked)).toBe('422 OJT_ACTIVITY_INCOMPLETE');
    expect(blocked.body.error.details).toHaveLength(1);
    // only the assigned trainer observes; the line manager of another team, HR (view) and the trainee cannot
    expect(err(await as(emp, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: c0, result: 'MEETS' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrB, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: c0, result: 'MEETS' }))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: c0, result: 'MEETS' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: activities[1].observations[0].criterionId, result: 'MEETS' }))).toBe('422 VALIDATION_ERROR'); // criterion of another activity
    const np = await as(mgrA, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: c0, result: 'NEEDS_PRACTICE', comment: 'Missed the duplicate-key check', observedAt: '2026-10-01' });
    expect(np.status).toBe(201);
    expect(np.body.data.observations[0].result).toBe('NEEDS_PRACTICE');
    expect(err(await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'COMPLETED' }))).toBe('422 OJT_ACTIVITY_INCOMPLETE');
    // NEEDS_PRACTICE has no effect on the competency level, the performance module or employee relations
    expect((await sqlLevel()).finalLevel).toBe(3);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
    // resubmission replaces — one final observation per criterion per observer
    const ok = await as(mgrA, 'post', `${L}/ojt/activities/${a0}/observations`).send({ criterionId: c0, result: 'MEETS', comment: 'Second run was clean', observedAt: '2026-10-03' });
    expect(ok.status).toBe(201);
    expect(await prisma.ojtActivityObservation.count({ where: { planActivityId: a0 } })).toBe(1);
    expect(ok.body.data.observations[0]).toMatchObject({ result: 'MEETS', comment: 'Second run was clean' });
    expect(ok.body.data.blockers).toEqual([]);
    const done = await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'COMPLETED' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'COMPLETED' });
    expect(done.body.data.completedAt).toBeTruthy();
    expect(err(await as(emp, 'patch', `${L}/ojt/activities/${a0}`).send({ status: 'IN_PROGRESS' }))).toBe('409 OJT_ACTIVITY_FINISHED');
    // the trainee sees the observation result but not the trainer's observation comment
    const mine = (await as(emp, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(mine.activities[0].observations[0]).toMatchObject({ result: 'MEETS', comment: null });
    // activity 2 needs evidence: MEETS alone is not enough
    await as(mgrA, 'post', `${L}/ojt/activities/${a1}/observations`).send({ criterionId: activities[1].observations[0].criterionId, result: 'MEETS' });
    const noDoc = await as(emp, 'patch', `${L}/ojt/activities/${a1}`).send({ status: 'COMPLETED' });
    expect(err(noDoc)).toBe('422 OJT_ACTIVITY_INCOMPLETE');
    expect(noDoc.body.error.details[0].message).toMatch(/evidence/i);
  });

  it('document evidence is a Task 30 link: the trainee links their own document, a stranger’s document is 404, the link does not widen access, and a second link is idempotent', async () => {
    const a1 = activities[1].id;
    const other = await prisma.document.create({ data: { documentNumber: 'DOC-2026-000902', title: 'Someone else’s file', categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: employees.EMP005, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } });
    expect(err(await as(emp, 'patch', `${L}/ojt/activities/${a1}`).send({ documentId: other.id }))).toBe('404 DOCUMENT_NOT_FOUND');
    const linked = await as(emp, 'patch', `${L}/ojt/activities/${a1}`).send({ documentId: docId });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ documentId: docId, documentTitle: 'Quality report v1' });
    expect(await prisma.documentLink.count({ where: { documentId: docId, entityType: 'OJT_ACTIVITY', entityId: a1 } })).toBe(1);
    expect((await as(emp, 'patch', `${L}/ojt/activities/${a1}`).send({ documentId: docId })).status).toBe(200);
    expect(await prisma.documentLink.count({ where: { documentId: docId, entityType: 'OJT_ACTIVITY' } })).toBe(1);
    // the link grants nothing: the trainer sees the title in the plan but the document itself still follows Task 30 rules
    expect(err(await as(mgrB, 'get', `/api/v1/documents/${docId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    // the Document Center's own link endpoint applies the same authority (owning module)
    expect(err(await as(emp4, 'post', `/api/v1/documents/${docId}/links`).send({ entityType: 'OJT_ACTIVITY', entityId: a1, relationType: 'OJT_EVIDENCE' }))).toMatch(/^(403 FORBIDDEN|404 NOT_FOUND)$/);
    const done = await as(emp, 'patch', `${L}/ojt/activities/${a1}`).send({ status: 'COMPLETED' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');
  });

  it('two simultaneous completions of the same activity yield exactly one transition; required activities cannot be skipped by the trainee', async () => {
    const a2 = activities[2].id; // optional activity
    await as(mgrA, 'post', `${L}/ojt/activities/${a2}/observations`).send({ criterionId: activities[2].observations[0].criterionId, result: 'MEETS' });
    const results = await Promise.all([as(emp, 'patch', `${L}/ojt/activities/${a2}`).send({ status: 'COMPLETED' }), as(mgrA, 'patch', `${L}/ojt/activities/${a2}`).send({ status: 'COMPLETED' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.ojtPlanActivity.findUniqueOrThrow({ where: { id: a2 } })).status).toBe('COMPLETED');
    expect(await prisma.auditLog.count({ where: { action: 'UPDATE_OJT_ACTIVITY', recordId: a2 } })).toBe(1);
    // a second plan for EMP004 proves skip rules
    const p2 = await as(hrAdmin, 'post', `${L}/ojt/plans`).send({ employeeId: employees.EMP004, programId, trainerEmployeeId: employees.MGRA, startDate: '2026-10-01' });
    await as(hrAdmin, 'post', `${L}/ojt/plans/${p2.body.data.id}/activate`);
    const req = p2.body.data.activities[0].id;
    expect(err(await as(emp4, 'patch', `${L}/ojt/activities/${req}`).send({ status: 'SKIPPED' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'patch', `${L}/ojt/activities/${req}`).send({ status: 'SKIPPED' }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans/${p2.body.data.id}/complete`))).toBe('409 OJT_REQUIRED_ACTIVITIES_OPEN');
    // HR admin cancels it; the plan is closed and its snapshot stays
    const c = await as(hrAdmin, 'post', `${L}/ojt/plans/${p2.body.data.id}/cancel`);
    expect(c.body.data.status).toBe('CANCELLED');
    expect(err(await as(mgrA, 'patch', `${L}/ojt/activities/${req}`).send({ status: 'IN_PROGRESS' }))).toBe('409 OJT_PLAN_NOT_ACTIVE');
  });

  it('final assessment is a human record by the trainer; MORE_PRACTICE_REQUIRED keeps the plan active; completion is one transition and marks the linked need fulfilled; SQL stays 3', async () => {
    expect(err(await as(emp, 'post', `${L}/ojt/plans/${planId}/assessments`).send({ outcome: 'COMPLETED' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrB, 'post', `${L}/ojt/plans/${planId}/assessments`).send({ outcome: 'COMPLETED' }))).toBe('403 FORBIDDEN');
    const more = await as(mgrA, 'post', `${L}/ojt/plans/${planId}/assessments`).send({ outcome: 'MORE_PRACTICE_REQUIRED', comment: 'One more report cycle before sign-off.' });
    expect(more.status).toBe(201);
    expect(more.body.data.status).toBe('ACTIVE');
    const final = await as(mgrA, 'post', `${L}/ojt/plans/${planId}/assessments`).send({ outcome: 'COMPLETED', comment: 'Ready.' });
    expect(final.body.data.assessment).toHaveLength(2);
    expect(final.body.data.status).toBe('ACTIVE'); // completion is HR's explicit act
    expect(final.body.data.can.complete).toBe(false); // HR admin only
    expect((await as(hrAdmin, 'get', `${L}/ojt/plans/${planId}`)).body.data.can.complete).toBe(true);
    expect(err(await as(mgrA, 'post', `${L}/ojt/plans/${planId}/complete`))).toBe('403 FORBIDDEN');
    const results = await Promise.all([as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/complete`), as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/complete`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const plan = (await as(hrAdmin, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(plan.status).toBe('COMPLETED');
    expect(plan.completedAt).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: 'COMPLETE_OJT_PLAN', recordId: planId } })).toBe(1);
    expect((await prisma.trainingNeed.findUniqueOrThrow({ where: { id: needId } })).status).toBe('FULFILLED');
    expect((await prisma.idpItem.findUniqueOrThrow({ where: { id: idpItemId } })).status).toBe('COMPLETED'); // untouched (was already COMPLETED); no IDP write
    expect(await prisma.notification.count({ where: { type: 'OJT_COMPLETED', userId: emp.user.id } })).toBe(1);
    expect(await sqlLevel()).toMatchObject({ finalLevel: 3, managerLevel: 3 });
    expect((await profileSql(emp)).currentLevel).toBe(3);
    expect(await prisma.competencyEvidence.count()).toBe(0);
    // the trainee sees the outcome, not the assessor's comment
    const mine = (await as(emp, 'get', `${L}/ojt/plans/${planId}`)).body.data;
    expect(mine.assessment.map((a: { outcome: string; comment: string | null }) => [a.outcome, a.comment])).toEqual([['MORE_PRACTICE_REQUIRED', null], ['COMPLETED', null]]);
  });

  it('the explicit evidence handoff creates competency evidence pointers, is idempotent, and changes no level (§25/§71)', async () => {
    expect(err(await as(mgrA, 'post', `${L}/ojt/plans/${planId}/competency-evidence`).send({}))).toBe('403 FORBIDDEN');
    const h = await as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/competency-evidence`).send({ note: 'Observed during OJT-2026' });
    expect(h.status).toBe(201);
    expect(h.body.data.map((e: { competencyName: string; observedLevel: number; sourceType: string }) => [e.competencyName, e.observedLevel, e.sourceType]).sort()).toEqual([['SQL', 4, 'OJT'], ['Visualization', 3, 'OJT']]);
    expect(h.body.data[0].sourceLabel).toMatch(/^OJT OJT-2026-\d{6}/);
    await as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/competency-evidence`).send({ competencyIds: [comp.SQL] });
    expect(await prisma.competencyEvidence.count()).toBe(2);
    expect(await sqlLevel()).toMatchObject({ finalLevel: 3, managerLevel: 3, selfLevel: 3 });
    const rows = await prisma.$queryRaw<{ final_level: number }[]>`SELECT "final_level" FROM "competency_assessment_items" WHERE "competency_id" = ${comp.SQL}`;
    expect(rows).toEqual([{ final_level: 3 }]);
    expect((await profileSql(emp)).currentLevel).toBe(3);
    expect(await prisma.competencyAssessment.count()).toBe(1); // no assessment created or finalized by OJT
    // the employee and the competency assessor can read the pointers; another employee cannot
    expect((await as(emp, 'get', `${L}/competency-evidence/${employees.EMP003}`)).body.data).toHaveLength(2);
    expect((await as(mgrA, 'get', `${L}/competency-evidence/${employees.EMP003}`)).body.data).toHaveLength(2);
    expect(err(await as(emp4, 'get', `${L}/competency-evidence/${employees.EMP003}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    expect(err(await as(mgrB, 'get', `${L}/competency-evidence/${employees.EMP003}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    expect(err(await as(hrAdmin, 'post', `${L}/ojt/plans/${planId}/competency-evidence`).send({ competencyIds: [comp.STAT] }))).toBe('422 VALIDATION_ERROR');
  });
});

describe('learning paths', () => {
  it('HR admin builds an ordered path with prerequisites; references are validated; assignment snapshots the steps and notifies; no duplicate active assignment', async () => {
    expect(err(await as(hrAdmin, 'post', `${L}/certifications/definitions`).send({ code: 'IDQ', name: 'Internal Data Quality Certification', issuerType: 'INTERNAL', validityDays: 365 })).startsWith('201')).toBe(true);
    certDefId = (await as(hrAdmin, 'get', `${L}/certifications/definitions`)).body.data[0].id;
    const body = { code: 'DA-SDA', name: 'Data Analyst → Senior Data Analyst Development', targetJobId: sdaJobId, steps: [
      { stepType: 'COURSE', referenceId: courseId, required: true },
      { stepType: 'OJT_PROGRAM', referenceId: programId, required: true, prerequisiteIndex: 0 },
      { stepType: 'IDP_ACTIVITY', title: 'Lead one quality review (IDP activity)', required: false, prerequisiteIndex: 1 },
      { stepType: 'CERTIFICATION', referenceId: certDefId, required: true, prerequisiteIndex: 1 },
    ] };
    expect(err(await as(hr, 'post', `${L}/paths`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/paths`).send({ ...body, steps: [{ stepType: 'COURSE', referenceId: 'nope', required: true }] }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${L}/paths`).send({ ...body, steps: [{ stepType: 'COURSE', referenceId: courseId, required: true, prerequisiteIndex: 0 }] }))).toBe('422 VALIDATION_ERROR'); // prerequisite must be earlier
    const r = await as(hrAdmin, 'post', `${L}/paths`).send(body);
    expect(r.status).toBe(201);
    pathId = r.body.data.id;
    expect(r.body.data.steps.map((s: { title: string }) => s.title)).toEqual(['Advanced SQL', 'Senior Data Analyst OJT', 'Lead one quality review (IDP activity)', 'Internal Data Quality Certification']);
    expect(r.body.data.steps[1].prerequisiteStepId).toBe(r.body.data.steps[0].id);
    expect(err(await as(mgrA, 'post', `${L}/paths/${pathId}/assignments`).send({ employeeId: employees.EMP003 }))).toBe('403 FORBIDDEN');
    const a = await as(hrAdmin, 'post', `${L}/paths/${pathId}/assignments`).send({ employeeId: employees.EMP003, targetDate: '2027-03-31' });
    expect(a.status).toBe(201);
    assignmentId = a.body.data.id;
    expect(a.body.data.status).toBe('ACTIVE');
    // progress projected from real completions: the course (completed enrolment) and the OJT (completed plan) are fulfilled; certification is AVAILABLE, IDP step AVAILABLE
    expect(a.body.data.steps.map((s: { state: string }) => s.state)).toEqual(['FULFILLED', 'FULFILLED', 'AVAILABLE', 'AVAILABLE']);
    expect(a.body.data.progress).toMatchObject({ total: 4, fulfilled: 2, requiredOpen: 1 });
    expect(await prisma.notification.count({ where: { type: 'LEARNING_PATH_ASSIGNED', userId: emp.user.id } })).toBe(1);
    const dup = await Promise.all([as(hrAdmin, 'post', `${L}/paths/${pathId}/assignments`).send({ employeeId: employees.EMP003 }), as(hrAdmin, 'post', `${L}/paths/${pathId}/assignments`).send({ employeeId: employees.EMP003 })]);
    expect(dup.map((x) => x.status).sort()).toEqual([409, 409]);
    expect(await prisma.learningPathAssignment.count({ where: { employeeId: employees.EMP003, status: 'ACTIVE' } })).toBe(1);
    // EMP004 has none of it: everything after step 0 is LOCKED
    const b = await as(hrAdmin, 'post', `${L}/paths/${pathId}/assignments`).send({ employeeId: employees.EMP004 });
    expect(b.body.data.steps.map((s: { state: string }) => s.state)).toEqual(['AVAILABLE', 'LOCKED', 'LOCKED', 'LOCKED']);
  });

  it('changing the path after assignment does not change the assignment (§65); the IDP step needs a human confirmation with a completed IDP item; path completion promotes nobody', async () => {
    const upd = await as(hrAdmin, 'patch', `${L}/paths/${pathId}`).send({ steps: [{ stepType: 'COURSE', referenceId: courseId, required: true }] });
    expect(upd.status).toBe(200);
    const a = (await as(hrAdmin, 'get', `${L}/path-assignments/${assignmentId}`)).body.data;
    expect(a.steps).toHaveLength(4);
    const idpStep = a.steps[2]; const certStep = a.steps[3];
    expect(err(await as(emp, 'post', `${L}/path-assignments/${assignmentId}/steps/${idpStep.id}/fulfil`).send({ idpItemId }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/path-assignments/${assignmentId}/steps/${certStep.id}/fulfil`).send({}))).toBe('409 LEARNING_STEP_NOT_MANUAL');
    const wrongItem = await prisma.idpItem.create({ data: { idpId: (await prisma.individualDevelopmentPlan.findFirstOrThrow()).id, title: 'Open item', developmentType: 'OJT', status: 'PLANNED' } });
    expect(err(await as(hrAdmin, 'post', `${L}/path-assignments/${assignmentId}/steps/${idpStep.id}/fulfil`).send({ idpItemId: wrongItem.id }))).toBe('409 IDP_ITEM_NOT_COMPLETED');
    const f = await as(hrAdmin, 'post', `${L}/path-assignments/${assignmentId}/steps/${idpStep.id}/fulfil`).send({ idpItemId, note: 'Led the September review' });
    expect(f.status).toBe(200);
    expect(f.body.data.steps[2]).toMatchObject({ state: 'FULFILLED', fulfilledBy: expect.stringMatching(/Hana/) });
    expect(f.body.data.status).toBe('ACTIVE'); // the certification step is still open
    expect(err(await as(hrAdmin, 'post', `${L}/path-assignments/${assignmentId}/steps/${idpStep.id}/fulfil`).send({ idpItemId }))).toBe('409 LEARNING_STEP_ALREADY_FULFILLED');
    expect((await prisma.idpItem.findUniqueOrThrow({ where: { id: idpItemId } })).updatedAt.getTime()).toBeLessThan(Date.now() - 1); // read only
    // employees see their own assignment; others do not
    expect((await as(emp, 'get', `${L}/path-assignments/${assignmentId}`)).body.data.steps).toHaveLength(4);
    expect(err(await as(emp4, 'get', `${L}/path-assignments/${assignmentId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    expect(err(await as(mgrB, 'get', `${L}/path-assignments/${assignmentId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
    expect((await as(mgrA, 'get', `${L}/path-assignments`)).body.data).toHaveLength(2);
  });
});

describe('certifications', () => {
  it('issue derives status and expiry from validity; duplicate issue is 409 (also concurrently); renewal keeps history; revoke is manual and audited; the path step is fulfilled by the certification', async () => {
    const t = new Date().toISOString().slice(0, 10);
    expect(err(await as(hr, 'post', `${L}/certifications`).send({ employeeId: employees.EMP003, definitionId: certDefId, issuedDate: t }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/certifications`).send({ employeeId: employees.EMP003, definitionId: certDefId, issuedDate: t, expiryDate: '2020-01-01' }))).toBe('422 VALIDATION_ERROR');
    const dup = await Promise.all([1, 2].map(() => as(hrAdmin, 'post', `${L}/certifications`).send({ employeeId: employees.EMP003, definitionId: certDefId, issuedDate: '2025-09-01', certificateNumber: 'IDQ-0001' })));
    expect(dup.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(await prisma.employeeCertification.count()).toBe(1);
    const first = dup.find((x) => x.status === 201)!.body.data;
    expect(first).toMatchObject({ status: 'EXPIRED', expiryDate: '2026-09-01', certificateNumber: 'IDQ-0001' });
    // the path's certification step is not fulfilled by an expired certification
    expect((await as(hrAdmin, 'get', `${L}/path-assignments/${assignmentId}`)).body.data.steps[3].state).toBe('AVAILABLE');
    const ren = await as(hrAdmin, 'post', `${L}/certifications/${first.id}/renew`).send({ issuedDate: t, certificateNumber: 'IDQ-0002', documentId: docId });
    expect(ren.status).toBe(201);
    certId = ren.body.data.id;
    expect(ren.body.data).toMatchObject({ status: 'ACTIVE', expiryDate: addDaysIso(t, 365), renewedFromId: first.id, documentTitle: 'Quality report v1' });
    expect(err(await as(hrAdmin, 'post', `${L}/certifications/${first.id}/renew`).send({ issuedDate: t }))).toBe('409 CERTIFICATION_ALREADY_RENEWED');
    expect(await prisma.employeeCertification.count({ where: { employeeId: employees.EMP003 } })).toBe(2); // history kept (§66)
    // the path assignment completes now that the last required step is fulfilled; the employee's job is unchanged
    const a = (await as(hrAdmin, 'get', `${L}/path-assignments/${assignmentId}`)).body.data;
    expect(a.status).toBe('COMPLETED');
    expect(a.steps[3]).toMatchObject({ state: 'FULFILLED' });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 }, select: { position: { select: { jobId: true } } } })).position!.jobId).toBe(daJobId);
    // an expiring-soon certification for EMP004 (20 days out)
    const soon = await as(hrAdmin, 'post', `${L}/certifications`).send({ employeeId: employees.EMP004, definitionId: certDefId, issuedDate: addDaysIso(t, -345) });
    expect(soon.body.data.status).toBe('EXPIRING_SOON');
    expect(soon.body.data.daysToExpiry).toBe(20);
    const list = await as(hrAdmin, 'get', `${L}/certifications?status=EXPIRING_SOON`);
    expect(list.body.data.map((c: { employeeId: string }) => c.employeeId)).toEqual([employees.EMP004]);
    // revoke: manual, reason recorded, length only in the audit
    expect(err(await as(mgrA, 'post', `${L}/certifications/${soon.body.data.id}/revoke`).send({ reason: 'x' }))).toBe('403 FORBIDDEN');
    const rv = await as(hrAdmin, 'post', `${L}/certifications/${soon.body.data.id}/revoke`).send({ reason: 'Issued to the wrong person' });
    expect(rv.body.data.status).toBe('REVOKED');
    expect(err(await as(hrAdmin, 'post', `${L}/certifications/${soon.body.data.id}/revoke`).send({ reason: 'again' }))).toBe('409 CERTIFICATION_ALREADY_REVOKED');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'REVOKE_EMPLOYEE_CERTIFICATION' } });
    expect(text(audit)).not.toMatch(/wrong person/);
    // scope: the employee sees own; manager A sees the team; manager B nothing
    expect((await as(emp, 'get', `${L}/certifications`)).body.data.map((c: { id: string }) => c.id).sort()).toEqual([first.id, certId].sort());
    expect((await as(mgrA, 'get', `${L}/certifications`)).body.meta.total).toBe(3);
    expect((await as(mgrB, 'get', `${L}/certifications`)).body.meta.total).toBe(0);
    expect(err(await as(emp4, 'get', `${L}/certifications/${certId}`))).toMatch(/^404 [A-Z_]*NOT_FOUND$/);
  });
});

describe('who sees what', () => {
  it('My learning carries own OJT, paths, certifications and evidence; the trainer queue carries assigned plans; trainer comments never reach the employee', async () => {
    const my = (await as(emp, 'get', `${L}/my`)).body.data;
    expect(my.ojt.map((p: { planNumber: string; status: string }) => p.status)).toEqual(['COMPLETED']);
    expect(my.paths).toHaveLength(1);
    expect(my.certifications).toHaveLength(2);
    expect(my.evidence).toHaveLength(2);
    expect(my.trainerQueue).toEqual([]);
    expect(text(my)).not.toMatch(/reconciliation step|Second run was clean|One more report cycle|Ready\./);
    expect(text(my)).toMatch(/row counts/); // own reflection
    const trainer = (await as(mgrA, 'get', `${L}/my`)).body.data;
    expect(trainer.ojt).toEqual([]);
    expect(trainer.trainerQueue).toEqual([]); // no ACTIVE plan is assigned any more
    expect((await as(mgrA, 'get', `${L}/ojt/plans?mine=trainer`)).body.meta.total).toBe(2);
    expect((await as(exec, 'get', `${L}/my`)).body.data).toMatchObject({ ojt: [], trainerQueue: [], paths: [], certifications: [] });
  });

  it('the executive sees the dashboard, report and datasets as aggregates only; HR sees the dashboard; managers cannot open the report', async () => {
    const dash = await as(exec, 'get', `${L}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.data.ojt).toMatchObject({ active: 0, completedLast90Days: 1 });
    expect(dash.body.data.certifications).toMatchObject({ active: 1, expired: 1, revoked: 1 });
    expect(dash.body.data.paths).toMatchObject({ active: 1, completedLast90Days: 1 });
    const rep = await as(exec, 'get', `${L}/reports?from=2026-01-01&to=2026-12-31`);
    expect(rep.status).toBe(200);
    expect(rep.body.data.ojt.byProgram[0]).toMatchObject({ program: 'Senior Data Analyst OJT', plans: 2, completed: 1 });
    expect(rep.body.data.certifications.byDefinition[0]).toMatchObject({ certification: 'Internal Data Quality Certification', active: 1, expired: 1, revoked: 1 });
    for (const payload of [dash.body.data, rep.body.data]) expect(forbiddenKeys(payload, /^(employeeId|employeeCode|employeeName|firstName|lastName|name|trainerComment|employeeReflection|comment|certificateNumber|documentId|planNumber)$/)).toEqual([]);
    expect(text(rep.body.data)).not.toMatch(/Emma|Alice|IDQ-000|reconciliation|row counts/);
    expect(err(await as(exec, 'get', `${L}/ojt/plans`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${L}/certifications`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'get', `${L}/reports`))).toBe('403 FORBIDDEN');
    expect((await as(hr, 'get', `${L}/dashboard`)).status).toBe(200);
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const o = await run(exec, 'ojt_summary', ['program', 'department', 'status', 'activities', 'activitiesCompleted', 'completionDays']);
    expect(err(o)).toBe('200');
    expect(o.body.data.rows.find((x: { status: string }) => x.status === 'COMPLETED')).toMatchObject({ program: 'Senior Data Analyst OJT', department: 'Analytics', activities: 3, activitiesCompleted: 3 });
    const p = await run(exec, 'learning_path_summary', ['path', 'department', 'status', 'steps', 'fulfilled', 'progressPct']);
    expect(p.body.data.rows.find((x: { status: string }) => x.status === 'COMPLETED')).toMatchObject({ department: 'Analytics', steps: 4, fulfilled: 4, progressPct: 100 });
    const c = await run(hr, 'certification_summary', ['certification', 'issuerType', 'department', 'status', 'renewal']);
    expect(c.body.data.rows.map((x: { status: string }) => x.status).sort()).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED']);
    expect(c.body.data.rows.find((x: { status: string }) => x.status === 'ACTIVE')).toMatchObject({ certification: 'Internal Data Quality Certification', issuerType: 'INTERNAL', renewal: true });
    for (const r of [o, p, c]) expect(text(r.body)).not.toMatch(/Emma|EMP003|IDQ-000|Quality report|reconciliation|row counts|Alice/);
    expect(err(await run(emp, 'ojt_summary', ['program']))).toMatch(/^40[134]/);
    expect(err(await run(mgrA, 'certification_summary', ['certification']))).toMatch(/^40[134]/);
  });

  it('the Employee 360 carries learning statuses only; the privacy export carries own records and reflections but no trainer comment', async () => {
    const e360 = (await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(e360.sections.development.learning.ojt[0]).toMatchObject({ program: 'Senior Data Analyst OJT', status: 'COMPLETED', activitiesCompleted: 3, activities: 3 });
    expect(e360.sections.development.learning.learningPaths[0]).toMatchObject({ status: 'COMPLETED', stepsFulfilled: 4, steps: 4 });
    expect(e360.sections.development.learning.certifications.map((c: { status: string }) => c.status).sort()).toEqual(['ACTIVE', 'EXPIRED']);
    expect(text(e360.sections.development.learning)).not.toMatch(/reconciliation|row counts|Second run|IDQ-000|Ready\./);
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    const exported = JSON.parse(x.text);
    expect(exported.data.learning.ojtPlans[0]).toMatchObject({ programNameSnapshot: 'Senior Data Analyst OJT', status: 'COMPLETED' });
    expect(exported.data.learning.ojtPlans[0].activities[0]).toMatchObject({ status: 'COMPLETED', employeeReflection: expect.stringMatching(/row counts/) });
    expect(exported.data.learning.ojtPlans[0].activities[0].observations[0]).toMatchObject({ result: 'MEETS' });
    expect(exported.data.learning.certifications).toHaveLength(2);
    expect(exported.data.learning.pathAssignments[0].status).toBe('COMPLETED');
    expect(x.text).not.toMatch(/reconciliation step|Second run was clean|One more report cycle|Ready\./);
    expect(exported.notIncluded.some((n: { category: string }) => /trainer comments/.test(n.category))).toBe(true);
    const ev = await prisma.auditLog.findFirst({ where: { action: 'EXPORT_EMPLOYEE_PERSONAL_DATA' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(ev!.newValue!).counts).toMatchObject({ ojtPlans: 1, learningPathAssignments: 1, certifications: 2 });
  });

  it('audit entries exist for every learning mutation and carry no comment, reflection, evidence title or certificate number', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { module: 'learning' }, select: { action: true } })).map((a) => a.action);
    for (const a of ['CREATE_OJT_PROGRAM', 'UPDATE_OJT_PROGRAM', 'CREATE_OJT_PLAN', 'ACTIVATE_OJT_PLAN', 'UPDATE_OJT_ACTIVITY', 'SUBMIT_OJT_OBSERVATION', 'SUBMIT_OJT_ASSESSMENT', 'COMPLETE_OJT_PLAN', 'CANCEL_OJT_PLAN', 'CREATE_COMPETENCY_EVIDENCE_FROM_OJT', 'CREATE_LEARNING_PATH', 'UPDATE_LEARNING_PATH', 'ASSIGN_LEARNING_PATH', 'UPDATE_LEARNING_PATH_ASSIGNMENT', 'CREATE_CERTIFICATION_DEFINITION', 'ISSUE_EMPLOYEE_CERTIFICATION', 'RENEW_EMPLOYEE_CERTIFICATION', 'REVOKE_EMPLOYEE_CERTIFICATION']) expect(actions, a).toContain(a);
    const all = text(await prisma.auditLog.findMany({ where: { module: 'learning' } }));
    expect(all).not.toMatch(/reconciliation step|row counts|Second run was clean|One more report cycle|Missed the duplicate|IDQ-000|Quality report v1|wrong person|Led the September/);
  });

  it('cross-domain isolation: OJT, paths and certifications wrote nothing to payroll, performance, employee relations, talent, recruitment or the employee master', async () => {
    expect(await prisma.payrollRun.count()).toBe(0);
    expect(await prisma.performanceCycle.count()).toBe(0);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
    expect(await prisma.talentReviewCycle.count()).toBe(0);
    expect(await prisma.competencyAssessment.count()).toBe(1);
    expect(await prisma.competencyAssessmentItem.count()).toBe(1);
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 }, select: { positionId: true, employmentStatus: true, departmentId: true } });
    expect(e).toMatchObject({ employmentStatus: 'ACTIVE', departmentId: dataDeptId });
    expect(await prisma.idpItem.count({ where: { status: 'COMPLETED' } })).toBe(1); // still the one we seeded; no IDP writes
    expect(opsDeptId).toBeTruthy();
  });
});
