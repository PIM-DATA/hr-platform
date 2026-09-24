/**
 * Task 24 — Competency and skill gap MVP.
 *
 * The questions under test: what does this job need, where is this person, and what is the difference — and does
 * each of those stay true when the other two move. The sharpest rule here is that **unassessed is not zero**: an
 * employee nobody has looked at must never be reported as deficient.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateGap } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { skillGapService } from '../src/modules/competency/skill-gap.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, mgr: Session, otherMgr: Session, emp1: Session, emp2: Session, exec: Session;
let orgId: string, deptId: string, analystJobId: string, engineerJobId: string, analystPositionId: string, engineerPositionId: string;
const emp: Record<string, string> = {};
const comp: Record<string, string> = {};
let scaleId: string, categoryId: string, cycleId: string;

const LEVELS = [
  { level: 1, label: 'Awareness' },
  { level: 2, label: 'Basic' },
  { level: 3, label: 'Working' },
  { level: 4, label: 'Advanced' },
  { level: 5, label: 'Expert' },
];

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'COMP', name: 'Competency Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'DATA', name: 'Data' } });
  deptId = dept.id;
  const analystJob = await prisma.job.create({ data: { code: 'ANALYST', title: 'Data Analyst', level: 3 } });
  const engineerJob = await prisma.job.create({ data: { code: 'ENGINEER', title: 'Data Engineer', level: 4 } });
  analystJobId = analystJob.id;
  engineerJobId = engineerJob.id;
  const analystPosition = await prisma.position.create({ data: { departmentId: dept.id, code: 'DA1', title: 'Data Analyst', jobId: analystJob.id } });
  const engineerPosition = await prisma.position.create({ data: { departmentId: dept.id, code: 'DE1', title: 'Data Engineer', jobId: engineerJob.id } });
  analystPositionId = analystPosition.id;
  engineerPositionId = engineerPosition.id;
  // a position deliberately without a job, to prove the assignment skips it rather than inventing a profile
  const looseDept = await prisma.department.create({ data: { organizationId: org.id, code: 'MISC', name: 'Misc' } });
  const loosePosition = await prisma.position.create({ data: { departmentId: looseDept.id, code: 'X1', title: 'Unmapped' } });

  const mk = async (code: string, managerId: string | null, positionId = analystPosition.id, departmentId = dept.id) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@comp.local`,
        hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.OTHERMGR = await mk('OTHERMGR', null, engineerPosition.id);
  emp.EMP003 = await mk('EMP003', emp.MGR);
  emp.EMP004 = await mk('EMP004', emp.MGR);
  emp.NOACCOUNT = await mk('NOACCOUNT', emp.MGR);
  emp.NOJOB = await mk('NOJOB', emp.MGR, loosePosition.id, looseDept.id);

  await createUser({ email: 'admin@comp.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'mgr@comp.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'othermgr@comp.local', password: PW, role: 'MANAGER', employeeId: emp.OTHERMGR });
  await createUser({ email: 'emp1@comp.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP003 });
  await createUser({ email: 'emp2@comp.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP004 });
  await createUser({ email: 'exec@comp.local', password: PW, role: 'EXECUTIVE' });
  [admin, mgr, otherMgr, emp1, emp2, exec] = await Promise.all(
    ['admin', 'mgr', 'othermgr', 'emp1', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@comp.local`, PW)),
  );
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('the gap calculation', () => {
  it('is a subtraction, and says so plainly', () => {
    expect(calculateGap({ requiredLevel: 4, currentLevel: 2 })).toEqual({ gap: 2, gapNeeded: 2, status: 'GAP' });
    expect(calculateGap({ requiredLevel: 3, currentLevel: 3 })).toEqual({ gap: 0, gapNeeded: 0, status: 'NO_GAP' });
  });

  it('keeps overqualification rather than clamping it away', () => {
    expect(calculateGap({ requiredLevel: 3, currentLevel: 4 })).toEqual({ gap: -1, gapNeeded: 0, status: 'EXCEEDS_REQUIREMENT' });
  });

  it('treats "nobody has assessed this" as unknown, never as zero', () => {
    expect(calculateGap({ requiredLevel: 4, currentLevel: null })).toEqual({ gap: null, gapNeeded: null, status: 'UNASSESSED' });
    // The distinction that matters: an unassessed competency is not a four-level deficiency.
    expect(calculateGap({ requiredLevel: 4, currentLevel: null }).gapNeeded).not.toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('the framework', () => {
  it('a proficiency scale is the customer\'s, and needs at least two rungs', async () => {
    const tooSmall = await as(admin, 'post', '/api/v1/competency/scales').send({ code: 'ONE', name: 'One', levels: [{ level: 1, label: 'Only' }] });
    expect(tooSmall.status).toBe(400);

    const duplicateLevel = await as(admin, 'post', '/api/v1/competency/scales').send({
      code: 'DUP', name: 'Duplicate', levels: [{ level: 1, label: 'A' }, { level: 1, label: 'B' }],
    });
    expect(duplicateLevel.status).toBe(400);

    const created = await as(admin, 'post', '/api/v1/competency/scales').send({ code: 'STD5', name: 'Standard five', levels: LEVELS });
    expect(created.status).toBe(201);
    expect(created.body.data.levels).toHaveLength(5);
    expect(created.body.data.levels[2].label).toBe('Working');
    scaleId = created.body.data.id;

    const category = await as(admin, 'post', '/api/v1/competency/categories').send({ code: 'TECHNICAL', name: 'Technical', sortOrder: 1 });
    expect(category.status).toBe(201);
    categoryId = category.body.data.id;
  });

  it('a competency belongs to a category and a scale, and its indicators must sit on that scale', async () => {
    const offScale = await as(admin, 'post', '/api/v1/competency/competencies').send({
      code: 'BAD', name: 'Bad', categoryId, scaleId, indicators: [{ level: 9, description: 'Nine does not exist' }],
    });
    expect(err(offScale)).toBe('422 COMPETENCY_LEVEL_INVALID');

    for (const [code, name, indicator] of [
      ['SQL', 'SQL', 'Writes joins and aggregations without help'],
      ['DATAVIZ', 'Data Visualization', 'Builds a dashboard somebody else can read'],
      ['COMMUNICATION', 'Communication', 'Explains a result to a non-specialist'],
    ] as const) {
      const created = await as(admin, 'post', '/api/v1/competency/competencies').send({
        code, name, categoryId, scaleId, indicators: [{ level: 3, description: indicator }],
      });
      expect(created.status).toBe(201);
      comp[code] = created.body.data.id;
    }
    const list = await as(admin, 'get', '/api/v1/competency/competencies?pageSize=50');
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data[0].scale.levels).toHaveLength(5);
  });

  it('a scale in use cannot have its rungs changed, but can be reworded', async () => {
    const addRung = await as(admin, 'patch', `/api/v1/competency/scales/${scaleId}`).send({ levels: [...LEVELS, { level: 6, label: 'Master' }] });
    expect(err(addRung)).toBe('409 COMPETENCY_SCALE_IN_USE');

    const reword = await as(admin, 'patch', `/api/v1/competency/scales/${scaleId}`).send({
      levels: LEVELS.map((l) => (l.level === 3 ? { ...l, label: 'Working (independently)' } : l)),
    });
    expect(reword.status).toBe(200);
    expect(reword.body.data.levels[2].label).toBe('Working (independently)');
  });

  it('the framework is managed by permission, not by role', async () => {
    expect(err(await as(mgr, 'post', '/api/v1/competency/competencies').send({ code: 'SNEAK', name: 'Sneaky', categoryId, scaleId }))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'post', '/api/v1/competency/scales').send({ code: 'SNEAK', name: 'Sneaky', levels: LEVELS }))).toBe('403 FORBIDDEN');
    expect((await as(mgr, 'get', '/api/v1/competency/competencies')).status).toBe(200); // reading is fine
  });
});

// ---------------------------------------------------------------------------
describe('job competency profiles', () => {
  it('a job says what it needs, and a required level must exist on the scale', async () => {
    expect(err(await as(admin, 'put', `/api/v1/competency/jobs/${analystJobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 9 })))
      .toBe('422 COMPETENCY_LEVEL_INVALID');

    for (const [code, level] of [['SQL', 4], ['DATAVIZ', 4], ['COMMUNICATION', 3]] as const) {
      const set = await as(admin, 'put', `/api/v1/competency/jobs/${analystJobId}/profile`).send({ competencyId: comp[code], requiredLevel: level, isMandatory: true });
      expect(set.status).toBe(200);
    }
    const profile = await as(admin, 'get', `/api/v1/competency/jobs/${analystJobId}/profile`);
    expect(profile.body.data.requirements).toHaveLength(3);
    expect(profile.body.data.requirements.find((r: { competency: { code: string } }) => r.competency.code === 'SQL').requiredLevel).toBe(4);
    expect(profile.body.data.requirements[0].requiredLevelLabel).toBeTruthy();
    expect(profile.body.data.employeeCount).toBeGreaterThan(0);
  });

  it('setting the same competency twice updates it rather than duplicating it', async () => {
    await as(admin, 'put', `/api/v1/competency/jobs/${engineerJobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 5 });
    await as(admin, 'put', `/api/v1/competency/jobs/${engineerJobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 4 });
    const profile = await as(admin, 'get', `/api/v1/competency/jobs/${engineerJobId}/profile`);
    expect(profile.body.data.requirements).toHaveLength(1);
    expect(profile.body.data.requirements[0].requiredLevel).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('assessment cycles and assignment', () => {
  it('a population is assigned in one go, with the job profile snapshotted onto each assessment', async () => {
    const cycle = await as(admin, 'post', '/api/v1/competency/cycles').send({
      code: 'COMP2026', name: '2026 Competency Assessment', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
    expect(cycle.status).toBe(201);
    cycleId = cycle.body.data.id;

    const assigned = await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/assign`).send({ departmentId: deptId });
    expect(assigned.status).toBe(201);
    expect(assigned.body.data.created).toBe(5); // MGR, OTHERMGR, EMP003, EMP004 and NOACCOUNT all hold a job with a profile
    expect(assigned.body.data.skipped).toEqual([]);

    const again = await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/assign`).send({ departmentId: deptId });
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.alreadyAssigned).toBe(5);

    const list = await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&pageSize=50`);
    const mine = list.body.data.find((a: { employee: { employeeCode: string } }) => a.employee.employeeCode === 'EMP003');
    expect(mine.snapshot.jobTitle).toBe('Data Analyst');
    expect(mine.snapshot.departmentName).toBe('Data');
    expect(mine.reviewer.name).toBe('MGR Person');
    expect(mine.itemCount).toBe(3);
  }, 60000);

  it('an employee whose job has no competency profile is skipped with a reason, not given an empty assessment', async () => {
    const skippedCycle = await as(admin, 'post', '/api/v1/competency/cycles').send({
      code: 'NOJOB', name: 'No job profile', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
    const result = await as(admin, 'post', `/api/v1/competency/cycles/${skippedCycle.body.data.id}/assign`).send({ employeeIds: [emp.NOJOB] });
    expect(result.body.data.created).toBe(0);
    expect(result.body.data.skipped[0].employeeCode).toBe('NOJOB');
    expect(result.body.data.skipped[0].reason).toMatch(/not linked to a job/i);
    expect(await prisma.competencyAssessment.count({ where: { cycleId: skippedCycle.body.data.id } })).toBe(0);
  });

  it('an item carries the requirement, the scale labels and the indicators as they read at the time', async () => {
    const assessment = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((a: { employee: { employeeCode: string } }) => a.employee.employeeCode === 'EMP003');
    const detail = (await as(admin, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data;
    const sql = detail.items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL');
    expect(sql.requiredLevel).toBe(4);
    expect(sql.levelLabels).toHaveLength(5);
    expect(sql.indicators[0].description).toMatch(/joins and aggregations/);
    expect(sql.gapStatus).toBe('UNASSESSED'); // nothing assessed yet — not a gap of four
  });
});

// ---------------------------------------------------------------------------
describe('the two assessments', () => {
  it('a self assessment needs every competency levelled, on the scale, and submits once', async () => {
    await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/activate`);
    await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/open-review`);

    const mine = (await as(emp1, 'get', '/api/v1/competency/assessments?view=mine')).body.data[0];
    expect(mine.status).toBe('SELF_REVIEW');
    const items = (await as(emp1, 'get', `/api/v1/competency/assessments/${mine.id}`)).body.data.items;

    expect(err(await as(emp1, 'post', `/api/v1/competency/assessments/${mine.id}/submit-self`))).toBe('422 COMPETENCY_SELF_LEVEL_MISSING');
    expect(err(await as(emp1, 'patch', `/api/v1/competency/items/${items[0].id}/self`).send({ selfLevel: 9 }))).toBe('422 COMPETENCY_LEVEL_INVALID');

    const levels: Record<string, number> = { SQL: 3, DATAVIZ: 4, COMMUNICATION: 4 };
    for (const item of items) {
      const saved = await as(emp1, 'patch', `/api/v1/competency/items/${item.id}/self`).send({ selfLevel: levels[item.competencyCode], selfComment: 'My own view' });
      expect(saved.status).toBe(200);
    }
    const submitted = await as(emp1, 'post', `/api/v1/competency/assessments/${mine.id}/submit-self`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('MANAGER_REVIEW');

    expect(err(await as(emp1, 'patch', `/api/v1/competency/items/${items[0].id}/self`).send({ selfLevel: 5 }))).toBe('409 COMPETENCY_SELF_ASSESSMENT_CLOSED');
  }, 60000);

  it('only the snapshot reviewer assesses, and their level is the final level', async () => {
    const assessment = (await as(mgr, 'get', '/api/v1/competency/assessments?view=reviewing&status=MANAGER_REVIEW&pageSize=50')).body.data
      .find((a: { employee: { employeeCode: string } }) => a.employee.employeeCode === 'EMP003');
    expect(assessment).toBeTruthy();
    const items = (await as(mgr, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data.items;
    expect(items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL').selfLevel).toBe(3);

    expect(err(await as(otherMgr, 'patch', `/api/v1/competency/items/${items[0].id}/manager`).send({ managerLevel: 1 }))).toBe('403 FORBIDDEN');
    expect(err(await as(otherMgr, 'get', `/api/v1/competency/assessments/${assessment.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`))).toBe('422 COMPETENCY_MANAGER_LEVEL_MISSING');

    const levels: Record<string, number> = { SQL: 3, DATAVIZ: 4, COMMUNICATION: 3 };
    for (const item of items) {
      await as(mgr, 'patch', `/api/v1/competency/items/${item.id}/manager`).send({ managerLevel: levels[item.competencyCode], managerComment: 'Agreed, with notes' });
    }
    const finalized = await as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`);
    expect(finalized.status).toBe(200);
    expect(finalized.body.data.status).toBe('FINALIZED');

    const sql = finalized.body.data.items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL');
    expect(sql.finalLevel).toBe(3); // the reviewer's level, never an average of 3 and 3
    expect(sql.gap).toBe(1);
    expect(sql.gapStatus).toBe('GAP');
    const communication = finalized.body.data.items.find((i: { competencyCode: string }) => i.competencyCode === 'COMMUNICATION');
    expect(communication.selfLevel).toBe(4);
    expect(communication.finalLevel).toBe(3); // the reviewer disagreed, and theirs is the one that counts
    expect(communication.gapStatus).toBe('NO_GAP');
    expect(finalized.body.data.gapCount).toBe(1);

    expect(err(await as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`))).toBe('409 COMPETENCY_MANAGER_ASSESSMENT_CLOSED');
  }, 60000);

  it('the employee sees their finished assessment', async () => {
    const mine = (await as(emp1, 'get', '/api/v1/competency/assessments?view=mine')).body.data[0];
    expect(mine.status).toBe('FINALIZED');
    expect(mine.gapCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the current skill profile', () => {
  it('shows the latest assessed level against what the job asks for today', async () => {
    const profile = (await as(emp1, 'get', '/api/v1/competency/profile/me')).body.data;
    expect(profile.job.title).toBe('Data Analyst');
    const sql = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'SQL');
    expect(sql.currentLevel).toBe(3);
    expect(sql.requiredLevel).toBe(4);
    expect(sql.gapNeeded).toBe(1);
    expect(sql.sourceCycle.code).toBe('COMP2026');
    expect(sql.lastAssessedAt).toBeTruthy();
    expect(profile.summary.withGap).toBe(1);
    expect(profile.summary.assessed).toBe(3);
  });

  it('raising the job requirement changes today\'s gap and leaves the finished assessment alone', async () => {
    await as(admin, 'put', `/api/v1/competency/jobs/${analystJobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 5 });

    const profile = (await as(emp1, 'get', '/api/v1/competency/profile/me')).body.data;
    const sql = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'SQL');
    expect(sql.requiredLevel).toBe(5);
    expect(sql.currentLevel).toBe(3);
    expect(sql.gapNeeded).toBe(2); // the requirement moved, so the gap did

    const assessment = (await as(emp1, 'get', '/api/v1/competency/assessments?view=mine')).body.data[0];
    const historical = (await as(emp1, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data;
    const historicalSql = historical.items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL');
    expect(historicalSql.requiredLevel).toBe(4); // what it was measured against at the time
    expect(historicalSql.gap).toBe(1);

    await as(admin, 'put', `/api/v1/competency/jobs/${analystJobId}/profile`).send({ competencyId: comp.SQL, requiredLevel: 4 });
  });

  it('moving to another job brings its requirements, and what was never assessed stays unassessed', async () => {
    await as(admin, 'put', `/api/v1/competency/jobs/${engineerJobId}/profile`).send({ competencyId: comp.DATAVIZ, requiredLevel: 3 });
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { positionId: engineerPositionId } });
    // The engineer profile also needs something nobody has ever assessed this person on.
    const pipeline = await as(admin, 'post', '/api/v1/competency/competencies').send({ code: 'PIPELINES', name: 'Data pipelines', categoryId, scaleId });
    comp.PIPELINES = pipeline.body.data.id;
    await as(admin, 'put', `/api/v1/competency/jobs/${engineerJobId}/profile`).send({ competencyId: comp.PIPELINES, requiredLevel: 4 });

    const profile = (await as(emp1, 'get', '/api/v1/competency/profile/me')).body.data;
    expect(profile.job.title).toBe('Data Engineer');
    const sql = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'SQL');
    expect(sql.currentLevel).toBe(3); // a level assessed under the old job is still a known level
    expect(sql.requiredLevel).toBe(4);
    const pipelines = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'PIPELINES');
    expect(pipelines.currentLevel).toBeNull();
    expect(pipelines.gapStatus).toBe('UNASSESSED');
    expect(pipelines.gapNeeded).toBeNull(); // emphatically not 4
    // Communication is no longer required by the new job, but the assessed level is not forgotten.
    const communication = profile.entries.find((e: { competencyCode: string }) => e.competencyCode === 'COMMUNICATION');
    expect(communication.currentLevel).toBe(3);
    expect(communication.requiredLevel).toBeNull();

    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { positionId: analystPositionId } });
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('history does not move', () => {
  it('renaming a competency, changing the requirement and changing the manager leave a finished assessment alone', async () => {
    const assessment = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&status=FINALIZED`)).body.data[0];
    const before = (await as(admin, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data;

    await as(admin, 'patch', `/api/v1/competency/competencies/${comp.SQL}`).send({ name: 'Structured Query Language (renamed)' });
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { managerId: emp.OTHERMGR } });

    const after = (await as(admin, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data;
    const sql = after.items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL');
    expect(sql.competencyName).toBe('SQL');
    expect(sql.requiredLevel).toBe(before.items.find((i: { competencyCode: string }) => i.competencyCode === 'SQL').requiredLevel);
    expect(after.reviewer.name).toBe('MGR Person');
    expect(after.snapshot.jobTitle).toBe('Data Analyst');

    await as(admin, 'patch', `/api/v1/competency/competencies/${comp.SQL}`).send({ name: 'SQL' });
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { managerId: emp.MGR } });
  }, 60000);

  it('a competency that is in use can be deactivated but never disappears from history', async () => {
    const deactivated = await as(admin, 'patch', `/api/v1/competency/competencies/${comp.COMMUNICATION}`).send({ isActive: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.isActive).toBe(false);
    expect(deactivated.body.data.inUse).toBe(true);
    expect(err(await as(admin, 'put', `/api/v1/competency/jobs/${engineerJobId}/profile`).send({ competencyId: comp.COMMUNICATION, requiredLevel: 3 })))
      .toBe('409 COMPETENCY_INACTIVE');

    const assessment = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&status=FINALIZED`)).body.data[0];
    const detail = (await as(admin, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data;
    expect(detail.items.some((i: { competencyCode: string }) => i.competencyCode === 'COMMUNICATION')).toBe(true);
    await as(admin, 'patch', `/api/v1/competency/competencies/${comp.COMMUNICATION}`).send({ isActive: true });
  });
});

// ---------------------------------------------------------------------------
describe('who may see what', () => {
  it('an employee reads their own assessment and profile, and nobody else\'s', async () => {
    const mine = (await as(emp1, 'get', '/api/v1/competency/assessments?view=mine')).body.data[0];
    expect((await as(emp1, 'get', `/api/v1/competency/assessments/${mine.id}`)).status).toBe(200);

    const theirs = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((a: { employee: { employeeCode: string } }) => a.employee.employeeCode === 'EMP004');
    expect(err(await as(emp1, 'get', `/api/v1/competency/assessments/${theirs.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', `/api/v1/competency/profile/${emp.EMP004}`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', '/api/v1/competency/assessments?view=all'))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', '/api/v1/competency/skill-gaps'))).toBe('403 FORBIDDEN');
  });

  it('a manager assesses only what was assigned to them, whatever their team scope says', async () => {
    const reviewing = await as(mgr, 'get', '/api/v1/competency/assessments?view=reviewing&pageSize=50');
    expect(reviewing.status).toBe(200);
    expect(reviewing.body.data.every((a: { reviewer: { name: string } }) => a.reviewer.name === 'MGR Person')).toBe(true);
    expect(err(await as(mgr, 'get', '/api/v1/competency/assessments?view=all'))).toBe('403 FORBIDDEN');
  });

  it('an executive sees aggregate reporting and no individual assessment', async () => {
    const report = await as(exec, 'get', `/api/v1/competency/reports/gaps?cycleId=${cycleId}`);
    expect(report.status).toBe(200);
    expect(report.body.data.coverage.assigned).toBeGreaterThan(0);
    expect(JSON.stringify(report.body.data)).not.toMatch(/Agreed, with notes|My own view/);

    const someone = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&pageSize=50`)).body.data[0];
    expect(err(await as(exec, 'get', `/api/v1/competency/assessments/${someone.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `/api/v1/competency/cycles/${cycleId}/assign`))).toMatch(/40[34]/);
  });
});

// ---------------------------------------------------------------------------
describe('notifications and audit keep the comments out', () => {
  it('a notification names the cycle and the person, never a level or a comment', async () => {
    const notifications = await prisma.notification.findMany({ where: { sourceModule: 'competency' }, select: { type: true, title: true, body: true } });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.map((n) => n.type)).toEqual(expect.arrayContaining(['COMPETENCY_ASSESSMENT_OPENED', 'COMPETENCY_MANAGER_ASSESSMENT_REQUIRED', 'COMPETENCY_ASSESSMENT_FINALIZED']));
    for (const n of notifications) expect(`${n.title} ${n.body}`).not.toMatch(/Agreed, with notes|My own view|level 3/i);
  });

  it('the audit records what happened and that comments exist, never what they say', async () => {
    const audits = await prisma.auditLog.findMany({ where: { module: 'competency' }, select: { action: true, newValue: true, userId: true, createdAt: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      'CREATE_COMPETENCY_SCALE', 'CREATE_COMPETENCY_CATEGORY', 'CREATE_COMPETENCY', 'UPDATE_JOB_COMPETENCY_PROFILE',
      'CREATE_COMPETENCY_CYCLE', 'ASSIGN_COMPETENCY_ASSESSMENT', 'SUBMIT_COMPETENCY_SELF_ASSESSMENT',
      'SUBMIT_COMPETENCY_MANAGER_ASSESSMENT', 'FINALIZE_COMPETENCY_ASSESSMENT',
    ]));
    const payloads = JSON.stringify(audits);
    expect(payloads).not.toMatch(/Agreed, with notes|My own view/);
    expect(payloads).toMatch(/commentedItems/);
    expect(payloads).not.toMatch(/salary|netPay|weightedScore/i);
    expect(audits.every((a) => !!a.userId && !!a.createdAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('reporting and the development hand-off', () => {
  it('the gap report counts coverage and ranks the competencies people are short on', async () => {
    const report = (await as(admin, 'get', `/api/v1/competency/reports/gaps?cycleId=${cycleId}`)).body.data;
    expect(report.coverage.assigned).toBe(5);
    expect(report.coverage.finalized).toBe(1);
    expect(report.coverage.coveragePercent).toBe(20);
    expect(report.totals.employeesAssessed).toBe(1);
    expect(report.totals.employeesWithGap).toBe(1);
    expect(report.totals.gapItems).toBe(1);
    expect(report.totals.averageGapNeeded).toBe('1.00');
    const sql = report.topGaps.find((g: { competencyCode: string }) => g.competencyCode === 'SQL');
    expect(sql.belowRequirement).toBe(1);
    expect(sql.maxGap).toBe(1);
    expect(report.byDepartment[0].departmentName).toBe('Data');
    expect(report.byJob[0].jobTitle).toBe('Data Analyst');
  });

  it('the development hand-off returns one row per requirement, unassessed included but never as zero', async () => {
    const rows = await skillGapService.getSkillGapsForDevelopment({ employeeId: emp.EMP003 });
    expect(rows.length).toBe(3);
    const sql = rows.find((r) => r.competencyCode === 'SQL')!;
    expect(sql).toMatchObject({ currentLevel: 3, requiredLevel: 4, gapNeeded: 1, gapStatus: 'GAP', jobTitle: 'Data Analyst' });
    expect(sql.assessmentDate).toBeTruthy();

    const unassessed = await skillGapService.getSkillGapsForDevelopment({ employeeId: emp.EMP004 });
    expect(unassessed.every((r) => r.currentLevel === null && r.gapNeeded === null && r.gapStatus === 'UNASSESSED')).toBe(true);

    const gapsOnly = await skillGapService.getSkillGapsForDevelopment({ departmentId: deptId, gapOnly: true });
    expect(gapsOnly.every((r) => r.gapStatus === 'GAP')).toBe(true);
    expect(gapsOnly.length).toBe(1);

    // It is reachable over HTTP too, for whatever Task 25 turns out to be.
    const viaApi = await as(admin, 'get', `/api/v1/competency/skill-gaps?employeeId=${emp.EMP003}&gapOnly=true`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.data).toHaveLength(1);
    expect(JSON.stringify(viaApi.body.data)).not.toMatch(/Agreed, with notes/);
  });
});

// ---------------------------------------------------------------------------
describe('closing a cycle', () => {
  it('a closed cycle is history: no assignment, no assessment, no edits', async () => {
    const closed = await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/close`);
    expect(closed.status).toBe(200);
    expect(err(await as(admin, 'post', `/api/v1/competency/cycles/${cycleId}/assign`).send({ employeeIds: [emp.EMP004] }))).toBe('409 COMPETENCY_CYCLE_CLOSED');
    expect(err(await as(admin, 'patch', `/api/v1/competency/cycles/${cycleId}`).send({ name: 'Renamed' }))).toBe('409 COMPETENCY_CYCLE_CLOSED');

    const open = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&status=MANAGER_REVIEW`)).body.data[0];
    if (open) expect(err(await as(mgr, 'post', `/api/v1/competency/assessments/${open.id}/submit-manager`))).toMatch(/409|422/);

    // The finished assessment stays readable — closing is about change, not access.
    const finalized = (await as(admin, 'get', `/api/v1/competency/assessments?view=all&cycleId=${cycleId}&status=FINALIZED`)).body.data[0];
    expect((await as(emp1, 'get', `/api/v1/competency/assessments/${finalized.id}`)).body.data.gapCount).toBe(1);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two submissions produce one self submission and one finalization', async () => {
    const cycle = await as(admin, 'post', '/api/v1/competency/cycles').send({
      code: 'RACE', name: 'Race', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    });
    const raceId = cycle.body.data.id as string;
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/assign`).send({ employeeIds: [emp.EMP004] });
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/activate`);
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/open-review`);

    const assessment = (await as(emp2, 'get', `/api/v1/competency/assessments?view=mine&cycleId=${raceId}`)).body.data[0];
    const items = (await as(emp2, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data.items;
    for (const item of items) await as(emp2, 'patch', `/api/v1/competency/items/${item.id}/self`).send({ selfLevel: 3 });

    const selfRace = await Promise.all([
      as(emp2, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-self`),
      as(emp2, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-self`),
    ]);
    expect(selfRace.filter((r) => r.status === 200)).toHaveLength(1);

    for (const item of items) await as(mgr, 'patch', `/api/v1/competency/items/${item.id}/manager`).send({ managerLevel: 4 });
    const managerRace = await Promise.all([
      as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`),
      as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`),
    ]);
    expect(managerRace.filter((r) => r.status === 200)).toHaveLength(1);
    const after = await prisma.competencyAssessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(after.status).toBe('FINALIZED');
    expect(await prisma.competencyAssessmentItem.count({ where: { assessmentId: assessment.id, finalLevel: null } })).toBe(0);
  }, 120000);

  it('closing a cycle beside a submission leaves no half-finished assessment', async () => {
    const cycle = await as(admin, 'post', '/api/v1/competency/cycles').send({
      code: 'RACE2', name: 'Race 2', periodStart: '2026-01-01', periodEnd: '2026-12-31', selfAssessmentRequired: false,
    });
    const raceId = cycle.body.data.id as string;
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/assign`).send({ employeeIds: [emp.EMP003] });
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/activate`);
    await as(admin, 'post', `/api/v1/competency/cycles/${raceId}/open-review`);

    const assessment = (await as(mgr, 'get', `/api/v1/competency/assessments?view=reviewing&cycleId=${raceId}`)).body.data[0];
    expect(assessment.status).toBe('MANAGER_REVIEW'); // no self assessment on this cycle, so it lands on the reviewer
    const items = (await as(mgr, 'get', `/api/v1/competency/assessments/${assessment.id}`)).body.data.items;
    for (const item of items) await as(mgr, 'patch', `/api/v1/competency/items/${item.id}/manager`).send({ managerLevel: 4 });

    const [closeResult, submitResult] = await Promise.all([
      as(admin, 'post', `/api/v1/competency/cycles/${raceId}/close`),
      as(mgr, 'post', `/api/v1/competency/assessments/${assessment.id}/submit-manager`),
    ]);
    expect([closeResult.status, submitResult.status]).toContain(200);
    const after = await prisma.competencyAssessment.findUniqueOrThrow({ where: { id: assessment.id }, include: { items: true } });
    if (after.status === 'FINALIZED') {
      expect(after.items.every((i) => i.finalLevel !== null)).toBe(true);
      expect(after.finalizedAt).toBeTruthy();
    } else {
      expect(after.items.every((i) => i.finalLevel === null)).toBe(true);
      expect(after.finalizedAt).toBeNull();
    }
  }, 120000);
});
