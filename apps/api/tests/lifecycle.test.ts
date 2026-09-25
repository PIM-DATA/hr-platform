/**
 * Task 34 — onboarding, probation, offboarding.
 *
 * What these tests guard: templates are copied, not referenced; an employee without an account is never
 * provisioned and their tasks stay visibly unassigned; task and plan completion are one transition under
 * concurrency; probation outcomes are recorded by a person and change nothing in employment; the separation is the
 * only master change, happens once, disables the account and kills its sessions, and never touches payroll,
 * documents or recruitment; cancel-vs-complete leaves one terminal state; snapshots stay historical; managers and
 * employees see only their own scope; executives see counts only.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addCalendarDays, checklistProgress } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const L = '/api/v1/lifecycle';
const text = (v: unknown) => JSON.stringify(v);

let hrAdmin: Session, hr: Session, mgrA: Session, mgrB: Session, emp: Session, exec: Session, jane: Session | null = null;
let orgId: string, engId: string, opsId: string, engPos: string, mgrPos: string;
const employees: Record<string, string> = {};
let onbTemplate: string, offTemplate: string, policyId: string;

function personalDataIn(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const forbidden = /^(employeeId|employeeCode|firstName|lastName|email|employeeName|reasonNote|comment|note|exitInterview)$/;
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (forbidden.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } else if (typeof v === 'string' && /Jane|EMP00|Person|budget cut|slow start/.test(v)) hits.push(`${p}="${v}"`); };
  walk(value, path); return hits;
}
const masters = async (employeeId: string) => ({ emp: await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { employmentStatus: true, terminationDate: true, user: { select: { isActive: true } } } }), payroll: await prisma.payrollRun.count(), er: await prisma.employeeRelationCase.count(), reqs: await prisma.recruitmentRequisition.count(), docs: await prisma.document.count(), users: await prisma.user.count() });

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A34', name: 'Lifecycle Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const eng = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  const ops = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  engId = eng.id; opsId = ops.id;
  const job = await prisma.job.create({ data: { code: 'ENG', title: 'Engineer', level: 2 } });
  const mgrJob = await prisma.job.create({ data: { code: 'EM', title: 'Engineering Manager', level: 4 } });
  engPos = (await prisma.position.create({ data: { departmentId: eng.id, code: 'ENG1', title: 'Engineer', jobId: job.id } })).id;
  mgrPos = (await prisma.position.create({ data: { departmentId: eng.id, code: 'EM1', title: 'Engineering Manager', jobId: mgrJob.id } })).id;
  const opsPos = (await prisma.position.create({ data: { departmentId: ops.id, code: 'OPS1', title: 'Operations Officer', jobId: job.id } })).id;
  const mk = async (code: string, first: string, positionId: string, departmentId: string, managerId: string | null, hire = '2026-09-01') => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a34.local`, hireDate: new Date(`${hire}T00:00:00Z`), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE', positionHistory: { create: { positionId, departmentId, startDate: new Date(`${hire}T00:00:00Z`) } }, ...(managerId ? { managerHistory: { create: { managerId, startDate: new Date(`${hire}T00:00:00Z`) } } } : {}) } })).id);
  await mk('MGRA', 'Alice', mgrPos, eng.id, null, '2020-01-01');
  await mk('MGRB', 'Bob', opsPos, ops.id, null, '2020-01-01');
  await mk('HRADM', 'Hana', opsPos, ops.id, null, '2020-01-01');
  await mk('EMP003', 'Emma', engPos, eng.id, employees.MGRA, '2026-06-01');
  await mk('EMP004', 'Ed', engPos, eng.id, employees.MGRA, '2026-01-15');
  await mk('EMP005', 'Olly', opsPos, ops.id, employees.MGRB, '2026-02-01');
  await mk('EMP-NEW-001', 'Jane', engPos, eng.id, employees.MGRA, '2026-10-01'); // no user account yet
  await createUser({ email: 'hradmin@a34.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a34.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@a34.local', password: PW, role: 'MANAGER', employeeId: employees.MGRA });
  await createUser({ email: 'mgrb@a34.local', password: PW, role: 'MANAGER', employeeId: employees.MGRB });
  await createUser({ email: 'emp@a34.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp4@a34.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a34.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgrA, mgrB, emp, exec] = await Promise.all(['hradmin', 'hr', 'mgra', 'mgrb', 'emp', 'exec'].map((u) => loginAs(app, `${u}@a34.local`, PW)));
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

const day = (d: string) => d;

describe('templates', () => {
  it('HR admin builds onboarding and offboarding templates; HR and managers cannot; relative dates are validated per type', async () => {
    const onb = await as(hrAdmin, 'post', `${L}/templates`).send({ code: 'ONB-STD', name: 'Standard onboarding', type: 'ONBOARDING', tasks: [
      { title: 'Prepare employee documents', category: 'PRE_START', assigneeType: 'HR', dueOffsetDays: -3, relativeTo: 'START_DATE' },
      { title: 'Prepare workstation', category: 'PRE_START', assigneeType: 'HR', dueOffsetDays: -1, relativeTo: 'START_DATE' },
      { title: 'Review company policies', category: 'DAY_1', assigneeType: 'EMPLOYEE', dueOffsetDays: 0, relativeTo: 'START_DATE', requiresDocument: false },
      { title: 'Meet manager', category: 'DAY_1', assigneeType: 'MANAGER', dueOffsetDays: 0, relativeTo: 'START_DATE' },
      { title: 'Complete orientation', category: 'FIRST_WEEK', assigneeType: 'EMPLOYEE', dueOffsetDays: 5, relativeTo: 'START_DATE' },
      { title: 'Sign policy acknowledgement', category: 'DOCUMENT', assigneeType: 'EMPLOYEE', dueOffsetDays: 7, relativeTo: 'START_DATE', requiresDocument: true, required: false },
    ] });
    expect(err(onb)).toBe('201');
    onbTemplate = onb.body.data.id;
    expect(onb.body.data.tasks.map((t: { title: string }) => t.title)).toEqual(['Prepare employee documents', 'Prepare workstation', 'Review company policies', 'Meet manager', 'Complete orientation', 'Sign policy acknowledgement']);
    const off = await as(hrAdmin, 'post', `${L}/templates`).send({ code: 'OFF-STD', name: 'Standard offboarding', type: 'OFFBOARDING', tasks: [
      { title: 'Hand over responsibilities', category: 'HANDOVER', assigneeType: 'EMPLOYEE', dueOffsetDays: -5, relativeTo: 'LAST_WORKING_DATE' },
      { title: 'Return company property', category: 'ASSET', assigneeType: 'EMPLOYEE', dueOffsetDays: 0, relativeTo: 'LAST_WORKING_DATE' },
      { title: 'Confirm handover received', category: 'HANDOVER', assigneeType: 'MANAGER', dueOffsetDays: -1, relativeTo: 'LAST_WORKING_DATE' },
      { title: 'Final payroll preparation', category: 'PAYROLL', assigneeType: 'HR', dueOffsetDays: -2, relativeTo: 'LAST_WORKING_DATE' },
      { title: 'Revoke system access', category: 'ACCESS', assigneeType: 'HR', dueOffsetDays: 0, relativeTo: 'LAST_WORKING_DATE' },
      { title: 'Collect documents', category: 'DOCUMENT', assigneeType: 'HR', dueOffsetDays: 1, relativeTo: 'CASE_START', required: false },
    ] });
    expect(err(off)).toBe('201');
    offTemplate = off.body.data.id;
    expect(err(await as(hr, 'post', `${L}/templates`).send({ code: 'X', name: 'x', type: 'ONBOARDING' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'post', `${L}/templates`).send({ code: 'X', name: 'x', type: 'ONBOARDING' }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${L}/templates`).send({ code: 'BAD', name: 'Bad template', type: 'ONBOARDING', tasks: [{ title: 'Late', category: 'OTHER', assigneeType: 'HR', dueOffsetDays: 0, relativeTo: 'LAST_WORKING_DATE' }] }))).toBe('422 VALIDATION_ERROR');
  });
});

describe('onboarding', () => {
  let planId: string;
  it('a plan copies the template with due dates from the start date; the new hire without an account gets unassigned tasks and no user', async () => {
    const usersBefore = await prisma.user.count();
    const r = await as(hrAdmin, 'post', `${L}/onboarding`).send({ employeeId: employees['EMP-NEW-001'], templateId: onbTemplate, createProbation: false });
    expect(err(r)).toBe('201');
    planId = r.body.data.id;
    const d = r.body.data;
    expect(d).toMatchObject({ status: 'DRAFT', startDate: '2026-10-01', hireDate: '2026-10-01', snapshot: { employeeCode: 'EMP-NEW-001', department: 'Engineering', manager: { employeeCode: 'MGRA' } } });
    expect(d.tasks.map((t: { title: string; dueDate: string }) => `${t.title}=${t.dueDate}`)).toEqual(['Prepare employee documents=2026-09-28', 'Prepare workstation=2026-09-30', 'Review company policies=2026-10-01', 'Meet manager=2026-10-01', 'Complete orientation=2026-10-06', 'Sign policy acknowledgement=2026-10-08']);
    const byTitle = (t: string) => d.tasks.find((x: { title: string }) => x.title === t);
    expect(byTitle('Review company policies')).toMatchObject({ assigneeType: 'EMPLOYEE', assigneeUserId: null, unassigned: true }); // no account yet: visibly unassigned, never auto-provisioned
    expect(byTitle('Meet manager')).toMatchObject({ assigneeType: 'MANAGER', assigneeUserId: mgrA.user.id });
    expect(byTitle('Prepare workstation')).toMatchObject({ assigneeType: 'HR', assigneeUserId: hrAdmin.user.id });
    expect(await prisma.user.count()).toBe(usersBefore); // no auto-provisioned account
    expect(err(await as(hrAdmin, 'post', `${L}/onboarding`).send({ employeeId: employees['EMP-NEW-001'], templateId: onbTemplate }))).toBe('409 ONBOARDING_PLAN_EXISTS');
  });
  it('template edits after creation do not reach the plan; a new plan gets the new wording', async () => {
    expect(err(await as(hrAdmin, 'patch', `${L}/templates/${onbTemplate}`).send({ tasks: [{ title: 'Prepare employee documents (reworded)', category: 'PRE_START', assigneeType: 'HR', dueOffsetDays: -3, relativeTo: 'START_DATE' }, { title: 'Meet manager', category: 'DAY_1', assigneeType: 'MANAGER', dueOffsetDays: 0, relativeTo: 'START_DATE' }, { title: 'Review company policies', category: 'DAY_1', assigneeType: 'EMPLOYEE', dueOffsetDays: 0, relativeTo: 'START_DATE' }] }))).toBe('200');
    expect((await as(hrAdmin, 'get', `${L}/onboarding/${planId}`)).body.data.tasks[0].title).toBe('Prepare employee documents');
    const p2 = await as(hrAdmin, 'post', `${L}/onboarding`).send({ employeeId: employees.EMP004, templateId: onbTemplate, startDate: '2026-01-15' });
    expect(p2.body.data.tasks[0].title).toBe('Prepare employee documents (reworded)');
    expect(err(await as(hrAdmin, 'post', `${L}/onboarding/${p2.body.data.id}/cancel`))).toBe('200');
  });
  it('activation notifies resolved assignees, leaves the account-less employee tasks unassigned, and shows HR the configuration issue', async () => {
    const r = await as(hrAdmin, 'post', `${L}/onboarding/${planId}/activate`);
    expect(err(r)).toBe('200');
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', unassignedTasks: 3 }); // 3 employee tasks
    expect(r.body.data.tasks.filter((t: { unassigned: boolean }) => t.unassigned).map((t: { title: string }) => t.title)).toEqual(['Review company policies', 'Complete orientation', 'Sign policy acknowledgement']);
    const notes = await prisma.notification.findMany({ where: { type: 'ONBOARDING_TASK_ASSIGNED' } });
    expect(notes.map((n) => n.userId).sort()).toEqual([hrAdmin.user.id, mgrA.user.id].sort());
    expect(notes.find((n) => n.userId === mgrA.user.id)!.body).toMatch(/1 onboarding task\(s\) for Jane Person/);
    expect(await prisma.notification.count({ where: { type: 'ONBOARDING_PLAN_STARTED' } })).toBe(0); // nobody to tell yet
    expect(err(await as(hrAdmin, 'post', `${L}/onboarding/${planId}/activate`))).toBe('409 ONBOARDING_PLAN_NOT_DRAFT');
  });
  it('the manager sees the plan for their report and works their task; another manager cannot; the employee cannot see HR tasks', async () => {
    const mine = (await as(mgrA, 'get', `${L}/onboarding?status=ACTIVE`)).body;
    expect(mine.data.map((p: { snapshot: { employeeCode: string } }) => p.snapshot.employeeCode)).toEqual(['EMP-NEW-001']);
    expect(err(await as(mgrB, 'get', `${L}/onboarding/${planId}`))).toBe('404 ONBOARDING_PLAN_NOT_FOUND');
    expect((await as(mgrB, 'get', `${L}/onboarding`)).body.data).toEqual([]);
    const d = (await as(mgrA, 'get', `${L}/onboarding/${planId}`)).body.data;
    const meet = d.tasks.find((t: { title: string }) => t.title === 'Meet manager');
    expect(meet.can.update).toBe(true);
    const hrTask = d.tasks.find((t: { title: string }) => t.title === 'Prepare workstation');
    expect(hrTask.can.update).toBe(false);
    expect(err(await as(mgrA, 'patch', `${L}/onboarding-tasks/${hrTask.id}`).send({ status: 'COMPLETED' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'patch', `${L}/onboarding-tasks/${meet.id}`).send({ status: 'COMPLETED', note: 'Met on day 1; do not enter passwords here' }))).toBe('200');
    const [a, b] = await Promise.all([as(hrAdmin, 'patch', `${L}/onboarding-tasks/${hrTask.id}`).send({ status: 'COMPLETED' }), as(hrAdmin, 'patch', `${L}/onboarding-tasks/${hrTask.id}`).send({ status: 'COMPLETED' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { module: 'lifecycle', action: 'UPDATE_ONBOARDING_TASK', recordId: hrTask.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirst({ where: { module: 'lifecycle', action: 'UPDATE_ONBOARDING_TASK', recordId: meet.id } });
    expect(text(audit)).not.toMatch(/Met on day 1|passwords/);
    expect(JSON.parse(audit!.newValue as string)).toMatchObject({ noteChanged: true, noteLength: 41 });
  });
  it('once the new hire gets an account, re-activation is not needed: HR reassigns or the employee is picked up by a fresh plan; the employee then sees and completes own tasks; required tasks gate completion', async () => {
    await createUser({ email: 'jane@a34.local', password: PW, role: 'EMPLOYEE', employeeId: employees['EMP-NEW-001'] });
    jane = await loginAs(app, 'jane@a34.local', PW);
    const d = (await as(hrAdmin, 'get', `${L}/onboarding/${planId}`)).body.data;
    for (const t of d.tasks.filter((x: { unassigned: boolean }) => x.unassigned)) expect(err(await as(hrAdmin, 'patch', `${L}/onboarding-tasks/${t.id}`).send({ assigneeUserId: jane.user.id }))).toBe('200');
    const my = (await as(jane, 'get', `${L}/my`)).body.data;
    expect(my.onboarding.id).toBe(planId);
    expect(my.onboarding.tasks.map((t: { title: string }) => t.title)).toHaveLength(6);
    expect(my.myTasks.map((t: { task: { title: string } }) => t.task.title)).toEqual(['Review company policies', 'Complete orientation', 'Sign policy acknowledgement']);
    const hrTask = my.onboarding.tasks.find((t: { title: string }) => t.title === 'Prepare employee documents');
    expect(hrTask.can.update).toBe(false); expect(hrTask.note).toBeNull();
    expect(err(await as(hrAdmin, 'post', `${L}/onboarding/${planId}/complete`))).toBe('409 ONBOARDING_REQUIRED_TASKS_OPEN');
    for (const title of ['Review company policies', 'Complete orientation']) expect(err(await as(jane, 'patch', `${L}/onboarding-tasks/${my.onboarding.tasks.find((t: { title: string }) => t.title === title).id}`).send({ status: 'COMPLETED' }))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${L}/onboarding-tasks/${hrTask.id}`).send({ status: 'COMPLETED' }))).toBe('200');
    // A document-bound task cannot complete without a document; it is optional so it does not block the plan.
    const sign = my.onboarding.tasks.find((t: { title: string }) => t.title === 'Sign policy acknowledgement');
    expect(err(await as(jane, 'patch', `${L}/onboarding-tasks/${sign.id}`).send({ status: 'COMPLETED' }))).toBe('422 LIFECYCLE_TASK_DOCUMENT_REQUIRED');
    const before = await masters(employees['EMP-NEW-001']);
    const [c1, c2] = await Promise.all([as(hrAdmin, 'post', `${L}/onboarding/${planId}/complete`), as(hrAdmin, 'post', `${L}/onboarding/${planId}/complete`)]);
    expect([c1.status, c2.status].sort(), text([c1.body, c2.body])).toEqual([200, 409]);
    const done = (await as(hrAdmin, 'get', `${L}/onboarding/${planId}`)).body.data;
    expect(done.status).toBe('COMPLETED');
    expect(done.tasks.find((t: { title: string }) => t.title === 'Sign policy acknowledgement').status).toBe('CANCELLED');
    expect(await masters(employees['EMP-NEW-001'])).toEqual(before); // no payroll, user, document or requisition side effect
    expect(checklistProgress(done.tasks).ready).toBe(true);
  });
});

describe('probation', () => {
  let caseId: string;
  it('policies are configurable (no hardcoded duration); a case computes its end date and defaults its reviewer to the manager', async () => {
    const p = await as(hrAdmin, 'post', `${L}/probation/policies`).send({ name: 'Standard 120', durationDays: 120, allowExtension: true, maxExtensionDays: 30, reviewLeadDays: 14 });
    expect(err(p)).toBe('201');
    policyId = p.body.data.id;
    expect(err(await as(mgrA, 'post', `${L}/probation/policies`).send({ name: 'x', durationDays: 10 }))).toBe('403 FORBIDDEN');
    const c = await as(hrAdmin, 'post', `${L}/probation`).send({ employeeId: employees.EMP003, policyId, startDate: '2026-06-01' });
    expect(err(c)).toBe('201');
    caseId = c.body.data.id;
    expect(c.body.data).toMatchObject({ status: 'ACTIVE', startDate: '2026-06-01', originalEndDate: '2026-09-29', currentEndDate: '2026-09-29', reviewerUserId: mgrA.user.id, policyName: 'Standard 120', snapshot: { manager: { employeeCode: 'MGRA' }, department: 'Engineering' } });
    expect(addCalendarDays('2026-06-01', 120)).toBe('2026-09-29');
    expect(await prisma.notification.count({ where: { type: 'PROBATION_REVIEW_REQUIRED', userId: mgrA.user.id } })).toBe(1);
    expect(err(await as(hrAdmin, 'post', `${L}/probation`).send({ employeeId: employees.EMP003, policyId }))).toBe('409 PROBATION_CASE_EXISTS');
  });
  it('the assigned manager extends by 14 days, then passes; history keeps every event; an unrelated manager cannot review; the employee sees dates and outcome, never the comment', async () => {
    expect(err(await as(mgrB, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'PASS' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'EXTEND', extensionEndDate: '2026-11-15', comment: 'too long' }))).toBe('422 PROBATION_EXTENSION_TOO_LONG');
    const [e1, e2] = await Promise.all([as(mgrA, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'EXTEND', extensionEndDate: '2026-10-13', comment: 'slow start on the platform work' }), as(mgrA, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'EXTEND', extensionEndDate: '2026-10-13', comment: 'slow start on the platform work' })]);
    expect([e1.status, e2.status].sort()).toEqual([201, 422]); // the second sees the moved end date and is refused (not after current end)
    let d = (await as(mgrA, 'get', `${L}/probation/${caseId}`)).body.data;
    expect(d).toMatchObject({ status: 'EXTENDED', originalEndDate: '2026-09-29', currentEndDate: '2026-10-13', extensions: 1 });
    expect(await prisma.probationReview.count({ where: { caseId } })).toBe(1);
    const before = await masters(employees.EMP003);
    expect(err(await as(mgrA, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'PASS', comment: 'Confirmed' }))).toBe('201');
    d = (await as(hrAdmin, 'get', `${L}/probation/${caseId}`)).body.data;
    expect(d).toMatchObject({ status: 'PASSED', finalOutcome: 'PASS', currentEndDate: '2026-10-13' });
    expect(d.reviews.map((r: { outcome: string; extensionEndDate: string | null; comment: string | null }) => `${r.outcome}:${r.extensionEndDate ?? '-'}:${r.comment}`)).toEqual(['EXTEND:2026-10-13:slow start on the platform work', 'PASS:-:Confirmed']);
    expect(await masters(employees.EMP003)).toEqual(before); // PASS changes no employment field
    expect(err(await as(mgrA, 'post', `${L}/probation/${caseId}/reviews`).send({ outcome: 'NOT_PASS' }))).toBe('409 PROBATION_CASE_CLOSED');
    const own = (await as(emp, 'get', `${L}/my`)).body.data;
    expect(own.probation).toEqual({ startDate: '2026-06-01', currentEndDate: '2026-10-13', status: 'PASSED', finalOutcome: 'PASS', extensions: 1 });
    const ownCase = (await as(emp, 'get', `${L}/probation/${caseId}`)).body.data;
    expect(ownCase.reviews.every((r: { comment: string | null }) => r.comment === null)).toBe(true);
    expect(ownCase.reviewerUserId).toBeNull();
    expect(text(ownCase)).not.toMatch(/slow start|Confirmed/);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'lifecycle', recordId: caseId } }))).not.toMatch(/slow start|Confirmed/);
  });
  it('NOT_PASS records an outcome and nothing else: employee active, account active, payroll untouched, no ER case, no offboarding', async () => {
    const c = (await as(hrAdmin, 'post', `${L}/probation`).send({ employeeId: employees.EMP005, durationDays: 90, startDate: '2026-02-01' })).body.data;
    expect(c.reviewerUserId).toBe(mgrB.user.id);
    const before = await masters(employees.EMP005);
    expect(err(await as(mgrB, 'post', `${L}/probation/${c.id}/reviews`).send({ outcome: 'NOT_PASS', comment: 'budget cut in the team' }))).toBe('201');
    expect((await as(hrAdmin, 'get', `${L}/probation/${c.id}`)).body.data.status).toBe('NOT_PASSED');
    expect(await masters(employees.EMP005)).toEqual(before);
    expect(before.emp).toMatchObject({ employmentStatus: 'ACTIVE', terminationDate: null });
    expect(await prisma.offboardingCase.count({ where: { employeeId: employees.EMP005 } })).toBe(0);
  });
  it('a transfer after the case keeps the reviewer and manager snapshot; the manager list is scoped', async () => {
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { managerId: employees.MGRB } });
    const d = (await as(hrAdmin, 'get', `${L}/probation/${caseId}`)).body.data;
    expect(d.snapshot.manager.employeeCode).toBe('MGRA');
    expect(d.current.manager).toMatch(/MGRB/);
    expect((await as(mgrA, 'get', `${L}/probation?mine=true`)).body.data.map((x: { id: string }) => x.id)).toContain(caseId); // historical reviewer keeps access
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { managerId: employees.MGRA } });
  });
});

describe('offboarding', () => {
  let caseId: string;
  it('HR creates the case with a confidential reason note; activation notifies; the employee sees the checklist without confidential tasks or the note; the manager sees no note', async () => {
    const r = await as(hrAdmin, 'post', `${L}/offboarding`).send({ employeeId: employees.EMP003, templateId: offTemplate, reasonCode: 'RESIGNATION', reasonNote: 'Leaving for a role abroad; budget cut mentioned', plannedLastWorkingDate: '2026-12-31' });
    expect(err(r)).toBe('201');
    caseId = r.body.data.id;
    expect(r.body.data.tasks.map((t: { title: string; dueDate: string }) => `${t.title}=${t.dueDate}`)).toEqual(expect.arrayContaining(['Hand over responsibilities=2026-12-26', 'Return company property=2026-12-31', 'Confirm handover received=2026-12-30', 'Final payroll preparation=2026-12-29', 'Revoke system access=2026-12-31']));
    const before = await masters(employees.EMP003);
    expect(err(await as(hrAdmin, 'post', `${L}/offboarding/${caseId}/activate`))).toBe('200');
    expect(await masters(employees.EMP003)).toEqual(before); // activation terminates nobody
    expect(await prisma.notification.count({ where: { type: 'OFFBOARDING_STARTED', userId: emp.user.id } })).toBe(1);
    const mine = (await as(emp, 'get', `${L}/offboarding/${caseId}`)).body.data;
    expect(mine.reasonNote).toBeNull(); expect(mine.exitInterview).toBeNull();
    expect(mine.tasks.map((t: { title: string }) => t.title).sort()).toEqual(['Hand over responsibilities', 'Return company property', 'Collect documents', 'Confirm handover received'].sort());
    expect(text(mine)).not.toMatch(/budget cut|Final payroll|Revoke system access/);
    const mgr = (await as(mgrA, 'get', `${L}/offboarding/${caseId}`)).body.data;
    expect(mgr.reasonNote).toBeNull();
    expect(mgr.tasks.find((t: { title: string }) => t.title === 'Confirm handover received').can.update).toBe(true);
    expect(err(await as(mgrB, 'get', `${L}/offboarding/${caseId}`))).toBe('404 OFFBOARDING_CASE_NOT_FOUND');
    expect(err(await as(mgrA, 'post', `${L}/offboarding/${caseId}/complete-separation`).send({}))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'post', `${L}/offboarding/${caseId}/complete-separation`).send({}))).toBe('403 FORBIDDEN');
  });
  it('the case becomes READY_TO_COMPLETE when every required task is done; separation is refused before that', async () => {
    expect(err(await as(hrAdmin, 'post', `${L}/offboarding/${caseId}/complete-separation`).send({}))).toBe('409 OFFBOARDING_NOT_READY');
    const d = (await as(hrAdmin, 'get', `${L}/offboarding/${caseId}`)).body.data;
    const t = (title: string) => d.tasks.find((x: { title: string }) => x.title === title);
    expect(err(await as(emp, 'patch', `${L}/offboarding-tasks/${t('Hand over responsibilities').id}`).send({ status: 'COMPLETED', note: 'Handed over the platform runbook' }))).toBe('200');
    expect(err(await as(emp, 'patch', `${L}/offboarding-tasks/${t('Return company property').id}`).send({ status: 'COMPLETED' }))).toBe('200');
    expect(err(await as(mgrA, 'patch', `${L}/offboarding-tasks/${t('Confirm handover received').id}`).send({ status: 'COMPLETED' }))).toBe('200');
    expect(err(await as(hrAdmin, 'patch', `${L}/offboarding-tasks/${t('Final payroll preparation').id}`).send({ status: 'COMPLETED', note: 'Final payroll pending in Payroll' }))).toBe('200');
    expect((await as(hrAdmin, 'get', `${L}/offboarding/${caseId}`)).body.data.status).toBe('ACTIVE');
    expect(err(await as(hrAdmin, 'patch', `${L}/offboarding-tasks/${t('Revoke system access').id}`).send({ status: 'COMPLETED' }))).toBe('200');
    expect((await as(hrAdmin, 'get', `${L}/offboarding/${caseId}`)).body.data).toMatchObject({ status: 'READY_TO_COMPLETE', can: { completeSeparation: true } });
    expect(await prisma.auditLog.count({ where: { module: 'lifecycle', action: 'READY_OFFBOARDING_CASE', recordId: caseId } })).toBe(1);
    expect(err(await as(hrAdmin, 'post', `${L}/offboarding/${caseId}/exit-interview`).send({ interviewDate: '2026-12-20', reasonCategory: 'CAREER_GROWTH', wouldRejoin: true, note: 'Positive about the team' }))).toBe('200');
    expect((await as(hrAdmin, 'get', `${L}/offboarding/${caseId}`)).body.data.exitInterview).toMatchObject({ reasonCategory: 'CAREER_GROWTH', wouldRejoin: true });
  });
  it('two concurrent completions terminate exactly once; the employee is TERMINATED with the last day, history rows closed, account disabled and sessions gone; payroll, documents, requisitions and ER untouched', async () => {
    const before = await masters(employees.EMP003);
    expect(err(await as(emp, 'get', `${L}/my`))).toBe('200'); // the session works before separation
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${L}/offboarding/${caseId}/complete-separation`).send({}), as(hrAdmin, 'post', `${L}/offboarding/${caseId}/complete-separation`).send({})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 }, include: { positionHistory: true, managerHistory: true, user: true } });
    expect(e.employmentStatus).toBe('TERMINATED');
    expect(e.terminationDate?.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(e.positionHistory.every((p) => p.endDate !== null)).toBe(true);
    expect(e.managerHistory.every((m) => m.endDate !== null)).toBe(true);
    expect(e.user?.isActive).toBe(false);
    expect(await prisma.session.count({ where: { userId: emp.user.id } })).toBe(0);
    expect(err(await as(emp, 'get', `${L}/my`))).toMatch(/^401/); // the old cookie no longer authenticates
    const done = (await as(hrAdmin, 'get', `${L}/offboarding/${caseId}`)).body.data;
    expect(done).toMatchObject({ status: 'COMPLETED', actualLastWorkingDate: '2026-12-31', separation: { accountDisabled: true, sessionsRevoked: 1 } });
    expect(await prisma.auditLog.count({ where: { action: 'TERMINATE_EMPLOYEE', recordId: employees.EMP003 } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'COMPLETE_EMPLOYMENT_SEPARATION', recordId: caseId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'DEACTIVATE_USER', recordId: emp.user.id } })).toBe(1);
    const after = await masters(employees.EMP003);
    expect({ payroll: after.payroll, er: after.er, reqs: after.reqs, docs: after.docs, users: after.users }).toEqual({ payroll: before.payroll, er: before.er, reqs: before.reqs, docs: before.docs, users: before.users });
    expect(text(await prisma.auditLog.findMany({ where: { module: 'lifecycle', recordId: caseId } }))).not.toMatch(/budget cut|abroad|Positive about|runbook/);
    expect(err(await as(hrAdmin, 'post', `${L}/offboarding/${caseId}/cancel`))).toBe('409 OFFBOARDING_CASE_CLOSED');
  });
  it('cancel vs complete: one terminal state, and a cancelled case never terminates', async () => {
    const c = (await as(hrAdmin, 'post', `${L}/offboarding`).send({ employeeId: employees.EMP004, reasonCode: 'RESIGNATION', plannedLastWorkingDate: '2026-11-30' })).body.data;
    await as(hrAdmin, 'post', `${L}/offboarding/${c.id}/activate`);
    expect((await as(hrAdmin, 'get', `${L}/offboarding/${c.id}`)).body.data.status).toBe('READY_TO_COMPLETE'); // no tasks → ready
    const [cancel, complete] = await Promise.all([as(hrAdmin, 'post', `${L}/offboarding/${c.id}/cancel`), as(hrAdmin, 'post', `${L}/offboarding/${c.id}/complete-separation`).send({})]);
    expect([cancel.status, complete.status].sort()).toEqual([200, 409]);
    const final = (await as(hrAdmin, 'get', `${L}/offboarding/${c.id}`)).body.data;
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP004 }, include: { user: true } });
    if (final.status === 'CANCELLED') { expect(e.employmentStatus).toBe('ACTIVE'); expect(e.terminationDate).toBeNull(); expect(e.user?.isActive).toBe(true); }
    else { expect(final.status).toBe('COMPLETED'); expect(e.employmentStatus).toBe('TERMINATED'); }
    // A fresh case for an active employee is cancelled cleanly: nothing changes.
    if (final.status === 'COMPLETED') return;
    expect(await prisma.offboardingTask.count({ where: { caseId: c.id, status: { in: ['PENDING', 'IN_PROGRESS'] } } })).toBe(0);
  });
});

describe('reporting, 360, export and executive', () => {
  it('the executive dashboard and report are counts only; the HR dashboard lists upcoming dates', async () => {
    const dash = (await as(exec, 'get', `${L}/dashboard`)).body.data;
    expect(dash.upcoming).toEqual([]);
    expect(personalDataIn(dash)).toEqual([]);
    const rep = (await as(exec, 'get', `${L}/reports?from=2026-01-01&to=2026-12-31`)).body.data;
    expect(rep.probation).toMatchObject({ passed: 1, notPassed: 1 });
    expect(rep.offboarding.completedSeparations).toBeGreaterThanOrEqual(1);
    expect(rep.offboarding.byReason.find((x: { reason: string }) => x.reason === 'RESIGNATION').count).toBeGreaterThanOrEqual(1);
    expect(personalDataIn(rep)).toEqual([]);
    expect(err(await as(exec, 'get', `${L}/onboarding`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${L}/offboarding`))).toBe('403 FORBIDDEN');
    const hrDash = (await as(hrAdmin, 'get', `${L}/dashboard`)).body.data;
    expect(hrDash.onboarding.completedLast90Days).toBe(1);
    expect(hrDash.probation.passedLast90Days).toBe(1);
  });
  it('Report Center datasets carry departments, statuses and months only', async () => {
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const p = await run(exec, 'probation_summary', ['department', 'status', 'outcome', 'extensions']);
    expect(err(p)).toBe('200');
    expect(p.body.data.rows.find((x: { status: string }) => x.status === 'PASSED')).toMatchObject({ department: 'Engineering', outcome: 'PASS', extensions: 1 });
    expect(text(p.body)).not.toMatch(/Emma|EMP003|slow start/);
    const o = await run(hr, 'offboarding_summary', ['department', 'reason', 'status', 'plannedMonth']);
    expect(o.body.data.rows.find((x: { status: string }) => x.status === 'COMPLETED')).toMatchObject({ reason: 'RESIGNATION', plannedMonth: '2026-12' });
    expect(err(await run(emp, 'onboarding_summary', ['department']))).toMatch(/^40[13]/);
  });
  it('the Employee 360 carries lifecycle statuses and dates only; the privacy export carries own records without notes', async () => {
    const e360 = (await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(e360.sections.lifecycle).toMatchObject({ probation: { status: 'PASSED', finalOutcome: 'PASS' }, offboarding: { status: 'COMPLETED', actualLastWorkingDate: '2026-12-31' } });
    expect(text(e360.sections.lifecycle)).not.toMatch(/slow start|budget cut|abroad|Positive about/);
    expect((await as(mgrB, 'get', `/api/v1/analytics/employee-360/${employees.EMP005}`)).body.data.sections.lifecycle.probation).toMatchObject({ status: 'NOT_PASSED' });
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    const exported = JSON.parse(x.text);
    expect(exported.data.lifecycle.probationCases[0]).toMatchObject({ finalOutcome: 'PASS', currentEndDate: '2026-10-13' });
    expect(exported.data.lifecycle.offboardingCases[0]).toMatchObject({ reasonCode: 'RESIGNATION', status: 'COMPLETED' });
    expect(x.text).not.toMatch(/slow start|Confirmed|budget cut|abroad|Positive about|Final payroll pending/);
    expect(exported.notIncluded.some((n: { category: string }) => /review comments/.test(n.category))).toBe(true);
  });
});

describe('list filters for the recruitment handoff (Task 38)', () => {
  it('employeeId narrows a lifecycle list inside the caller’s scope and never widens it', async () => {
    const plans = await as(hrAdmin, 'get', `/api/v1/lifecycle/onboarding?employeeId=${employees['EMP-NEW-001']}&pageSize=5`);
    expect(plans.status).toBe(200);
    expect(plans.body.data.every((p: { employeeId: string }) => p.employeeId === employees['EMP-NEW-001'])).toBe(true);
    expect(plans.body.data.length).toBeGreaterThanOrEqual(1);
    const cases = await as(hrAdmin, 'get', `/api/v1/lifecycle/probation?employeeId=${employees.EMP003}&pageSize=5`);
    expect(cases.body.data.every((c: { employeeId: string }) => c.employeeId === employees.EMP003)).toBe(true);
    expect(cases.body.data.length).toBeGreaterThanOrEqual(1);
    // a manager of another team asks for EMP003 by id: the scope still applies, so nothing comes back
    expect((await as(mgrB, 'get', `/api/v1/lifecycle/probation?employeeId=${employees.EMP003}`)).body.data).toEqual([]);
    expect((await as(mgrB, 'get', `/api/v1/lifecycle/onboarding?employeeId=${employees['EMP-NEW-001']}`)).body.data).toEqual([]);
    const off = await as(hrAdmin, 'get', `/api/v1/lifecycle/offboarding?employeeId=${employees.EMP003}`);
    expect(off.body.data.every((c: { employeeId: string }) => c.employeeId === employees.EMP003)).toBe(true);
  });
});
