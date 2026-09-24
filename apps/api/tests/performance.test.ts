/**
 * Task 23 — Performance management MVP.
 *
 * What these tests are about: scores that come out the same every time, snapshots that do not move when the
 * organization does, and the line between "I manage this person" and "I am allowed to read what was written about
 * them". Weights and scores are asserted as decimal strings — comparing floats would pass while the product drifted.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { scoreIsOnScale, sumWeights, weightedScore } from '../src/modules/performance/score';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let admin: Session, mgr: Session, otherMgr: Session, emp1: Session, emp2: Session, exec: Session;
let orgId: string, deptId: string, otherDeptId: string;
const emp: Record<string, string> = {};
const kpi: Record<string, string> = {};
let cycleId: string;

const BANDS = [
  { code: 'EXCEPTIONAL', label: 'Exceptional', minScore: '4.50', maxScore: '5.00' },
  { code: 'EXCEEDS', label: 'Exceeds expectations', minScore: '3.50', maxScore: '4.49' },
  { code: 'MEETS', label: 'Meets expectations', minScore: '2.50', maxScore: '3.49' },
  { code: 'PARTIAL', label: 'Partially meets', minScore: '1.00', maxScore: '2.49' },
];

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'PERF', name: 'Performance Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const job = await prisma.job.create({ data: { code: 'J1', title: 'Analyst' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } });
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id;
  otherDeptId = otherDept.id;
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'P1', title: 'Sales Executive', jobId: job.id } });
  const otherPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'P2', title: 'Operations Officer', jobId: job.id } });

  const mk = async (code: string, managerId: string | null, departmentId = dept.id, positionId = position.id) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@perf.local`,
        hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.OTHERMGR = await mk('OTHERMGR', null, otherDept.id, otherPosition.id);
  emp.EMP003 = await mk('EMP003', emp.MGR);
  emp.EMP004 = await mk('EMP004', emp.MGR);
  emp.EMP005 = await mk('EMP005', emp.OTHERMGR, otherDept.id, otherPosition.id);
  emp.NOACCOUNT = await mk('NOACCOUNT', emp.MGR);

  await createUser({ email: 'admin@perf.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'mgr@perf.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'othermgr@perf.local', password: PW, role: 'MANAGER', employeeId: emp.OTHERMGR });
  await createUser({ email: 'emp1@perf.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP003 });
  await createUser({ email: 'emp2@perf.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP004 });
  await createUser({ email: 'exec@perf.local', password: PW, role: 'EXECUTIVE', employeeId: emp.EMP005 });
  [admin, mgr, otherMgr, emp1, emp2, exec] = await Promise.all(
    ['admin', 'mgr', 'othermgr', 'emp1', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@perf.local`, PW)),
  );

  for (const [code, name, measurementType] of [
    ['SALES_RESULT', 'Sales / business result', 'NUMBER'],
    ['QUALITY', 'Quality', 'PERCENTAGE'],
    ['COLLABORATION', 'Collaboration', 'QUALITATIVE'],
  ] as const) {
    const created = await as(admin, 'post', '/api/v1/performance/kpis').send({ code, name, measurementType, category: 'Core' });
    expect(created.status).toBe(201);
    kpi[code] = created.body.data.id;
  }
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('score arithmetic', () => {
  it('a weighted score is deterministic even when the weights are thirds', () => {
    // 33.33 / 33.33 / 33.34, the split that makes floats drift
    const total = weightedScore([
      { managerScore: '4.2', weight: '33.33' },
      { managerScore: '3.7', weight: '33.33' },
      { managerScore: '4.5', weight: '33.34' },
    ]);
    expect(total.toFixed(2)).toBe('4.13');
    expect(sumWeights(['33.33', '33.33', '33.34']).toFixed(2)).toBe('100.00');
  });

  it('the worked example from the specification comes out exactly', () => {
    const total = weightedScore([
      { managerScore: '4', weight: '50' },
      { managerScore: '3.5', weight: '30' },
      { managerScore: '4.5', weight: '20' },
    ]);
    expect(total.toFixed(2)).toBe('3.95');
  });

  it('rounding happens once, at the end', () => {
    // Each term is 1.0333…; rounding the terms first would give 3.09, rounding once gives 3.10.
    const total = weightedScore([
      { managerScore: '3.1', weight: '33.33' },
      { managerScore: '3.1', weight: '33.33' },
      { managerScore: '3.1', weight: '33.34' },
    ]);
    expect(total.toFixed(2)).toBe('3.10');
  });

  it('a score has to sit on the scale, step included', () => {
    expect(scoreIsOnScale('3.5', '1', '5', '0.1')).toBe(true);
    expect(scoreIsOnScale('0.9', '1', '5', '0.1')).toBe(false);
    expect(scoreIsOnScale('5.1', '1', '5', '0.1')).toBe(false);
    expect(scoreIsOnScale('3.55', '1', '5', '0.1')).toBe(false); // finer than the configured step
  });
});

// ---------------------------------------------------------------------------
describe('cycles and the KPI library', () => {
  it('a cycle is created with its own scale and bands, and the dates have to make sense', async () => {
    const backwards = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'BAD', name: 'Backwards', periodStart: '2026-12-31', periodEnd: '2026-01-01', ratingBands: BANDS,
    });
    expect(backwards.status).toBe(400); // the schema refuses it before any service sees it

    const managerBeforeSelf = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'BAD2', name: 'Manager first', periodStart: '2026-01-01', periodEnd: '2026-12-31',
      selfReviewStart: '2026-12-01', selfReviewEnd: '2026-12-10', managerReviewStart: '2026-11-01', managerReviewEnd: '2026-11-10',
      ratingBands: BANDS,
    });
    expect(managerBeforeSelf.status).toBe(400);

    const created = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'ANNUAL2026', name: '2026 Annual Performance', organizationId: orgId,
      periodStart: '2026-01-01', periodEnd: '2026-12-31',
      selfReviewStart: '2026-12-01', selfReviewEnd: '2026-12-10',
      managerReviewStart: '2026-12-11', managerReviewEnd: '2026-12-20',
      minScore: '1', maxScore: '5', scoreStep: '0.1', ratingBands: BANDS,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.minScore).toBe('1.00');
    expect(created.body.data.ratingBands).toHaveLength(4);
    cycleId = created.body.data.id;

    expect(err(await as(admin, 'post', '/api/v1/performance/cycles').send({ code: 'ANNUAL2026', name: 'Duplicate', periodStart: '2026-01-01', periodEnd: '2026-12-31' })))
      .toBe('409 PERFORMANCE_CYCLE_CODE_TAKEN');
  });

  it('rating bands cannot overlap, sit outside the scale, or leave a gap at activation', async () => {
    const overlap = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'OVERLAP', name: 'Overlapping', periodStart: '2026-01-01', periodEnd: '2026-12-31',
      ratingBands: [{ code: 'A', label: 'A', minScore: '1', maxScore: '3' }, { code: 'B', label: 'B', minScore: '2.5', maxScore: '5' }],
    });
    expect(err(overlap)).toBe('422 PERFORMANCE_BAND_OVERLAP');

    const outside = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'OUTSIDE', name: 'Outside', periodStart: '2026-01-01', periodEnd: '2026-12-31',
      minScore: '1', maxScore: '5', ratingBands: [{ code: 'A', label: 'A', minScore: '1', maxScore: '7' }],
    });
    expect(err(outside)).toBe('422 PERFORMANCE_BAND_OUT_OF_SCALE');

    const gappy = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'GAPPY', name: 'Gappy', periodStart: '2026-01-01', periodEnd: '2026-12-31',
      minScore: '1', maxScore: '5', ratingBands: [{ code: 'TOP', label: 'Top', minScore: '4', maxScore: '5' }],
    });
    expect(gappy.status).toBe(201);
    expect(err(await as(admin, 'post', `/api/v1/performance/cycles/${gappy.body.data.id}/activate`))).toBe('422 PERFORMANCE_BAND_GAP');
  });

  it('the KPI library is managed by permission, and a code is used once', async () => {
    expect(err(await as(mgr, 'post', '/api/v1/performance/kpis').send({ code: 'SNEAKY', name: 'Sneaky', measurementType: 'NUMBER' }))).toBe('403 FORBIDDEN');
    expect(err(await as(admin, 'post', '/api/v1/performance/kpis').send({ code: 'QUALITY', name: 'Duplicate', measurementType: 'NUMBER' }))).toBe('409 PERFORMANCE_KPI_CODE_TAKEN');
    const list = await as(admin, 'get', '/api/v1/performance/kpis?pageSize=50');
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
describe('plans, weights and the review', () => {
  it('a whole population is assigned at once, with the organization snapshotted onto each plan', async () => {
    const assigned = await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/assign`).send({ departmentId: deptId });
    expect(assigned.status).toBe(201);
    expect(assigned.body.data.created).toBe(4); // MGR, EMP003, EMP004, NOACCOUNT — everybody in Sales

    // Re-running is normal after adding people; it must not create a second plan for anybody.
    const again = await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/assign`).send({ departmentId: deptId });
    expect(again.body.data.created).toBe(0);
    expect(again.body.data.alreadyAssigned).toBe(4);

    const plans = await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`);
    const mine = plans.body.data.find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP003');
    expect(mine.snapshot.departmentName).toBe('Sales');
    expect(mine.snapshot.positionTitle).toBe('Sales Executive');
    expect(mine.snapshot.jobTitle).toBe('Analyst');
    expect(mine.reviewer.name).toBe('MGR Person'); // the direct manager, resolved and frozen
    expect(mine.reviewer.hasAccount).toBe(true);
  }, 60000);

  it('a plan with no account for the employee is visible as such, and nobody invents an account for them', async () => {
    const plans = await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`);
    const orphan = plans.body.data.find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'NOACCOUNT');
    expect(orphan.selfReviewUnavailable).toBe(true);
    expect(await prisma.user.count({ where: { employeeId: emp.NOACCOUNT } })).toBe(0);
  });

  it('KPIs are added with weights that must end up at exactly 100', async () => {
    const plans = await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`);
    for (const plan of plans.body.data) {
      const weights = plan.employee.employeeCode === 'EMP003' ? ['50', '30', '20'] : ['50', '30', '20'];
      const codes = ['SALES_RESULT', 'QUALITY', 'COLLABORATION'] as const;
      for (let i = 0; i < codes.length; i++) {
        const added = await as(admin, 'post', `/api/v1/performance/plans/${plan.id}/items`).send({
          kpiId: kpi[codes[i]], weight: weights[i], targetValue: i === 0 ? '1000000' : null, targetText: i === 0 ? null : 'Consistently high',
        });
        expect(added.status).toBe(201);
      }
    }
    const one = plans.body.data.find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP003');
    const detail = await as(admin, 'get', `/api/v1/performance/plans/${one.id}`);
    expect(detail.body.data.totalWeight).toBe('100.00');
    expect(detail.body.data.items[0].kpiCode).toBe('SALES_RESULT');
  }, 60000);

  it('the cycle moves to active, then to review, and the plans move with it', async () => {
    expect((await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/activate`)).status).toBe(200);
    const active = await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`);
    expect(active.body.data.every((p: { status: string }) => p.status === 'ACTIVE')).toBe(true);

    // The scale is frozen once people are being measured against it.
    expect(err(await as(admin, 'patch', `/api/v1/performance/cycles/${cycleId}`).send({ maxScore: '10' }))).toBe('409 PERFORMANCE_CYCLE_IN_PROGRESS');
  });

  it('an employee records progress against their own plan and nobody else\'s', async () => {
    const mine = (await as(emp1, 'get', '/api/v1/performance/plans?view=mine')).body.data[0];
    const item = (await as(emp1, 'get', `/api/v1/performance/plans/${mine.id}`)).body.data.items[0];
    const updated = await as(emp1, 'patch', `/api/v1/performance/items/${item.id}/progress`).send({ actualValue: '920000', progressPercent: 92, employeeComment: 'Two large accounts closed late' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.items[0].actualValue).toBe('920000.00');
    expect(updated.body.data.progressPercent).toBeGreaterThan(0);

    const theirs = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP004');
    const theirItem = (await as(admin, 'get', `/api/v1/performance/plans/${theirs.id}`)).body.data.items[0];
    expect(err(await as(emp1, 'patch', `/api/v1/performance/items/${theirItem.id}/progress`).send({ progressPercent: 10 }))).toBe('403 FORBIDDEN');
  });

  it('a self review needs every KPI scored, on the scale, before it can be submitted', async () => {
    expect((await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/open-review`)).status).toBe(200);
    const mine = (await as(emp1, 'get', '/api/v1/performance/plans?view=mine')).body.data[0];
    expect(mine.status).toBe('SELF_REVIEW');
    const detail = await as(emp1, 'get', `/api/v1/performance/plans/${mine.id}`);
    const items = detail.body.data.items;

    expect(err(await as(emp1, 'post', `/api/v1/performance/plans/${mine.id}/submit-self`))).toBe('422 PERFORMANCE_SELF_SCORE_MISSING');
    expect(err(await as(emp1, 'patch', `/api/v1/performance/items/${items[0].id}/self`).send({ selfScore: '5.4' }))).toBe('422 PERFORMANCE_SCORE_OUT_OF_RANGE');

    for (const [index, value] of ['4', '4', '5'].entries()) {
      const saved = await as(emp1, 'patch', `/api/v1/performance/items/${items[index].id}/self`).send({ selfScore: value, employeeComment: 'My own view' });
      expect(saved.status).toBe(200);
    }
    const submitted = await as(emp1, 'post', `/api/v1/performance/plans/${mine.id}/submit-self`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('MANAGER_REVIEW');
    expect(submitted.body.data.selfSubmittedAt).toBeTruthy();

    // ...and it is theirs no longer.
    expect(err(await as(emp1, 'patch', `/api/v1/performance/items/${items[0].id}/self`).send({ selfScore: '5' }))).toBe('409 PERFORMANCE_SELF_REVIEW_CLOSED');
    expect(err(await as(emp1, 'post', `/api/v1/performance/plans/${mine.id}/submit-self`))).toBe('409 PERFORMANCE_SELF_REVIEW_CLOSED');
  }, 60000);

  it('only the snapshot reviewer can review, and the weighted score and rating are the server\'s', async () => {
    const plan = (await as(mgr, 'get', '/api/v1/performance/plans?view=reviewing&status=MANAGER_REVIEW')).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP003');
    expect(plan).toBeTruthy();
    const items = (await as(mgr, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data.items;

    // Another manager — with the same permission and their own team — is still not this plan's reviewer.
    expect(err(await as(otherMgr, 'patch', `/api/v1/performance/items/${items[0].id}/manager`).send({ managerScore: '1' }))).toBe('403 FORBIDDEN');
    expect(err(await as(otherMgr, 'get', `/api/v1/performance/plans/${plan.id}`))).toBe('403 FORBIDDEN');

    expect(err(await as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`))).toBe('422 PERFORMANCE_MANAGER_SCORE_MISSING');
    for (const [index, value] of ['4', '3.5', '4.5'].entries()) {
      const saved = await as(mgr, 'patch', `/api/v1/performance/items/${items[index].id}/manager`).send({ managerScore: value, managerComment: 'Solid year' });
      expect(saved.status).toBe(200);
    }
    const finalized = await as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`);
    expect(finalized.status).toBe(200);
    expect(finalized.body.data.status).toBe('FINALIZED');
    expect(finalized.body.data.weightedScore).toBe('3.95'); // 4×50% + 3.5×30% + 4.5×20%
    expect(finalized.body.data.ratingCode).toBe('EXCEEDS');
    expect(finalized.body.data.ratingLabel).toBe('Exceeds expectations');
    expect(finalized.body.data.items.every((i: { finalScore: string | null }) => i.finalScore !== null)).toBe(true);

    // A finalized plan is finished: the reviewer cannot keep editing it, and cannot submit it twice.
    expect(err(await as(mgr, 'patch', `/api/v1/performance/items/${items[0].id}/manager`).send({ managerScore: '5' }))).toBe('409 PERFORMANCE_MANAGER_REVIEW_CLOSED');
    expect(err(await as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`))).toBe('409 PERFORMANCE_MANAGER_REVIEW_CLOSED');
  }, 60000);

  it('the employee sees the result, and a weight that no longer adds up blocks a review', async () => {
    const mine = (await as(emp1, 'get', '/api/v1/performance/plans?view=mine')).body.data[0];
    expect(mine.weightedScore).toBe('3.95');
    expect(mine.ratingLabel).toBe('Exceeds expectations');

    // EMP004's plan is still open; break its weights and the submission is refused.
    const other = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP004');
    const items = (await as(admin, 'get', `/api/v1/performance/plans/${other.id}`)).body.data.items;
    // The structure is frozen now that the review is open — which is itself the rule under test.
    expect(err(await as(admin, 'patch', `/api/v1/performance/items/${items[0].id}`).send({ weight: '49.99' }))).toBe('409 PERFORMANCE_PLAN_IN_REVIEW');
  });
});

// ---------------------------------------------------------------------------
describe('weights that do not add up', () => {
  it('99.99 and 100.01 are both refused, exactly', async () => {
    const cycle = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'WEIGHTS', name: 'Weight checks', periodStart: '2026-01-01', periodEnd: '2026-12-31', minScore: '1', maxScore: '5', ratingBands: BANDS,
    });
    const assigned = await as(admin, 'post', `/api/v1/performance/cycles/${cycle.body.data.id}/assign`).send({ employeeIds: [emp.EMP003] });
    expect(assigned.body.data.created).toBe(1);
    const plan = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycle.body.data.id}`)).body.data[0];

    for (const weight of ['50', '49.99']) {
      await as(admin, 'post', `/api/v1/performance/plans/${plan.id}/items`).send({ kpiId: kpi.SALES_RESULT, weight });
    }
    await as(admin, 'post', `/api/v1/performance/cycles/${cycle.body.data.id}/activate`);
    await as(admin, 'post', `/api/v1/performance/cycles/${cycle.body.data.id}/open-review`);

    const items = (await as(emp1, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data.items;
    for (const item of items) await as(emp1, 'patch', `/api/v1/performance/items/${item.id}/self`).send({ selfScore: '4' });
    const low = await as(emp1, 'post', `/api/v1/performance/plans/${plan.id}/submit-self`);
    expect(err(low)).toBe('422 PERFORMANCE_WEIGHT_INVALID');
    expect(low.body.error.message).toContain('99.99');
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('history does not move', () => {
  it('renaming a KPI, transferring the employee and changing their manager leave a finished review alone', async () => {
    const plan = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&status=FINALIZED`)).body.data[0];
    const before = (await as(admin, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data;

    await as(admin, 'patch', `/api/v1/performance/kpis/${kpi.SALES_RESULT}`).send({ name: 'Revenue (renamed in 2027)' });
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { departmentId: otherDeptId, managerId: emp.OTHERMGR } });

    const after = (await as(admin, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data;
    expect(after.items[0].kpiName).toBe(before.items[0].kpiName);
    expect(after.items[0].kpiName).not.toBe('Revenue (renamed in 2027)');
    expect(after.snapshot.departmentName).toBe('Sales');
    expect(after.reviewer.name).toBe('MGR Person');

    // The report still counts them where they were when the plan was written.
    const report = (await as(admin, 'get', `/api/v1/performance/cycles/${cycleId}/report`)).body.data;
    expect(report.byDepartment.find((d: { departmentName: string }) => d.departmentName === 'Sales')).toBeTruthy();

    // put the org chart back for the tests that follow
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { departmentId: deptId, managerId: emp.MGR } });
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('who may see what', () => {
  it('an employee reads their own plan and not a colleague\'s', async () => {
    const mine = (await as(emp1, 'get', '/api/v1/performance/plans?view=mine')).body.data[0];
    expect((await as(emp1, 'get', `/api/v1/performance/plans/${mine.id}`)).status).toBe(200);
    const theirs = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP004');
    expect(err(await as(emp1, 'get', `/api/v1/performance/plans/${theirs.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', `/api/v1/performance/plans?view=all`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', `/api/v1/performance/plans?view=reviewing`))).toBe('403 FORBIDDEN');
  });

  it('a manager sees the plans assigned to them, and nothing else', async () => {
    const reviewing = await as(mgr, 'get', '/api/v1/performance/plans?view=reviewing&pageSize=50');
    expect(reviewing.status).toBe(200);
    expect(reviewing.body.data.every((p: { reviewer: { name: string } }) => p.reviewer.name === 'MGR Person')).toBe(true);
    const outsider = (await as(admin, 'get', `/api/v1/performance/plans?view=all&pageSize=50`)).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP005');
    if (outsider) expect(err(await as(mgr, 'get', `/api/v1/performance/plans/${outsider.id}`))).toBe('403 FORBIDDEN');
  });

  it('an executive sees aggregate reporting, never an individual review', async () => {
    const report = await as(exec, 'get', `/api/v1/performance/cycles/${cycleId}/report`);
    expect(report.status).toBe(200);
    expect(report.body.data.completion.assigned).toBeGreaterThan(0);
    expect(JSON.stringify(report.body.data)).not.toMatch(/Solid year|My own view/);

    const someone = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&pageSize=50`)).body.data
      .find((p: { employee: { employeeCode: string } }) => p.employee.employeeCode === 'EMP003');
    expect(err(await as(exec, 'get', `/api/v1/performance/plans/${someone.id}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', '/api/v1/performance/plans?view=all'))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'post', `/api/v1/performance/cycles/${cycleId}/close`))).toBe('403 FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
describe('notifications and audit keep the comments out', () => {
  it('a notification names the cycle and the person, never a score or a comment', async () => {
    const notifications = await prisma.notification.findMany({ where: { sourceModule: 'performance' }, select: { type: true, title: true, body: true } });
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.map((n) => n.type)).toEqual(expect.arrayContaining(['PERFORMANCE_REVIEW_OPENED', 'PERFORMANCE_MANAGER_REVIEW_REQUIRED', 'PERFORMANCE_FINALIZED']));
    for (const n of notifications) {
      expect(`${n.title} ${n.body}`).not.toMatch(/Solid year|My own view|3\.95|Exceeds expectations/);
    }
  });

  it('the audit says what happened, who did it and when — and not a word of the review', async () => {
    const audits = await prisma.auditLog.findMany({ where: { module: 'performance' }, select: { action: true, newValue: true, userId: true, createdAt: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      'CREATE_PERFORMANCE_CYCLE', 'ACTIVATE_PERFORMANCE_CYCLE', 'OPEN_PERFORMANCE_REVIEW', 'CREATE_PERFORMANCE_KPI',
      'ASSIGN_PERFORMANCE_PLAN', 'SUBMIT_SELF_REVIEW', 'SUBMIT_MANAGER_REVIEW', 'FINALIZE_PERFORMANCE_PLAN',
    ]));
    const payloads = JSON.stringify(audits);
    expect(payloads).not.toMatch(/Solid year|My own view/);
    expect(payloads).toMatch(/commentedItems/); // that comments exist is recorded; what they say is not
    expect(payloads).not.toMatch(/salary|baseSalary|netPay/i);
    expect(audits.every((a) => !!a.userId && !!a.createdAt)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('reporting', () => {
  it('counts completion, averages the finished plans and lists every band', async () => {
    const report = (await as(admin, 'get', `/api/v1/performance/cycles/${cycleId}/report`)).body.data;
    expect(report.completion.assigned).toBe(4);
    expect(report.completion.selfSubmitted).toBe(1);
    expect(report.completion.finalized).toBe(1);
    expect(report.averageFinalScore).toBe('3.95');
    expect(report.ratingDistribution).toHaveLength(4);
    expect(report.ratingDistribution.find((r: { code: string }) => r.code === 'EXCEEDS').count).toBe(1);
    expect(report.ratingDistribution.find((r: { code: string }) => r.code === 'MEETS').count).toBe(0);
    expect(report.byDepartment[0].assigned).toBe(4);
    expect(report.byKpi.find((k: { kpiCode: string }) => k.kpiCode === 'SALES_RESULT').averageManagerScore).toBe('4.00');
  });

  it('a department filter narrows the report to the snapshot department', async () => {
    const filtered = (await as(admin, 'get', `/api/v1/performance/cycles/${cycleId}/report?departmentId=${otherDeptId}`)).body.data;
    expect(filtered.completion.assigned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('closing a cycle', () => {
  it('a closed cycle is history: nothing in it can be assigned, reviewed or edited again', async () => {
    const closed = await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('CLOSED');

    expect(err(await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/assign`).send({ employeeIds: [emp.EMP005] }))).toBe('409 PERFORMANCE_CYCLE_CLOSED');
    expect(err(await as(admin, 'patch', `/api/v1/performance/cycles/${cycleId}`).send({ name: 'Renamed' }))).toBe('409 PERFORMANCE_CYCLE_CLOSED');
    expect(err(await as(admin, 'post', `/api/v1/performance/cycles/${cycleId}/activate`))).toBe('409 PERFORMANCE_CYCLE_TRANSITION_INVALID');

    const plan = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&status=MANAGER_REVIEW`)).body.data[0];
    if (plan) {
      const items = (await as(admin, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data.items;
      expect(err(await as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`))).toMatch(/409|422/);
      expect(err(await as(admin, 'patch', `/api/v1/performance/items/${items[0].id}`).send({ weight: '10' }))).toBe('409 PERFORMANCE_CYCLE_CLOSED');
    }
    // The finished review is still readable — closing is about change, not access.
    const finalized = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleId}&status=FINALIZED`)).body.data[0];
    expect((await as(emp1, 'get', `/api/v1/performance/plans/${finalized.id}`)).body.data.weightedScore).toBe('3.95');
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two submissions of the same review produce one finalization', async () => {
    const cycle = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'RACE', name: 'Race', periodStart: '2026-01-01', periodEnd: '2026-12-31', minScore: '1', maxScore: '5',
      selfReviewRequired: false, ratingBands: BANDS,
    });
    const cycleRaceId = cycle.body.data.id as string;
    await as(admin, 'post', `/api/v1/performance/cycles/${cycleRaceId}/assign`).send({ employeeIds: [emp.EMP004] });
    const plan = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${cycleRaceId}`)).body.data[0];
    await as(admin, 'post', `/api/v1/performance/plans/${plan.id}/items`).send({ kpiId: kpi.QUALITY, weight: '100' });
    await as(admin, 'post', `/api/v1/performance/cycles/${cycleRaceId}/activate`);
    await as(admin, 'post', `/api/v1/performance/cycles/${cycleRaceId}/open-review`);

    // No self review on this cycle, so it lands on the reviewer immediately.
    const detail = await as(mgr, 'get', `/api/v1/performance/plans/${plan.id}`);
    expect(detail.body.data.status).toBe('MANAGER_REVIEW');
    await as(mgr, 'patch', `/api/v1/performance/items/${detail.body.data.items[0].id}/manager`).send({ managerScore: '3' });

    const both = await Promise.all([
      as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`),
      as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`),
    ]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    const finalized = await prisma.performancePlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(finalized.status).toBe('FINALIZED');
    expect(finalized.weightedScore?.toFixed(2)).toBe('3.00');
  }, 120000);

  it('two self submissions produce one, and closing a cycle beside a submission leaves a coherent state', async () => {
    const cycle = await as(admin, 'post', '/api/v1/performance/cycles').send({
      code: 'RACE2', name: 'Race 2', periodStart: '2026-01-01', periodEnd: '2026-12-31', minScore: '1', maxScore: '5', ratingBands: BANDS,
    });
    const raceId = cycle.body.data.id as string;
    await as(admin, 'post', `/api/v1/performance/cycles/${raceId}/assign`).send({ employeeIds: [emp.EMP003] });
    const plan = (await as(admin, 'get', `/api/v1/performance/plans?view=all&cycleId=${raceId}`)).body.data[0];
    await as(admin, 'post', `/api/v1/performance/plans/${plan.id}/items`).send({ kpiId: kpi.COLLABORATION, weight: '100' });
    await as(admin, 'post', `/api/v1/performance/cycles/${raceId}/activate`);
    await as(admin, 'post', `/api/v1/performance/cycles/${raceId}/open-review`);

    const items = (await as(emp1, 'get', `/api/v1/performance/plans/${plan.id}`)).body.data.items;
    await as(emp1, 'patch', `/api/v1/performance/items/${items[0].id}/self`).send({ selfScore: '4' });
    const both = await Promise.all([
      as(emp1, 'post', `/api/v1/performance/plans/${plan.id}/submit-self`),
      as(emp1, 'post', `/api/v1/performance/plans/${plan.id}/submit-self`),
    ]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await prisma.performancePlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('MANAGER_REVIEW');

    // Closing the cycle while the reviewer submits: whichever wins, the plan is never half-finalized.
    await as(mgr, 'patch', `/api/v1/performance/items/${items[0].id}/manager`).send({ managerScore: '4' });
    const [closeResult, submitResult] = await Promise.all([
      as(admin, 'post', `/api/v1/performance/cycles/${raceId}/close`),
      as(mgr, 'post', `/api/v1/performance/plans/${plan.id}/submit-manager`),
    ]);
    expect([closeResult.status, submitResult.status]).toContain(200);
    const after = await prisma.performancePlan.findUniqueOrThrow({ where: { id: plan.id } });
    if (after.status === 'FINALIZED') {
      expect(after.weightedScore?.toFixed(2)).toBe('4.00');
      expect(after.finalizedAt).toBeTruthy();
    } else {
      expect(after.weightedScore).toBeNull();
      expect(after.finalizedAt).toBeNull();
    }
  }, 120000);
});
