/**
 * Shared fixture for the leave request suites. Everything is built through the same code paths the app uses
 * (HTTP for master data + entitlements, Prisma for org/employees). Dates are derived from business "today" so the
 * suite stays valid on any day; `wd(n)` = the n-th working day (Mon–Fri, no holiday) after today.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { addDays, businessToday, weekdayOf } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createUser, loginAs, resetDatabase } from './helpers';

export const PW = 'Correct-Horse-1';
export type Session = { cookie: string; csrf: string; user: { id: string; employee: { id: string } | null } };
export const TZ = 'Asia/Bangkok';

export async function setupLeaveFixture(app: Server) {
  await resetDatabase();
  const as = (s: Session, m: 'get' | 'post' | 'patch', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  const today = businessToday(TZ);
  const year = Number(today.slice(0, 4));
  const period = { periodStart: `${year}-01-01`, periodEnd: `${year + 1}-12-31` };

  // organizations + departments + positions
  const orgA = await prisma.organization.create({ data: { code: 'LA', name: 'Leave A', timezone: TZ } });
  const orgB = await prisma.organization.create({ data: { code: 'LB', name: 'Leave B', timezone: TZ } });
  const deptA = await prisma.department.create({ data: { organizationId: orgA.id, code: 'OPS', name: 'Ops' } });
  const deptA2 = await prisma.department.create({ data: { organizationId: orgA.id, code: 'FIN', name: 'Finance' } });
  const deptB = await prisma.department.create({ data: { organizationId: orgB.id, code: 'OPSB', name: 'Ops B' } });
  const mk = async (code: string, dept: { id: string; organizationId: string }, managerId: string | null, employmentType = 'FULL_TIME') => {
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: `P-${code}`, title: code } });
    return (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Leave', email: `${code.toLowerCase()}@lv.local`, hireDate: new Date('2020-01-01'), organizationId: dept.organizationId, departmentId: dept.id, positionId: pos.id, managerId, employmentType, employmentStatus: 'ACTIVE', positionHistory: { create: { positionId: pos.id, departmentId: dept.id, startDate: new Date('2020-01-01') } } } })).id;
  };
  const HEAD = await mk('HEAD', deptA, null);
  const MGR = await mk('MGR', deptA, HEAD);
  const EMP = await mk('EMP', deptA, MGR);
  const EMP2 = await mk('EMP2', deptA, MGR);
  const OTHER = await mk('OTHER', deptA2, HEAD); // not MGR's report
  const LONER = await mk('LONER', deptA2, null); // no manager → auto-approve definition skips
  const TRANS = await mk('TRANS', deptA, MGR); // entitlement under org A policy, later transferred to org B
  const HRA = await mk('HRA', deptA2, HEAD);
  const NOLV = await mk('NOLV', deptA2, HEAD); // account without leave permissions (users.employee_id is unique → own employee)
  await prisma.department.update({ where: { id: deptA.id }, data: { headEmployeeId: HEAD } });

  // users
  await prisma.role.create({ data: { code: 'NOLEAVE', name: 'No leave', dataScope: 'SELF', isSystem: false, rolePermissions: { create: { permission: { connect: { code: 'dashboard.view' } } } } } });
  await createUser({ email: 'admin@lv.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hr@lv.local', password: PW, role: 'HR' }); // leave.view + leave.request, NO employee profile
  await createUser({ email: 'hradmin@lv.local', password: PW, role: 'HR_ADMIN', employeeId: HRA }); // ALL scope + workflow.approve
  await createUser({ email: 'mgr@lv.local', password: PW, role: 'MANAGER', employeeId: MGR });
  await createUser({ email: 'head@lv.local', password: PW, role: 'MANAGER', employeeId: HEAD });
  await createUser({ email: 'emp@lv.local', password: PW, role: 'EMPLOYEE', employeeId: EMP });
  await createUser({ email: 'emp2@lv.local', password: PW, role: 'EMPLOYEE', employeeId: EMP2 });
  await createUser({ email: 'other@lv.local', password: PW, role: 'EMPLOYEE', employeeId: OTHER });
  await createUser({ email: 'loner@lv.local', password: PW, role: 'EMPLOYEE', employeeId: LONER });
  await createUser({ email: 'trans@lv.local', password: PW, role: 'EMPLOYEE', employeeId: TRANS });
  await createUser({ email: 'noleave@lv.local', password: PW, role: 'NOLEAVE', employeeId: NOLV });
  const names = ['admin', 'hr', 'hradmin', 'mgr', 'head', 'emp', 'emp2', 'other', 'loner', 'trans', 'noleave'] as const;
  const sessions = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await loginAs(app, `${n}@lv.local`, PW)]))) as Record<(typeof names)[number], Session>;
  const admin = sessions.admin;

  // calendars: Mon–Fri; holiday on the 8th working day ahead (org A) — org B gets its own calendar
  const wdRaw = (n: number, from = today) => { let d = from, k = 0; while (k < n) { d = addDays(d, 1); if (!['SAT', 'SUN'].includes(weekdayOf(d))) k++; } return d; };
  const HOLIDAY = wdRaw(8);
  const mkCal = async (org: { id: string }, code: string, holidays: string[]) => {
    const c = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: org.id, code, name: code, workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
    if (c.status !== 201) throw new Error(JSON.stringify(c.body));
    for (const h of holidays) await as(admin, 'post', `/api/v1/calendars/${c.body.data.id}/holidays`).send({ date: h, name: `Holiday ${h}` });
    const d = await as(admin, 'patch', `/api/v1/calendars/organizations/${org.id}/default`).send({ calendarId: c.body.data.id });
    if (d.status !== 200) throw new Error(JSON.stringify(d.body));
    return c.body.data.id as string;
  };
  const calA = await mkCal(orgA, 'STD-A', [HOLIDAY]);
  const calB = await mkCal(orgB, 'STD-B', []);
  /** n-th working day after `from` that is not the holiday. */
  const wd = (n: number, from = today) => { let d = from, k = 0; while (k < n) { d = addDays(d, 1); if (!['SAT', 'SUN'].includes(weekdayOf(d)) && d !== HOLIDAY) k++; } return d; };

  // workflows
  const wf = async (code: string, steps: object[]) => { const d = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code, name: code, module: 'leave', entityType: 'LEAVE_REQUEST', steps }); if (d.status !== 201) throw new Error(JSON.stringify(d.body)); const a = await as(admin, 'post', `/api/v1/workflow/definitions/${d.body.data.id}/activate`); if (a.status !== 200) throw new Error(JSON.stringify(a.body)); };
  await wf('LEAVE_STD', [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }]);
  await wf('LEAVE_TWO', [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }, { name: 'Head', approverType: 'DEPARTMENT_HEAD' }]);
  await wf('LEAVE_AUTO', [{ name: 'Manager', approverType: 'DIRECT_MANAGER', onUnresolved: 'SKIP' }]);

  // leave types + policies
  const type = async (code: string) => { const r = await as(admin, 'post', '/api/v1/leave/types').send({ code, name: code }); if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r.body.data.id as string; };
  const types = { ANNUAL: await type('ANNUAL'), SICK: await type('SICK'), STRICT: await type('STRICT'), LONG: await type('LONG'), ADV: await type('ADV'), AUTO: await type('AUTO'), NOWF: await type('NOWF') };
  const policy = async (body: object) => {
    const c = await as(admin, 'post', '/api/v1/leave/policies').send({ annualUnits: 10, effectiveFrom: `${year - 1}-01-01`, workflowDefinitionCode: 'LEAVE_STD', allowBackdate: true, ...body });
    if (c.status !== 201) throw new Error(JSON.stringify(c.body));
    const a = await as(admin, 'patch', `/api/v1/leave/policies/${c.body.data.id}/activate`); if (a.status !== 200) throw new Error(JSON.stringify(a.body));
    return c.body.data.id as string;
  };
  const policies = {
    annualA: await policy({ name: 'Annual A', leaveTypeId: types.ANNUAL, organizationId: orgA.id, annualUnits: 10 }),
    annualB: await policy({ name: 'Annual B (negative ok)', leaveTypeId: types.ANNUAL, organizationId: orgB.id, annualUnits: 10, allowNegativeBalance: true }),
    sick: await policy({ name: 'Sick', leaveTypeId: types.SICK, annualUnits: 5, requiresAttachment: true }),
    strict: await policy({ name: 'Strict', leaveTypeId: types.STRICT, annualUnits: 10, allowHalfDay: false, allowBackdate: false, minNoticeDays: 3, maxConsecutiveDays: 2, requiresReason: true }),
    long: await policy({ name: 'Long (two-step)', leaveTypeId: types.LONG, annualUnits: 10, workflowDefinitionCode: 'LEAVE_TWO' }),
    adv: await policy({ name: 'Advance (negative ok)', leaveTypeId: types.ADV, annualUnits: 1, allowNegativeBalance: true }),
    auto: await policy({ name: 'Auto', leaveTypeId: types.AUTO, annualUnits: 5, workflowDefinitionCode: 'LEAVE_AUTO' }),
  };

  // entitlements (HTTP generate → GRANT ledger)
  const entitle = async (employeeId: string, leaveTypeId: string) => { const r = await as(admin, 'post', '/api/v1/leave/entitlements').send({ employeeId, leaveTypeId, ...period }); if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r.body.data.id as string; };
  const ent: Record<string, string> = {};
  for (const e of [EMP, EMP2, OTHER, TRANS]) for (const t of ['ANNUAL', 'SICK', 'STRICT', 'LONG', 'ADV'] as const) ent[`${e}:${t}`] = await entitle(e, types[t]);
  ent[`${HRA}:ANNUAL`] = await entitle(HRA, types.ANNUAL);
  ent[`${LONER}:AUTO`] = await entitle(LONER, types.AUTO);
  ent[`${LONER}:ANNUAL`] = await entitle(LONER, types.ANNUAL);

  return { as, today, year, period, orgA, orgB, deptA, deptB, calA, calB, HOLIDAY, wd, wdRaw, employees: { HEAD, MGR, EMP, EMP2, OTHER, LONER, TRANS, HRA, NOLV }, s: sessions, types, policies, ent };
}
export type LeaveFixture = Awaited<ReturnType<typeof setupLeaveFixture>>;
