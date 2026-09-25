/**
 * Task 39 — Expense and travel management.
 *
 * What these tests guard: expenses never touch benefit tables; policy applicability is deterministic and ambiguity is
 * refused; a submitted travel request is approved through the workflow and books nothing; an expense report is
 * created from an approved trip only by an explicit action; totals are Σ Decimal of the items and exact; per-item
 * maxima and receipt thresholds are exact-decimal comparisons at the boundary; submission freezes the rules; double
 * submit yields one workflow; approve-versus-reject yields one terminal state; payment is a record; the payroll
 * handoff is explicit, idempotent and ends in SENT_TO_PAYROLL; employees see own, managers see nothing of a
 * subordinate outside approval, executives see aggregates; nothing here writes performance, ER, talent or benefits.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const X = '/api/v1/expense';
const text = (v: unknown) => JSON.stringify(v);
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT', comment?: string) => as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action, comment });

let admin: Session, hrAdmin: Session, hr: Session, mgrA: Session, mgrB: Session, emp: Session, emp4: Session, exec: Session, payAdmin: Session;
let orgId: string, salesId: string, mktId: string;
const employees: Record<string, string> = {};
const cats: Record<string, string> = {};
let policyId: string, travelPolicyId: string, docCatId: string, receiptA: string, receiptB: string, receipt2: string, receipt3: string;
let travelId: string, travelWf: string, reportId: string, reportWf: string, paidTotal: string;

function forbiddenKeys(value: unknown, re: RegExp, path = ''): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (re.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } };
  walk(value, path); return hits;
}
const newReport = async (s: Session, title = 'Report', travelRequestId: string | null = null) => (await as(s, 'post', `${X}/expense-reports`).send({ policyId, title, travelRequestId })).body.data.id as string;
const addItem = async (s: Session, id: string, item: Record<string, unknown>) => { const before = new Set(((await as(s, 'get', `${X}/expense-reports/${id}`)).body.data.items as { id: string }[]).map((i) => i.id)); const r = await as(s, 'post', `${X}/expense-reports/${id}/items`).send(item); expect(r.status, text(r.body)).toBe(201); return (r.body.data.items as { id: string }[]).find((i) => !before.has(i.id))!.id; }; // items are ordered by date, so the new one is found by id

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A39', name: 'Expense Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const sales = await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } });
  const mkt = await prisma.department.create({ data: { organizationId: org.id, code: 'MKT', name: 'Marketing' } });
  salesId = sales.id; mktId = mkt.id;
  const job = await prisma.job.create({ data: { code: 'REP', title: 'Sales Representative', level: 2 } });
  const mgrJob = await prisma.job.create({ data: { code: 'SM', title: 'Sales Manager', level: 4 } });
  const repPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'REP1', title: 'Sales Representative', jobId: job.id } })).id;
  const smPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'SM1', title: 'Sales Manager', jobId: mgrJob.id } })).id;
  const mktPos = (await prisma.position.create({ data: { departmentId: mkt.id, code: 'MKT1', title: 'Marketing Officer', jobId: job.id } })).id;
  const mk = async (code: string, first: string, positionId: string, departmentId: string, managerId: string | null) => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a39.local`, hireDate: new Date('2022-01-10T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id);
  await mk('MGRA', 'Alice', smPos, sales.id, null);
  await mk('MGRB', 'Bob', mktPos, mkt.id, null);
  await mk('HRADM', 'Hana', smPos, sales.id, null);
  await mk('PAYADM', 'Pat', smPos, sales.id, null);
  await mk('EMP003', 'Emma', repPos, sales.id, employees.MGRA);
  await mk('EMP004', 'Ed', repPos, sales.id, employees.MGRA);
  await mk('EMP005', 'Olly', mktPos, mkt.id, employees.MGRB);
  await createUser({ email: 'admin@a39.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@a39.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a39.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@a39.local', password: PW, role: 'MANAGER', employeeId: employees.MGRA });
  await createUser({ email: 'mgrb@a39.local', password: PW, role: 'MANAGER', employeeId: employees.MGRB });
  await createUser({ email: 'emp@a39.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp4@a39.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a39.local', password: PW, role: 'EXECUTIVE' });
  await createUser({ email: 'pay@a39.local', password: PW, role: 'HR_ADMIN', employeeId: employees.PAYADM });
  [admin, hrAdmin, hr, mgrA, mgrB, emp, emp4, exec, payAdmin] = await Promise.all(['admin', 'hradmin', 'hr', 'mgra', 'mgrb', 'emp', 'emp4', 'exec', 'pay'].map((u) => loginAs(app, `${u}@a39.local`, PW)));
  for (const [code, entityType] of [['EXPENSE_STD', 'EXPENSE_REPORT'], ['TRAVEL_STD', 'TRAVEL_REQUEST']] as const) {
    const def = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code, name: code, module: 'expense', entityType, steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }] });
    expect(def.status).toBe(201);
    await as(admin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  }
  docCatId = (await prisma.documentCategory.create({ data: { code: 'RCPT', name: 'Receipts', defaultClassification: 'EMPLOYEE_PRIVATE' } })).id;
  const doc = async (n: string, title: string, owner: string) => (await prisma.document.create({ data: { documentNumber: `DOC-2026-0009${n}`, title, categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: owner, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } })).id;
  receiptA = await doc('01', 'Hotel receipt Chiang Mai', employees.EMP003); receipt2 = await doc('02', 'Taxi receipt', employees.EMP003); receipt3 = await doc('03', 'Meal receipt', employees.EMP003); receiptB = await doc('04', 'Someone else’s receipt', employees.EMP005);
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('categories and policies', () => {
  it('HR admin creates categories and a policy with per-category rules and applicability; HR and managers cannot; wrong workflows and duplicate categories are refused', async () => {
    expect(err(await as(hr, 'post', `${X}/categories`).send({ code: 'MEALS', name: 'Meals' }))).toBe('403 FORBIDDEN');
    for (const [code, name, type] of [['ACCOM', 'Accommodation', 'TRAVEL'], ['TRANSPORT', 'Transport', 'TRAVEL'], ['MEALS', 'Meals', 'GENERAL'], ['OFFICE', 'Office Supplies', 'GENERAL']]) { const r = await as(hrAdmin, 'post', `${X}/categories`).send({ code, name, type }); expect(r.status).toBe(201); cats[code] = r.body.data.id; }
    expect(err(await as(hrAdmin, 'post', `${X}/categories`).send({ code: 'MEALS', name: 'Again' }))).toBe('409 EXPENSE_CATEGORY_CODE_EXISTS');
    const body = { code: 'TH-BIZ', name: 'Thailand Business Expense Policy', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', rules: [
      { categoryId: cats.ACCOM, requiresReceipt: true, perItemMaximum: '5000.00' },
      { categoryId: cats.TRANSPORT, requiresReceipt: true },
      { categoryId: cats.MEALS, requiresReceipt: true, receiptRequiredAbove: '500.00' },
      { categoryId: cats.OFFICE, requiresReceipt: false, descriptionRequired: true },
    ], applicability: [{ ruleType: 'ORGANIZATION', value: orgId }] };
    expect(err(await as(mgrA, 'post', `${X}/policies`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${X}/policies`).send({ ...body, workflowCode: 'TRAVEL_STD' }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${X}/policies`).send({ ...body, rules: [...body.rules, { categoryId: cats.MEALS }] }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${X}/policies`).send({ ...body, applicability: [{ ruleType: 'GENDER', value: 'F' }] }))).toBe('400 VALIDATION_ERROR');
    const r = await as(hrAdmin, 'post', `${X}/policies`).send(body);
    expect(r.status, text(r.body)).toBe(201); policyId = r.body.data.id;
    expect(r.body.data.rules.find((x: { categoryCode: string }) => x.categoryCode === 'ACCOM')).toMatchObject({ perItemMaximum: '5000.00', requiresReceipt: true });
    expect(r.body.data.rules.find((x: { categoryCode: string }) => x.categoryCode === 'MEALS')).toMatchObject({ receiptRequiredAbove: '500.00' });
    expect((await as(hrAdmin, 'patch', `${X}/policies/${policyId}`).send({ status: 'ACTIVE' })).body.data.status).toBe('ACTIVE');
    const tp = await as(hrAdmin, 'post', `${X}/travel-policies`).send({ code: 'TH-TRAVEL', name: 'Domestic travel', currency: 'THB', workflowCode: 'TRAVEL_STD', expensePolicyId: policyId, effectiveFrom: '2026-01-01' });
    expect(tp.status, text(tp.body)).toBe(201); travelPolicyId = tp.body.data.id;
    await as(hrAdmin, 'patch', `${X}/travel-policies/${travelPolicyId}`).send({ status: 'ACTIVE' });
    expect(err(await as(emp, 'get', `${X}/policies`))).toBe('403 FORBIDDEN');
  });

  it('policy resolution is server authority: the unique most-specific policy is assigned; the claimant cannot choose another; equal specificity is refused with EXPENSE_POLICY_AMBIGUOUS and nothing is created', async () => {
    let my = (await as(emp, 'get', `${X}/my`)).body.data;
    expect(my.policyResolution).toMatchObject({ kind: 'RESOLVED', policy: { code: 'TH-BIZ' } });
    expect(my.policies).toEqual([{ id: policyId, code: 'TH-BIZ', name: 'Thailand Business Expense Policy', currency: 'THB', isDefault: true }]);
    // §8 more specific wins deterministically: Sales (department) outranks the organization-wide policy
    const sales = await as(hrAdmin, 'post', `${X}/policies`).send({ code: 'SALES-BIZ', name: 'Sales expense policy', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', rules: [{ categoryId: cats.MEALS, perItemMaximum: '500.00' }], applicability: [{ ruleType: 'DEPARTMENT', value: salesId }] });
    await as(hrAdmin, 'patch', `${X}/policies/${sales.body.data.id}`).send({ status: 'ACTIVE' });
    my = (await as(emp, 'get', `${X}/my`)).body.data;
    expect(my.policyResolution).toMatchObject({ kind: 'RESOLVED', policy: { code: 'SALES-BIZ' } });
    expect(my.policies.map((p: { code: string }) => p.code)).toEqual(['SALES-BIZ']); // only the resolved one is offered
    expect((await as(mgrB, 'get', `${X}/my`)).body.data.policyResolution.policy.code).toBe('TH-BIZ'); // Marketing: the organization-wide one
    // the claimant cannot pick the organization policy by id while a more specific one applies
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ policyId, title: 'Prefer the wider policy' }))).toBe('422 EXPENSE_POLICY_NOT_APPLICABLE');
    // §7 two Sales policies at the same specificity: Policy A meals ≤ 500.00, Policy B meals ≤ 2,000.00 → ambiguous, B cannot be chosen
    const b = await as(hrAdmin, 'post', `${X}/policies`).send({ code: 'SALES-BIZ-B', name: 'Generous sales policy', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', rules: [{ categoryId: cats.MEALS, perItemMaximum: '2000.00' }], applicability: [{ ruleType: 'DEPARTMENT', value: salesId }] });
    await as(hrAdmin, 'patch', `${X}/policies/${b.body.data.id}`).send({ status: 'ACTIVE' });
    my = (await as(emp, 'get', `${X}/my`)).body.data;
    expect(my.policyResolution).toMatchObject({ kind: 'AMBIGUOUS', policy: null });
    expect(my.policyResolution.conflicting.map((p: { code: string }) => p.code).sort()).toEqual(['SALES-BIZ', 'SALES-BIZ-B']);
    expect(my.policies).toEqual([]);
    const reportsBefore = await prisma.expenseReport.count(); const wfBefore = await prisma.workflowInstance.count();
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ title: 'No policy named' }))).toBe('409 EXPENSE_POLICY_AMBIGUOUS');
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ policyId: b.body.data.id, title: 'I choose B' }))).toBe('409 EXPENSE_POLICY_AMBIGUOUS');
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ policyId: sales.body.data.id, title: 'I choose A' }))).toBe('409 EXPENSE_POLICY_AMBIGUOUS');
    expect(await prisma.expenseReport.count()).toBe(reportsBefore); expect(await prisma.workflowInstance.count()).toBe(wfBefore);
    // HR sees the conflict; a manager and an employee cannot
    const conflicts = await as(hrAdmin, 'get', `${X}/policies/conflicts`);
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.data).toEqual([{ policies: expect.arrayContaining([expect.objectContaining({ code: 'SALES-BIZ' }), expect.objectContaining({ code: 'SALES-BIZ-B' })]), employeeCount: 5 }]); // MGRA, HRADM, PAYADM, EMP003 and EMP004 are in Sales
    expect(err(await as(mgrA, 'get', `${X}/policies/conflicts`))).toBe('403 FORBIDDEN');
    // a draft created before the tie cannot be submitted into it either (independent check at submit)
    await as(hrAdmin, 'patch', `${X}/policies/${b.body.data.id}`).send({ status: 'INACTIVE' });
    const draft = await as(emp, 'post', `${X}/expense-reports`).send({ title: 'Drafted under A' });
    expect(draft.status, text(draft.body)).toBe(201); expect(draft.body.data.policyCode).toBe('SALES-BIZ');
    await addItem(emp, draft.body.data.id, { categoryId: cats.MEALS, expenseDate: '2026-08-20', amount: '100.00' });
    await as(hrAdmin, 'patch', `${X}/policies/${b.body.data.id}`).send({ status: 'ACTIVE' });
    expect(err(await as(emp, 'post', `${X}/expense-reports/${draft.body.data.id}/submit`))).toBe('409 EXPENSE_POLICY_AMBIGUOUS');
    expect(await prisma.workflowInstance.count()).toBe(wfBefore);
    // HR fixes the applicability: the tie is gone and the draft can be submitted under A, its policy
    await as(hrAdmin, 'patch', `${X}/policies/${b.body.data.id}`).send({ status: 'INACTIVE' });
    expect((await as(emp, 'get', `${X}/my`)).body.data.policyResolution.policy.code).toBe('SALES-BIZ');
    expect((await as(hrAdmin, 'get', `${X}/policies/conflicts`)).body.data).toEqual([]);
    // a draft whose policy is no longer the resolved one is blocked at submit with a clear reason
    await as(hrAdmin, 'patch', `${X}/policies/${sales.body.data.id}`).send({ status: 'INACTIVE' });
    const stale = await as(emp, 'post', `${X}/expense-reports/${draft.body.data.id}/submit`);
    expect(err(stale)).toBe('422 EXPENSE_REPORT_INVALID'); expect(stale.body.error.message).toMatch(/now Thailand Business Expense Policy/);
    await as(emp, 'post', `${X}/expense-reports/${draft.body.data.id}/cancel`);
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ policyId: sales.body.data.id, title: 'Retired policy' }))).toBe('422 EXPENSE_POLICY_NOT_APPLICABLE');
    // a policy for another department cannot be named either
    const other = await as(hrAdmin, 'post', `${X}/policies`).send({ code: 'MKT-ONLY', name: 'Marketing only', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', applicability: [{ ruleType: 'DEPARTMENT', value: mktId }] });
    await as(hrAdmin, 'patch', `${X}/policies/${other.body.data.id}`).send({ status: 'ACTIVE' });
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ policyId: other.body.data.id, title: 'Sneaky' }))).toBe('422 EXPENSE_POLICY_NOT_APPLICABLE');
  });

  it('§10 maximumReportAmount and §11 maximumAgeDays are enforced server-side at exact Decimal and date boundaries', async () => {
    const strict = await as(hrAdmin, 'post', `${X}/policies`).send({ code: 'SALES-STRICT', name: 'Strict sales policy', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', maximumReportAmount: '5000.00', rules: [{ categoryId: cats.OFFICE, maximumAgeDays: 30 }], applicability: [{ ruleType: 'DEPARTMENT', value: salesId }] });
    expect(strict.status, text(strict.body)).toBe(201);
    await as(hrAdmin, 'patch', `${X}/policies/${strict.body.data.id}`).send({ status: 'ACTIVE' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-25T03:00:00.000Z') }); // business today in Asia/Bangkok = 2026-09-25
    try {
      const created = await as(emp, 'post', `${X}/expense-reports`).send({ title: 'Strict report' });
      expect(created.status, text(created.body)).toBe(201); const id = created.body.data.id as string;
      expect(created.body.data.policyCode).toBe('SALES-STRICT');
      const a = await addItem(emp, id, { categoryId: cats.MEALS, expenseDate: '2026-09-20', amount: '4000.00' });
      void a;
      const b = await addItem(emp, id, { categoryId: cats.MEALS, expenseDate: '2026-09-21', amount: '1000.00' });
      let d = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
      expect(d).toMatchObject({ total: '5000.00', maximumReportAmount: '5000.00', blockers: [] }); // exactly the maximum is valid
      await as(emp, 'patch', `${X}/expense-reports/${id}/items/${b}`).send({ amount: '1000.01' });
      d = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
      expect(d.total).toBe('5000.01'); expect(d.blockers).toEqual(['The total exceeds the policy maximum of 5000.00']);
      expect(err(await as(emp, 'post', `${X}/expense-reports/${id}/submit`))).toBe('422 EXPENSE_REPORT_INVALID');
      await as(emp, 'patch', `${X}/expense-reports/${id}/items/${b}`).send({ amount: '1000.00' });
      // age: 30 days before 2026-09-25 is 2026-08-26 (allowed, inclusive); 2026-08-25 is 31 days old (blocked)
      const old = await addItem(emp, id, { categoryId: cats.OFFICE, expenseDate: '2026-08-26', amount: '1.00', description: 'Boundary' });
      d = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
      expect(d.items.find((i: { id: string }) => i.id === old).blockers).toEqual([]);
      await as(emp, 'patch', `${X}/expense-reports/${id}/items/${old}`).send({ expenseDate: '2026-08-25' });
      d = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
      expect(d.items.find((i: { id: string }) => i.id === old).blockers, text(d.items)).toEqual(['Older than the 30-day limit']);
      const s = await as(emp, 'post', `${X}/expense-reports/${id}/submit`);
      expect(err(s)).toBe('422 EXPENSE_REPORT_INVALID'); expect(s.body.error.message).toMatch(/Older than the 30-day limit/);
      await as(emp, 'patch', `${X}/expense-reports/${id}/items/${old}`).send({ expenseDate: '2026-08-26' });
      await as(emp, 'patch', `${X}/expense-reports/${id}/items/${b}`).send({ amount: '999.00' }); // 4000.00 + 999.00 + 1.00 = 5000.00, the maximum
      expect((await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data).toMatchObject({ total: '5000.00', blockers: [] });
      expect((await as(emp, 'post', `${X}/expense-reports/${id}/submit`)).status).toBe(200);
      const wf = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data.workflowInstanceId;
      await act(mgrA, wf, 'REJECT', 'test cleanup');
    } finally { vi.useRealTimers(); await as(hrAdmin, 'patch', `${X}/policies/${strict.body.data.id}`).send({ status: 'INACTIVE' }); }
    expect((await as(emp, 'get', `${X}/my`)).body.data.policyResolution.policy.code).toBe('TH-BIZ');
  });
});

describe('travel requests', () => {
  it('an employee drafts, edits and submits a travel request; the approver is notified; nobody else sees it; approval through the workflow books nothing', async () => {
    expect(err(await as(emp, 'post', `${X}/travel`).send({ travelPolicyId, purpose: 'Customer workshop', destination: 'Chiang Mai', startDate: '2026-08-12', endDate: '2026-08-10', estimatedAmount: '12000.00' }))).toBe('400 VALIDATION_ERROR');
    const r = await as(emp, 'post', `${X}/travel`).send({ travelPolicyId, purpose: 'Customer workshop with the northern accounts', destination: 'Bangkok → Chiang Mai', startDate: '2026-08-10', endDate: '2026-08-12', estimatedAmount: '12000.00' });
    expect(r.status, text(r.body)).toBe(201); travelId = r.body.data.id;
    expect(r.body.data).toMatchObject({ status: 'DRAFT', estimatedAmount: '12000.00', currency: 'THB', snapshot: { department: 'Sales' } });
    expect(r.body.data.requestNumber).toMatch(/^TRV-2026-\d{6}$/);
    expect((await as(emp, 'patch', `${X}/travel/${travelId}`).send({ estimatedAmount: '12500.00' })).body.data.estimatedAmount).toBe('12500.00');
    expect(err(await as(emp4, 'get', `${X}/travel/${travelId}`))).toBe('404 TRAVEL_REQUEST_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${X}/travel/${travelId}`))).toBe('404 TRAVEL_REQUEST_NOT_FOUND'); // TEAM scope does not widen
    const s = await as(emp, 'post', `${X}/travel/${travelId}/submit`);
    expect(s.status, text(s.body)).toBe(200);
    expect(s.body.data.status).toBe('PENDING_APPROVAL'); travelWf = s.body.data.workflowInstanceId;
    expect(err(await as(emp, 'patch', `${X}/travel/${travelId}`).send({ estimatedAmount: '1.00' }))).toBe('409 TRAVEL_REQUEST_NOT_DRAFT');
    expect(await prisma.notification.count({ where: { type: 'TRAVEL_APPROVAL_REQUIRED', userId: mgrA.user.id } })).toBe(1);
    expect(text(await prisma.notification.findMany({ where: { type: { startsWith: 'TRAVEL_' } } }))).not.toMatch(/northern accounts|Chiang Mai|12500/);
    // the approver's view carries the purpose; a manager of another team is refused
    const review = await as(mgrA, 'get', `${X}/travel/${travelId}/review`);
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ myStepPending: true, travel: { purpose: 'Customer workshop with the northern accounts' } });
    expect(err(await as(mgrB, 'get', `${X}/travel/${travelId}/review`))).toBe('404 TRAVEL_REQUEST_NOT_FOUND');
    expect(err(await act(emp, travelWf, 'APPROVE'))).toMatch(/403/);
    const approved = await act(mgrA, travelWf, 'APPROVE', 'ok');
    expect(approved.status).toBe(200);
    const t = (await as(emp, 'get', `${X}/travel/${travelId}`)).body.data;
    expect(t).toMatchObject({ status: 'APPROVED', can: { createExpenseReport: true } });
    expect(t.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);
    expect(await prisma.expenseReport.count({ where: { travelRequestId: travelId } })).toBe(0); // nothing created automatically
    expect(await prisma.notification.count({ where: { type: 'TRAVEL_REQUEST_APPROVED', userId: emp.user.id } })).toBe(1);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'expense' } }))).not.toMatch(/northern accounts/);
  });
});

describe('expense reports', () => {
  it('the employee explicitly creates a report from the approved trip (§73); the report belongs to them, links the trip and starts as an empty draft', async () => {
    expect(err(await as(emp4, 'post', `${X}/expense-reports`).send({ policyId, title: 'Not my trip', travelRequestId: travelId }))).toBe('404 TRAVEL_REQUEST_NOT_FOUND');
    // §9: the travel policy names TH-BIZ explicitly. Even while a more specific Sales policy resolves for the employee,
    // the report from the trip uses the linked policy, and the employee cannot name the resolved one instead.
    const salesB = await as(hrAdmin, 'post', `${X}/policies`).send({ code: 'SALES-TRAVEL-TEST', name: 'Sales policy for the travel test', currency: 'THB', effectiveFrom: '2026-01-01', workflowCode: 'EXPENSE_STD', applicability: [{ ruleType: 'DEPARTMENT', value: salesId }] });
    await as(hrAdmin, 'patch', `${X}/policies/${salesB.body.data.id}`).send({ status: 'ACTIVE' });
    expect((await as(emp, 'get', `${X}/my`)).body.data.policyResolution.policy.code).toBe('SALES-TRAVEL-TEST');
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ title: 'Wrong policy for the trip', travelRequestId: travelId, policyId: salesB.body.data.id }))).toBe('422 EXPENSE_POLICY_NOT_APPLICABLE');
    await as(hrAdmin, 'patch', `${X}/policies/${policyId}`).send({ status: 'INACTIVE' }); // the linked policy is still validated
    expect(err(await as(emp, 'post', `${X}/expense-reports`).send({ title: 'Trip without a valid linked policy', travelRequestId: travelId }))).toBe('422 EXPENSE_POLICY_NOT_APPLICABLE');
    await as(hrAdmin, 'patch', `${X}/policies/${policyId}`).send({ status: 'ACTIVE' });
    const r = await as(emp, 'post', `${X}/expense-reports`).send({ title: 'Chiang Mai workshop', travelRequestId: travelId });
    expect(r.status, text(r.body)).toBe(201); reportId = r.body.data.id;
    expect(r.body.data.policyCode).toBe('TH-BIZ'); // linked, not resolved
    await as(hrAdmin, 'patch', `${X}/policies/${salesB.body.data.id}`).send({ status: 'INACTIVE' });
    expect((await as(emp, 'get', `${X}/my`)).body.data.policyResolution.policy.code).toBe('TH-BIZ');
    expect(r.body.data).toMatchObject({ status: 'DRAFT', total: '0.00', itemCount: 0, travelRequestId: travelId, travel: { estimatedAmount: '12500.00' }, blockers: ['Add at least one item'] });
    expect(r.body.data.reportNumber).toMatch(/^EXP-2026-\d{6}$/);
    expect(err(await as(emp, 'post', `${X}/expense-reports/${reportId}/submit`))).toBe('422 EXPENSE_REPORT_INVALID');
  });

  it('items: per-item maximum and receipt threshold are exact-decimal boundaries (§67, §68); receipts are Task 30 links; a stranger’s receipt is 404', async () => {
    const accom = await addItem(emp, reportId, { categoryId: cats.ACCOM, expenseDate: '2026-08-10', amount: '5000.00', merchant: 'Hotel', description: 'Two nights' });
    let d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d.items[0]).toMatchObject({ amount: '5000.00', receiptRequired: true, perItemMaximum: '5000.00', blockers: ['A receipt is required'] });
    await as(emp, 'patch', `${X}/expense-reports/${reportId}/items/${accom}`).send({ amount: '5000.01' });
    d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d.items[0].blockers).toEqual(expect.arrayContaining(['Exceeds the per-item maximum of 5000.00']));
    await as(emp, 'patch', `${X}/expense-reports/${reportId}/items/${accom}`).send({ amount: '4500.00' });
    expect(err(await as(emp, 'post', `${X}/expense-reports/${reportId}/items/${accom}/receipts`).send({ documentId: receiptB }))).toBe('404 DOCUMENT_NOT_FOUND');
    expect((await as(emp, 'post', `${X}/expense-reports/${reportId}/items/${accom}/receipts`).send({ documentId: receiptA })).status).toBe(201);
    const transport = await addItem(emp, reportId, { categoryId: cats.TRANSPORT, expenseDate: '2026-08-10', amount: '2400.00', merchant: 'Airline' });
    await as(emp, 'post', `${X}/expense-reports/${reportId}/items/${transport}/receipts`).send({ documentId: receipt2 });
    // meals: threshold 500.00 inclusive — 499.99 needs no receipt, 500.00 does
    const meal = await addItem(emp, reportId, { categoryId: cats.MEALS, expenseDate: '2026-08-11', amount: '499.99' });
    d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d.items.find((i: { id: string }) => i.id === meal)).toMatchObject({ receiptRequired: false, blockers: [] });
    await as(emp, 'patch', `${X}/expense-reports/${reportId}/items/${meal}`).send({ amount: '500.00' });
    d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d.items.find((i: { id: string }) => i.id === meal)).toMatchObject({ receiptRequired: true, blockers: ['A receipt is required'] });
    await as(emp, 'patch', `${X}/expense-reports/${reportId}/items/${meal}`).send({ amount: '450.00' });
    d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d).toMatchObject({ total: '7350.00', itemCount: 3, blockers: [] });
    expect(err(await as(emp4, 'post', `${X}/expense-reports/${reportId}/items`).send({ categoryId: cats.MEALS, expenseDate: '2026-08-11', amount: '1.00' }))).toBe('404 EXPENSE_REPORT_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${X}/expense-reports/${reportId}`))).toBe('404 EXPENSE_REPORT_NOT_FOUND');
  });

  it('submission freezes the rules and the total, starts one workflow even under a double submit (§69), and the report is immutable afterwards', async () => {
    const results = await Promise.all([as(emp, 'post', `${X}/expense-reports/${reportId}/submit`), as(emp, 'post', `${X}/expense-reports/${reportId}/submit`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d).toMatchObject({ status: 'PENDING_APPROVAL', total: '7350.00' }); reportWf = d.workflowInstanceId;
    expect(await prisma.workflowInstance.count({ where: { entityId: reportId } })).toBe(1);
    expect(await prisma.expenseStatusHistory.count({ where: { entityId: reportId, toStatus: 'PENDING_APPROVAL' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'EXPENSE_REPORT_SUBMITTED', userId: emp.user.id, sourceEntityId: reportId } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'EXPENSE_APPROVAL_REQUIRED', userId: mgrA.user.id, sourceEntityId: reportId } })).toBe(1);
    expect(err(await as(emp, 'post', `${X}/expense-reports/${reportId}/items`).send({ categoryId: cats.MEALS, expenseDate: '2026-08-11', amount: '1.00' }))).toBe('409 EXPENSE_REPORT_NOT_DRAFT');
    expect(err(await as(emp, 'patch', `${X}/expense-reports/${reportId}/items/${d.items[0].id}`).send({ amount: '1.00' }))).toBe('409 EXPENSE_REPORT_NOT_DRAFT');
    // the frozen rules survive a policy edit
    await as(hrAdmin, 'patch', `${X}/policies/${policyId}`).send({ rules: [{ categoryId: cats.ACCOM, requiresReceipt: false, perItemMaximum: '100.00' }, { categoryId: cats.TRANSPORT, requiresReceipt: true }, { categoryId: cats.MEALS, requiresReceipt: true, receiptRequiredAbove: '500.00' }, { categoryId: cats.OFFICE, descriptionRequired: true }] });
    const after = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(after.items.find((i: { categoryCode: string }) => i.categoryCode === 'ACCOM')).toMatchObject({ receiptRequired: true, perItemMaximum: '5000.00' });
    await as(hrAdmin, 'patch', `${X}/policies/${policyId}`).send({ rules: [{ categoryId: cats.ACCOM, requiresReceipt: true, perItemMaximum: '5000.00' }, { categoryId: cats.TRANSPORT, requiresReceipt: true }, { categoryId: cats.MEALS, requiresReceipt: true, receiptRequiredAbove: '500.00' }, { categoryId: cats.OFFICE, descriptionRequired: true }] });
    // approver view: items, receipts marked accessible or not, travel context; not the generic view
    const review = await as(mgrA, 'get', `${X}/expense-reports/${reportId}/review`);
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ myStepPending: true, report: { total: '7350.00', travel: { estimatedAmount: '12500.00' } } });
    expect(review.body.data.report.items[0].documents[0]).toMatchObject({ documentId: receiptA, accessible: false }); // Task 30 still decides the file
    expect(err(await as(mgrB, 'get', `${X}/expense-reports/${reportId}/review`))).toBe('404 EXPENSE_REPORT_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `/api/v1/documents/${receiptA}`))).toMatch(/^404/);
  });

  it('final approval makes the report READY_FOR_PAYMENT once under a double decision; nothing is paid; the employee sees the status and not the comment', async () => {
    const results = await Promise.all([act(mgrA, reportWf, 'APPROVE', 'fine'), act(mgrA, reportWf, 'APPROVE', 'fine again')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const d = (await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data;
    expect(d).toMatchObject({ status: 'READY_FOR_PAYMENT', paidDate: null, paymentMethod: null });
    expect(d.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT']);
    expect(text(d)).not.toMatch(/fine again/);
    expect(await prisma.auditLog.count({ where: { action: 'APPROVE_EXPENSE_REPORT' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'EXPENSE_REPORT_APPROVED', userId: emp.user.id } })).toBe(1);
    expect(err(await as(emp, 'post', `${X}/expense-reports/${reportId}/cancel`))).toBe('409 EXPENSE_REPORT_NOT_CANCELLABLE');
  });

  it('external payment is bookkeeping (§72): PAID with method and date, reference minimised, no payroll row', async () => {
    const payrollBefore = await prisma.payrollResultItem.count();
    expect(err(await as(hr, 'post', `${X}/expense-reports/${reportId}/payment`).send({ paymentMethod: 'EXTERNAL', paidDate: '2026-09-20' }))).toBe('403 FORBIDDEN');
    const paid = await as(payAdmin, 'post', `${X}/expense-reports/${reportId}/payment`).send({ paymentMethod: 'EXTERNAL', paymentReference: 'TRF-20260920-0009', paidDate: '2026-09-20' });
    expect(paid.status, text(paid.body)).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'PAID', paymentMethod: 'EXTERNAL', paidDate: '2026-09-20', total: '7350.00' }); paidTotal = paid.body.data.total;
    expect(await prisma.payrollResultItem.count()).toBe(payrollBefore);
    expect(text(await prisma.auditLog.findFirst({ where: { action: 'RECORD_EXPENSE_PAYMENT' } }))).not.toMatch(/TRF-20260920/);
    expect((await as(emp, 'get', `${X}/expense-reports/${reportId}`)).body.data.paymentReference).toBeNull();
    expect(await prisma.notification.count({ where: { type: 'EXPENSE_PAID', userId: emp.user.id } })).toBe(1);
    // the trip can be marked completed by hand; the actual (7,350.00) beside the estimate (12,500.00) is shown, not judged
    expect((await as(emp, 'post', `${X}/travel/${travelId}/complete`)).body.data.status).toBe('COMPLETED');
  });

  it('decimal test (§66): 333.37 + 666.73 = 1000.10 exactly, from the API and from SQL; the estimate does not cap the actual (§74)', async () => {
    const trip = await as(emp, 'post', `${X}/travel`).send({ travelPolicyId, purpose: 'Site visit', destination: 'Khon Kaen', startDate: '2026-08-01', endDate: '2026-08-02', estimatedAmount: '100.00' });
    const ts = await as(emp, 'post', `${X}/travel/${trip.body.data.id}/submit`);
    await act(mgrA, ts.body.data.workflowInstanceId, 'APPROVE');
    const id = await newReport(emp, 'Decimal report', trip.body.data.id);
    const a = await addItem(emp, id, { categoryId: cats.OFFICE, expenseDate: '2026-08-01', amount: '333.37', description: 'Printer toner' });
    const b = await addItem(emp, id, { categoryId: cats.OFFICE, expenseDate: '2026-08-02', amount: '666.73', description: 'Paper' });
    void a; void b;
    const d = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
    expect(d.total).toBe('1000.10');
    expect(d.blockers).toEqual([]); // 1000.10 actual against a 100.00 estimate: shown, not blocked
    await as(emp, 'post', `${X}/expense-reports/${id}/submit`);
    const sql = await prisma.$queryRaw<{ total: string; cached: string }[]>`SELECT SUM("amount")::text AS total, (SELECT "total_amount"::text FROM "expense_reports" WHERE "id" = ${id}) AS cached FROM "expense_items" WHERE "report_id" = ${id}`;
    expect(sql).toEqual([{ total: '1000.10', cached: '1000.10' }]);
    const wf = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data.workflowInstanceId;
    await act(mgrA, wf, 'REJECT', 'Duplicate of an earlier claim');
    const after = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
    expect(after.status).toBe('REJECTED');
    expect(after.items).toHaveLength(2); // nothing deleted
    expect(text(after)).not.toMatch(/Duplicate of an earlier/);
    expect(await prisma.notification.count({ where: { type: 'EXPENSE_REPORT_REJECTED', userId: emp.user.id, sourceEntityId: id } })).toBe(1);
  });

  it('approve versus reject race (§70) yields one terminal state; cancel releases nothing and works exactly once; a draft cancels without a workflow', async () => {
    const id = await newReport(emp, 'Race report');
    await addItem(emp, id, { categoryId: cats.OFFICE, expenseDate: '2026-08-15', amount: '120.00', description: 'Stationery' });
    const s = await as(emp, 'post', `${X}/expense-reports/${id}/submit`);
    expect(s.status, text(s.body)).toBe(200);
    const race = await Promise.all([act(mgrA, s.body.data.workflowInstanceId, 'REJECT', 'no'), act(mgrA, s.body.data.workflowInstanceId, 'APPROVE')]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data;
    expect(['REJECTED', 'READY_FOR_PAYMENT']).toContain(after.status);
    expect(after.history.filter((h: { to: string }) => h.to === 'REJECTED' || h.to === 'READY_FOR_PAYMENT')).toHaveLength(1);
    const c = await newReport(emp, 'Cancel report');
    await addItem(emp, c, { categoryId: cats.OFFICE, expenseDate: '2026-08-15', amount: '10.00', description: 'Pens' });
    await as(emp, 'post', `${X}/expense-reports/${c}/submit`);
    const cancels = await Promise.all([as(emp, 'post', `${X}/expense-reports/${c}/cancel`), as(emp, 'post', `${X}/expense-reports/${c}/cancel`)]);
    expect(cancels.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.workflowInstance.findFirst({ where: { entityId: c } }))!.status).toBe('CANCELLED');
    const dr = await newReport(emp, 'Draft only');
    expect((await as(emp, 'post', `${X}/expense-reports/${dr}/cancel`)).body.data.status).toBe('CANCELLED');
    expect(await prisma.workflowInstance.count({ where: { entityId: dr } })).toBe(0);
    // office supplies need a description under this policy
    const o = await newReport(emp, 'Office');
    await addItem(emp, o, { categoryId: cats.OFFICE, expenseDate: '2026-08-15', amount: '10.00' });
    expect(err(await as(emp, 'post', `${X}/expense-reports/${o}/submit`))).toBe('422 EXPENSE_REPORT_INVALID');
  });

  it('the payroll handoff (§71) needs both permissions, adds one earning line linked to the report, is idempotent, and ends in SENT_TO_PAYROLL, never PAID', async () => {
    const id = await newReport(emp, 'Payroll report');
    await addItem(emp, id, { categoryId: cats.TRANSPORT, expenseDate: '2026-08-18', amount: '2000.00' });
    const items = (await as(emp, 'get', `${X}/expense-reports/${id}`)).body.data.items;
    await as(emp, 'post', `${X}/expense-reports/${id}/items/${items[0].id}/receipts`).send({ documentId: receipt3 });
    const s = await as(emp, 'post', `${X}/expense-reports/${id}/submit`);
    expect(s.status, text(s.body)).toBe(200);
    await act(mgrA, s.body.data.workflowInstanceId, 'APPROVE');
    const payDef = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'PAYROLL_STD', name: 'Payroll', module: 'payroll', entityType: 'PAYROLL_RUN', steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: admin.user.id }] });
    await as(admin, 'post', `/api/v1/workflow/definitions/${payDef.body.data.id}/activate`);
    const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: orgId, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
    await as(admin, 'patch', `/api/v1/calendars/organizations/${orgId}/default`).send({ calendarId: calendar.body.data.id });
    expect((await as(admin, 'post', '/api/v1/payroll/policies').send({ organizationId: orgId, name: 'Standard payroll', monthlyDivisorDays: 30, dailyWorkHours: 8, newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS', absenceDeductionEnabled: false, lateDeductionEnabled: false, workflowDefinitionCode: 'PAYROLL_STD', effectiveFrom: '2020-01-01', currencyCode: 'THB' })).status).toBe(201);
    for (const code of ['MGRA', 'MGRB', 'HRADM', 'PAYADM', 'EMP003', 'EMP004', 'EMP005']) expect((await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: employees[code], effectiveFrom: '2020-01-01', baseSalary: '30000.00', currencyCode: 'THB' })).status).toBe(201);
    const period = await as(admin, 'post', '/api/v1/payroll/periods').send({ organizationId: orgId, year: 2026, month: 9, periodStart: '2026-09-01', periodEnd: '2026-09-30', attendanceFrom: '2026-08-21', attendanceTo: '2026-09-20', paymentDate: '2026-09-28' });
    expect(period.status, text(period.body)).toBe(201);
    const calc = await as(admin, 'post', `/api/v1/payroll/periods/${period.body.data.id}/calculate`);
    expect(calc.status, text(calc.body)).toBe(200);
    const comp = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'EXPENSE_REIMB', name: 'Expense reimbursement', type: 'EARNING' });
    const body = { payrollPeriodId: period.body.data.id, componentId: comp.body.data.id };
    expect(err(await as(hr, 'post', `${X}/expense-reports/${id}/send-to-payroll`).send(body))).toBe('403 FORBIDDEN');
    const before = await prisma.payrollResultItem.count();
    const sent = await Promise.all([as(payAdmin, 'post', `${X}/expense-reports/${id}/send-to-payroll`).send(body), as(payAdmin, 'post', `${X}/expense-reports/${id}/send-to-payroll`).send(body)]);
    expect(sent.map((r) => r.status).sort(), text(sent.map((r) => r.body))).toEqual([200, 200]);
    expect((await as(payAdmin, 'post', `${X}/expense-reports/${id}/send-to-payroll`).send(body)).status).toBe(200);
    expect(await prisma.payrollResultItem.count()).toBe(before + 1);
    const line = await prisma.payrollResultItem.findFirst({ where: { referenceType: 'EXPENSE_REPORT', referenceId: id } });
    expect(line).toMatchObject({ isManual: true, componentCodeSnapshot: 'EXPENSE_REIMB' });
    expect(line!.amount.toFixed(2)).toBe('2000.00');
    expect((await as(payAdmin, 'get', `${X}/expense-reports/${id}`)).body.data).toMatchObject({ status: 'SENT_TO_PAYROLL', paymentMethod: 'PAYROLL', paidDate: null });
    expect((await as(payAdmin, 'post', `${X}/expense-reports/${id}/payment`).send({ paymentMethod: 'PAYROLL', paidDate: '2026-09-28' })).body.data.status).toBe('PAID');
  });

  it('transfer keeps the historical snapshot (§60); a terminated employee cannot start a new report (§61)', async () => {
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { departmentId: mktId, positionId: (await prisma.position.findFirstOrThrow({ where: { code: 'MKT1' } })).id } });
    expect((await as(hrAdmin, 'get', `${X}/expense-reports/${reportId}`)).body.data.snapshot.department).toBe('Sales');
    expect((await as(hrAdmin, 'get', `${X}/travel/${travelId}`)).body.data.snapshot.department).toBe('Sales');
    await prisma.employee.update({ where: { id: employees.EMP004 }, data: { employmentStatus: 'TERMINATED' } });
    expect(err(await as(emp4, 'post', `${X}/expense-reports`).send({ policyId, title: 'After leaving' }))).toBe('409 EMPLOYEE_NOT_ACTIVE');
    await prisma.employee.update({ where: { id: employees.EMP004 }, data: { employmentStatus: 'ACTIVE' } });
  });
});

describe('who sees what', () => {
  it('My expenses carries own trips, reports, applicable policies and the approver queue; a manager sees nothing of a subordinate; HR and executives list per their permissions', async () => {
    const my = (await as(emp, 'get', `${X}/my`)).body.data;
    expect(my.travelRequests.length).toBeGreaterThanOrEqual(2);
    expect(my.reports.every((r: { employeeId: string }) => r.employeeId === employees.EMP003)).toBe(true);
    expect(my.reports.some((r: { status: string }) => r.status === 'PAID')).toBe(true);
    const mgr = (await as(mgrA, 'get', `${X}/my`)).body.data;
    expect(mgr).toMatchObject({ travelRequests: [], reports: [] });
    expect((await as(mgrA, 'get', `${X}/expense-reports?employeeId=${employees.EMP003}`)).body.meta.total).toBe(0);
    expect((await as(mgrA, 'get', `${X}/travel?employeeId=${employees.EMP003}`)).body.meta.total).toBe(0);
    expect(err(await as(mgrA, 'get', `${X}/dashboard`))).toBe('403 FORBIDDEN');
    expect((await as(hr, 'get', `${X}/expense-reports`)).body.meta.total).toBeGreaterThan(0); // HR: view with ALL scope
    expect(err(await as(exec, 'get', `${X}/expense-reports`))).toBe('403 FORBIDDEN');
  });

  it('the executive sees aggregates only (§78); datasets are exact and aggregate-safe; the manager is denied', async () => {
    const dash = await as(exec, 'get', `${X}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.data.reports.paid).toBe(2);
    const rep = await as(exec, 'get', `${X}/reports?from=2026-01-01&to=2026-12-31`);
    expect(rep.status).toBe(200);
    expect(rep.body.data.byPolicy.find((p: { policy: string }) => p.policy === 'Thailand Business Expense Policy')).toMatchObject({ currency: 'THB', paidTotal: '9350.00' });
    expect(rep.body.data.byCategory.find((c: { category: string }) => c.category === 'Meals')).toMatchObject({ items: 3 }); // 450.00 + the two strict-policy items
    expect(rep.body.data.byCategory.find((c: { category: string }) => c.category === 'Office Supplies')).toMatchObject({ items: 5, total: '1131.10' });
    expect(rep.body.data.travel).toMatchObject({ requests: 2, approved: 2, estimatedTotal: '12600.00' });
    for (const payload of [dash.body.data, rep.body.data]) expect(forbiddenKeys(payload, /^(employeeId|employeeCode|employeeName|firstName|lastName|name|email|reportNumber|requestNumber|merchant|description|purpose|destination|documentId|paymentReference)$/)).toEqual([]);
    expect(text(rep.body.data)).not.toMatch(/Emma|EMP003|EXP-|TRV-|Hotel|Chiang|northern|TRF-/);
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const r1 = await run(exec, 'expense_report_summary', ['policy', 'status', 'currency', 'items', 'total']);
    expect(err(r1)).toBe('200');
    expect(r1.body.data.rows.filter((x: { status: string }) => x.status === 'PAID').map((x: { total: string }) => x.total).sort()).toEqual([paidTotal, '2000.00'].sort());
    const r2 = await run(exec, 'expense_category_summary', ['category', 'amount', 'reportStatus']);
    expect(r2.body.data.rows.filter((x: { category: string }) => x.category === 'Office Supplies').map((x: { amount: string }) => x.amount).sort()).toEqual(['1.00', '10.00', '120.00', '333.37', '666.73'].sort());
    const r3 = await run(hrAdmin, 'travel_request_summary', ['travelPolicy', 'status', 'tripDays', 'estimatedAmount']);
    expect(r3.body.data.rows.find((x: { estimatedAmount: string }) => x.estimatedAmount === '12500.00')).toMatchObject({ tripDays: 3, status: 'COMPLETED' });
    for (const r of [r1, r2, r3]) expect(text(r.body)).not.toMatch(/Emma|EMP003|EXP-|TRV-|Hotel|Chiang|northern|TRF-/);
    expect(err(await run(mgrA, 'expense_report_summary', ['policy']))).toMatch(/^40[134]/);
    expect(err(await run(emp, 'travel_request_summary', ['travelPolicy']))).toMatch(/^40[134]/);
  });

  it('the privacy export carries own trips, reports, items and payment records without approver comments; the 360 has no expense section; audit is minimal; nothing else was written', async () => {
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    const exported = JSON.parse(x.text);
    expect(exported.data.expenses.travelRequests[0]).toMatchObject({ purpose: 'Customer workshop with the northern accounts', status: 'COMPLETED', estimatedAmount: '12500.00' });
    const paid = exported.data.expenses.expenseReports.find((r: { status: string; totalAmount: string }) => r.status === 'PAID' && r.totalAmount === '7350.00');
    expect(paid).toMatchObject({ paymentMethod: 'EXTERNAL', paymentReference: 'TRF-20260920-0009' });
    expect(paid.items.map((i: { amount: string }) => i.amount).sort()).toEqual(['2400.00', '4500.00', '450.00'].sort());
    expect(x.text).not.toMatch(/fine again|Duplicate of an earlier/);
    expect(exported.notIncluded.some((n: { category: string }) => /approver comments/.test(n.category))).toBe(true);
    const e360 = (await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(e360.sections.expenses).toBeUndefined();
    expect(text(e360)).not.toMatch(/EXP-|TRV-|7350/);
    const actions = (await prisma.auditLog.findMany({ where: { module: 'expense' }, select: { action: true } })).map((a) => a.action);
    for (const a of ['CREATE_EXPENSE_CATEGORY', 'CREATE_EXPENSE_POLICY', 'ACTIVATE_EXPENSE_POLICY', 'UPDATE_EXPENSE_POLICY', 'CREATE_TRAVEL_POLICY', 'CREATE_TRAVEL_REQUEST', 'UPDATE_TRAVEL_REQUEST', 'SUBMIT_TRAVEL_REQUEST', 'APPROVE_TRAVEL_REQUEST', 'COMPLETE_TRAVEL_REQUEST', 'CREATE_EXPENSE_REPORT', 'UPDATE_EXPENSE_ITEM', 'LINK_EXPENSE_RECEIPT', 'SUBMIT_EXPENSE_REPORT', 'APPROVE_EXPENSE_REPORT', 'REJECT_EXPENSE_REPORT', 'CANCEL_EXPENSE_REPORT', 'RECORD_EXPENSE_PAYMENT', 'SEND_EXPENSE_TO_PAYROLL']) expect(actions, a).toContain(a);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'expense' } }))).not.toMatch(/northern accounts|Two nights|Hotel receipt|TRF-20260920|fine again|Duplicate of an earlier|Stationery/);
    expect(await prisma.benefitClaim.count()).toBe(0);
    expect(await prisma.benefitEntitlementLedger.count()).toBe(0);
    expect(await prisma.performanceCycle.count()).toBe(0);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
    expect(await prisma.talentReviewCycle.count()).toBe(0);
    expect(await prisma.payrollResultItem.count({ where: { referenceType: 'EXPENSE_REPORT' } })).toBe(1);
  });
});
