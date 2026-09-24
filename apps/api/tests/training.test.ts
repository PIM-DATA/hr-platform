/**
 * Task 25 — TNA, training and IDP MVP.
 *
 * The questions under test: does a competency gap turn into a development need without being recalculated, does an
 * unassessed competency stay out of it, is a session's capacity safe under concurrent booking, and — above all —
 * does completing a course leave the competency level exactly where the assessment put it.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completionRate, trainingHours } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, hrd: Session, mgr: Session, emp1: Session, emp2: Session, exec: Session;
let deptId: string, jobId: string, otherDeptId: string;
const emp: Record<string, string> = {};
const comp: Record<string, string> = {};
let courseId: string, sessionId: string, needId: string, idpId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'TRN', name: 'Training Co', timezone: 'Asia/Bangkok' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'DATA', name: 'Data' } });
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id;
  otherDeptId = otherDept.id;
  const job = await prisma.job.create({ data: { code: 'ANALYST', title: 'Data Analyst', level: 3 } });
  jobId = job.id;
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'DA1', title: 'Data Analyst', jobId: job.id } });
  const otherPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OP1', title: 'Operations Officer', jobId: job.id } });

  const mk = async (code: string, managerId: string | null, positionId = position.id, departmentId = dept.id) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@trn.local`,
        hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.EMP003 = await mk('EMP003', emp.MGR);
  emp.EMP004 = await mk('EMP004', emp.MGR);
  emp.OTHER = await mk('OTHER', null, otherPosition.id, otherDept.id);

  await createUser({ email: 'admin@trn.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hrd@trn.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'mgr@trn.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'emp1@trn.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP003 });
  await createUser({ email: 'emp2@trn.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP004 });
  await createUser({ email: 'exec@trn.local', password: PW, role: 'EXECUTIVE' });
  [admin, hrd, mgr, emp1, emp2, exec] = await Promise.all(
    ['admin', 'hrd', 'mgr', 'emp1', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@trn.local`, PW)),
  );

  // --- the competency side, built through its own API so this test consumes it the way Task 25 does ---
  const scale = await as(hrd, 'post', '/api/v1/competency/scales').send({
    code: 'STD5', name: 'Standard', levels: [1, 2, 3, 4, 5].map((level) => ({ level, label: `L${level}` })),
  });
  const category = await as(hrd, 'post', '/api/v1/competency/categories').send({ code: 'TECH', name: 'Technical' });
  for (const [code, name] of [['SQL', 'SQL'], ['DATAVIZ', 'Data Visualization'], ['COMMUNICATION', 'Communication']] as const) {
    const created = await as(hrd, 'post', '/api/v1/competency/competencies').send({ code, name, categoryId: category.body.data.id, scaleId: scale.body.data.id });
    comp[code] = created.body.data.id;
  }
  for (const [code, level] of [['SQL', 5], ['DATAVIZ', 4], ['COMMUNICATION', 3]] as const) {
    await as(hrd, 'put', `/api/v1/competency/jobs/${jobId}/profile`).send({ competencyId: comp[code], requiredLevel: level });
  }

  // EMP003 assessed at SQL 3, DATAVIZ 4 (Communication deliberately left out of the cycle: it is UNASSESSED)
  const cycle = await as(hrd, 'post', '/api/v1/competency/cycles').send({ code: 'C1', name: 'Cycle 1', periodStart: '2026-01-01', periodEnd: '2026-12-31', selfAssessmentRequired: false });
  await as(hrd, 'post', `/api/v1/competency/cycles/${cycle.body.data.id}/assign`).send({ employeeIds: [emp.EMP003] });
  await as(hrd, 'post', `/api/v1/competency/cycles/${cycle.body.data.id}/activate`);
  await as(hrd, 'post', `/api/v1/competency/cycles/${cycle.body.data.id}/open-review`);
  const assessment = (await as(mgr, 'get', '/api/v1/competency/assessments?view=reviewing')).body.data[0];
  const items = (await as(mgr, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data.items;
  // Communication was on the job profile when assigned, so remove it from the assessment to leave it unassessed.
  await prisma.competencyAssessmentItem.deleteMany({ where: { assessmentId: assessment.id, competencyCodeSnapshot: 'COMMUNICATION' } });
  const levels: Record<string, number> = { SQL: 3, DATAVIZ: 4 };
  for (const item of items.filter((i: { competencyCode: string }) => i.competencyCode !== 'COMMUNICATION')) {
    await as(mgr, 'patch', `/api/v1/competency/items/${item.id}/manager`).send({ managerLevel: levels[item.competencyCode] });
  }
  const finalized = await as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`);
  expect(finalized.status).toBe(200);
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('the pure rules', () => {
  it('a completion rate excludes cancelled and still-enrolled people', () => {
    expect(completionRate({ completed: 3, failed: 1, noShow: 1 })).toBe(60);
    expect(completionRate({ completed: 0, failed: 0, noShow: 0 })).toBeNull();
  });

  it('training hours count attended and completed places only', () => {
    expect(trainingHours([
      { status: 'COMPLETED', durationMinutes: 90 },
      { status: 'ATTENDED', durationMinutes: 90 },
      { status: 'ENROLLED', durationMinutes: 90 },
      { status: 'NO_SHOW', durationMinutes: 90 },
    ])).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('TNA — from the competency gap to a need', () => {
  it('generates a need per real gap, carries the gap it came from, and never invents one for an unassessed competency', async () => {
    const generated = await as(hrd, 'post', '/api/v1/training/needs/generate').send({ departmentId: deptId });
    expect(generated.status).toBe(201);
    // SQL 3 of 5 is a gap; DATAVIZ 4 of 4 is not; COMMUNICATION was never assessed.
    expect(generated.body.data.created).toBe(1);
    expect(generated.body.data.assessmentRequired).toEqual(expect.arrayContaining([{ employeeCode: 'EMP003', competencyCode: 'COMMUNICATION' }]));
    expect(generated.body.data.assessmentRequired.some((r: { employeeCode: string }) => r.employeeCode === 'EMP004')).toBe(true); // never assessed at all

    const needs = await as(hrd, 'get', `/api/v1/training/needs?view=all&departmentId=${deptId}`);
    expect(needs.body.data).toHaveLength(1);
    const need = needs.body.data[0];
    needId = need.id;
    expect(need.employee.employeeCode).toBe('EMP003');
    expect(need.competency.code).toBe('SQL');
    expect(need.source).toBe('COMPETENCY_GAP');
    expect(need.gapSnapshot).toEqual({ currentLevel: 3, requiredLevel: 5, gap: 2 });
    expect(need.snapshot.jobTitle).toBe('Data Analyst');
    expect(need.sourceAssessmentDate).toBeTruthy();
    expect(need.currentGapStatus).toBe('GAP');
    // Nothing was made for the unassessed competency, and nothing for the person nobody assessed.
    expect(await prisma.trainingNeed.count({ where: { competencyId: comp.COMMUNICATION } })).toBe(0);
    expect(await prisma.trainingNeed.count({ where: { employeeId: emp.EMP004 } })).toBe(0);
  }, 60000);

  it('is idempotent: the same gap does not become a second need', async () => {
    const again = await as(hrd, 'post', '/api/v1/training/needs/generate').send({ departmentId: deptId });
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.alreadyOpen).toBe(1);
    expect(await prisma.trainingNeed.count({ where: { employeeId: emp.EMP003, competencyId: comp.SQL } })).toBe(1);
  });

  it('keeps the gap it was raised from when the job requirement moves, while the live gap changes', async () => {
    await as(hrd, 'put', `/api/v1/competency/jobs/${jobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 4 });
    const need = (await as(hrd, 'get', `/api/v1/training/needs/${needId}`)).body.data;
    expect(need.gapSnapshot).toEqual({ currentLevel: 3, requiredLevel: 5, gap: 2 }); // history
    const live = (await as(hrd, 'get', `/api/v1/competency/skill-gaps?employeeId=${emp.EMP003}`)).body.data.find((r: { competencyCode: string }) => r.competencyCode === 'SQL');
    expect(live.gapNeeded).toBe(1); // today
    await as(hrd, 'put', `/api/v1/competency/jobs/${jobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 5 });
  });

  it('a manual need needs no competency at all', async () => {
    const manual = await as(hrd, 'post', '/api/v1/training/needs').send({ employeeId: emp.EMP004, title: 'Compliance refresher', priority: 'HIGH' });
    expect(manual.status).toBe(201);
    expect(manual.body.data.source).toBe('MANUAL');
    expect(manual.body.data.gapSnapshot).toBeNull();
    expect(manual.body.data.competency).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the catalogue', () => {
  it('a course maps to the competencies it develops, and suggests itself to a matching need', async () => {
    const created = await as(hrd, 'post', '/api/v1/training/courses').send({
      code: 'SQL_ADV', title: 'Advanced SQL', deliveryMethod: 'CLASSROOM', durationMinutes: 480, providerType: 'INTERNAL', competencyIds: [comp.SQL],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.competencies[0].code).toBe('SQL');
    courseId = created.body.data.id;

    expect(err(await as(hrd, 'post', '/api/v1/training/courses').send({ code: 'SQL_ADV', title: 'Dup', deliveryMethod: 'VIRTUAL' }))).toBe('409 TRAINING_COURSE_CODE_TAKEN');
    expect(err(await as(mgr, 'post', '/api/v1/training/courses').send({ code: 'SNEAK', title: 'Sneaky', deliveryMethod: 'VIRTUAL' }))).toBe('403 FORBIDDEN');

    const suggested = await as(hrd, 'get', `/api/v1/training/needs/${needId}/suggested-courses`);
    expect(suggested.body.data.map((c: { code: string }) => c.code)).toEqual(['SQL_ADV']);
  });

  it('a session freezes the course, keeps its own timezone, and refuses impossible dates', async () => {
    const backwards = await as(hrd, 'post', '/api/v1/training/sessions').send({
      courseId, startAt: '2026-10-10T09:00:00+07:00', endAt: '2026-10-10T08:00:00+07:00', timezone: 'Asia/Bangkok',
    });
    expect(backwards.status).toBe(400);

    const created = await as(hrd, 'post', '/api/v1/training/sessions').send({
      courseId, startAt: '2026-10-10T09:00:00+07:00', endAt: '2026-10-10T17:00:00+07:00', timezone: 'Asia/Bangkok', location: 'Room 4', capacity: 10,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.startAt).toBe('2026-10-10T02:00:00.000Z'); // stored as UTC
    expect(created.body.data.timezone).toBe('Asia/Bangkok');
    expect(created.body.data.status).toBe('DRAFT');
    sessionId = created.body.data.id;

    // A retired course keeps its sessions but takes no new ones.
    await as(hrd, 'patch', `/api/v1/training/courses/${courseId}`).send({ isActive: false });
    expect(err(await as(hrd, 'post', '/api/v1/training/sessions').send({ courseId, startAt: '2026-11-01T09:00:00+07:00', endAt: '2026-11-01T17:00:00+07:00', timezone: 'Asia/Bangkok' })))
      .toBe('409 TRAINING_COURSE_INACTIVE');
    expect((await as(hrd, 'get', `/api/v1/training/sessions/${sessionId}`)).status).toBe(200);
    await as(hrd, 'patch', `/api/v1/training/courses/${courseId}`).send({ isActive: true, title: 'Advanced SQL (2027 edition)' });
    // ...and the renamed course does not rename the session already scheduled from it.
    expect((await prisma.trainingSession.findUniqueOrThrow({ where: { id: sessionId } })).courseTitleSnapshot).toBe('Advanced SQL');
    await as(hrd, 'patch', `/api/v1/training/courses/${courseId}`).send({ title: 'Advanced SQL' });
  });
});

// ---------------------------------------------------------------------------
describe('enrolment', () => {
  it('books people in bulk against a need, once each, and moves the need to in progress', async () => {
    await as(hrd, 'post', `/api/v1/training/sessions/${sessionId}/open`);
    const result = await as(hrd, 'post', `/api/v1/training/sessions/${sessionId}/enroll`).send({ employeeIds: [emp.EMP003, emp.EMP004], source: 'TNA', trainingNeedId: needId });
    expect(result.status).toBe(201);
    expect(result.body.data.enrolled).toBe(2);

    const again = await as(hrd, 'post', `/api/v1/training/sessions/${sessionId}/enroll`).send({ employeeIds: [emp.EMP003] });
    expect(again.body.data.enrolled).toBe(0);
    expect(again.body.data.alreadyEnrolled).toBe(1);
    expect(await prisma.trainingEnrollment.count({ where: { sessionId } })).toBe(2);

    expect((await as(hrd, 'get', `/api/v1/training/needs/${needId}`)).body.data.status).toBe('IN_PROGRESS');
    expect((await as(hrd, 'get', `/api/v1/training/sessions/${sessionId}`)).body.data.seatsLeft).toBe(8);
    expect(err(await as(mgr, 'post', `/api/v1/training/sessions/${sessionId}/enroll`).send({ employeeIds: [emp.EMP003] }))).toBe('403 FORBIDDEN');
  });

  it('a session with one seat cannot end up with two people on it', async () => {
    const tiny = await as(hrd, 'post', '/api/v1/training/sessions').send({
      courseId, startAt: '2026-11-05T09:00:00+07:00', endAt: '2026-11-05T12:00:00+07:00', timezone: 'Asia/Bangkok', capacity: 1,
    });
    await as(hrd, 'post', `/api/v1/training/sessions/${tiny.body.data.id}/open`);
    const race = await Promise.all([
      as(hrd, 'post', `/api/v1/training/sessions/${tiny.body.data.id}/enroll`).send({ employeeIds: [emp.EMP003] }),
      as(admin, 'post', `/api/v1/training/sessions/${tiny.body.data.id}/enroll`).send({ employeeIds: [emp.EMP004] }),
    ]);
    const enrolled = race.reduce((sum, r) => sum + (r.body.data?.enrolled ?? 0), 0);
    const full = race.some((r) => r.body.data?.skipped?.some((s: { reason: string }) => /full/i.test(s.reason)));
    expect(enrolled).toBe(1);
    expect(full).toBe(true);
    expect(await prisma.trainingEnrollment.count({ where: { sessionId: tiny.body.data.id, status: { not: 'CANCELLED' } } })).toBe(1);
  }, 60000);

  it('the same person booked twice at once gets one place', async () => {
    const solo = await as(hrd, 'post', '/api/v1/training/sessions').send({
      courseId, startAt: '2026-11-06T09:00:00+07:00', endAt: '2026-11-06T12:00:00+07:00', timezone: 'Asia/Bangkok',
    });
    await as(hrd, 'post', `/api/v1/training/sessions/${solo.body.data.id}/open`);
    const race = await Promise.all([
      as(hrd, 'post', `/api/v1/training/sessions/${solo.body.data.id}/enroll`).send({ employeeIds: [emp.EMP003] }),
      as(admin, 'post', `/api/v1/training/sessions/${solo.body.data.id}/enroll`).send({ employeeIds: [emp.EMP003] }),
    ]);
    expect(race.every((r) => r.status === 201)).toBe(true);
    expect(await prisma.trainingEnrollment.count({ where: { sessionId: solo.body.data.id, employeeId: emp.EMP003 } })).toBe(1);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('attendance, results and what they do to the need', () => {
  it('completing fulfils the need; not turning up does not; and a session completing does nothing to anybody', async () => {
    await as(hrd, 'post', `/api/v1/training/sessions/${sessionId}/start`);
    const rows = (await as(hrd, 'get', `/api/v1/training/enrollments?view=all&sessionId=${sessionId}`)).body.data;
    const mine = rows.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP003');
    const theirs = rows.find((r: { employee: { employeeCode: string } }) => r.employee.employeeCode === 'EMP004');

    // EMP004 never turned up.
    const noShow = await as(hrd, 'post', `/api/v1/training/enrollments/${theirs.id}/attendance`).send({ status: 'NO_SHOW' });
    expect(noShow.body.data.status).toBe('NO_SHOW');

    // EMP003 attended and passed.
    expect((await as(hrd, 'post', `/api/v1/training/enrollments/${mine.id}/attendance`).send({ status: 'ATTENDED' })).body.data.status).toBe('ATTENDED');
    expect(err(await as(mgr, 'post', `/api/v1/training/enrollments/${mine.id}/result`).send({ status: 'COMPLETED' }))).toBe('403 FORBIDDEN');
    const completed = await as(hrd, 'post', `/api/v1/training/enrollments/${mine.id}/result`).send({ status: 'COMPLETED', score: '82.5' });
    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.score).toBe('82.50');

    const need = (await as(hrd, 'get', `/api/v1/training/needs/${needId}`)).body.data;
    expect(need.status).toBe('FULFILLED');

    // A recorded outcome is final.
    expect(err(await as(hrd, 'post', `/api/v1/training/enrollments/${mine.id}/attendance`).send({ status: 'NO_SHOW' }))).toBe('409 TRAINING_ENROLLMENT_FINISHED');
    expect(err(await as(hrd, 'post', `/api/v1/training/enrollments/${theirs.id}/result`).send({ status: 'COMPLETED' }))).toBe('409 TRAINING_ENROLLMENT_FINISHED');

    // Completing the session changes nobody's record.
    await as(hrd, 'post', `/api/v1/training/sessions/${sessionId}/complete`);
    const after = (await as(hrd, 'get', `/api/v1/training/enrollments?view=all&sessionId=${sessionId}`)).body.data;
    expect(after.map((r: { status: string }) => r.status).sort()).toEqual(['COMPLETED', 'NO_SHOW']);
  }, 60000);

  it('completing training leaves the competency exactly where the assessment put it', async () => {
    // The whole point of the module boundary: SQL was assessed at 3, and Advanced SQL was completed.
    const profile = (await as(emp1, 'get', '/api/v1/competency/profile/me')).body.data;
    const sql = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'SQL');
    expect(sql.currentLevel).toBe(3);
    expect(sql.gapNeeded).toBe(2);
    expect(await prisma.competencyAssessmentItem.findFirst({ where: { competencyId: comp.SQL, assessment: { employeeId: emp.EMP003 } }, select: { finalLevel: true } })).toMatchObject({ finalLevel: 3 });
  });

  it('a failed result and a cancelled session both leave the need unfulfilled', async () => {
    const generated = await as(hrd, 'post', '/api/v1/training/needs/generate').send({ employeeId: emp.EMP004 });
    expect(generated.body.data.created).toBe(0); // EMP004 has never been assessed — no need is invented
    const manual = (await as(hrd, 'get', `/api/v1/training/needs?view=all&employeeId=${emp.EMP004}`)).body.data[0];

    const retake = await as(hrd, 'post', '/api/v1/training/sessions').send({ courseId, startAt: '2026-12-01T09:00:00+07:00', endAt: '2026-12-01T17:00:00+07:00', timezone: 'Asia/Bangkok' });
    await as(hrd, 'post', `/api/v1/training/sessions/${retake.body.data.id}/open`);
    await as(hrd, 'post', `/api/v1/training/sessions/${retake.body.data.id}/enroll`).send({ employeeIds: [emp.EMP004], source: 'TNA', trainingNeedId: manual.id });
    expect((await as(hrd, 'get', `/api/v1/training/needs/${manual.id}`)).body.data.status).toBe('IN_PROGRESS');

    const place = (await as(hrd, 'get', `/api/v1/training/enrollments?view=all&sessionId=${retake.body.data.id}`)).body.data[0];
    await as(hrd, 'post', `/api/v1/training/enrollments/${place.id}/result`).send({ status: 'FAILED' });
    expect((await as(hrd, 'get', `/api/v1/training/needs/${manual.id}`)).body.data.status).toBe('IN_PROGRESS'); // not fulfilled

    // Book them again; cancel the session; the place is cancelled and the need is back to planned.
    const another = await as(hrd, 'post', '/api/v1/training/sessions').send({ courseId, startAt: '2026-12-15T09:00:00+07:00', endAt: '2026-12-15T17:00:00+07:00', timezone: 'Asia/Bangkok' });
    await as(hrd, 'post', `/api/v1/training/sessions/${another.body.data.id}/open`);
    await as(hrd, 'post', `/api/v1/training/sessions/${another.body.data.id}/enroll`).send({ employeeIds: [emp.EMP004], source: 'TNA', trainingNeedId: manual.id });
    const cancelled = await as(hrd, 'post', `/api/v1/training/sessions/${another.body.data.id}/cancel`);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    const places = (await as(hrd, 'get', `/api/v1/training/enrollments?view=all&sessionId=${another.body.data.id}`)).body.data;
    expect(places[0].status).toBe('CANCELLED');
    expect((await as(hrd, 'get', `/api/v1/training/needs/${manual.id}`)).body.data.status).toBe('PLANNED');
    expect(await prisma.notification.count({ where: { type: 'TRAINING_SESSION_UPDATED' } })).toBeGreaterThan(0);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('development plans', () => {
  it('a plan is built from needs and activities, activated, progressed and completed — and then frozen', async () => {
    const created = await as(hrd, 'post', '/api/v1/training/idps').send({ employeeId: emp.EMP003, title: '2026 development', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    expect(created.status).toBe(201);
    idpId = created.body.data.id;
    expect(created.body.data.manager.name).toBe('MGR Person');
    expect(err(await as(hrd, 'post', '/api/v1/training/idps').send({ employeeId: emp.EMP003, title: 'Clash', periodStart: '2026-06-01', periodEnd: '2026-08-31' }))).toBe('409 IDP_PERIOD_OVERLAP');
    expect(err(await as(hrd, 'post', `/api/v1/training/idps/${idpId}/activate`))).toBe('422 IDP_EMPTY');

    const fromNeed = await as(hrd, 'post', `/api/v1/training/idps/${idpId}/items`).send({ title: 'Complete Advanced SQL', developmentType: 'TRAINING', trainingNeedId: needId, linkedCourseId: courseId });
    expect(fromNeed.status).toBe(201);
    expect(fromNeed.body.data.items[0].competency.code).toBe('SQL'); // inherited from the need, and frozen
    const ojt = await as(hrd, 'post', `/api/v1/training/idps/${idpId}/items`).send({ title: 'Shadow the reporting run', developmentType: 'OJT', targetDate: '2026-09-30' });
    expect(ojt.body.data.items).toHaveLength(2);

    await as(hrd, 'post', `/api/v1/training/idps/${idpId}/activate`);
    expect((await as(emp1, 'get', `/api/v1/training/idps/${idpId}`)).body.data.status).toBe('ACTIVE');

    const ojtItem = ojt.body.data.items.find((i: { developmentType: string }) => i.developmentType === 'OJT');
    const progressed = await as(emp1, 'patch', `/api/v1/training/idp-items/${ojtItem.id}/progress`).send({ progressPercent: 60, employeeComment: 'Two runs shadowed' });
    expect(progressed.status).toBe(200);
    expect(progressed.body.data.items.find((i: { id: string }) => i.id === ojtItem.id).status).toBe('IN_PROGRESS');

    expect(err(await as(hrd, 'post', `/api/v1/training/idps/${idpId}/complete`))).toBe('422 IDP_ITEMS_OUTSTANDING');
    await as(hrd, 'patch', `/api/v1/training/idp-items/${ojtItem.id}`).send({ status: 'COMPLETED', managerComment: 'Done well' });
    const sqlItem = fromNeed.body.data.items[0];
    await as(hrd, 'patch', `/api/v1/training/idp-items/${sqlItem.id}`).send({ status: 'COMPLETED' });

    const race = await Promise.all([
      as(hrd, 'post', `/api/v1/training/idps/${idpId}/complete`),
      as(hrd, 'post', `/api/v1/training/idps/${idpId}/complete`),
    ]);
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    expect(err(await as(hrd, 'post', `/api/v1/training/idps/${idpId}/items`).send({ title: 'Late', developmentType: 'OTHER' }))).toBe('409 IDP_FINISHED');
  }, 60000);

  it('a training item completes when the training it is booked against completes', async () => {
    const plan = await as(hrd, 'post', '/api/v1/training/idps').send({ employeeId: emp.EMP004, title: 'Ops development', periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    const item = (await as(hrd, 'post', `/api/v1/training/idps/${plan.body.data.id}/items`).send({ title: 'Advanced SQL', developmentType: 'TRAINING', linkedCourseId: courseId })).body.data.items[0];
    await as(hrd, 'post', `/api/v1/training/idps/${plan.body.data.id}/activate`);
    const session = await as(hrd, 'post', '/api/v1/training/sessions').send({ courseId, startAt: '2027-02-01T09:00:00+07:00', endAt: '2027-02-01T17:00:00+07:00', timezone: 'Asia/Bangkok' });
    await as(hrd, 'post', `/api/v1/training/sessions/${session.body.data.id}/open`);
    await as(hrd, 'post', `/api/v1/training/sessions/${session.body.data.id}/enroll`).send({ employeeIds: [emp.EMP004], source: 'IDP', idpItemId: item.id });
    expect((await as(hrd, 'get', `/api/v1/training/idps/${plan.body.data.id}`)).body.data.items[0].status).toBe('IN_PROGRESS');

    const place = (await as(hrd, 'get', `/api/v1/training/enrollments?view=all&sessionId=${session.body.data.id}`)).body.data[0];
    await as(hrd, 'post', `/api/v1/training/enrollments/${place.id}/result`).send({ status: 'COMPLETED' });
    const after = (await as(hrd, 'get', `/api/v1/training/idps/${plan.body.data.id}`)).body.data.items[0];
    expect(after.status).toBe('COMPLETED');
    expect(after.progressPercent).toBe(100);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('who may see what', () => {
  it('an employee sees their own development and nobody else\'s', async () => {
    const mine = await as(emp1, 'get', '/api/v1/training/me');
    expect(mine.status).toBe(200);
    expect(mine.body.data.history.some((e: { status: string }) => e.status === 'COMPLETED')).toBe(true);
    expect(mine.body.data.idps).toHaveLength(1);
    expect(mine.body.data.summary.trainingHours).toBe(8);

    const theirs = (await as(hrd, 'get', `/api/v1/training/idps?view=all&employeeId=${emp.EMP004}`)).body.data[0];
    expect(err(await as(emp1, 'get', `/api/v1/training/idps/${theirs.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', '/api/v1/training/needs?view=all'))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', '/api/v1/training/idps?view=all'))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', '/api/v1/training/reports/overview'))).toBe('403 FORBIDDEN');
    // The employee never sees HR's private note.
    const own = (await as(emp1, 'get', `/api/v1/training/idps/${idpId}`)).body.data;
    expect(own.items.every((i: Record<string, unknown>) => !('hrComment' in i))).toBe(true);
  });

  it('a manager gets a team summary — counts, no comments — and cannot administer training', async () => {
    const team = await as(mgr, 'get', '/api/v1/training/team');
    expect(team.status).toBe(200);
    expect(team.body.data.teamSize).toBe(3); // themselves and two reports
    expect(team.body.data.members.some((m: { employeeCode: string }) => m.employeeCode === 'OTHER')).toBe(false);
    expect(JSON.stringify(team.body.data)).not.toMatch(/Two runs shadowed|Done well/);

    expect(err(await as(mgr, 'post', '/api/v1/training/sessions').send({ courseId, startAt: '2027-03-01T09:00:00+07:00', endAt: '2027-03-01T17:00:00+07:00', timezone: 'Asia/Bangkok' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'post', '/api/v1/training/needs/generate').send({ departmentId: deptId }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'post', '/api/v1/training/idps').send({ employeeId: emp.EMP003, title: 'x', periodStart: '2028-01-01', periodEnd: '2028-12-31' }))).toBe('403 FORBIDDEN');
    // A manager may read their report's plan (they are its snapshot manager), and sees no HR note either.
    const plan = (await as(mgr, 'get', `/api/v1/training/idps/${idpId}`)).body.data;
    expect(plan.items.every((i: Record<string, unknown>) => !('hrComment' in i))).toBe(true);
  });

  it('an executive has no development access at all', async () => {
    expect(err(await as(exec, 'get', '/api/v1/training/me'))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `/api/v1/training/idps/${idpId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', '/api/v1/training/courses'))).toBe('403 FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
describe('notifications, audit and reporting', () => {
  it('notifications and audit entries carry no result and no development comment', async () => {
    const notifications = await prisma.notification.findMany({ where: { sourceModule: 'training' }, select: { type: true, title: true, body: true } });
    expect(notifications.map((n) => n.type)).toEqual(expect.arrayContaining(['TRAINING_ENROLLED', 'TRAINING_COMPLETED', 'IDP_ACTIVATED', 'IDP_COMPLETED', 'TRAINING_SESSION_UPDATED']));
    for (const n of notifications) expect(`${n.title} ${n.body}`).not.toMatch(/82\.5|Two runs shadowed|Done well|FAILED|NO_SHOW/);

    const audits = await prisma.auditLog.findMany({ where: { module: 'training' }, select: { action: true, newValue: true, userId: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      'GENERATE_TNA', 'CREATE_TRAINING_NEED', 'CREATE_TRAINING_COURSE', 'CREATE_TRAINING_SESSION', 'ENROLL_TRAINING',
      'RECORD_TRAINING_ATTENDANCE', 'RECORD_TRAINING_RESULT', 'CREATE_IDP', 'ACTIVATE_IDP', 'UPDATE_IDP_ITEM', 'COMPLETE_IDP',
    ]));
    const payloads = JSON.stringify(audits);
    expect(payloads).not.toMatch(/Two runs shadowed|Done well/);
    expect(payloads).toMatch(/commentChanged/);
    expect(audits.every((a) => !!a.userId)).toBe(true);
  });

  it('the report counts enrolments, completion, no-shows and hours the way the definitions say', async () => {
    const report = (await as(hrd, 'get', '/api/v1/training/reports/overview')).body.data;
    expect(report.enrollments.completed).toBe(2);
    expect(report.enrollments.noShow).toBe(1);
    expect(report.enrollments.failed).toBe(1);
    expect(report.enrollments.cancelled).toBe(1);
    expect(report.completionRate).toBe(50); // 2 ÷ (2 + 1 + 1); the cancelled place is excluded
    expect(report.trainingHours).toBe(16); // two completions of an 8-hour course; the no-show and the failure earned none
    expect(report.byCourse[0].courseCode).toBe('SQL_ADV');
    expect(report.byCourse[0].competencies).toEqual(['SQL']);
    expect(report.byDepartment.find((d: { departmentName: string }) => d.departmentName === 'Data')).toBeTruthy();
    expect(report.needs.fulfilled).toBe(1);
    expect(report.needs.fromGap).toBe(1);
    expect(report.needs.manual).toBe(1);
    expect(report.idps.completed).toBe(1);
    expect(report.idps.active).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/improv/i); // it never claims a skill improved
  });
});
