/**
 * Task 47 — T44-P1-18: narrative free text never lands in the append-only audit log.
 *
 * Unique sentinels go through the real flows (leave reason on draft and edit, approver comment, termination reason,
 * ER case title) and are then searched for in the stored rows and in the audit API. The facts an auditor needs —
 * action, record, status transition, lengths, who and when — must still be there. A row written before this rule
 * (inserted raw, as an existing database would hold it) is masked on read.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { buildAuthContext } from '../src/services/authorization/authorization.service';
import { separateEmployeeWithTx } from '../src/modules/employees/employees.service';
import { createTestServer, resetDatabase } from './helpers';
import { setupLeaveFixture, type LeaveFixture } from './leave-fixture';

vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-23T03:00:00.000Z') });

const app = createTestServer();
let f: LeaveFixture;
const LEAVE = 'LEAVE_PRIVATE_SENTINEL my doctor says';
const LEAVE_EDIT = 'LEAVE_PRIVATE_SENTINEL_EDIT surgery follow-up';
const APPROVER = 'APPROVER_PRIVATE_SENTINEL get well soon';
const ER = 'ER_PRIVATE_SENTINEL harassment by a colleague';
const TERMINATION = 'TERMINATION_PRIVATE_SENTINEL misconduct details';
const ALL = [LEAVE, LEAVE_EDIT, APPROVER, ER, TERMINATION].map((s) => s.split(' ')[0]!);

beforeAll(async () => {
  await resetDatabase();
  f = await setupLeaveFixture(app);
}, 120000);
afterAll(async () => { vi.useRealTimers(); await resetDatabase(); await prisma.$disconnect(); });

const auditText = async () => JSON.stringify(await prisma.auditLog.findMany({ select: { oldValue: true, newValue: true } }));

describe('free text is replaced by facts in the audit log', () => {
  it('leave: a reason on draft and on edit, and the approver comment, are stored as lengths only', async () => {
    const d = await f.as(f.s.emp, 'post', '/api/v1/leave/requests').send({ leaveTypeId: f.types.ANNUAL, startDate: f.wd(5), endDate: f.wd(5), reason: LEAVE });
    expect(d.status).toBe(201);
    const e = await f.as(f.s.emp, 'patch', `/api/v1/leave/requests/${d.body.data.id}`).send({ reason: LEAVE_EDIT });
    expect(e.status).toBe(200);
    const sub = await f.as(f.s.emp, 'post', `/api/v1/leave/requests/${d.body.data.id}/submit`);
    expect(sub.status).toBe(200);
    const ap = await f.as(f.s.mgr, 'post', `/api/v1/workflow/instances/${sub.body.data.workflowInstanceId}/actions`).send({ action: 'APPROVE', comment: APPROVER });
    expect(ap.status).toBe(200);
    const upd = await prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE_LEAVE_REQUEST', recordId: d.body.data.id } });
    expect(JSON.parse(upd.newValue!)).toMatchObject({ reasonLength: LEAVE_EDIT.length, startDate: f.wd(5) });
    expect(JSON.parse(upd.oldValue!)).toMatchObject({ reasonLength: LEAVE.length });
    const appr = await prisma.auditLog.findFirstOrThrow({ where: { action: 'APPROVE_LEAVE_REQUEST', recordId: d.body.data.id } });
    expect(JSON.parse(appr.newValue!)).toMatchObject({ status: 'APPROVED', commentLength: APPROVER.length });
    expect(appr.userId).toBeTruthy();
  });

  it('termination: the reason is stored as a length; the status transition and date stay', async () => {
    const actor = await prisma.user.findFirstOrThrow({ where: { email: 'hradmin@lv.local' }, include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } } });
    const auth = buildAuthContext({ user: actor, roles: actor.userRoles.map((ur) => ur.role), sessionId: 'x', csrfToken: 'x' });
    await prisma.$transaction((tx) => separateEmployeeWithTx(tx, f.employees.NOLV, { terminationDate: '2026-09-30', reason: TERMINATION }, { auth, ipAddress: null, userAgent: null }));
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'TERMINATE_EMPLOYEE', recordId: f.employees.NOLV } });
    expect(JSON.parse(row.newValue!)).toEqual({ employmentStatus: 'TERMINATED', terminationDate: '2026-09-30', reasonLength: TERMINATION.length });
  });

  it('employee relations: the case title is stored as changed + length', async () => {
    const hr = f.s.hradmin;
    const c = await f.as(hr, 'post', '/api/v1/employee-relations/cases').send({ employeeId: f.employees.EMP2, incidentDate: '2026-09-01', title: 'Initial review', description: 'Details kept on the case, never in the audit.' });
    expect(c.status).toBe(201);
    const u = await f.as(hr, 'patch', `/api/v1/employee-relations/cases/${c.body.data.id}`).send({ title: ER });
    expect(u.status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'UPDATE_EMPLOYEE_RELATION_CASE', recordId: c.body.data.id } });
    expect(JSON.parse(row.newValue!)).toMatchObject({ titleChanged: true, titleLength: ER.length });
  });

  it('no sentinel is stored anywhere in audit_logs, nor returned by the audit API', async () => {
    const stored = await auditText();
    for (const s of ALL) expect(`${s} ${stored.includes(s)}`).toBe(`${s} false`);
    const list = await f.as(f.s.hradmin, 'get', '/api/v1/audit-logs?pageSize=100');
    expect(list.status).toBe(200);
    for (const row of list.body.data as { id: string }[]) {
      const detail = await f.as(f.s.hradmin, 'get', `/api/v1/audit-logs/${row.id}`);
      for (const s of ALL) expect(JSON.stringify(detail.body)).not.toContain(s);
    }
  });

  it('defence in depth: a raw row from before this rule (e.g. an existing database) is masked on read', async () => {
    const legacy = await prisma.auditLog.create({ data: { action: 'UPDATE_LEAVE_REQUEST', module: 'leave', recordType: 'LeaveRequest', recordId: 'legacy', newValue: JSON.stringify({ reason: 'LEGACY_PRIVATE_SENTINEL chemotherapy', startDate: '2026-01-05' }) } });
    const detail = await f.as(f.s.hradmin, 'get', `/api/v1/audit-logs/${legacy.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('LEGACY_PRIVATE_SENTINEL');
    expect(detail.body.data.newValue).toEqual({ reason: { redacted: true, length: 'LEGACY_PRIVATE_SENTINEL chemotherapy'.length }, startDate: '2026-01-05' });
    // …and a new write that still carried such a key would be masked before it is stored
    const { auditService } = await import('../src/services/audit/audit.service');
    await auditService.log({ userId: null, action: 'ADJUST_LEAVE_ENTITLEMENT', module: 'leave', recordType: 'LeaveEntitlement', recordId: 'x', newValue: { note: 'NEWWRITE_PRIVATE_SENTINEL', units: 1 } });
    expect(await auditText()).not.toContain('NEWWRITE_PRIVATE_SENTINEL');
  });
});
