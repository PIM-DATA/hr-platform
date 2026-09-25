/**
 * Task 40 — Employee service requests and HR letters.
 *
 * What these tests guard: a ticket records what was asked and what HR did and never writes to a source domain; a
 * request type's form fields are allow-listed data, not behaviour, and what an answer meant is frozen at submission;
 * internal notes never reach the employee and a manager reaches nothing of a subordinate; a letter template can only
 * contain registry tokens and nothing in one is ever executed; a salary-bearing letter needs the payroll authority,
 * not merely the right to fulfil tickets; an issued letter is an immutable snapshot with an exact decimal salary;
 * letter fulfilment is atomic and issues exactly one letter under concurrency; executives see aggregates only.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const text = (v: unknown) => JSON.stringify(v);
const X = '/api/v1/employee-services';
const act = (s: Session, wfId: string, action: 'APPROVE' | 'REJECT', comment?: string) => as(s, 'post', `/api/v1/workflow/instances/${wfId}/actions`).send({ action, comment });

let admin: Session, hrAdmin: Session, hr: Session, clerk: Session, mgrA: Session, mgrB: Session, emp: Session, emp4: Session, exec: Session;
let orgId: string, salesId: string, mktId: string, docCatId: string;
const employees: Record<string, string> = {};
const types: Record<string, string> = {};
const templates: Record<string, string> = {};
let ownDoc: string, strangerDoc: string, certRequestId: string, employmentLetterId: string;

function forbiddenKeys(value: unknown, re: RegExp, path = ''): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (re.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } };
  walk(value, path); return hits;
}
const newRequest = async (s: Session, requestTypeId: string, subject: string, answers?: unknown[], description?: string) => {
  const r = await as(s, 'post', `${X}/requests`).send({ requestTypeId, subject, description, answers });
  expect(r.status, text(r.body)).toBe(201); return r.body.data.id as string;
};

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A40', name: 'Services Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const sales = await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } });
  const mkt = await prisma.department.create({ data: { organizationId: org.id, code: 'MKT', name: 'Marketing' } });
  salesId = sales.id; mktId = mkt.id;
  const analyst = await prisma.job.create({ data: { code: 'DA', title: 'Data Analyst', level: 2 } });
  const senior = await prisma.job.create({ data: { code: 'SDA', title: 'Senior Data Analyst', level: 3 } });
  const mgrJob = await prisma.job.create({ data: { code: 'SM', title: 'Sales Manager', level: 4 } });
  const daPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'DA1', title: 'Data Analyst', jobId: analyst.id } })).id;
  const sdaPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'SDA1', title: 'Senior Data Analyst', jobId: senior.id } })).id;
  const smPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'SM1', title: 'Sales Manager', jobId: mgrJob.id } })).id;
  const mktPos = (await prisma.position.create({ data: { departmentId: mkt.id, code: 'MKT1', title: 'Marketing Officer', jobId: analyst.id } })).id;
  const mk = async (code: string, first: string, positionId: string, departmentId: string, managerId: string | null) => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: first, lastName: 'Person', email: `${code.toLowerCase()}@a40.local`, hireDate: new Date('2021-03-15T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id);
  await mk('MGRA', 'Alice', smPos, sales.id, null);
  await mk('MGRB', 'Bob', mktPos, mkt.id, null);
  await mk('HRADM', 'Hana', smPos, sales.id, null);
  await mk('CLERK', 'Kim', smPos, sales.id, null);
  await mk('EMP003', 'Emma', daPos, sales.id, employees.MGRA);
  await mk('EMP004', 'Ed', daPos, sales.id, employees.MGRA);
  await mk('EMP005', 'Olly', mktPos, mkt.id, employees.MGRB);
  void sdaPos;
  await createUser({ email: 'admin@a40.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@a40.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'hr@a40.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgra@a40.local', password: PW, role: 'MANAGER', employeeId: employees.MGRA });
  await createUser({ email: 'mgrb@a40.local', password: PW, role: 'MANAGER', employeeId: employees.MGRB });
  await createUser({ email: 'emp@a40.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP003 });
  await createUser({ email: 'emp4@a40.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP004 });
  await createUser({ email: 'exec@a40.local', password: PW, role: 'EXECUTIVE' });
  // A letter clerk: may fulfil tickets and issue letters, but has no payroll authority at all (§75).
  const codes = ['service_request.view_own', 'service_request.create', 'service_request.view', 'service_request.fulfill', 'service_request.manage', 'hr_letter.view_own', 'hr_letter.issue', 'hr_letter.manage_templates', 'hr_letter.view_reports', 'workflow.approve', 'documents.view_own'];
  const perms = await prisma.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
  const clerkRole = await prisma.role.create({ data: { code: 'LETTER_CLERK', name: 'Letter clerk (no payroll authority)', dataScope: 'ALL', rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  const clerkUser = await createUser({ email: 'clerk@a40.local', password: PW, employeeId: employees.CLERK });
  await prisma.userRole.create({ data: { userId: clerkUser.id, roleId: clerkRole.id } });
  [admin, hrAdmin, hr, clerk, mgrA, mgrB, emp, emp4, exec] = await Promise.all(['admin', 'hradmin', 'hr', 'clerk', 'mgra', 'mgrb', 'emp', 'emp4', 'exec'].map((u) => loginAs(app, `${u}@a40.local`, PW)));
  // Authoritative compensation for EMP003: an older row and the current one, so the effective-date rule is exercised.
  await prisma.employeeCompensation.createMany({ data: [
    { employeeId: employees.EMP003, effectiveFrom: '2021-03-15', effectiveTo: '2025-12-31', salaryType: 'MONTHLY', baseSalary: '28000.00', currencyCode: 'THB', createdByUserId: hrAdmin.user.id },
    { employeeId: employees.EMP003, effectiveFrom: '2026-01-01', salaryType: 'MONTHLY', baseSalary: '30612.50', currencyCode: 'THB', createdByUserId: hrAdmin.user.id },
  ] });
  const def = await as(admin, 'post', '/api/v1/workflow/definitions').send({ code: 'SERVICE_STD', name: 'Service request approval', module: 'employee_services', entityType: 'SERVICE_REQUEST', steps: [{ name: 'Direct manager', approverType: 'DIRECT_MANAGER' }] });
  expect(def.status, text(def.body)).toBe(201);
  await as(admin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  docCatId = (await prisma.documentCategory.create({ data: { code: 'SUPPORT', name: 'Supporting documents', defaultClassification: 'EMPLOYEE_PRIVATE' } })).id;
  const doc = async (n: string, title: string, owner: string) => (await prisma.document.create({ data: { documentNumber: `DOC-2026-0004${n}`, title, categoryId: docCatId, classification: 'EMPLOYEE_PRIVATE', ownerEmployeeId: owner, status: 'ACTIVE', createdByUserId: hrAdmin.user.id } })).id;
  ownDoc = await doc('01', 'Proof of address', employees.EMP003);
  strangerDoc = await doc('02', 'Someone else’s paper', employees.EMP005);
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('service catalogue and letter templates', () => {
  it('templates accept only registry tokens: an injection attempt, an unknown path and a stray brace are refused, and a salary token marks the template as needing payroll authority', async () => {
    const make = (code: string, bodyTemplate: string, letterType = 'GENERAL', subjectTemplate?: string) => as(hrAdmin, 'post', `${X}/letter-templates`).send({ code, name: code, letterType, bodyTemplate, subjectTemplate });
    for (const hostile of ['{{sql:SELECT * FROM users}}', '{{employee.password}}', '{{__proto__}}', '{{constructor}}', '{{employee.fullName.constructor}}', '{{unknown.path}}', '{{ employee.salaryHistory }}']) {
      const r = await make('X-BAD', `This letter certifies ${hostile} and nothing else at all.`);
      expect(err(r), hostile).toBe('422 HR_LETTER_UNKNOWN_TOKEN');
    }
    expect(err(await make('X-BAD', 'An unclosed {{employee.fullName brace is refused outright.'))).toBe('422 HR_LETTER_TEMPLATE_MALFORMED');
    expect(await prisma.hrLetterTemplate.count()).toBe(0);
    expect(err(await as(hr, 'post', `${X}/letter-templates`).send({ code: 'NOPE', name: 'Nope', letterType: 'GENERAL', bodyTemplate: 'Plain enough text here.' }))).toBe('403 FORBIDDEN');

    const cert = await make('EMP-CERT', 'This is to certify that {{employee.fullName}} (employee code {{employee.employeeCode}}) has been employed by {{organization.name}} since {{employment.hireDate}} as {{job.title}} in the {{department.name}} department. Employment status: {{employment.status}}. Issued on {{letter.issueDate}} under reference {{letter.number}}.', 'EMPLOYMENT_CERTIFICATE', 'Certificate of Employment — {{employee.fullName}}');
    expect(cert.status, text(cert.body)).toBe(201);
    expect(cert.body.data).toMatchObject({ requiresSalaryAccess: false, letterType: 'EMPLOYMENT_CERTIFICATE' });
    expect(cert.body.data.tokens).toEqual(expect.arrayContaining(['employee.fullName', 'job.title', 'letter.number']));
    templates.CERT = cert.body.data.id;

    const salary = await make('SAL-CERT', 'This is to certify that {{employee.fullName}} is employed by {{organization.name}} as {{job.title}} and receives a base salary of {{compensation.baseSalary}} {{compensation.currency}} per month ({{compensation.salaryType}}). Issued {{letter.issueDate}}, reference {{letter.number}}.', 'SALARY_CERTIFICATE', 'Salary Certificate — {{employee.fullName}}');
    expect(salary.status, text(salary.body)).toBe(201);
    expect(salary.body.data.requiresSalaryAccess).toBe(true); // derived from the tokens, never supplied by the caller
    templates.SALARY = salary.body.data.id;
    const general = await make('GEN', 'To whom it may concern: {{employee.fullName}} works at {{organization.name}}. Reference {{letter.number}}.');
    templates.GENERAL = general.body.data.id;
  });

  it('request types carry allow-listed form fields only; a letter type needs a template; the workflow must belong to this module', async () => {
    const mk = (body: Record<string, unknown>) => as(hrAdmin, 'post', `${X}/request-types`).send(body);
    expect(err(await mk({ code: 'BAD', name: 'Bad', category: 'GENERAL_HR', fields: [{ key: 'x', label: 'X', fieldType: 'SCRIPT' }] }))).toBe('400 VALIDATION_ERROR');
    expect(err(await mk({ code: 'BAD', name: 'Bad', category: 'GENERAL_HR', fields: [{ key: 'pick', label: 'Pick', fieldType: 'SELECT' }] }))).toBe('422 VALIDATION_ERROR');
    expect(err(await mk({ code: 'BAD', name: 'Bad', category: 'GENERAL_HR', workflowCode: 'BENEFIT_STD' }))).toBe('422 VALIDATION_ERROR');
    expect(err(await mk({ code: 'BAD', name: 'Bad', category: 'EMPLOYMENT_DOCUMENT', fulfillmentType: 'HR_LETTER' }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(hr, 'post', `${X}/request-types`).send({ code: 'HRTRY', name: 'HR try', category: 'GENERAL_HR' }))).toBe('403 FORBIDDEN');

    const cert = await mk({ code: 'EMP-CERT-REQ', name: 'Employment Certificate Request', category: 'EMPLOYMENT_DOCUMENT', fulfillmentType: 'HR_LETTER', letterTemplateId: templates.CERT, targetDays: 3, fields: [{ key: 'purpose', label: 'Purpose of the certificate', fieldType: 'SELECT', required: true, options: ['Visa application', 'Bank loan', 'Rental agreement'] }, { key: 'copies', label: 'Copies needed', fieldType: 'NUMBER' }] });
    expect(cert.status, text(cert.body)).toBe(201); types.CERT = cert.body.data.id;
    expect(cert.body.data.fields.map((f: { key: string }) => f.key)).toEqual(['purpose', 'copies']);
    const sal = await mk({ code: 'SAL-CERT-REQ', name: 'Salary Certificate Request', category: 'EMPLOYMENT_DOCUMENT', fulfillmentType: 'HR_LETTER', letterTemplateId: templates.SALARY, targetDays: 5 });
    types.SALARY = sal.body.data.id;
    const gen = await mk({ code: 'GEN-HR', name: 'General HR Request', category: 'GENERAL_HR', targetDays: 7, fields: [{ key: 'details', label: 'What do you need?', fieldType: 'TEXTAREA', required: true, maxLength: 500 }, { key: 'urgent', label: 'Urgent', fieldType: 'BOOLEAN' }, { key: 'effective', label: 'Effective from', fieldType: 'DATE' }] });
    types.GENERAL = gen.body.data.id;
    const wf = await mk({ code: 'WF-REQ', name: 'Request needing approval', category: 'PERSONAL_INFORMATION', workflowCode: 'SERVICE_STD', requiresAttachment: true, fields: [{ key: 'reason', label: 'Reason', fieldType: 'TEXT', required: true }] });
    expect(wf.status, text(wf.body)).toBe(201); types.WORKFLOW = wf.body.data.id;
    expect((await as(emp, 'get', `${X}/my`)).body.data.catalog.map((c: { code: string }) => c.code).sort()).toEqual(['EMP-CERT-REQ', 'GEN-HR', 'SAL-CERT-REQ', 'WF-REQ']);
  });
});

describe('a request is a ticket', () => {
  it('the employee drafts and submits; answers are validated against the configured fields and frozen; a double submit yields one transition', async () => {
    expect(err(await as(emp, 'post', `${X}/requests`).send({ requestTypeId: types.GENERAL, subject: 'x', answers: [{ key: 'details', value: 'Hi' }] }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(emp, 'post', `${X}/requests`).send({ requestTypeId: types.GENERAL, subject: 'Unknown field', answers: [{ key: 'nosuchfield', value: 'x' }] }))).toBe('422 VALIDATION_ERROR');
    expect(err(await as(emp, 'post', `${X}/requests`).send({ requestTypeId: types.CERT, subject: 'Bad choice', answers: [{ key: 'purpose', value: 'Something else' }] }))).toBe('422 VALIDATION_ERROR');
    const id = await newRequest(emp, types.GENERAL, 'My address has changed', [{ key: 'details', value: 'I moved to a new apartment and my address on file is out of date.' }, { key: 'urgent', value: false }, { key: 'effective', value: '2026-10-01' }], 'Please update my records.');
    let d = (await as(emp, 'get', `${X}/requests/${id}`)).body.data;
    expect(d).toMatchObject({ status: 'DRAFT', category: 'GENERAL_HR', fulfillmentType: 'GENERAL', blockers: [] });
    expect(d.requestNumber).toMatch(/^SR-2026-\d{6}$/);
    expect(d.answers).toEqual([
      { key: 'details', label: 'What do you need?', fieldType: 'TEXTAREA', value: 'I moved to a new apartment and my address on file is out of date.', employeeVisible: true },
      { key: 'urgent', label: 'Urgent', fieldType: 'BOOLEAN', value: 'false', employeeVisible: true },
      { key: 'effective', label: 'Effective from', fieldType: 'DATE', value: '2026-10-01', employeeVisible: true },
    ]);
    expect(err(await as(emp4, 'get', `${X}/requests/${id}`))).toBe('404 SERVICE_REQUEST_NOT_FOUND');
    const results = await Promise.all([as(emp, 'post', `${X}/requests/${id}/submit`), as(emp, 'post', `${X}/requests/${id}/submit`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    d = (await as(emp, 'get', `${X}/requests/${id}`)).body.data;
    expect(d).toMatchObject({ status: 'SUBMITTED', overdue: false, workflowInstanceId: null });
    expect(d.dueDate).toBe(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)); // targetDays 7, calendar days
    expect(await prisma.serviceRequestStatusHistory.count({ where: { requestId: id, toStatus: 'SUBMITTED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'SERVICE_REQUEST_SUBMITTED', userId: emp.user.id, sourceEntityId: id } })).toBe(1);
    expect(err(await as(emp, 'patch', `${X}/requests/${id}`).send({ subject: 'Changed my mind' }))).toBe('409 SERVICE_REQUEST_NOT_DRAFT');
    expect(text(await prisma.notification.findMany({ where: { type: { startsWith: 'SERVICE_REQUEST_' } } }))).not.toMatch(/new apartment|address has changed/);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'employee_services' } }))).not.toMatch(/new apartment|Please update my records/);
    types.GENERAL_REQUEST = id;
  });

  it('a required answer and a required attachment are enforced at submission, not at draft', async () => {
    const id = await newRequest(emp, types.WORKFLOW, 'Change my emergency contact');
    expect((await as(emp, 'get', `${X}/requests/${id}`)).body.data.blockers.sort()).toEqual(['Reason is required', 'This request type needs at least one attachment']);
    expect(err(await as(emp, 'post', `${X}/requests/${id}/submit`))).toBe('422 SERVICE_REQUEST_INVALID');
    await as(emp, 'patch', `${X}/requests/${id}`).send({ answers: [{ key: 'reason', value: 'My contact person moved abroad' }] });
    expect(err(await as(emp, 'post', `${X}/requests/${id}/submit`))).toBe('422 SERVICE_REQUEST_INVALID');
    expect(err(await as(emp, 'post', `${X}/requests/${id}/documents`).send({ documentId: strangerDoc }))).toBe('404 DOCUMENT_NOT_FOUND');
    expect((await as(emp, 'post', `${X}/requests/${id}/documents`).send({ documentId: ownDoc })).status).toBe(201);
    const s = await as(emp, 'post', `${X}/requests/${id}/submit`);
    expect(s.status, text(s.body)).toBe(200);
    expect(s.body.data).toMatchObject({ status: 'SUBMITTED', workflowStatus: 'PENDING', attachmentCount: 1 });
    types.WORKFLOW_REQUEST = id;
  });

  it('an approval authorises but does not fulfil (§19): the request stays submitted, the workflow result is recorded, and only then may HR fulfil', async () => {
    const id = types.WORKFLOW_REQUEST as string;
    const before = (await as(hrAdmin, 'get', `${X}/requests/${id}`)).body.data;
    expect(err(await as(hrAdmin, 'post', `${X}/requests/${id}/fulfill`).send({ resultNote: 'Too early' }))).toBe('409 SERVICE_REQUEST_NOT_APPROVED');
    const review = await as(mgrA, 'get', `${X}/requests/${id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.data).toMatchObject({ myStepPending: true, request: { subject: 'Change my emergency contact' } });
    expect(err(await as(mgrB, 'get', `${X}/requests/${id}/review`))).toBe('404 SERVICE_REQUEST_NOT_FOUND');
    expect((await act(mgrA, before.workflowInstanceId, 'APPROVE', 'fine by me')).status).toBe(200);
    const after = (await as(hrAdmin, 'get', `${X}/requests/${id}`)).body.data;
    expect(after).toMatchObject({ status: 'SUBMITTED', workflowStatus: 'APPROVED' }); // authorised, not yet fulfilled
    expect(after.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'SUBMITTED', 'WORKFLOW_APPROVED']);
    expect(text(after)).not.toMatch(/fine by me/);
    const f = await as(hrAdmin, 'post', `${X}/requests/${id}/fulfill`).send({ resultNote: 'Emergency contact updated in the employee master by HR.' });
    expect(f.status, text(f.body)).toBe(200);
    expect(f.body.data.status).toBe('FULFILLED');
  });

  it('assignment is row-locked and grants nothing: two fulfillers racing give one assignee, and a non-fulfiller cannot be assigned', async () => {
    const id = types.GENERAL_REQUEST as string;
    expect(err(await as(mgrA, 'post', `${X}/requests/${id}/assign`).send({ assignedToUserId: hrAdmin.user.id }))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${X}/requests/${id}/assign`).send({ assignedToUserId: emp.user.id }))).toBe('422 VALIDATION_ERROR');
    const race = await Promise.all([as(hrAdmin, 'post', `${X}/requests/${id}/assign`).send({ assignedToUserId: clerk.user.id }), as(clerk, 'post', `${X}/requests/${id}/assign`).send({ assignedToUserId: hrAdmin.user.id })]);
    expect(race.every((r) => r.status === 200)).toBe(true);
    const d = (await as(hrAdmin, 'get', `${X}/requests/${id}`)).body.data;
    expect([hrAdmin.user.id, clerk.user.id]).toContain(d.assignedToUserId);
    expect(d.status).toBe('IN_PROGRESS');
    expect(d.history.filter((h: { to: string }) => h.to === 'IN_PROGRESS')).toHaveLength(1);
    expect(await prisma.notification.count({ where: { type: 'SERVICE_REQUEST_ASSIGNED', sourceEntityId: id } })).toBe(2); // each fulfiller notified the other; assigning yourself notifies nobody
  });

  it('internal notes never reach the employee (§74); a manager and an executive see nothing of a subordinate request', async () => {
    const id = types.GENERAL_REQUEST as string;
    expect((await as(hrAdmin, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'REQUESTER_VISIBLE', body: 'Could you attach a utility bill showing the new address?' })).status).toBe(201);
    expect((await as(hrAdmin, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'INTERNAL', body: 'Checked with payroll: bank details unaffected. Watch for a duplicate ticket.' })).status).toBe(201);
    expect(err(await as(emp, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'INTERNAL', body: 'Let me in' }))).toBe('403 FORBIDDEN');
    const mine = await as(emp, 'get', `${X}/requests/${id}`);
    expect(mine.body.data.messages.map((m: { visibility: string }) => m.visibility)).toEqual(['REQUESTER_VISIBLE']);
    expect(mine.text).not.toMatch(/Checked with payroll|duplicate ticket/);
    const hrView = (await as(hrAdmin, 'get', `${X}/requests/${id}`)).body.data;
    expect(hrView.messages).toHaveLength(2);
    expect(err(await as(mgrA, 'get', `${X}/requests/${id}`))).toBe('404 SERVICE_REQUEST_NOT_FOUND');
    expect((await as(mgrA, 'get', `${X}/requests?employeeId=${employees.EMP003}`)).body.meta.total).toBe(0);
    expect(err(await as(exec, 'get', `${X}/requests/${id}`))).toBe('404 SERVICE_REQUEST_NOT_FOUND');
    expect(text(await prisma.auditLog.findMany({ where: { module: 'employee_services' } }))).not.toMatch(/utility bill|Checked with payroll/);
    // waiting on the employee, who answers; the answer changes no source domain
    expect((await as(hrAdmin, 'post', `${X}/requests/${id}/status`).send({ status: 'WAITING_EMPLOYEE' })).body.data.status).toBe('WAITING_EMPLOYEE');
    expect(await prisma.notification.count({ where: { type: 'SERVICE_REQUEST_WAITING_EMPLOYEE', userId: emp.user.id } })).toBe(1);
    expect((await as(emp, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'REQUESTER_VISIBLE', body: 'Attached, thank you.' })).status).toBe(201);
  });

  it('fulfilling a general request records what HR did and writes nothing to the employee master (§7, §97)', async () => {
    const id = types.GENERAL_REQUEST as string;
    const before = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 } });
    const f = await as(hrAdmin, 'post', `${X}/requests/${id}/fulfill`).send({ resultNote: 'Address updated separately in the employee master under its own authority.' });
    expect(f.status, text(f.body)).toBe(200);
    expect(f.body.data).toMatchObject({ status: 'FULFILLED', letterCount: 0 });
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: employees.EMP003 } });
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null }); // nothing in the source domain moved
    expect(await prisma.notification.count({ where: { type: 'SERVICE_REQUEST_FULFILLED', userId: emp.user.id, sourceEntityId: id } })).toBe(1);
    expect(err(await as(emp, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'REQUESTER_VISIBLE', body: 'One more thing' }))).toBe('409 SERVICE_REQUEST_CLOSED');
    expect(err(await as(emp, 'post', `${X}/requests/${id}/cancel`))).toBe('409 SERVICE_REQUEST_NOT_CANCELLABLE');
  });

  it('editing the catalogue later never changes what a historical answer meant (§10)', async () => {
    const u = await as(hrAdmin, 'patch', `${X}/request-types/${types.GENERAL}`).send({ name: 'General HR Request (revised)', targetDays: 10, fields: [{ key: 'details', label: 'Describe the issue in full', fieldType: 'TEXTAREA', required: true, maxLength: 500 }, { key: 'urgent', label: 'Needs a same-day answer', fieldType: 'BOOLEAN' }] });
    expect(u.status, text(u.body)).toBe(200);
    expect(u.body.data.fields.map((f: { label: string }) => f.label)).toEqual(['Describe the issue in full', 'Needs a same-day answer']);
    const old = (await as(hrAdmin, 'get', `${X}/requests/${types.GENERAL_REQUEST}`)).body.data;
    expect(old.answers.map((a: { label: string }) => a.label)).toEqual(['What do you need?', 'Urgent', 'Effective from']); // frozen at submission
    expect(old.requestTypeName).toBe('General HR Request');
    expect(old.dueDate).toBe(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)); // the old target, not the new one
    // a deactivated type disappears from self-service and cannot start a new request
    const gone = await as(hrAdmin, 'post', `${X}/request-types`).send({ code: 'RETIRED', name: 'Retired request', category: 'OTHER' });
    await as(hrAdmin, 'patch', `${X}/request-types/${gone.body.data.id}`).send({ isActive: false });
    expect((await as(emp, 'get', `${X}/my`)).body.data.catalog.some((c: { code: string }) => c.code === 'RETIRED')).toBe(false);
    expect(err(await as(emp, 'post', `${X}/requests`).send({ requestTypeId: gone.body.data.id, subject: 'Too late for this one' }))).toBe('409 SERVICE_REQUEST_TYPE_NOT_ACTIVE');
  });

  it('the employee withdraws a draft and a submitted request; a rejection carries a reason code and an explanation, never an internal note', async () => {
    const draft = await newRequest(emp, types.GENERAL, 'Withdrawn while a draft', [{ key: 'details', value: 'Never mind.' }]);
    expect((await as(emp, 'post', `${X}/requests/${draft}/cancel`)).body.data.status).toBe('CANCELLED');
    const sent = await newRequest(emp, types.GENERAL, 'Withdrawn after submitting', [{ key: 'details', value: 'Changed my mind.' }]);
    await as(emp, 'post', `${X}/requests/${sent}/submit`);
    const cancels = await Promise.all([as(emp, 'post', `${X}/requests/${sent}/cancel`), as(emp, 'post', `${X}/requests/${sent}/cancel`)]);
    expect(cancels.map((r) => r.status).sort()).toEqual([200, 409]);
    const rejected = await newRequest(emp, types.GENERAL, 'Something HR cannot do', [{ key: 'details', value: 'Please raise my grade.' }]);
    await as(emp, 'post', `${X}/requests/${rejected}/submit`);
    const r = await as(hrAdmin, 'post', `${X}/requests/${rejected}/reject`).send({ reasonCode: 'NOT_ELIGIBLE', explanation: 'Grade changes are decided in the annual review, not by a service request.' });
    expect(r.status, text(r.body)).toBe(200);
    const d = (await as(emp, 'get', `${X}/requests/${rejected}`)).body.data;
    expect(d).toMatchObject({ status: 'REJECTED', rejectReasonCode: 'NOT_ELIGIBLE' });
    expect(d.rejectExplanation).toMatch(/annual review/);
    expect(d.history.find((h: { to: string }) => h.to === 'REJECTED').reasonCode).toBe('NOT_ELIGIBLE');
    expect(await prisma.notification.count({ where: { type: 'SERVICE_REQUEST_REJECTED', userId: emp.user.id, sourceEntityId: rejected } })).toBe(1);
    expect(text(await prisma.auditLog.findMany({ where: { action: 'REJECT_SERVICE_REQUEST' } }))).not.toMatch(/annual review/);
  });
});

describe('HR letters', () => {
  it('an employment certificate freezes the employee facts at issue and is fulfilled atomically with its request; two concurrent calls issue one letter (§82)', async () => {
    certRequestId = await newRequest(emp, types.CERT, 'Employment certificate for my visa', [{ key: 'purpose', value: 'Visa application' }, { key: 'copies', value: 2 }]);
    await as(emp, 'post', `${X}/requests/${certRequestId}/submit`);
    const race = await Promise.all([as(hrAdmin, 'post', `${X}/requests/${certRequestId}/fulfill`).send({}), as(clerk, 'post', `${X}/requests/${certRequestId}/fulfill`).send({})]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.hrLetter.count({ where: { serviceRequestId: certRequestId } })).toBe(1);
    const d = (await as(emp, 'get', `${X}/requests/${certRequestId}`)).body.data;
    expect(d).toMatchObject({ status: 'FULFILLED', letterCount: 1 });
    employmentLetterId = d.letters[0].id;
    const letter = (await as(emp, 'get', `${X}/letters/${employmentLetterId}`)).body.data;
    expect(letter).toMatchObject({ letterType: 'EMPLOYMENT_CERTIFICATE', status: 'ISSUED', salaryAmount: null, snapshot: { job: 'Data Analyst', department: 'Sales' } });
    expect(letter.letterNumber).toMatch(/^HRL-2026-\d{6}$/);
    expect(letter.body).toContain('Emma Person');
    expect(letter.body).toContain('Data Analyst');
    expect(letter.body).toContain('2021-03-15');
    expect(letter.body).toContain(letter.letterNumber);
    expect(letter.body).not.toMatch(/\{\{|\}\}/); // every token resolved; no blanks, no leftovers
    expect(letter.subject).toBe('Certificate of Employment — Emma Person');
    expect(text(await prisma.auditLog.findMany({ where: { action: 'ISSUE_HR_LETTER' } }))).not.toMatch(/Emma Person|certify/);
    expect(await prisma.notification.count({ where: { type: 'HR_LETTER_ISSUED', userId: emp.user.id } })).toBe(1);
  });

  it('a salary letter needs the payroll authority, not merely the right to fulfil tickets (§75); the snapshot is the exact decimal in effect on the issue date (§57, §59)', async () => {
    const id = await newRequest(emp, types.SALARY, 'Salary certificate for my bank');
    await as(emp, 'post', `${X}/requests/${id}/submit`);
    // The clerk may triage the ticket…
    expect((await as(clerk, 'get', `${X}/requests/${id}`)).status).toBe(200);
    expect((await as(clerk, 'post', `${X}/requests/${id}/messages`).send({ visibility: 'INTERNAL', body: 'Waiting on payroll to issue.' })).status).toBe(201);
    // …but cannot issue the salary-bearing letter, through the request or directly.
    expect(err(await as(clerk, 'post', `${X}/requests/${id}/fulfill`).send({}))).toBe('403 FORBIDDEN');
    expect(err(await as(clerk, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.SALARY }))).toBe('403 FORBIDDEN');
    expect(await prisma.hrLetter.count({ where: { letterTypeSnapshot: 'SALARY_CERTIFICATE' } })).toBe(0);
    expect((await as(clerk, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.CERT })).status).toBe(201); // a non-salary letter is fine
    const f = await as(hrAdmin, 'post', `${X}/requests/${id}/fulfill`).send({});
    expect(f.status, text(f.body)).toBe(200);
    const letter = (await as(hrAdmin, 'get', `${X}/letters/${f.body.data.letters[0].id}`)).body.data;
    expect(letter).toMatchObject({ letterType: 'SALARY_CERTIFICATE', salaryAmount: '30612.50', salaryCurrency: 'THB' });
    expect(letter.body).toContain('30612.50 THB');
    expect(letter.body).not.toContain('28000'); // the superseded row is never used
    expect(letter.body).not.toMatch(/30612\.5[^0]|30612\.5$/);
    const notif = await prisma.notification.findMany({ where: { type: 'HR_LETTER_ISSUED' } });
    expect(text(notif)).not.toMatch(/30612/);
    expect(text(await prisma.auditLog.findMany({ where: { action: 'ISSUE_HR_LETTER' } }))).not.toMatch(/30612/);
    // an employee with no authoritative compensation cannot be given a salary letter at all
    expect(err(await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP004, templateId: templates.SALARY }))).toBe('409 COMPENSATION_NOT_FOUND');
  });

  it('an issued letter is immutable: editing the template or the employee changes only later letters (§78, §79, §80)', async () => {
    const original = (await as(hrAdmin, 'get', `${X}/letters/${employmentLetterId}`)).body.data;
    await as(hrAdmin, 'patch', `${X}/letter-templates/${templates.CERT}`).send({ bodyTemplate: 'REVISED WORDING: {{employee.fullName}} ({{employee.employeeCode}}) is employed by {{organization.name}} as {{job.title}}. Reference {{letter.number}}.' });
    await prisma.employee.update({ where: { id: employees.EMP003 }, data: { positionId: (await prisma.position.findFirstOrThrow({ where: { code: 'SDA1' } })).id } });
    await prisma.employeeCompensation.updateMany({ where: { employeeId: employees.EMP003, effectiveTo: null }, data: { effectiveTo: '2026-06-30' } });
    await prisma.employeeCompensation.create({ data: { employeeId: employees.EMP003, effectiveFrom: '2026-07-01', salaryType: 'MONTHLY', baseSalary: '35000.00', currencyCode: 'THB', createdByUserId: hrAdmin.user.id } });
    const unchanged = (await as(hrAdmin, 'get', `${X}/letters/${employmentLetterId}`)).body.data;
    expect(unchanged.body).toBe(original.body);
    expect(unchanged.body).toContain('Data Analyst');
    expect(unchanged.body).not.toContain('REVISED WORDING');
    const newer = await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.CERT });
    expect(newer.status, text(newer.body)).toBe(201);
    expect(newer.body.data.body).toContain('REVISED WORDING');
    expect(newer.body.data.body).toContain('Senior Data Analyst');
    const newSalary = await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.SALARY });
    expect(newSalary.body.data.salaryAmount).toBe('35000.00');
    // and a letter dated while the old compensation was in effect uses that one
    const backdated = await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.SALARY, issueDate: '2026-02-15' });
    expect(backdated.body.data.salaryAmount).toBe('30612.50');
  });

  it('a mistake is voided with a reason and replaced by a new letter; the old row and number stay (§81, §47)', async () => {
    const before = await prisma.hrLetter.count();
    const v = await as(hrAdmin, 'post', `${X}/letters/${employmentLetterId}/void`).send({ reasonCode: 'INCORRECT_DATA' });
    expect(v.status, text(v.body)).toBe(200);
    expect(v.body.data).toMatchObject({ status: 'VOID', voidReasonCode: 'INCORRECT_DATA' });
    expect(err(await as(hrAdmin, 'post', `${X}/letters/${employmentLetterId}/void`).send({ reasonCode: 'OTHER' }))).toBe('409 HR_LETTER_NOT_ISSUED');
    expect(await prisma.hrLetter.count()).toBe(before);
    const reissued = await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP003, templateId: templates.CERT, serviceRequestId: certRequestId });
    expect(reissued.body.data.letterNumber).not.toBe(v.body.data.letterNumber);
    const mine = (await as(emp, 'get', `${X}/letters?pageSize=50`)).body;
    expect(mine.data.find((l: { id: string }) => l.id === employmentLetterId).status).toBe('VOID');
    expect(await prisma.notification.count({ where: { type: 'HR_LETTER_VOIDED', userId: emp.user.id } })).toBe(1);
    expect(err(await as(clerk, 'post', `${X}/letters/${reissued.body.data.id}/void`).send({ reasonCode: 'OTHER' }))).toBe('200'.replace('200', '200')); // the clerk may void a non-salary letter
  });

  it('a hostile employee name is stored and returned as literal text, never as markup (§77)', async () => {
    await prisma.employee.update({ where: { id: employees.EMP004 }, data: { firstName: '<script>alert(1)</script>Ed' } });
    const letter = await as(hrAdmin, 'post', `${X}/letters`).send({ employeeId: employees.EMP004, templateId: templates.GENERAL });
    expect(letter.status, text(letter.body)).toBe(201);
    expect(letter.body.data.body).toContain('<script>alert(1)</script>Ed Person');
    expect(letter.body.data.body).not.toMatch(/\{\{/);
    // it is data, not markup: the API answers JSON, the snapshot is byte-for-byte what was rendered, and the print
    // view renders it as text (the web layer never uses dangerouslySetInnerHTML for a letter body).
    expect(letter.headers['content-type']).toMatch(/application\/json/);
    expect((await prisma.hrLetter.findUniqueOrThrow({ where: { id: letter.body.data.id } })).renderedBodySnapshot).toBe(letter.body.data.body);
    await prisma.employee.update({ where: { id: employees.EMP004 }, data: { firstName: 'Ed' } });
  });
});

describe('who sees what', () => {
  it('my services carries own requests, own letters and the catalogue; the HR queue needs an organization-wide scope; an executive gets neither', async () => {
    const my = (await as(emp, 'get', `${X}/my`)).body.data;
    expect(my.requests.every((r: { employeeId: string }) => r.employeeId === employees.EMP003)).toBe(true);
    expect(my.letters.length).toBeGreaterThanOrEqual(2);
    expect(my.queue).toEqual([]);
    expect((await as(mgrA, 'get', `${X}/my`)).body.data.requests).toEqual([]);
    expect((await as(hrAdmin, 'get', `${X}/requests?pageSize=50`)).body.meta.total).toBeGreaterThan(0);
    expect(err(await as(emp, 'get', `${X}/requests?employeeId=${employees.EMP004}`))).toBe('200');
    expect((await as(emp, 'get', `${X}/requests?employeeId=${employees.EMP004}`)).body.meta.total).toBe(0);
    // an executive has own-access like anyone else, and no employee record here, so they see nothing person-level
    expect((await as(exec, 'get', `${X}/requests`)).body.meta.total).toBe(0);
    expect((await as(exec, 'get', `${X}/letters`)).body.meta.total).toBe(0);
    expect(err(await as(emp, 'get', `${X}/letter-templates`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp4, 'get', `${X}/letters/${employmentLetterId}`))).toBe('404 HR_LETTER_NOT_FOUND');
    expect(err(await as(mgrA, 'get', `${X}/letters/${employmentLetterId}`))).toBe('404 HR_LETTER_NOT_FOUND');
  });

  it('the executive sees aggregates only (§88); datasets are aggregate-safe and a manager is denied', async () => {
    const dash = await as(exec, 'get', `${X}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.body.data.requests.fulfilled).toBeGreaterThanOrEqual(3);
    expect(dash.body.data.letters.issued).toBeGreaterThanOrEqual(3);
    const rep = await as(exec, 'get', `${X}/reports?from=2026-01-01&to=2026-12-31`);
    expect(rep.status).toBe(200);
    expect(rep.body.data.byCategory.find((c: { category: string }) => c.category === 'EMPLOYMENT_DOCUMENT')).toMatchObject({ fulfilled: 2 });
    for (const payload of [dash.body.data, rep.body.data]) expect(forbiddenKeys(payload, /^(employeeId|employeeCode|employeeName|firstName|lastName|email|requestNumber|letterNumber|subject|body|salary|salaryAmount|description|documentId)$/)).toEqual([]);
    expect(text(rep.body.data)).not.toMatch(/Emma|EMP003|SR-2026|HRL-2026|30612|visa|apartment/i);
    expect(err(await as(mgrA, 'get', `${X}/dashboard`))).toBe('403 FORBIDDEN');
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const r1 = await run(exec, 'service_request_summary', ['requestType', 'category', 'status', 'daysToFulfil', 'overdue']);
    expect(err(r1)).toBe('200');
    expect(r1.body.data.rows.filter((x: { status: string }) => x.status === 'FULFILLED').length).toBeGreaterThanOrEqual(3);
    const r2 = await run(exec, 'hr_letter_summary', ['letterType', 'template', 'status', 'fromRequest']);
    expect(r2.body.data.rows.filter((x: { letterType: string }) => x.letterType === 'SALARY_CERTIFICATE').length).toBeGreaterThanOrEqual(1);
    for (const r of [r1, r2]) expect(text(r.body)).not.toMatch(/Emma|EMP003|SR-2026|HRL-2026|30612|visa|apartment/i);
    expect(err(await run(mgrA, 'service_request_summary', ['requestType']))).toMatch(/^40[134]/);
    expect(err(await run(emp, 'hr_letter_summary', ['letterType']))).toMatch(/^40[134]/);
  });

  it('the privacy export carries own tickets, answers, visible messages, status trail and letters, and no internal note; the 360 has no service section; audit stays minimal', async () => {
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.EMP003}/export`);
    const exported = JSON.parse(x.text);
    const svc = exported.data.employeeServices;
    const general = svc.serviceRequests.find((r: { subject: string }) => r.subject === 'My address has changed');
    expect(general).toMatchObject({ status: 'FULFILLED', categorySnapshot: 'GENERAL_HR' });
    expect(general.values.map((v: { value: string }) => v.value)).toEqual(expect.arrayContaining(['false', '2026-10-01']));
    expect(general.messages.map((m: { body: string }) => m.body)).toEqual(['Could you attach a utility bill showing the new address?', 'Attached, thank you.']);
    expect(general.statusHistory.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE', 'FULFILLED']);
    expect(x.text).not.toMatch(/Checked with payroll|duplicate ticket|Waiting on payroll/); // internal notes stay internal
    expect(svc.hrLetters.some((l: { salaryAmountSnapshot: string | null }) => l.salaryAmountSnapshot === '30612.50')).toBe(true); // own salary letter is own data
    expect(svc.hrLetters.some((l: { status: string }) => l.status === 'VOID')).toBe(true);
    expect(exported.notIncluded.some((n: { category: string }) => /internal HR notes/.test(n.category))).toBe(true);
    const e360 = (await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.EMP003}`)).body.data;
    expect(e360.sections.employeeServices).toBeUndefined();
    expect(e360.sections.serviceRequests).toBeUndefined();
    expect(text(e360)).not.toMatch(/SR-2026|HRL-2026/);
    const actions = (await prisma.auditLog.findMany({ where: { module: 'employee_services' }, select: { action: true } })).map((a) => a.action);
    for (const a of ['CREATE_SERVICE_REQUEST_TYPE', 'UPDATE_SERVICE_REQUEST_TYPE', 'CREATE_SERVICE_REQUEST', 'UPDATE_SERVICE_REQUEST', 'SUBMIT_SERVICE_REQUEST', 'ASSIGN_SERVICE_REQUEST', 'UPDATE_SERVICE_REQUEST_STATUS', 'ADD_SERVICE_REQUEST_MESSAGE', 'LINK_SERVICE_REQUEST_DOCUMENT', 'FULFILL_SERVICE_REQUEST', 'REJECT_SERVICE_REQUEST', 'CANCEL_SERVICE_REQUEST', 'CREATE_HR_LETTER_TEMPLATE', 'UPDATE_HR_LETTER_TEMPLATE', 'ISSUE_HR_LETTER', 'VOID_HR_LETTER']) expect(actions, a).toContain(a);
    expect(text(await prisma.auditLog.findMany({ where: { module: 'employee_services' } }))).not.toMatch(/apartment|utility bill|Checked with payroll|30612|certify|Emma Person|Visa application/);
    // nothing else was written by any of it
    expect(await prisma.benefitClaim.count()).toBe(0);
    expect(await prisma.expenseReport.count()).toBe(0);
    expect(await prisma.performanceCycle.count()).toBe(0);
    expect(await prisma.employeeRelationCase.count()).toBe(0);
    expect(await prisma.payrollResultItem.count()).toBe(0);
    expect(await prisma.employeeCompensation.count({ where: { employeeId: employees.EMP003 } })).toBe(3); // the two seeded rows plus the raise; letters added none
  });
});
