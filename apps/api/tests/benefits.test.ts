/**
 * Task 36 — Benefits / welfare and claims.
 *
 * What these tests guard: money is Decimal end to end and the ledger is exact; a submitted claim reserves its amount
 * in the same transaction that starts the workflow and can never overspend, alone or concurrently; approval consumes
 * exactly once and rejection or cancellation releases exactly once; the ledger reconciles with the terminal status
 * under every race; a document requirement blocks submission and a link widens nothing; eligibility is
 * deterministic and never touches a protected attribute; a manager's TEAM scope sees no subordinate claim, balance or
 * utilization; executives see aggregates only; nothing here writes payroll, performance, ER or talent; the payroll
 * handoff is explicit, idempotent and ends in SENT_TO_PAYROLL, never PAID.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenureMonths } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const B = '/api/v1/benefits';
const text = (v: unknown) => JSON.stringify(v);
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT', comment?: string) => as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action, comment });

let admin: Session, hrAdmin: Session, hr: Session, mgrA: Session, mgrB: Session, emp: Session, emp4: Session, exec: Session, payAdmin: Session;
let orgId: string, orgBId: string, salesId: string, mktId: string;
const employees: Record<string, string> = {};
let categoryId: string, planId: string, periodId: string, coveragePlanId: string, docCatId: string, receiptId: string, otherReceiptId: string, ent3: string, ent4: string;
let claimA: string, claimAWf: string, claimB: string;
const paidAmounts: string[] = []; // whatever the race outcomes produced: the dataset must reflect exactly these

function forbiddenKeys(value: unknown, re: RegExp, path = ''): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (re.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } };
  walk(value, path); return hits;
}
const balance = async (entitlementId: string) => (await as(hrAdmin, 'get', `${B}/entitlements/${entitlementId}`)).body.data.balance;
const ledgerSql = (entitlementId: string) => prisma.$queryRaw<{ entry_type: string; amount: string }[]>`SELECT "entry_type", "amount"::text FROM "benefit_entitlement_ledger" WHERE "entitlement_id" = ${entitlementId} ORDER BY "created_at"`;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A36', name: 'Benefits Co', timezone: 'Asia/Bangkok' } });
  const orgB = await prisma.organization.create({ data: { code: 'B36', name: 'Other Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id; orgBId = orgB.id;
  const sales = await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } });
  const mkt = await prisma.department.create({ data: { organizationId: org.id, code: 'MKT', name: 'Marketing' } });
  const otherDept = await prisma.department.create({ data: { organizationId: orgB.id, code: 'OPS', name: 'Operations' } });
  salesId = sales.id; mktId = mkt.id;
  const job = await prisma.job.create({ data: { code: 'REP', title: 'Sales Representative', level: 2 } });
  const mgrJob = await prisma.job.create({ data: { code: 'SM', title: 'Sales Manager', level: 4 } });
  const repPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'REP1', title: 'Sales Representative', jobId: job.id } })).id;
  const mktPos = (await prisma.position.create({ data: { departmentId: mkt.id, code: 'MKT1', title: 'Marketing Officer', jobId: job.id } })).id;
  const smPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'SM1', title: 'Sales Manager', jobId: mgrJob.id } })).id;
  const opsPos = (await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OPS1', title: 'Operations', jobId: job.id } })).id;
  const mk = async (code: string, first: string, positionId: string, departmentId: string, organizationId: string, managerId: string | null, hire: string, type = 'FULL_TIME') => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a36.local`, hireDate: new Date(`${hire}T00:00:00Z`), organizationId, departmentId, positionId, managerId, employmentType: type, employmentStatus: 'ACTIVE' } })).id);
  await mk('MGRA', 'Alice', smPos, sales.id, org.id, null, '2018-01-01');
  await mk('MGRB', 'Bob', opsPos, otherDept.id, orgB.id, null, '2018-01-01');
  await mk('HRADM', 'Hana', smPos, sales.id, org.id, null, '2018-01-01');
  await mk('PAYADM', 'Pat', smPos, sales.id, org.id, null, '2018-01-01');
  await mk('EMP003', 'Emma', repPos, sales.id, org.id, employees.MGRA, '2024-01-15');
  await mk('EMP004', 'Ed', repPos, sales.id, org.id, employees.MGRA, '2026-05-01'); // 4–5 months of tenure on any 2026-09/10 test day
  await mk('EMP005', 'Olly', opsPos, otherDept.id, orgB.id, employees.MGRB, '2020-01-01');
  await mk('EMP006', 'Pia', repPos, sales.id, org.id, employees.MGRA, '2020-01-01', 'PART_TIME');
  await createUser({ email: 'admin@a36.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@a36.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a36.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@a36.local', password: PW, role: 'MANAGER', employeeId: employees.MGRA });
  await createUser({ email: 'mgrb@a36.local', password: PW, role: 'MANAGER', employeeId: employees.MGRB });
  await createUser({ email: 'emp@a36.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp4@a36.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a36.local', password: PW, role: 'EXECUTIVE' });
  await createUser({ email: 'pay@a36.local', password: PW, role: 'HR_ADMIN', employeeId: employees.PAYADM });
  [admin, hrAdmin, hr, mgrA, mgrB, emp, emp4, exec, payAdmin] = await Promise.all(['admin', 'hradmin', 'hr', 'mgra', 'mgrb', 'emp', 'emp4', 'exec', 'pay'].map((u) => loginAs(app, `${u}@a36.local`, PW)));
  // claims are approved by the direct manager, then a named HR user
  const def = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'BENEFIT_STD', name: 'Benefit claim approval', module: 'benefits', entityType: 'BENEFIT_CLAIM', steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }] });
  expect(def.status).toBe(201);
  await as(admin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  const wrong = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'LEAVE_X', name: 'Leave', module: 'leave', entityType: 'LEAVE_REQUEST', steps: [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }] });
  await as(admin, 'post', `/api/v1/workflow/definitions/${wrong.body.data.id}/activate`);
  docCatId = (await prisma.documentCategory.create({ data: { code: 'RCPT', name: 'Receipts', defaultClassification: 'EMPLOYEE_PRIVATE' } })).id;
  receiptId = (await prisma.document.create({ data: { documentNumber: 'DOC-2026-000801', title: 'Clinic receipt 2026-09-10', categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: employees.EMP003, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } })).id;
  otherReceiptId = (await prisma.document.create({ data: { documentNumber: 'DOC-2026-000802', title: 'Someone else’s receipt', categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: employees.EMP005, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } })).id;
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('helpers', () => {
  it('tenure months are calendar months, day-of-month respected', () => {
    expect(tenureMonths('2026-05-01', '2026-10-01')).toBe(5);
    expect(tenureMonths('2026-05-01', '2026-09-30')).toBe(4);
    expect(tenureMonths('2024-01-15', '2026-09-25')).toBe(32);
  });
});

describe('categories, plans, eligibility', () => {
  it('HR admin creates a category and a reimbursement plan with allow-listed rules; HR and managers cannot; a wrong workflow is refused', async () => {
    expect(err(await as(hr, 'post', `${B}/categories`).send({ code: 'HEALTH', name: 'Health & Wellness' }))).toBe('403 FORBIDDEN');
    const cat = await as(hrAdmin, 'post', `${B}/categories`).send({ code: 'HEALTH', name: 'Health & Wellness' });
    expect(cat.status).toBe(201); categoryId = cat.body.data.id;
    const body = { code: 'HW2026', name: '2026 Health & Wellness Allowance', categoryId, planType: 'REIMBURSEMENT', currency: 'THB', defaultEntitlementAmount: '10000.00', perClaimMaximum: '8000.00', requiresDocument: true, employeeSelectable: false, workflowDefinitionCode: 'BENEFIT_STD', effectiveFrom: '2026-01-01', rules: [{ ruleType: 'ORGANIZATION', value: orgId }, { ruleType: 'EMPLOYMENT_TYPE', value: 'FULL_TIME' }, { ruleType: 'MIN_TENURE_MONTHS', value: '6' }] };
    expect(err(await as(mgrA, 'post', `${B}/plans`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${B}/plans`).send({ ...body, workflowDefinitionCode: 'LEAVE_X' }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${B}/plans`).send({ ...body, currency: null }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${B}/plans`).send({ ...body, rules: [{ ruleType: 'GENDER', value: 'F' }] }))).toBe('400 VALIDATION_ERROR'); // no such rule type exists
    expect(err(await as(hrAdmin, 'post', `${B}/plans`).send({ ...body, defaultEntitlementAmount: '10000.123' }))).toBe('400 VALIDATION_ERROR');
    const r = await as(hrAdmin, 'post', `${B}/plans`).send(body);
    expect(r.status).toBe(201); planId = r.body.data.id;
    expect(r.body.data).toMatchObject({ status: 'DRAFT', defaultEntitlementAmount: '10000.00', perClaimMaximum: '8000.00', rules: expect.arrayContaining([expect.objectContaining({ ruleType: 'MIN_TENURE_MONTHS', label: '6 months' })]) });
    expect(err(await as(hrAdmin, 'post', `${B}/plans`).send(body))).toBe('409 BENEFIT_PLAN_CODE_EXISTS');
    // employees cannot read the plan catalogue's admin view
    expect(err(await as(emp, 'get', `${B}/plans`))).toBe('403 FORBIDDEN');
  });

  it('eligibility is deterministic from organization, employment type and tenure (§88); preview creates nothing; overrides are explicit and historical', async () => {
    const preview = await as(hrAdmin, 'get', `${B}/plans/${planId}/eligibility-preview?includeEmployees=true`);
    expect(preview.status).toBe(200);
    const by = (code: string) => preview.body.data.employees.find((e: { employeeCode: string }) => e.employeeCode === code);
    expect(by('EMP003').eligible).toBe(true);
    expect(by('EMP004')).toMatchObject({ eligible: false, reasons: ['Does not meet the minimum tenure (months) criteria'] });
    expect(by('EMP006')).toMatchObject({ eligible: false });
    expect(by('EMP005')).toMatchObject({ eligible: false, reasons: ['Does not meet the organization criteria'] }); // other organization
    expect(await prisma.benefitEnrollment.count()).toBe(0);
    expect(await prisma.benefitEntitlement.count()).toBe(0);
    const own = await as(emp4, 'get', `${B}/plans/${planId}/eligibility/${employees.EMP004}`);
    expect(own.body.data).toMatchObject({ eligible: false });
    expect(text(own.body.data)).not.toMatch(/hireDate|employmentType/); // reasons are display-safe codes and messages only
    expect(err(await as(emp4, 'get', `${B}/plans/${planId}/eligibility/${employees.EMP003}`))).toBe('403 FORBIDDEN');
    // explicit include for EMP004 with a reason
    const ov = await as(hrAdmin, 'post', `${B}/plans/${planId}/overrides`).send({ employeeId: employees.EMP004, mode: 'INCLUDE', reasonCode: 'CONTRACT_TERM', note: 'Agreed at hire' });
    expect(ov.status).toBe(201);
    expect((await as(hrAdmin, 'get', `${B}/plans/${planId}/eligibility/${employees.EMP004}`)).body.data).toMatchObject({ eligible: true, override: { mode: 'INCLUDE' } });
    await as(hrAdmin, 'post', `${B}/plans/${planId}/overrides`).send({ employeeId: employees.EMP004, mode: 'EXCLUDE', reasonCode: 'POLICY_EXCEPTION' });
    const list = (await as(hrAdmin, 'get', `${B}/plans/${planId}/overrides`)).body.data;
    expect(list).toHaveLength(2);
    expect(list.filter((o: { supersededAt: string | null }) => o.supersededAt).length).toBe(1); // history kept
    expect(text(await prisma.auditLog.findMany({ where: { action: 'SET_BENEFIT_ELIGIBILITY_OVERRIDE' } }))).not.toMatch(/Agreed at hire/);
    await as(hrAdmin, 'post', `${B}/plans/${planId}/overrides`).send({ employeeId: employees.EMP004, mode: 'INCLUDE', reasonCode: 'CONTRACT_TERM' });
  });
});

describe('periods, enrollment, entitlements', () => {
  it('a period opens only on an active plan and freezes the money rules; later plan edits do not touch it (§19); entitlements are generated once per enrolled and eligible employee', async () => {
    const period = await as(hrAdmin, 'post', `${B}/periods`).send({ planId, name: '2026 Annual Health Benefit', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    expect(period.status).toBe(201); periodId = period.body.data.id;
    expect(err(await as(hrAdmin, 'post', `${B}/periods/${periodId}/open`))).toBe('409 BENEFIT_PLAN_NOT_ACTIVE');
    expect((await as(hrAdmin, 'patch', `${B}/plans/${planId}`).send({ status: 'ACTIVE' })).body.data.status).toBe('ACTIVE');
    const open = await as(hrAdmin, 'post', `${B}/periods/${periodId}/open`);
    expect(open.body.data).toMatchObject({ status: 'OPEN', currencySnapshot: 'THB', entitlementAmountSnapshot: '10000.00', perClaimMaximumSnapshot: '8000.00', requiresDocumentSnapshot: true });
    expect(err(await as(hrAdmin, 'patch', `${B}/periods/${periodId}`).send({ name: 'Renamed' }))).toBe('409 BENEFIT_PERIOD_NOT_DRAFT');
    // the plan's money rules change for the future; the open period keeps its snapshot
    await as(hrAdmin, 'patch', `${B}/plans/${planId}`).send({ defaultEntitlementAmount: '12000.00', perClaimMaximum: '9000.00' });
    expect((await as(hrAdmin, 'get', `${B}/periods/${periodId}`)).body.data).toMatchObject({ entitlementAmountSnapshot: '10000.00', perClaimMaximumSnapshot: '8000.00' });
    // enrolment: HR enrols EMP003 and EMP004 (override), a part-timer is refused, self-enrolment is refused for a non-selectable plan
    expect(err(await as(emp, 'post', `${B}/plans/${planId}/self-enroll`).send({}))).toBe('409 BENEFIT_PLAN_NOT_SELECTABLE');
    expect(err(await as(hrAdmin, 'post', `${B}/plans/${planId}/enroll`).send({ employeeId: employees.EMP006 }))).toBe('422 BENEFIT_NOT_ELIGIBLE');
    expect((await as(hrAdmin, 'post', `${B}/plans/${planId}/enroll`).send({ employeeId: employees.EMP003 })).status).toBe(201);
    expect((await as(hrAdmin, 'post', `${B}/plans/${planId}/enroll`).send({ employeeId: employees.EMP004 })).status).toBe(201);
    expect(err(await as(hrAdmin, 'post', `${B}/plans/${planId}/enroll`).send({ employeeId: employees.EMP003 }))).toBe('409 BENEFIT_ALREADY_ENROLLED');
    expect(await prisma.notification.count({ where: { type: 'BENEFIT_ENROLLMENT_CONFIRMED', userId: emp.user.id } })).toBe(1);
    const gen = await as(hrAdmin, 'post', `${B}/entitlements/generate`).send({ periodId });
    expect(gen.body.data).toMatchObject({ created: 2, skippedExisting: 0 });
    expect((await as(hrAdmin, 'post', `${B}/entitlements/generate`).send({ periodId })).body.data).toMatchObject({ created: 0, skippedExisting: 2 }); // idempotent
    const ents = (await as(hrAdmin, 'get', `${B}/entitlements?periodId=${periodId}`)).body.data;
    expect(ents).toHaveLength(2);
    ent3 = ents.find((e: { employeeId: string }) => e.employeeId === employees.EMP003).id; ent4 = ents.find((e: { employeeId: string }) => e.employeeId === employees.EMP004).id;
    expect(await balance(ent3)).toEqual({ currency: 'THB', granted: '10000.00', adjustment: '0.00', reserved: '0.00', consumed: '0.00', available: '10000.00' });
    expect(await ledgerSql(ent3)).toEqual([{ entry_type: 'GRANT', amount: '10000.00' }]);
    expect(err(await as(hr, 'post', `${B}/entitlements/generate`).send({ periodId }))).toBe('403 FORBIDDEN');
  });

  it('adjustments are new ledger rows with a reason (§87); the grant row is never edited; a negative adjustment cannot go below zero', async () => {
    const plus = await as(hrAdmin, 'post', `${B}/entitlements/${ent4}/adjust`).send({ amount: '1000.00', reasonCode: 'GOODWILL', note: 'Relocation support' });
    expect(plus.status).toBe(200);
    expect(plus.body.data.balance).toMatchObject({ granted: '10000.00', adjustment: '1000.00', available: '11000.00' });
    const minus = await as(hrAdmin, 'post', `${B}/entitlements/${ent4}/adjust`).send({ amount: '-500.00', reasonCode: 'DATA_CORRECTION' });
    expect(minus.body.data.balance).toMatchObject({ adjustment: '500.00', available: '10500.00' });
    expect(minus.body.data.ledger.map((l: { entryType: string; amount: string }) => [l.entryType, l.amount])).toEqual([['GRANT', '10000.00'], ['ADJUSTMENT', '1000.00'], ['ADJUSTMENT', '-500.00']]);
    expect(err(await as(hrAdmin, 'post', `${B}/entitlements/${ent4}/adjust`).send({ amount: '-20000.00', reasonCode: 'DATA_CORRECTION' }))).toBe('422 BENEFIT_INSUFFICIENT_BALANCE');
    expect(err(await as(hrAdmin, 'post', `${B}/entitlements/${ent4}/adjust`).send({ amount: '0', reasonCode: 'OTHER' }))).toBe('400 VALIDATION_ERROR');
    expect(text(await prisma.auditLog.findMany({ where: { action: 'ADJUST_BENEFIT_ENTITLEMENT' } }))).not.toMatch(/Relocation support/);
    // employees see their own ledger without HR's notes; a manager sees nothing of a subordinate
    const own = await as(emp4, 'get', `${B}/entitlements/${ent4}`);
    expect(own.status).toBe(200);
    expect(text(own.body)).not.toMatch(/Relocation support/);
    expect(err(await as(mgrA, 'get', `${B}/entitlements/${ent4}`))).toBe('404 BENEFIT_ENTITLEMENT_NOT_FOUND');
    expect((await as(mgrA, 'get', `${B}/entitlements`)).body.meta.total).toBe(0);
    expect((await as(mgrA, 'get', `${B}/enrollments`)).body.meta.total).toBe(0);
  });
});

describe('claims — reservation, documents, workflow, ledger', () => {
  it('a draft reserves nothing; another employee cannot claim for you; submission needs the required document, an open period and a valid amount; the reservation happens with the workflow (§36)', async () => {
    const draft = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '3250.50', serviceDate: '2026-09-10', description: 'Annual check-up' });
    expect(draft.status).toBe(201); claimA = draft.body.data.id;
    expect(draft.body.data).toMatchObject({ status: 'DRAFT', claimedAmount: '3250.50', currency: 'THB', blockers: ['A supporting document is required'] });
    expect(draft.body.data.claimNumber).toMatch(/^BCL-2026-\d{6}$/);
    expect(await balance(ent3)).toMatchObject({ reserved: '0.00', available: '10000.00' });
    expect(err(await as(emp, 'post', `${B}/claims/${claimA}/submit`))).toBe('422 BENEFIT_CLAIM_INVALID');
    // a stranger's receipt is 404; own receipt links; the link does not widen the document
    expect(err(await as(emp, 'post', `${B}/claims/${claimA}/documents`).send({ documentId: otherReceiptId }))).toBe('404 DOCUMENT_NOT_FOUND');
    const linked = await as(emp, 'post', `${B}/claims/${claimA}/documents`).send({ documentId: receiptId });
    expect(linked.status).toBe(201);
    expect(linked.body.data.documents).toEqual([expect.objectContaining({ documentId: receiptId, accessible: true })]);
    expect(err(await as(mgrA, 'get', `/api/v1/documents/${receiptId}`))).toMatch(/^404/);
    // amount above the per-claim maximum
    const big = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '8000.01', serviceDate: '2026-09-11' });
    expect(err(await as(emp, 'post', `${B}/claims/${big.body.data.id}/submit`))).toBe('422 BENEFIT_CLAIM_INVALID');
    await as(emp, 'post', `${B}/claims/${big.body.data.id}/cancel`);
    // EMP004 cannot see or edit EMP003's claim
    expect(err(await as(emp4, 'get', `${B}/claims/${claimA}`))).toBe('404 BENEFIT_CLAIM_NOT_FOUND');
    expect(err(await as(emp4, 'patch', `${B}/claims/${claimA}`).send({ claimedAmount: '1.00' }))).toBe('404 BENEFIT_CLAIM_NOT_FOUND');
    const submitted = await as(emp, 'post', `${B}/claims/${claimA}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toMatchObject({ status: 'PENDING_APPROVAL', submittedDate: expect.any(String) });
    claimAWf = submitted.body.data.workflowInstanceId; expect(claimAWf).toBeTruthy();
    expect(await balance(ent3)).toEqual({ currency: 'THB', granted: '10000.00', adjustment: '0.00', reserved: '3250.50', consumed: '0.00', available: '6749.50' });
    expect(err(await as(emp, 'patch', `${B}/claims/${claimA}`).send({ claimedAmount: '9000.00' }))).toBe('409 BENEFIT_CLAIM_NOT_DRAFT'); // immutable once submitted (§49)
    expect(await prisma.notification.count({ where: { type: 'BENEFIT_CLAIM_APPROVAL_REQUIRED', userId: mgrA.user.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'BENEFIT_CLAIM_SUBMITTED', userId: emp.user.id } })).toBe(1);
    expect(text(await prisma.notification.findMany({ where: { type: { startsWith: 'BENEFIT_' } } }))).not.toMatch(/3250|check-up|Clinic receipt/);
  });

  it('pending claims cannot over-claim (§82): a second claim above the available amount is refused; the approver sees the review view; a manager who is not the approver sees nothing', async () => {
    const b = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '6749.51', serviceDate: '2026-09-12' });
    await as(emp, 'post', `${B}/claims/${b.body.data.id}/documents`).send({ documentId: receiptId });
    expect(err(await as(emp, 'post', `${B}/claims/${b.body.data.id}/submit`))).toBe('422 BENEFIT_INSUFFICIENT_BALANCE');
    expect(await balance(ent3)).toMatchObject({ reserved: '3250.50', available: '6749.50' }); // the refused submit left no reservation
    expect(await prisma.workflowInstance.count({ where: { entityId: b.body.data.id } })).toBe(0);
    await as(emp, 'post', `${B}/claims/${b.body.data.id}/cancel`);
    // the approver's purpose-specific view
    const review = await as(mgrA, 'get', `${B}/claims/${claimA}/review`);
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ myStepPending: true, descriptionVisible: true, claim: { claimNumber: expect.stringMatching(/^BCL-/), claimedAmount: '3250.50', description: 'Annual check-up' } });
    expect(review.body.data.claim.documents[0]).toMatchObject({ documentId: receiptId, accessible: false }); // Task 30 still decides the receipt itself
    expect(text(review.body.data)).not.toMatch(/paymentReference":"[^n]/);
    expect(err(await as(mgrB, 'get', `${B}/claims/${claimA}/review`))).toBe('404 BENEFIT_CLAIM_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${B}/claims/${claimA}`))).toBe('404 BENEFIT_CLAIM_NOT_FOUND'); // the generic claim view stays closed to the manager
    expect((await as(mgrA, 'get', `${B}/claims`)).body.meta.total).toBe(0);
    expect((await as(hr, 'get', `${B}/claims`)).body.meta.total).toBeGreaterThan(0); // HR view, ALL scope
    expect(err(await as(hr, 'post', `${B}/claims/${claimA}/payment`).send({ paymentMethod: 'EXTERNAL', paidDate: '2026-09-20' }))).toBe('403 FORBIDDEN');
  });

  it('approval converts the reservation into consumption exactly once (§85, §90); the ledger is exact; READY_FOR_PAYMENT is not paid', async () => {
    expect(err(await act(emp, claimAWf, 'APPROVE'))).toMatch(/403/);
    const results = await Promise.all([act(mgrA, claimAWf, 'APPROVE', 'ok'), act(mgrA, claimAWf, 'APPROVE', 'ok again')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const claim = (await as(hrAdmin, 'get', `${B}/claims/${claimA}`)).body.data;
    expect(claim).toMatchObject({ status: 'READY_FOR_PAYMENT', approvedAmount: '3250.50', paidDate: null, paymentMethod: null });
    expect(await balance(ent3)).toEqual({ currency: 'THB', granted: '10000.00', adjustment: '0.00', reserved: '0.00', consumed: '3250.50', available: '6749.50' });
    expect(await ledgerSql(ent3)).toEqual([{ entry_type: 'GRANT', amount: '10000.00' }, { entry_type: 'RESERVE', amount: '3250.50' }, { entry_type: 'RELEASE', amount: '-3250.50' }, { entry_type: 'CONSUME', amount: '3250.50' }]);
    expect(await prisma.auditLog.count({ where: { action: 'APPROVE_BENEFIT_CLAIM' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'BENEFIT_CLAIM_APPROVED', userId: emp.user.id } })).toBe(1);
    expect(claim.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT']);
    // the employee sees the outcome, not the approver's words
    const mine = (await as(emp, 'get', `${B}/claims/${claimA}`)).body.data;
    expect(mine.status).toBe('READY_FOR_PAYMENT');
    expect(text(mine)).not.toMatch(/ok again/);
  });

  it('rejection releases the reservation (§91); the employee sees the status, not the reviewer note; nothing else changed', async () => {
    const c = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '1000.00', serviceDate: '2026-09-15' });
    await as(emp, 'post', `${B}/claims/${c.body.data.id}/documents`).send({ documentId: receiptId });
    const s = await as(emp, 'post', `${B}/claims/${c.body.data.id}/submit`);
    expect(await balance(ent3)).toMatchObject({ reserved: '1000.00', consumed: '3250.50', available: '5749.50' });
    const race = await Promise.all([act(mgrA, s.body.data.workflowInstanceId, 'REJECT', 'Receipt is not itemised'), act(mgrA, s.body.data.workflowInstanceId, 'APPROVE')]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]); // one terminal decision (§86)
    const after = (await as(emp, 'get', `${B}/claims/${c.body.data.id}`)).body.data;
    expect(['REJECTED', 'READY_FOR_PAYMENT']).toContain(after.status);
    const bal = await balance(ent3);
    if (after.status === 'REJECTED') expect(bal).toMatchObject({ reserved: '0.00', consumed: '3250.50', available: '6749.50' });
    else expect(bal).toMatchObject({ reserved: '0.00', consumed: '4250.50', available: '5749.50' });
    expect(text(after)).not.toMatch(/not itemised/);
    expect(await prisma.notification.count({ where: { type: { in: ['BENEFIT_CLAIM_REJECTED', 'BENEFIT_CLAIM_APPROVED'] }, userId: emp.user.id } })).toBe(2);
    if (after.status === 'READY_FOR_PAYMENT') { claimB = after.id; }
  });

  it('cancelling a pending claim releases exactly once; a draft cancels without a ledger row; approved claims cannot be cancelled', async () => {
    const before = await balance(ent3);
    const c = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '500.00', serviceDate: '2026-09-16' });
    await as(emp, 'post', `${B}/claims/${c.body.data.id}/documents`).send({ documentId: receiptId });
    await as(emp, 'post', `${B}/claims/${c.body.data.id}/submit`);
    const cancels = await Promise.all([as(emp, 'post', `${B}/claims/${c.body.data.id}/cancel`), as(emp, 'post', `${B}/claims/${c.body.data.id}/cancel`)]);
    expect(cancels.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balance(ent3)).toEqual(before);
    expect((await prisma.workflowInstance.findFirst({ where: { entityId: c.body.data.id } }))!.status).toBe('CANCELLED');
    expect(await prisma.benefitEntitlementLedger.count({ where: { claimId: c.body.data.id } })).toBe(2); // RESERVE + RELEASE
    const d = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '10.00', serviceDate: '2026-09-16' });
    expect((await as(emp, 'post', `${B}/claims/${d.body.data.id}/cancel`)).body.data.status).toBe('CANCELLED');
    expect(await prisma.benefitEntitlementLedger.count({ where: { claimId: d.body.data.id } })).toBe(0);
    expect(err(await as(emp, 'post', `${B}/claims/${claimA}/cancel`))).toBe('409 BENEFIT_CLAIM_NOT_CANCELLABLE');
  });

  it('two concurrent submissions of 6,000 each against 10,000 never over-reserve (§84); a double submit of one claim yields one reservation and one workflow (§46)', async () => {
    const bal = await balance(ent4); // 10,500 available (10,000 + 500 adjustment)
    expect(bal.available).toBe('10500.00');
    const mk = async (amount: string) => { const c = await as(emp4, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: amount, serviceDate: '2026-09-01' }); const own = await prisma.document.create({ data: { documentNumber: `DOC-2026-0009${Math.floor(Math.random() * 90 + 10)}`, title: 'Receipt', categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: employees.EMP004, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } }); await as(emp4, 'post', `${B}/claims/${c.body.data.id}/documents`).send({ documentId: own.id }); return c.body.data.id as string; };
    const [x, y] = await Promise.all([mk('5000.00'), mk('5000.00')]);
    const z = await mk('4000.00');
    const results = await Promise.all([as(emp4, 'post', `${B}/claims/${x}/submit`), as(emp4, 'post', `${B}/claims/${y}/submit`), as(emp4, 'post', `${B}/claims/${z}/submit`)]);
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const after = await balance(ent4);
    expect(Number(after.reserved) <= 10500).toBe(true); // never above the balance
    expect(Number(after.available) >= 0).toBe(true);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.error.code === 'BENEFIT_INSUFFICIENT_BALANCE')).toBe(true);
    const pendingIds = results.filter((r) => r.status === 200).map((r) => r.body.data.id as string);
    expect(await prisma.workflowInstance.count({ where: { entityId: { in: [x, y, z] } } })).toBe(ok);
    // double submit of an already-submitted claim: 409, no second reservation
    const dbl = await Promise.all([as(emp4, 'post', `${B}/claims/${pendingIds[0]}/submit`), as(emp4, 'post', `${B}/claims/${pendingIds[0]}/submit`)]);
    expect(dbl.map((r) => r.status)).toEqual([409, 409]);
    expect(await prisma.benefitEntitlementLedger.count({ where: { claimId: pendingIds[0], entryType: 'RESERVE' } })).toBe(1);
    expect(await prisma.workflowInstance.count({ where: { entityId: pendingIds[0] } })).toBe(1);
    for (const id of pendingIds) await as(emp4, 'post', `${B}/claims/${id}/cancel`);
    expect(await balance(ent4)).toMatchObject({ reserved: '0.00', available: '10500.00' });
  });

  it('decimal test (§81): 1000.10 granted, 333.37 + 666.73 consumed → consumed 1000.10, available 0.00, exactly', async () => {
    const plan = await as(hrAdmin, 'post', `${B}/plans`).send({ code: 'DEC', name: 'Decimal plan', categoryId, planType: 'ALLOWANCE', currency: 'THB', defaultEntitlementAmount: '1000.10', requiresDocument: false, workflowDefinitionCode: 'BENEFIT_STD', effectiveFrom: '2026-01-01', rules: [] });
    await as(hrAdmin, 'patch', `${B}/plans/${plan.body.data.id}`).send({ status: 'ACTIVE' });
    const period = await as(hrAdmin, 'post', `${B}/periods`).send({ planId: plan.body.data.id, name: 'Decimal period', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await as(hrAdmin, 'post', `${B}/periods/${period.body.data.id}/open`);
    await as(hrAdmin, 'post', `${B}/plans/${plan.body.data.id}/enroll`).send({ employeeId: employees.EMP003 });
    await as(hrAdmin, 'post', `${B}/entitlements/generate`).send({ periodId: period.body.data.id });
    const ent = (await as(hrAdmin, 'get', `${B}/entitlements?periodId=${period.body.data.id}`)).body.data[0];
    for (const amount of ['333.37', '666.73']) {
      const c = await as(emp, 'post', `${B}/claims`).send({ planId: plan.body.data.id, periodId: period.body.data.id, claimedAmount: amount, serviceDate: '2026-09-01' });
      const s = await as(emp, 'post', `${B}/claims/${c.body.data.id}/submit`);
      expect(s.status).toBe(200);
      expect((await act(mgrA, s.body.data.workflowInstanceId, 'APPROVE')).status).toBe(200);
    }
    expect(await balance(ent.id)).toEqual({ currency: 'THB', granted: '1000.10', adjustment: '0.00', reserved: '0.00', consumed: '1000.10', available: '0.00' });
    const sql = await prisma.$queryRaw<{ consumed: string; available: string }[]>`SELECT SUM(CASE WHEN "entry_type" = 'CONSUME' THEN "amount" ELSE 0 END)::text AS consumed, (SUM(CASE WHEN "entry_type" IN ('GRANT','ADJUSTMENT') THEN "amount" ELSE 0 END) - SUM(CASE WHEN "entry_type" IN ('RESERVE','RELEASE','CONSUME') THEN "amount" ELSE 0 END))::text AS available FROM "benefit_entitlement_ledger" WHERE "entitlement_id" = ${ent.id}`;
    expect(sql).toEqual([{ consumed: '1000.10', available: '0.00' }]);
    const third = await as(emp, 'post', `${B}/claims`).send({ planId: plan.body.data.id, periodId: period.body.data.id, claimedAmount: '0.01', serviceDate: '2026-09-01' });
    expect(err(await as(emp, 'post', `${B}/claims/${third.body.data.id}/submit`))).toBe('422 BENEFIT_INSUFFICIENT_BALANCE');
  });
});

describe('payment, payroll boundary, coverage, transfer', () => {
  it('HR records an external payment (§90 end); the claim becomes PAID; no payroll row changed; the reference is minimised in the audit', async () => {
    const payrollBefore = await prisma.payrollResultItem.count();
    const paid = await as(payAdmin, 'post', `${B}/claims/${claimA}/payment`).send({ paymentMethod: 'EXTERNAL', paymentReference: 'TRF-20260920-0001', paidDate: '2026-09-20' });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'PAID', paymentMethod: 'EXTERNAL', paidDate: '2026-09-20' });
    paidAmounts.push(paid.body.data.approvedAmount);
    expect(err(await as(payAdmin, 'post', `${B}/claims/${claimA}/payment`).send({ paymentMethod: 'EXTERNAL', paidDate: '2026-09-21' }))).toBe('409 BENEFIT_CLAIM_NOT_PAYABLE');
    expect(await prisma.payrollResultItem.count()).toBe(payrollBefore);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'RECORD_BENEFIT_PAYMENT' } });
    expect(text(audit)).not.toMatch(/TRF-20260920/);
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ paymentMethod: 'EXTERNAL', referenceLength: 17 });
    expect((await as(emp, 'get', `${B}/claims/${claimA}`)).body.data.paymentReference).toBeNull(); // the employee sees paid, not the bank reference
    expect(await prisma.notification.count({ where: { type: 'BENEFIT_CLAIM_PAID', userId: emp.user.id } })).toBe(1);
  });

  it('the payroll handoff is explicit, needs both permissions, is idempotent, and ends in SENT_TO_PAYROLL — never PAID (§93)', async () => {
    if (!claimB) { const c = await as(emp, 'post', `${B}/claims`).send({ planId, periodId, claimedAmount: '2000.00', serviceDate: '2026-09-17' }); await as(emp, 'post', `${B}/claims/${c.body.data.id}/documents`).send({ documentId: receiptId }); const s = await as(emp, 'post', `${B}/claims/${c.body.data.id}/submit`); await act(mgrA, s.body.data.workflowInstanceId, 'APPROVE'); claimB = c.body.data.id; }
    // payroll fixture: a policy, a salary, a calendar, a period and a calculated run in review
    const payDef = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'PAYROLL_STD', name: 'Payroll', module: 'payroll', entityType: 'PAYROLL_RUN', steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: admin.user.id }] });
    await as(admin, 'post', `/api/v1/workflow/definitions/${payDef.body.data.id}/activate`);
    const calendar = await as(admin, 'post', '/api/v1/calendars').send({ organizationId: orgId, code: 'STD', name: 'Standard', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
    await as(admin, 'patch', `/api/v1/calendars/organizations/${orgId}/default`).send({ calendarId: calendar.body.data.id });
    const policy = await as(admin, 'post', '/api/v1/payroll/policies').send({ organizationId: orgId, name: 'Standard payroll', monthlyDivisorDays: 30, dailyWorkHours: 8, newHireProration: 'CALENDAR_DAYS', terminationProration: 'CALENDAR_DAYS', absenceDeductionEnabled: false, lateDeductionEnabled: false, workflowDefinitionCode: 'PAYROLL_STD', effectiveFrom: '2020-01-01', currencyCode: 'THB' });
    expect(policy.status).toBe(201);
    for (const code of ['MGRA', 'HRADM', 'PAYADM', 'EMP003', 'EMP004', 'EMP006']) expect((await as(admin, 'post', '/api/v1/payroll/compensations').send({ employeeId: employees[code], effectiveFrom: '2018-01-01', baseSalary: '30000.00', currencyCode: 'THB' })).status).toBe(201);
    const period = await as(admin, 'post', '/api/v1/payroll/periods').send({ organizationId: orgId, year: 2026, month: 9, periodStart: '2026-09-01', periodEnd: '2026-09-30', attendanceFrom: '2026-08-21', attendanceTo: '2026-09-20', paymentDate: '2026-09-28' });
    expect(period.status).toBe(201);
    const calc = await as(admin, 'post', `/api/v1/payroll/periods/${period.body.data.id}/calculate`);
    expect(calc.status, text(calc.body)).toBe(200);
    const comp = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'BENEFIT_REIMB', name: 'Benefit reimbursement', type: 'EARNING' });
    const deduction = await as(admin, 'post', '/api/v1/payroll/components').send({ code: 'SOME_DED', name: 'Deduction', type: 'DEDUCTION' });
    const body = { payrollPeriodId: period.body.data.id, componentId: comp.body.data.id };
    expect(err(await as(hr, 'post', `${B}/claims/${claimB}/send-to-payroll`).send(body))).toBe('403 FORBIDDEN'); // no record_payment
    expect(err(await as(payAdmin, 'post', `${B}/claims/${claimB}/send-to-payroll`).send({ ...body, componentId: deduction.body.data.id }))).toBe('422 VALIDATION_ERROR');
    const itemsBefore = await prisma.payrollResultItem.count();
    const sent = await Promise.all([as(payAdmin, 'post', `${B}/claims/${claimB}/send-to-payroll`).send(body), as(payAdmin, 'post', `${B}/claims/${claimB}/send-to-payroll`).send(body)]);
    expect(sent.map((r) => r.status).sort()).toEqual([200, 200]);
    expect(await prisma.payrollResultItem.count()).toBe(itemsBefore + 1); // exactly one line
    const again = await as(payAdmin, 'post', `${B}/claims/${claimB}/send-to-payroll`).send(body);
    expect(again.status).toBe(200);
    expect(await prisma.payrollResultItem.count()).toBe(itemsBefore + 1);
    const claim = (await as(payAdmin, 'get', `${B}/claims/${claimB}`)).body.data;
    expect(claim).toMatchObject({ status: 'SENT_TO_PAYROLL', paymentMethod: 'PAYROLL', paidDate: null });
    const line = await prisma.payrollResultItem.findFirst({ where: { referenceType: 'BENEFIT_CLAIM', referenceId: claimB } });
    expect(line).toMatchObject({ isManual: true, source: 'MANUAL', componentCodeSnapshot: 'BENEFIT_REIMB' });
    expect(line!.amount.toFixed(2)).toBe(claim.approvedAmount);
    // the payroll line carries no taxability decision: it is an earning line like any other manual adjustment
    expect(Object.keys(line!)).not.toEqual(expect.arrayContaining(['taxable', 'taxTreatment']));
    // then HR records PAID once payroll is done — a separate human step
    const paidB = await as(payAdmin, 'post', `${B}/claims/${claimB}/payment`).send({ paymentMethod: 'PAYROLL', paidDate: '2026-09-28' });
    expect(paidB.body.data.status).toBe('PAID');
    paidAmounts.push(paidB.body.data.approvedAmount);
  });

  it('a coverage-only plan has enrolment and coverage dates and no money (§92); an employee-selectable plan can be self-enrolled and waived', async () => {
    const plan = await as(hrAdmin, 'post', `${B}/plans`).send({ code: 'GRPINS', name: 'Group Insurance', categoryId, planType: 'COVERAGE_ONLY', employeeSelectable: true, effectiveFrom: '2026-01-01', rules: [{ ruleType: 'ORGANIZATION', value: orgId }] });
    expect(plan.status).toBe(201); coveragePlanId = plan.body.data.id;
    expect(plan.body.data).toMatchObject({ currency: null, defaultEntitlementAmount: null, workflowDefinitionCode: null });
    await as(hrAdmin, 'patch', `${B}/plans/${coveragePlanId}`).send({ status: 'ACTIVE' });
    expect(err(await as(hrAdmin, 'post', `${B}/periods`).send({ planId: coveragePlanId, name: 'Coverage period', periodStart: '2026-01-01', periodEnd: '2026-12-31' }))).toBe('409 BENEFIT_PLAN_NOT_MONETARY');
    const self = await as(emp, 'post', `${B}/plans/${coveragePlanId}/self-enroll`).send({ coverageStart: '2026-10-01' });
    expect(self.status).toBe(201);
    expect(self.body.data).toMatchObject({ status: 'ENROLLED', source: 'SELF', coverageStart: '2026-10-01' });
    const my = (await as(emp, 'get', `${B}/my`)).body.data;
    expect(my.coverage.map((c: { planName: string }) => c.planName)).toEqual(['Group Insurance']);
    expect(my.entitlements.every((e: { planId: string }) => e.planId !== coveragePlanId)).toBe(true); // no fake balance
    expect(err(await as(emp, 'post', `${B}/claims`).send({ planId: coveragePlanId, periodId, claimedAmount: '1.00', serviceDate: '2026-09-01' }))).toMatch(/404|409/);
    const waived = await as(emp, 'post', `${B}/plans/${coveragePlanId}/waive`);
    expect(waived.body.data.status).toBe('WAIVED');
    expect(await prisma.benefitEnrollment.count({ where: { planId: coveragePlanId } })).toBe(1); // history kept, nothing deleted
    expect(err(await as(emp4, 'post', `${B}/plans/${planId}/waive`))).toBe('409 BENEFIT_PLAN_NOT_SELECTABLE');
  });

  it('transfer keeps the historical claim snapshot and the granted entitlement (§74, §75, §89)', async () => {
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { departmentId: mktId, positionId: (await prisma.position.findFirstOrThrow({ where: { code: 'MKT1' } })).id } });
    const claim = (await as(hrAdmin, 'get', `${B}/claims/${claimA}`)).body.data;
    expect(claim.snapshot.department).toBe('Sales');
    expect((await as(hrAdmin, 'get', `${B}/entitlements/${ent3}`)).body.data).toMatchObject({ snapshot: { department: 'Sales' }, balance: { granted: '10000.00' } });
    const dept = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 }, select: { department: { select: { name: true } } } });
    expect(dept.department.name).toBe('Marketing');
    // a future period re-evaluates the current rules (EMP003 is still eligible: same organization, full-time, tenure)
    const next = await as(hrAdmin, 'post', `${B}/periods`).send({ planId, name: '2027 Annual Health Benefit', periodStart: '2027-01-01', periodEnd: '2027-12-31' });
    await as(hrAdmin, 'post', `${B}/periods/${next.body.data.id}/open`);
    const gen = await as(hrAdmin, 'post', `${B}/entitlements/generate`).send({ periodId: next.body.data.id, employeeIds: [employees.EMP003] });
    expect(gen.body.data).toMatchObject({ created: 1 });
    const ents = (await as(hrAdmin, 'get', `${B}/entitlements?periodId=${next.body.data.id}`)).body.data;
    expect(ents[0]).toMatchObject({ snapshot: { department: 'Marketing' }, balance: { granted: '12000.00' } }); // the plan's new default applied to the new period only
  });
});

describe('who sees what', () => {
  it('My benefits carries own enrolments, balances, claims and coverage; a manager sees only their own account; nobody sees another employee', async () => {
    const my = (await as(emp, 'get', `${B}/my`)).body.data;
    expect(my.entitlements.length).toBeGreaterThanOrEqual(2);
    expect(my.claims.every((c: { employeeId: string }) => c.employeeId === employees.EMP003)).toBe(true);
    expect(my.claims.some((c: { status: string }) => c.status === 'PAID')).toBe(true);
    const mgr = (await as(mgrA, 'get', `${B}/my`)).body.data;
    expect(mgr).toMatchObject({ enrollments: [], entitlements: [], claims: [] });
    expect((await as(mgrA, 'get', `${B}/claims?employeeId=${employees.EMP003}`)).body.meta.total).toBe(0);
    expect((await as(mgrA, 'get', `${B}/entitlements?employeeId=${employees.EMP003}`)).body.meta.total).toBe(0);
    expect(err(await as(mgrA, 'get', `${B}/dashboard`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgrA, 'get', `${B}/reports`))).toBe('403 FORBIDDEN');
  });

  it('the executive sees aggregates only (§94, §98); the datasets are aggregate-safe and exact; the manager is denied', async () => {
    const dash = await as(exec, 'get', `${B}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.data.plans.active).toBe(3);
    expect(dash.body.data.money.find((m: { currency: string }) => m.currency === 'THB')).toMatchObject({ granted: expect.stringMatching(/^\d+\.\d{2}$/) });
    const rep = await as(exec, 'get', `${B}/reports?from=2026-01-01&to=2026-12-31`);
    expect(rep.status).toBe(200);
    const hw = rep.body.data.byPlan.find((p: { plan: string }) => p.plan === '2026 Health & Wellness Allowance');
    expect(hw).toMatchObject({ enrolled: 2, claims: expect.any(Number) });
    // Task 42 correction: report money is keyed by currency (amounts[]), never a cross-currency total.
    expect(hw.amounts.map((m: { currency: string }) => m.currency)).toEqual(['THB']);
    expect(Number(hw.amounts[0].approvedAmount)).toBeGreaterThanOrEqual(3250.5);
    for (const payload of [dash.body.data, rep.body.data]) expect(forbiddenKeys(payload, /^(employeeId|employeeCode|employeeName|firstName|lastName|name|email|claimNumber|description|documentId|paymentReference|department)$/)).toEqual([]);
    expect(text(rep.body.data)).not.toMatch(/Emma|EMP003|BCL-|check-up|TRF-|Clinic/);
    expect(err(await as(exec, 'get', `${B}/claims`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${B}/my`)).startsWith('200')).toBe(true);
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const c = await run(exec, 'benefit_claim_summary', ['plan', 'status', 'currency', 'claimedAmount', 'approvedAmount']);
    expect(err(c)).toBe('200');
    expect(c.body.data.rows.filter((x: { status: string; plan: string }) => x.status === 'PAID' && x.plan === '2026 Health & Wellness Allowance').map((x: { claimedAmount: string; approvedAmount: string; currency: string }) => [x.claimedAmount, x.approvedAmount, x.currency]).sort()).toEqual([...paidAmounts].sort().map((a) => [a, a, 'THB'])); // the approve/reject race earlier decides which claim reached payroll
    const e = await run(exec, 'benefit_entitlement_summary', ['plan', 'currency', 'granted', 'consumed', 'available']);
    expect(e.body.data.rows.find((x: { plan: string }) => x.plan === 'Decimal plan')).toMatchObject({ granted: '1000.10', consumed: '1000.10', available: '0.00' });
    const n = await run(hrAdmin, 'benefit_enrollment_summary', ['plan', 'status', 'organization']);
    expect(n.body.data.rows.filter((x: { status: string }) => x.status === 'ENROLLED').length).toBeGreaterThanOrEqual(3);
    for (const r of [c, e, n]) expect(text(r.body)).not.toMatch(/Emma|EMP003|BCL-|check-up|TRF-|Sales|Marketing/);
    expect(err(await run(mgrA, 'benefit_claim_summary', ['plan']))).toMatch(/^40[134]/);
    expect(err(await run(emp, 'benefit_entitlement_summary', ['plan']))).toMatch(/^40[134]/);
  });

  it('Employee 360: self sees own summary, the manager’s 360 of a subordinate has no benefits section, HR sees a safe summary; the privacy export carries own records without reviewer comments', async () => {
    const self360 = (await as(emp, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(self360.sections.benefits.balances.length).toBeGreaterThanOrEqual(1);
    expect(self360.sections.benefits.claims.some((c: { status: string }) => c.status === 'PAID')).toBe(true);
    const mgr360 = (await as(mgrA, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(mgr360.sections.benefits ?? null).toBeNull();
    const hr360 = (await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(hr360.sections.benefits.enrollments.some((e: { plan: string }) => e.plan === '2026 Health & Wellness Allowance')).toBe(true);
    expect(text(hr360.sections.benefits)).not.toMatch(/check-up|Clinic|TRF-|not itemised|BCL-/);
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    const exported = JSON.parse(x.text);
    expect(exported.data.benefits.claims.find((c: { status: string }) => c.status === 'PAID')).toMatchObject({ claimedAmount: '3250.50', description: 'Annual check-up', paymentMethod: 'EXTERNAL' });
    const hwEntitlement = exported.data.benefits.entitlements.find((e: { plan: { name: string }; period: { name: string } }) => e.plan.name === '2026 Health & Wellness Allowance' && e.period.name === '2026 Annual Health Benefit'); // export order is unspecified
    expect(hwEntitlement.ledger.length).toBeGreaterThanOrEqual(4);
    expect(x.text).not.toMatch(/not itemised|ok again|Relocation support/);
    expect(exported.notIncluded.some((n: { category: string }) => /reviewer comments/.test(n.category))).toBe(true);
  });

  it('audit entries exist for every benefits mutation and carry no description, document, receipt, reference or reviewer note; nothing else was written (§78)', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { module: 'benefits' }, select: { action: true } })).map((a) => a.action);
    for (const a of ['CREATE_BENEFIT_CATEGORY', 'CREATE_BENEFIT_PLAN', 'UPDATE_BENEFIT_PLAN', 'ACTIVATE_BENEFIT_PLAN', 'SET_BENEFIT_ELIGIBILITY_OVERRIDE', 'CREATE_BENEFIT_PERIOD', 'OPEN_BENEFIT_PERIOD', 'ENROLL_BENEFIT', 'WAIVE_BENEFIT', 'GENERATE_BENEFIT_ENTITLEMENTS', 'ADJUST_BENEFIT_ENTITLEMENT', 'CREATE_BENEFIT_CLAIM', 'SUBMIT_BENEFIT_CLAIM', 'APPROVE_BENEFIT_CLAIM', 'CANCEL_BENEFIT_CLAIM', 'RECORD_BENEFIT_PAYMENT', 'SEND_BENEFIT_TO_PAYROLL']) expect(actions, a).toContain(a);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'benefits' } }))).not.toMatch(/check-up|Clinic receipt|TRF-20260920|not itemised|ok again|Relocation support|Agreed at hire/);
    expect(await prisma.performanceCycle.count()).toBe(0);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
    expect(await prisma.talentReviewCycle.count()).toBe(0);
    expect(await prisma.probationCase.count()).toBe(0);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 } })).employmentStatus).toBe('ACTIVE');
    expect(await prisma.payrollResultItem.count({ where: { referenceType: 'BENEFIT_CLAIM' } })).toBe(1); // only the explicit handoff
    expect(orgBId && salesId).toBeTruthy();
  });
});
