import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { getDashboardSummary } from '../src/modules/dashboard/dashboard.service';
import { windowStartIncludingToday } from '../src/lib/dates';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { createTestServer, createUser, explainAuthFailure, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, url: string) => request(app).get(url).set('Cookie', s.cookie);
const DAY = 86_400_000;

// dataset: CEO → Manager → Employee → Indirect ; Unrelated (Sales) ; Inactive (Sales, reports to Manager)
let deptExec: string, deptData: string, deptSales: string, deptEmpty: string;
let CEO: string, MGR: string, EMP: string, IND: string, UNR: string, OFF: string;
let ceoS: Session, mgrS: Session, empS: Session, hrS: Session, selfNoEmpS: Session, noPermS: Session;

async function mkEmployee(code: string, departmentId: string, managerId: string | null, hireDate: Date, status = 'ACTIVE') {
  const pos = await prisma.position.create({ data: { departmentId, code: `P-${code}`, title: `Seat ${code}` } });
  const org = (await prisma.department.findUniqueOrThrow({ where: { id: departmentId } })).organizationId;
  return (await prisma.employee.create({
    data: {
      employeeCode: code, firstName: code, lastName: 'Dash', email: `${code.toLowerCase()}@dash.local`, hireDate,
      organizationId: org, departmentId, positionId: pos.id, managerId, employmentStatus: status,
      positionHistory: { create: { positionId: pos.id, departmentId, startDate: hireDate } },
      managerHistory: managerId ? { create: { managerId, startDate: hireDate } } : undefined,
    },
  })).id;
}

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'DASH', name: 'Dash Co' } });
  const dept = (code: string) => prisma.department.create({ data: { organizationId: org.id, code, name: code } });
  deptExec = (await dept('EXEC')).id; deptData = (await dept('DATA')).id; deptSales = (await dept('SALES')).id; deptEmpty = (await dept('EMPTY')).id;
  const old = new Date('2020-01-01');
  CEO = await mkEmployee('CEO', deptExec, null, old);
  MGR = await mkEmployee('MGR', deptData, CEO, old);
  EMP = await mkEmployee('EMP', deptData, MGR, old);
  IND = await mkEmployee('IND', deptData, EMP, old);
  UNR = await mkEmployee('UNR', deptSales, CEO, old);
  OFF = await mkEmployee('OFF', deptSales, MGR, old, 'INACTIVE');

  await createUser({ email: 'ceo@dash.local', password: PW, role: 'MANAGER', employeeId: CEO }); // TEAM: CEO + MGR + UNR
  await createUser({ email: 'mgr@dash.local', password: PW, role: 'MANAGER', employeeId: MGR }); // TEAM: MGR + EMP + OFF
  await createUser({ email: 'emp@dash.local', password: PW, role: 'EMPLOYEE', employeeId: EMP }); // SELF
  await createUser({ email: 'hr@dash.local', password: PW, role: 'HR' }); // ALL, no employee
  await createUser({ email: 'selfnoemp@dash.local', password: PW, role: 'EMPLOYEE' }); // SELF, no employee
  const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'employees.view' } });
  await prisma.role.create({ data: { code: 'NO_DASH', name: 'no dashboard', dataScope: 'ALL', rolePermissions: { create: [{ permissionId: perm.id }] } } });
  await createUser({ email: 'nodash@dash.local', password: PW, role: 'NO_DASH' });
  [ceoS, mgrS, empS, hrS, selfNoEmpS, noPermS] = await Promise.all(['ceo', 'mgr', 'emp', 'hr', 'selfnoemp', 'nodash'].map((u) => loginAs(app, `${u}@dash.local`, PW)));
});
afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const summary = async (s: Session) => {
  const res = await as(s, '/api/v1/dashboard/summary');
  expect(res.status).toBe(200);
  return res.body.data as { employees: { total: number; active: number; newLast30Days: number }; departments: { represented: number }; scope: string; generatedAt: string };
};

describe('permissions', () => {
  it('1. unauthenticated → 401', async () => expect((await request(app).get('/api/v1/dashboard/summary')).status).toBe(401));
  it('2. without dashboard.view → 403 (even with employees.view)', async () => {
    const res = await as(noPermS, '/api/v1/dashboard/summary');
    if (res.status !== 403) throw new Error(`unexpected ${res.status}: ${await explainAuthFailure('nodash@dash.local', res, noPermS.cookie)}`);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
  it('3. dashboard.view → 200 with typed shape; not audited', async () => {
    const before = await prisma.auditLog.count();
    const d = await summary(hrS);
    expect(d).toMatchObject({ employees: { total: expect.any(Number), active: expect.any(Number), newLast30Days: expect.any(Number) }, departments: { represented: expect.any(Number) }, scope: 'ALL' });
    expect(new Date(d.generatedAt).getTime()).toBeGreaterThan(0);
    expect(await prisma.auditLog.count()).toBe(before);
  });
});

describe('data scope', () => {
  it('4–6. SELF: total = self only, active reflects self, departments = own department', async () => {
    const d = await summary(empS);
    expect(d).toMatchObject({ employees: { total: 1, active: 1, newLast30Days: 0 }, departments: { represented: 1 }, scope: 'SELF' });
    await prisma.employee.update({ where: { id: EMP }, data: { employmentStatus: 'INACTIVE' } });
    expect((await summary(empS)).employees).toMatchObject({ total: 1, active: 0 });
    await prisma.employee.update({ where: { id: EMP }, data: { employmentStatus: 'ACTIVE' } });
  });
  it('7–11. TEAM: self + direct reports (MGR, EMP, OFF); indirect (IND) and unrelated (UNR) excluded; active + distinct departments correct', async () => {
    const d = await summary(mgrS);
    expect(d.scope).toBe('TEAM');
    expect(d.employees.total).toBe(3); // MGR + EMP + OFF (inactive still counted in total)
    expect(d.employees.active).toBe(2); // OFF is INACTIVE
    expect(d.departments.represented).toBe(2); // DATA (MGR, EMP) + SALES (OFF)
    const ceo = await summary(ceoS);
    expect(ceo.employees.total).toBe(3); // CEO + MGR + UNR — not EMP/IND
    expect(ceo.departments.represented).toBe(3); // EXEC, DATA, SALES
  });
  it('12–14. ALL: everything, active count, distinct departments (EMPTY department master not counted)', async () => {
    const d = await summary(hrS);
    expect(d.employees).toMatchObject({ total: 6, active: 5 });
    expect(d.departments.represented).toBe(3); // EXEC, DATA, SALES — EMPTY has no employees
    expect(await prisma.department.count()).toBe(4);
  });
  it('15. user with no employeeId + SELF → all employee metrics 0', async () => {
    expect(await summary(selfNoEmpS)).toMatchObject({ employees: { total: 0, active: 0, newLast30Days: 0 }, departments: { represented: 0 }, scope: 'SELF' });
  });
  it('16. user with no employeeId + ALL → sees all', async () => {
    expect((await summary(hrS)).employees.total).toBe(6);
  });
});

describe('new employees — last 30 days (hireDate, UTC day boundaries, injectable now)', () => {
  const now = new Date('2026-09-22T15:30:00Z');
  const ctx = (scope: 'SELF' | 'TEAM' | 'ALL', employeeId: string | null): AuthContext =>
    ({ userId: 'u', email: 'x', employeeId, roles: [], permissions: ['dashboard.view'], permissionScopes: { 'dashboard.view': scope }, dataScope: scope, sessionId: 's', csrfToken: 'c' });
  it('window start = startOfDay(today − 29)', () => {
    expect(windowStartIncludingToday(30, now).toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });
  it('17. hired today → included; 18. hired 29 days ago → included; 19. 30 days ago → excluded', async () => {
    const today = await mkEmployee('N-TODAY', deptData, null, new Date('2026-09-22T00:00:00Z'));
    const d29 = await mkEmployee('N-29', deptData, null, new Date(Date.UTC(2026, 7, 24))); // 2026-08-24 = today − 29
    const d30 = await mkEmployee('N-30', deptData, null, new Date(Date.UTC(2026, 7, 23))); // today − 30 → outside
    const d = await getDashboardSummary(ctx('ALL', null), now);
    expect(d.employees.newLast30Days).toBe(2);
    // sanity: which ones
    const inWindow = await prisma.employee.findMany({ where: { hireDate: { gte: windowStartIncludingToday(30, now) } }, select: { employeeCode: true } });
    expect(inWindow.map((e) => e.employeeCode).sort()).toEqual(['N-29', 'N-TODAY']);
    expect([today, d29, d30]).toHaveLength(3);
  });
  it('20. created recently but old hireDate → excluded; 21. old record updated today → excluded', async () => {
    const before = (await getDashboardSummary(ctx('ALL', null), now)).employees.newLast30Days;
    await mkEmployee('N-OLDHIRE', deptData, null, new Date('2019-05-01')); // createdAt = now, hireDate old
    await prisma.employee.update({ where: { id: CEO }, data: { nickname: 'touched' } }); // updatedAt = now
    expect((await getDashboardSummary(ctx('ALL', null), now)).employees.newLast30Days).toBe(before);
  });
  it('22. scope still applies to the new-employee metric', async () => {
    expect((await getDashboardSummary(ctx('SELF', EMP), now)).employees.newLast30Days).toBe(0);
    expect((await getDashboardSummary(ctx('TEAM', MGR), now)).employees.newLast30Days).toBe(0);
    const nTodayId = (await prisma.employee.findUniqueOrThrow({ where: { employeeCode: 'N-TODAY' } })).id;
    expect((await getDashboardSummary(ctx('SELF', nTodayId), now)).employees.newLast30Days).toBe(1);
    await prisma.employeePosition.deleteMany({ where: { employee: { employeeCode: { startsWith: 'N-' } } } });
    await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: 'N-' } } });
  });
});

describe('departments represented (distinct)', () => {
  it('23. three employees in one department → 1 (TEAM view of a single-department team)', async () => {
    // EMP manages IND; give EMP a second report in DATA → EMP + IND + X all in DATA
    const x = await mkEmployee('X', deptData, EMP, new Date('2020-01-01'));
    const teamOfEmp: AuthContext = { userId: 'u', email: 'x', employeeId: EMP, roles: [], permissions: ['dashboard.view'], permissionScopes: { 'dashboard.view': 'TEAM' }, dataScope: 'TEAM', sessionId: 's', csrfToken: 'c' };
    const d = await getDashboardSummary(teamOfEmp);
    expect(d.employees.total).toBe(3);
    expect(d.departments.represented).toBe(1);
    await prisma.employeePosition.deleteMany({ where: { employeeId: x } }); await prisma.employeeManager.deleteMany({ where: { employeeId: x } }); await prisma.employee.delete({ where: { id: x } });
  });
  it('24. visible employees across two departments → 2', async () => {
    expect((await summary(mgrS)).departments.represented).toBe(2);
  });
  it('25. departmentId cannot be null — the schema enforces it (FK NOT NULL), so null never dilutes the count', async () => {
    await expect(prisma.employee.create({ data: { employeeCode: 'NULLDEPT', firstName: 'x', lastName: 'y', email: 'nd@dash.local', hireDate: new Date(), organizationId: 'o', positionId: 'p' } as never })).rejects.toThrow();
  });
  it('26. department master without employees is not counted', async () => {
    expect((await prisma.department.findUniqueOrThrow({ where: { id: deptEmpty } })).isActive).toBe(true);
    expect((await summary(hrS)).departments.represented).toBe(3);
  });
});

describe('dashboard ↔ employee list consistency (same scope source)', () => {
  it('total equals the unfiltered employee list population for SELF / TEAM / ALL', async () => {
    for (const s of [empS, mgrS, ceoS, hrS, selfNoEmpS]) {
      const d = await summary(s);
      const list = await as(s, '/api/v1/employees?pageSize=1');
      expect(list.status).toBe(200);
      expect(d.employees.total, `scope ${d.scope}`).toBe(list.body.meta.total);
    }
  });
});
