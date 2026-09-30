/**
 * Task 44 audit evidence: one department with more than 500 employees.
 *
 * Attendance and overtime range reports load the employees first (`take: 500`, ordered by employee code) and then
 * aggregate only those, so employee #501 onward is dropped without any signal — and the executive overview consumes
 * the same per-department reports. The correctness expectations below are written as they SHOULD hold; they are marked
 * `it.fails` because they do not hold today (finding T44 in docs/final-enterprise-readiness-audit.md). When the defect is
 * fixed, `it.fails` turns red and must be switched back to `it`. The "documents today" test pins the current behaviour.
 */
import { appendFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
/** Evidence lines for the audit report; written to AUDIT44_OUT when set (vitest hides console output of passing tests). */
const note = (...parts: unknown[]) => { const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '); if (process.env.AUDIT44_OUT) appendFileSync(process.env.AUDIT44_OUT, `${line}\n`); };
const PW = 'Correct-Horse-1';
const N = 520;
const DAY = '2026-09-01';
let hr: { cookie: string; csrf: string };
let deptId: string;
const get = (url: string) => request(app).get(url).set('Cookie', hr.cookie).set('x-csrf-token', hr.csrf);

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'BIG', name: 'Big Co', timezone: 'Asia/Bangkok' } });
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'PLANT', name: 'Plant' } });
  deptId = dept.id;
  const job = await prisma.job.create({ data: { code: 'OP', title: 'Operator', level: 1 } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'OP1', title: 'Operator', jobId: job.id } });
  await prisma.employee.createMany({
    data: Array.from({ length: N }, (_, i) => {
      const code = `P${String(i + 1).padStart(4, '0')}`;
      return { employeeCode: code, firstName: code, lastName: 'Worker', email: `${code.toLowerCase()}@big.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' };
    }),
  });
  const ids = (await prisma.employee.findMany({ where: { departmentId: dept.id }, select: { id: true } })).map((e) => e.id);
  const at = new Date(`${DAY}T01:00:00Z`);
  await prisma.attendanceRecord.createMany({ data: ids.map((employeeId) => ({ employeeId, attendanceDate: DAY, dayType: 'WORKDAY', workMinutes: 480, status: 'NORMAL', calculatedAt: at })) });
  const hrUser = await createUser({ email: 'hradmin@big.local', password: PW, role: 'HR_ADMIN' });
  await prisma.overtimeRequest.createMany({ data: ids.map((employeeId) => ({ employeeId, attendanceDate: DAY, claimedMinutes: 60, approvedMinutes: 60, dayType: 'WORKDAY', status: 'APPROVED', organizationId: org.id, departmentId: dept.id, createdByUserId: hrUser.id })) });
  hr = await loginAs(app, 'hradmin@big.local', PW);
}, 180000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe(`one department with ${N} employees`, () => {
  it('documents today: attendance and overtime reports stop at 500 employees without saying so', async () => {
    const att = (await get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${deptId}`)).body.data;
    const ot = (await get(`/api/v1/attendance/overtime/reports/overview?from=${DAY}&to=${DAY}&departmentId=${deptId}`)).body.data;
    expect(att.rows).toHaveLength(500);
    expect(att.totals.presentDays).toBe(500);
    expect(ot.rows).toHaveLength(500);
    expect(ot.totals.approvedMinutes).toBe(500 * 60);
    expect(JSON.stringify([att, ot])).not.toMatch(/truncat|limit|partial/i);
  });

  it.fails('attendance report counts every employee of the department', async () => {
    const att = (await get(`/api/v1/attendance/reports/overview?from=${DAY}&to=${DAY}&departmentId=${deptId}`)).body.data;
    expect(att.totals.presentDays).toBe(N);
  });

  it.fails('overtime report counts every employee of the department', async () => {
    const ot = (await get(`/api/v1/attendance/overtime/reports/overview?from=${DAY}&to=${DAY}&departmentId=${deptId}`)).body.data;
    expect(ot.totals.approvedMinutes).toBe(N * 60);
  });

  it('executive overview headcount is not capped (evidence for the report)', async () => {
    const r = await get(`/api/v1/analytics/executive/overview?from=${DAY}&to=${DAY}`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body.data);
    // Workforce headcount is a groupBy count, so it sees all employees; attendance/OT sections reuse the capped reports.
    expect(text).toContain(`${N}`);
    note('[audit44] executive attendance/overtime sections:', JSON.stringify({ attendance: r.body.data.attendance ?? r.body.data.sections?.attendance, overtime: r.body.data.overtime ?? r.body.data.sections?.overtime }).slice(0, 600));
  });
});
