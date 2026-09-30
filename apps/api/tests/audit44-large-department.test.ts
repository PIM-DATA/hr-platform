/**
 * T44-P1-13 — attendance / overtime totals must not depend on a first-N employee list.
 *
 * Task 44 evidence: one department of 520 employees; the attendance and overtime range reports loaded the first 500
 * employees (`take: 500`, by employee code) and summed only them — 500 rows, 500 × totals, executive
 * `attendance.employees: 500`, no truncation marker. Those assertions were `it.fails` until Task 48.
 *
 * Task 48: the totals are one SQL aggregate over the whole scope; the rows are a separate page (`meta`, `totalEmployees`).
 * Departments of 499, 500, 501, 520 and 1,000 employees, one worked day and one approved hour of overtime each, prove
 * the totals are independent of the page limit — in the report, the executive overview and the Report Center — and that
 * recalculation covers everybody (it used to stop at 2,000 employees; a batch boundary at 500 is crossed here).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
const SIZES = [499, 500, 501, 520, 1000] as const;
const DAY = '2026-09-01';
let hr: { cookie: string; csrf: string };
const dept: Record<number, string> = {};
const get = (url: string) => request(app).get(url).set('Cookie', hr.cookie).set('x-csrf-token', hr.csrf);
const post = (url: string) => request(app).post(url).set('Cookie', hr.cookie).set('x-csrf-token', hr.csrf);
const timings: Record<string, number> = {};
const timed = async <T>(label: string, fn: () => Promise<T>) => { const t = performance.now(); const r = await fn(); timings[label] = Math.round(performance.now() - t); return r; };

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'BIG', name: 'Big Co', timezone: 'Asia/Bangkok' } });
  const job = await prisma.job.create({ data: { code: 'OP', title: 'Operator', level: 1 } });
  const hrUser = await createUser({ email: 'hradmin@big.local', password: PW, role: 'HR_ADMIN' });
  for (const n of SIZES) {
    const d = await prisma.department.create({ data: { organizationId: org.id, code: `D${n}`, name: `Plant ${n}` } });
    dept[n] = d.id;
    const pos = await prisma.position.create({ data: { departmentId: d.id, code: `OP${n}`, title: 'Operator', jobId: job.id } });
    await prisma.employee.createMany({
      data: Array.from({ length: n }, (_, i) => {
        const code = `P${n}-${String(i + 1).padStart(4, '0')}`;
        return { employeeCode: code, firstName: code, lastName: 'Worker', email: `${code.toLowerCase()}@big.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: d.id, positionId: pos.id, employmentType: 'FULL_TIME' as const, employmentStatus: 'ACTIVE' as const };
      }),
    });
    const ids = (await prisma.employee.findMany({ where: { departmentId: d.id }, select: { id: true } })).map((e) => e.id);
    const at = new Date(`${DAY}T01:00:00Z`);
    await prisma.attendanceRecord.createMany({ data: ids.map((employeeId) => ({ employeeId, attendanceDate: DAY, dayType: 'WORKDAY', workMinutes: 480, status: 'NORMAL', calculatedAt: at })) });
    await prisma.overtimeRequest.createMany({ data: ids.map((employeeId) => ({ employeeId, attendanceDate: DAY, claimedMinutes: 60, approvedMinutes: 60, dayType: 'WORKDAY' as const, status: 'APPROVED' as const, organizationId: org.id, departmentId: d.id, createdByUserId: hrUser.id })) });
  }
  hr = await loginAs(app, 'hradmin@big.local', PW);
}, 300000);
afterAll(async () => {
  // eslint-disable-next-line no-console
  if (process.env.AUDIT44_OUT) console.log('[task48] timings ms', JSON.stringify(timings));
  await resetDatabase();
  await prisma.$disconnect();
});

describe('attendance and overtime totals cover the whole department, whatever the page size', () => {
  for (const n of SIZES) {
    it(`${n} employees: attendance totals, population and paging`, async () => {
      const r = await timed(`attendance ${n}`, () => get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${dept[n]}`));
      expect(r.status).toBe(200);
      const att = r.body.data;
      expect(att.totals.presentDays).toBe(n);
      expect(att.totals.workMinutes).toBe(n * 480);
      expect(att.totalEmployees).toBe(n);
      expect(att.meta).toEqual({ page: 1, pageSize: 50, total: n });
      expect(att.rows).toHaveLength(50); // the page, never the population
    });

    it(`${n} employees: overtime totals and population`, async () => {
      const r = await timed(`overtime ${n}`, () => get(`/api/v1/attendance/overtime/reports/overview?from=${DAY}&to=${DAY}&departmentId=${dept[n]}`));
      expect(r.status).toBe(200);
      const ot = r.body.data;
      expect(ot.totals.approvedMinutes).toBe(n * 60);
      expect(ot.totals.approvedRequests).toBe(n);
      expect(ot.totalEmployees).toBe(n);
      expect(ot.meta.total).toBe(n);
    });
  }

  it('the last page holds the remainder; walking every page visits each employee exactly once', async () => {
    const seen = new Set<string>();
    for (let page = 1; page <= 6; page++) {
      const r = await get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${dept[520]}&page=${page}&pageSize=100`);
      expect(r.body.data.rows).toHaveLength(page < 6 ? 100 : 20);
      expect(r.body.data.totals.presentDays).toBe(520); // totals do not follow the page
      for (const row of r.body.data.rows as { employee: { id: string } }[]) seen.add(row.employee.id);
    }
    expect(seen.size).toBe(520);
    const beyond = await get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${dept[520]}&page=7&pageSize=100`);
    expect(beyond.body.data.rows).toHaveLength(0);
    expect(beyond.body.data.totals.presentDays).toBe(520);
  });

  it('a page larger than 100 rows is refused, not silently shortened', async () => {
    const r = await get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${dept[1000]}&pageSize=1000`);
    expect(r.status).toBe(400);
    const o = await get(`/api/v1/attendance/overtime/reports/overview?from=${DAY}&to=${DAY}&pageSize=101`);
    expect(o.status).toBe(400);
  });

  it('the whole organization (3,020 employees) with no department filter', async () => {
    const total = SIZES.reduce((a, b) => a + b, 0);
    const att = (await timed('attendance all', () => get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}`))).body.data;
    expect(att.totals.presentDays).toBe(total);
    expect(att.totalEmployees).toBe(total);
    const ot = (await timed('overtime all', () => get(`/api/v1/attendance/overtime/reports/overview?from=${DAY}&to=${DAY}`))).body.data;
    expect(ot.totals.approvedMinutes).toBe(total * 60);
  });
});

describe('consumers', () => {
  it('executive overview: attendance and overtime reflect every employee, per department and in total, with no rows', async () => {
    const r = await timed('executive overview', () => get(`/api/v1/analytics/executive/overview?from=${DAY}&to=${DAY}`));
    expect(r.status).toBe(200);
    const total = SIZES.reduce((a, b) => a + b, 0);
    const { attendance, overtime } = r.body.data.sections;
    expect(attendance.employees).toBe(total);
    expect(attendance.totals.presentDays).toBe(total);
    expect(overtime.totals.approvedMinutes).toBe(total * 60);
    for (const n of SIZES) {
      expect(attendance.byDepartment.find((d: { departmentName: string }) => d.departmentName === `Plant ${n}`).presentDays).toBe(n);
      expect(overtime.byDepartment.find((d: { departmentName: string }) => d.departmentName === `Plant ${n}`).approvedMinutes).toBe(n * 60);
    }
    expect(JSON.stringify(r.body.data)).not.toMatch(/P1000-0001|employeeCode/);
  });

  it('Report Center: grouped attendance counts every record (the preview page is not the population)', async () => {
    const total = SIZES.reduce((a, b) => a + b, 0);
    const r = await post('/api/v1/reports/run').send({
      datasetId: 'attendance_summary', page: 1,
      definition: { columns: ['dayType'], filters: [{ fieldId: 'attendanceDate', operator: 'BETWEEN', value: [DAY, DAY] }], sort: [], groupBy: ['dayType'], aggregations: [{ fieldId: 'workMinutes', function: 'SUM', alias: 'Minutes' }, { fieldId: 'workMinutes', function: 'COUNT', alias: 'Days' }], pageSize: 50 },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.rows).toHaveLength(1);
    expect(Object.values(r.body.data.rows[0])).toEqual(expect.arrayContaining([total * 480, total]));
  });

  it('recalculation covers every active employee in scope (no 2,000 cap; crosses the 500 batch boundary)', async () => {
    const one = await timed('recalculate 501', () => post('/api/v1/attendance/recalculate').send({ from: DAY, to: DAY, departmentId: dept[501] }));
    expect(one.status).toBe(200);
    expect(one.body.data).toEqual({ employees: 501, records: 501 });
    // Before Task 48 this stopped at 2,000 of the 3,020 employees and said "employees: 2000".
    const all = await timed('recalculate 3020', () => post('/api/v1/attendance/recalculate').send({ from: DAY, to: DAY }));
    expect(all.status).toBe(200);
    expect(all.body.data).toEqual({ employees: 3020, records: 3020 });
  }, 300000);
});
