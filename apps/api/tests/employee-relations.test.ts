/**
 * Task 26 — Employee relations and warning MVP.
 *
 * What these tests guard: that nothing reaches ISSUED except a final approval, that an issued letter never changes,
 * that acknowledging means receipt and nothing more, and that this — the most confidential data in the system — is
 * visible to exactly the people it should be and to nobody's manager by accident.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACKNOWLEDGEMENT_STATEMENT, addDays, businessToday, formatCaseNumber, renderLetterTemplate, toPlainText, validityState } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { erCaseService } from '../src/modules/employee-relations/er-case.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';

type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

let hrAdmin: Session, approver: Session, hr: Session, mgr: Session, emp1: Session, emp2: Session, exec: Session;
let orgId: string, deptId: string, otherDeptId: string;
const emp: Record<string, string> = {};
let writtenWarningId: string, verbalId: string, caseId: string, actionId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'ERC', name: 'Relations Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'SALES', name: 'Sales' } });
  const otherDept = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: 'Operations' } });
  deptId = dept.id;
  otherDeptId = otherDept.id;
  const job = await prisma.job.create({ data: { code: 'SE', title: 'Sales Executive', level: 2 } });
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'SE1', title: 'Sales Executive', jobId: job.id } });
  const otherPosition = await prisma.position.create({ data: { departmentId: otherDept.id, code: 'OP1', title: 'Operations Officer', jobId: job.id } });

  const mk = async (code: string, managerId: string | null, positionId = position.id, departmentId = dept.id) =>
    (await prisma.employee.create({
      data: {
        employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@erc.local`,
        hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId,
        employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE',
      },
    })).id;
  emp.MGR = await mk('MGR', null);
  emp.EMP003 = await mk('EMP003', emp.MGR);
  emp.EMP004 = await mk('EMP004', emp.MGR);
  emp.HRADM = await mk('HRADM', null, otherPosition.id, otherDept.id);
  emp.APPROVER = await mk('APPROVER', null, otherPosition.id, otherDept.id);

  await createUser({ email: 'hradmin@erc.local', password: PW, role: 'HR_ADMIN', employeeId: emp.HRADM });
  await createUser({ email: 'approver@erc.local', password: PW, role: 'HR_ADMIN', employeeId: emp.APPROVER });
  await createUser({ email: 'hr@erc.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@erc.local', password: PW, role: 'MANAGER', employeeId: emp.MGR });
  await createUser({ email: 'emp1@erc.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP003 });
  await createUser({ email: 'emp2@erc.local', password: PW, role: 'EMPLOYEE', employeeId: emp.EMP004 });
  await createUser({ email: 'exec@erc.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, approver, hr, mgr, emp1, emp2, exec] = await Promise.all(
    ['hradmin', 'approver', 'hr', 'mgr', 'emp1', 'emp2', 'exec'].map((u) => loginAs(app, `${u}@erc.local`, PW)),
  );

  const definition = await as(hrAdmin, 'post', '/api/v1/workflow/definitions').send({
    code: 'ER_STD', name: 'Employee relations approval', module: 'employee_relations', entityType: 'DISCIPLINARY_ACTION',
    steps: [{ name: 'HR approver', approverType: 'SPECIFIC_USER', approverUserId: approver.user.id }],
  });
  expect(definition.status).toBe(201);
  await as(hrAdmin, 'post', `/api/v1/workflow/definitions/${definition.body.data.id}/activate`);
  const policy = await as(hrAdmin, 'put', '/api/v1/employee-relations/policies').send({
    organizationId: org.id, name: 'Standard', workflowDefinitionCode: 'ER_STD', defaultAcknowledgementDueDays: 7, effectiveFrom: '2020-01-01',
  });
  expect(policy.status).toBe(200);
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe('the pure rules', () => {
  it('validity is derived from the date, not from a job', () => {
    expect(validityState('ISSUED', null, '2026-06-01')).toBe('ACTIVE');
    expect(validityState('ACKNOWLEDGED', '2026-06-01', '2026-06-01')).toBe('ACTIVE');
    expect(validityState('ISSUED', '2026-05-31', '2026-06-01')).toBe('EXPIRED');
    expect(validityState('DRAFT', null, '2026-06-01')).toBe('NOT_APPLICABLE');
  });

  it('templates fill allow-listed placeholders only, and never run anything', () => {
    expect(renderLetterTemplate('Dear {{employeeName}} ({{employeeCode}}), re {{incidentDate}}. {{notAllowed}} {{ constructor }}', { employeeName: 'A Person', employeeCode: 'E1', incidentDate: '2026-05-01' }))
      .toBe('Dear A Person (E1), re 2026-05-01. {{notAllowed}} {{ constructor }}');
    expect(renderLetterTemplate('until {{validUntil}}', {})).toBe('until {{validUntil}}'); // not known yet: left for later
    expect(renderLetterTemplate('until {{validUntil}}', { validUntil: null })).toBe('until —'); // known to be open-ended
    expect(toPlainText('<script>alert(1)</script>Warning <b>text</b>')).toBe('alert(1)Warning text');
    expect(formatCaseNumber(2026, 7)).toBe('ER-2026-000007');
  });
});

// ---------------------------------------------------------------------------
describe('configuration', () => {
  it('action types are the customer\'s, with no built-in ladder', async () => {
    const written = await as(hrAdmin, 'post', '/api/v1/employee-relations/action-types').send({
      code: 'WRITTEN_WARNING', name: 'Written warning', severityOrder: 2, requiresWarningLetter: true, requiresAcknowledgement: true, defaultValidityDays: 180,
    });
    expect(written.status).toBe(201);
    writtenWarningId = written.body.data.id;
    const verbal = await as(hrAdmin, 'post', '/api/v1/employee-relations/action-types').send({
      code: 'VERBAL_WARNING', name: 'Verbal warning', severityOrder: 1, requiresWarningLetter: false, requiresAcknowledgement: false,
    });
    verbalId = verbal.body.data.id;
    expect(err(await as(hrAdmin, 'post', '/api/v1/employee-relations/action-types').send({ code: 'WRITTEN_WARNING', name: 'Dup' }))).toBe('409 ACTION_TYPE_CODE_TAKEN');
    expect(err(await as(hr, 'post', '/api/v1/employee-relations/action-types').send({ code: 'X', name: 'x' }))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', '/api/v1/employee-relations/action-types'))).toBe('403 FORBIDDEN');
    await as(hrAdmin, 'post', '/api/v1/employee-relations/categories').send({ code: 'CONDUCT', name: 'Conduct' });
    const template = await as(hrAdmin, 'put', '/api/v1/employee-relations/letter-templates').send({
      code: 'STD', name: 'Standard', subjectTemplate: '{{actionName}} — {{employeeName}}',
      bodyTemplate: 'Dear {{employeeName}},\n\nThis letter concerns the incident of {{incidentDate}} while you were {{position}} in {{department}}.\n\nThis {{actionName}} remains on record until {{validUntil}}.',
    });
    expect(template.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('a case, from draft to issued', () => {
  it('opens with the employee\'s organization frozen and a unique number, and the narrative stays out of the audit log', async () => {
    const category = (await as(hrAdmin, 'get', '/api/v1/employee-relations/categories')).body.data[0];
    const created = await as(hrAdmin, 'post', '/api/v1/employee-relations/cases').send({
      employeeId: emp.EMP003, incidentDate: '2026-05-10', categoryId: category.id, title: 'Repeated late submission of client reports',
      description: 'On 10 May the weekly client report was submitted two days late for the third consecutive week. <script>alert(1)</script>',
      internalNotes: 'Spoke to the team lead on 11 May; pattern confirmed.',
    });
    expect(created.status).toBe(201);
    caseId = created.body.data.id;
    expect(created.body.data.caseNumber).toMatch(/^ER-\d{4}-\d{6}$/);
    expect(created.body.data.snapshot.departmentName).toBe('Sales');
    expect(created.body.data.snapshot.positionTitle).toBe('Sales Executive');
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.description).not.toMatch(/<script>/);
    expect(created.body.data.internalNotes).toMatch(/team lead/);

    const audit = await prisma.auditLog.findFirst({ where: { module: 'employee_relations', action: 'CREATE_EMPLOYEE_RELATION_CASE' } });
    const payload = JSON.stringify(audit?.newValue);
    expect(payload).not.toMatch(/two days late|team lead/);
    expect(payload).toMatch(/descriptionLength/);
  });

  it('two cases opened at once get two numbers', async () => {
    const pair = await Promise.all([
      as(hrAdmin, 'post', '/api/v1/employee-relations/cases').send({ employeeId: emp.EMP004, incidentDate: '2026-05-11', title: 'A', description: 'a' }),
      as(hrAdmin, 'post', '/api/v1/employee-relations/cases').send({ employeeId: emp.EMP004, incidentDate: '2026-05-11', title: 'B', description: 'b' }),
    ]);
    expect(pair.every((r) => r.status === 201)).toBe(true);
    expect(pair[0].body.data.caseNumber).not.toBe(pair[1].body.data.caseNumber);
    for (const r of pair) await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${r.body.data.id}/cancel`);
  }, 60000);

  it('a proposal is drafted from a template, editable, and needs its letter before it can be submitted', async () => {
    const template = (await as(hrAdmin, 'get', '/api/v1/employee-relations/letter-templates')).body.data[0];
    const proposed = await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${caseId}/actions`).send({
      actionTypeId: writtenWarningId, reason: 'Third consecutive late report after a verbal reminder', letterTemplateId: template.id,
    });
    expect(proposed.status).toBe(201);
    const action = proposed.body.data.actions[0];
    actionId = action.id;
    expect(action.status).toBe('DRAFT');
    expect(action.validityDays).toBe(180); // the type's default, not a number in the code
    expect(action.letterBody).toMatch(/Dear EMP003 Person/);
    expect(action.letterBody).toMatch(/Sales Executive in Sales/);
    expect(proposed.body.data.status).toBe('UNDER_REVIEW');
    expect(proposed.body.data.priorActiveActions).toEqual([]);

    // HR may override the validity before submitting; a second proposal on the same case is refused.
    const edited = await as(hrAdmin, 'patch', `/api/v1/employee-relations/actions/${actionId}`).send({ validityDays: 120 });
    expect(edited.body.data.actions[0].validityDays).toBe(120);
    expect(err(await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${caseId}/actions`).send({ actionTypeId: verbalId, reason: 'x' }))).toBe('409 DISCIPLINARY_ACTION_EXISTS');

    // A type that requires a letter cannot go to the approver without one.
    await as(hrAdmin, 'patch', `/api/v1/employee-relations/actions/${actionId}`).send({ letterBody: null });
    expect(err(await as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${actionId}/submit`))).toBe('422 WARNING_LETTER_REQUIRED');
    await as(hrAdmin, 'patch', `/api/v1/employee-relations/actions/${actionId}`).send({ letterBody: action.letterBody });
    expect(err(await as(hr, 'post', `/api/v1/employee-relations/actions/${actionId}/submit`))).toBe('403 FORBIDDEN');
  });

  it('submitting freezes the facts; the wrong approver is refused; a double submit yields one workflow', async () => {
    const race = await Promise.all([
      as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${actionId}/submit`),
      as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${actionId}/submit`),
    ]);
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    const pending = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data;
    expect(pending.status).toBe('PENDING_APPROVAL');
    const instanceId = pending.actions[0].workflowInstanceId;
    expect(instanceId).toBeTruthy();
    expect(await prisma.workflowInstance.count({ where: { entityId: actionId } })).toBe(1);

    expect(err(await as(hrAdmin, 'patch', `/api/v1/employee-relations/actions/${actionId}`).send({ validityDays: 30 }))).toBe('409 DISCIPLINARY_ACTION_FROZEN');
    expect(err(await as(hrAdmin, 'patch', `/api/v1/employee-relations/cases/${caseId}`).send({ description: 'rewritten' }))).toBe('409 ER_CASE_FROZEN');

    // The approver sees a projection: the proposal and the case summary, and no internal notes.
    const projection = await as(approver, 'get', `/api/v1/employee-relations/actions/${actionId}/approval`);
    expect(projection.status).toBe(200);
    expect(projection.body.data.caseSummary.description).toMatch(/two days late/);
    expect(JSON.stringify(projection.body.data)).not.toMatch(/team lead/);
    expect(err(await as(mgr, 'get', `/api/v1/employee-relations/actions/${actionId}/approval`))).toBe('403 FORBIDDEN');

    // Only the snapshot approver may decide.
    expect((await as(hrAdmin, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' })).status).not.toBe(200);
    expect((await as(mgr, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' })).status).not.toBe(200);
  }, 60000);

  it('final approval issues the action and freezes the letter; a second approval changes nothing', async () => {
    const instanceId = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data.actions[0].workflowInstanceId;
    const decisions = await Promise.all([
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE', comment: 'Proportionate' }),
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE', comment: 'Proportionate' }),
    ]);
    expect(decisions.filter((r) => r.status === 200)).toHaveLength(1);

    const issued = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data;
    expect(issued.status).toBe('ACTION_ISSUED');
    const action = issued.actions[0];
    expect(action.status).toBe('ISSUED');
    expect(action.validity).toBe('ACTIVE');
    const today = businessToday('UTC');
    expect(action.issuedDate).toBe(today);
    expect(action.validUntil).toBe(addDays(today, 120)); // the overridden validity, frozen
    expect(action.acknowledgementDueDate).toBe(addDays(today, 7)); // the policy's default
    expect(action.letter).toBeTruthy();
    expect(action.letter.letterNumber).toMatch(/^WL-/);
    expect(action.letter.body).toMatch(new RegExp(`remains on record until ${addDays(today, 120)}`));
    expect(action.letter.acknowledgementText).toBe(ACKNOWLEDGEMENT_STATEMENT);
    expect(await prisma.warningLetter.count({ where: { disciplinaryActionId: actionId } })).toBe(1);

    // After issue nothing on the proposal moves, and the timeline tells the story.
    expect(err(await as(hrAdmin, 'patch', `/api/v1/employee-relations/actions/${actionId}`).send({ letterBody: 'edited' }))).toBe('409 DISCIPLINARY_ACTION_FROZEN');
    expect(err(await as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${actionId}/cancel`))).toBe('409 DISCIPLINARY_ACTION_NOT_DRAFT');
    expect(issued.timeline.map((t: { kind: string }) => t.kind)).toEqual(expect.arrayContaining(['CREATED', 'SUBMITTED', 'APPROVED', 'ISSUED']));

    // The employee is told a document exists — and nothing about it.
    const notice = await prisma.notification.findFirst({ where: { type: 'DISCIPLINARY_ACTION_ISSUED' } });
    expect(notice).toBeTruthy();
    expect(`${notice!.title} ${notice!.body}`).not.toMatch(/late|warning|written|report/i);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('acknowledgement', () => {
  it('the employee sees only what was issued to them, acknowledges receipt once, and the record says what that means', async () => {
    const mine = await as(emp1, 'get', '/api/v1/employee-relations/my/records');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].letter.body).toMatch(/Dear EMP003 Person/);
    expect(JSON.stringify(mine.body.data)).not.toMatch(/team lead|Third consecutive/); // no internal notes, no proposal reason
    expect(mine.body.data[0].letter.acknowledgementText).toMatch(/does not mean that I agree/);

    // Nobody else can see it, and nothing the employee sends can change whose record is acknowledged.
    expect(err(await as(emp2, 'get', `/api/v1/employee-relations/my/records/${actionId}`))).toBe('404 DISCIPLINARY_ACTION_NOT_FOUND');
    expect(err(await as(emp2, 'post', `/api/v1/employee-relations/my/records/${actionId}/acknowledge`))).toBe('404 DISCIPLINARY_ACTION_NOT_FOUND');
    expect(err(await as(exec, 'get', '/api/v1/employee-relations/my/records'))).toBe('403 FORBIDDEN');

    const race = await Promise.all([
      as(emp1, 'post', `/api/v1/employee-relations/my/records/${actionId}/acknowledge`),
      as(emp1, 'post', `/api/v1/employee-relations/my/records/${actionId}/acknowledge`),
    ]);
    expect(race.every((r) => r.status === 200)).toBe(true);
    expect(race[0].body.data.acknowledgedAt).toBe(race[1].body.data.acknowledgedAt); // idempotent, timestamp stable
    expect(await prisma.disciplinaryAcknowledgement.count({ where: { actionId } })).toBe(1);
    const ack = await prisma.disciplinaryAcknowledgement.findUniqueOrThrow({ where: { actionId } });
    expect(ack.employeeId).toBe(emp.EMP003);
    expect(ack.acknowledgementTextSnapshot).toBe(ACKNOWLEDGEMENT_STATEMENT);

    const after = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data;
    expect(after.actions[0].status).toBe('ACKNOWLEDGED');
    expect(after.actions[0].acknowledgedAt).toBe(race[0].body.data.acknowledgedAt);
    expect(after.timeline.some((t: { kind: string }) => t.kind === 'ACKNOWLEDGED')).toBe(true);
  }, 60000);

  it('a draft cannot be acknowledged, and a type without a letter needs no acknowledgement', async () => {
    const other = await as(hrAdmin, 'post', '/api/v1/employee-relations/cases').send({ employeeId: emp.EMP004, incidentDate: '2026-05-12', title: 'Verbal', description: 'Late twice.' });
    const draft = (await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${other.body.data.id}/actions`).send({ actionTypeId: verbalId, reason: 'Reminder' })).body.data.actions[0];
    expect(err(await as(emp2, 'post', `/api/v1/employee-relations/my/records/${draft.id}/acknowledge`))).toBe('404 DISCIPLINARY_ACTION_NOT_FOUND');
    expect((await as(emp2, 'get', '/api/v1/employee-relations/my/records')).body.data).toHaveLength(0); // a draft is invisible to its subject
    await as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${draft.id}/submit`);
    const instanceId = (await prisma.disciplinaryAction.findUniqueOrThrow({ where: { id: draft.id } })).workflowInstanceId!;
    await as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' });
    const issued = (await as(emp2, 'get', '/api/v1/employee-relations/my/records')).body.data[0];
    expect(issued.letter).toBeNull();
    expect(issued.requiresAcknowledgement).toBe(false);
    expect(err(await as(emp2, 'post', `/api/v1/employee-relations/my/records/${draft.id}/acknowledge`))).toBe('409 ACKNOWLEDGEMENT_NOT_REQUIRED');
    await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${other.body.data.id}/close`);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('rejection and withdrawal', () => {
  it('a rejected proposal is terminal; the case goes back to review and HR drafts a new one', async () => {
    const created = await as(hrAdmin, 'post', '/api/v1/employee-relations/cases').send({ employeeId: emp.EMP004, incidentDate: '2026-06-01', title: 'Conduct', description: 'Raised voice in a client meeting.' });
    const id = created.body.data.id;
    const template = (await as(hrAdmin, 'get', '/api/v1/employee-relations/letter-templates')).body.data[0];
    const proposal = (await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${id}/actions`).send({ actionTypeId: writtenWarningId, reason: 'Conduct', letterTemplateId: template.id })).body.data.actions[0];
    // A person deciding is shown what already stands against the employee — and nothing recommends anything.
    const detail = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${id}`)).body.data;
    expect(detail.priorActiveActions).toHaveLength(1); // the verbal warning issued above
    expect(JSON.stringify(detail)).not.toMatch(/recommend|escalat/i);

    await as(hrAdmin, 'post', `/api/v1/employee-relations/actions/${proposal.id}/submit`);
    const instanceId = (await prisma.disciplinaryAction.findUniqueOrThrow({ where: { id: proposal.id } })).workflowInstanceId!;
    const rejected = await as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'REJECT', comment: 'Talk to them first' });
    expect(rejected.status).toBe(200);
    const after = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${id}`)).body.data;
    expect(after.status).toBe('UNDER_REVIEW');
    expect(after.actions[0].status).toBe('REJECTED');
    expect(after.currentAction).toBeNull();
    expect(await prisma.warningLetter.count({ where: { disciplinaryActionId: proposal.id } })).toBe(0); // nothing was issued
    expect((await as(emp2, 'get', '/api/v1/employee-relations/my/records')).body.data.some((r: { caseNumber: string }) => r.caseNumber === after.caseNumber)).toBe(false);

    // HR can propose again on the same case.
    const again = await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${id}/actions`).send({ actionTypeId: verbalId, reason: 'A conversation instead' });
    expect(again.status).toBe(201);
    await as(hrAdmin, 'post', `/api/v1/employee-relations/cases/${id}/cancel`).catch(() => undefined);
  }, 60000);
});

// ---------------------------------------------------------------------------
describe('history does not move', () => {
  it('a transfer, a renamed action type and a changed template leave the issued warning alone', async () => {
    const before = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data;
    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { departmentId: otherDeptId } });
    await as(hrAdmin, 'patch', `/api/v1/employee-relations/action-types/${writtenWarningId}`).send({ name: 'Formal written warning (renamed)', defaultValidityDays: 365 });
    await as(hrAdmin, 'put', '/api/v1/employee-relations/letter-templates').send({ code: 'STD', name: 'Standard', subjectTemplate: 'changed', bodyTemplate: 'changed' });

    const after = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data;
    expect(after.snapshot.departmentName).toBe('Sales');
    expect(after.actions[0].actionType.name).toBe('Written warning');
    expect(after.actions[0].validUntil).toBe(before.actions[0].validUntil);
    expect(after.actions[0].letter.body).toBe(before.actions[0].letter.body);
    expect(after.actions[0].letter.department).toBe('Sales');
    const mine = (await as(emp1, 'get', '/api/v1/employee-relations/my/records')).body.data[0];
    expect(mine.actionTypeName).toBe('Written warning');

    await prisma.employee.update({ where: { id: emp.EMP003 }, data: { departmentId: deptId } });
    await as(hrAdmin, 'patch', `/api/v1/employee-relations/action-types/${writtenWarningId}`).send({ name: 'Written warning', defaultValidityDays: 180 });
  });

  it('expiry is a matter of date', async () => {
    await prisma.disciplinaryAction.update({ where: { id: actionId }, data: { validUntil: '2020-01-01' } });
    const expired = (await as(hrAdmin, 'get', `/api/v1/employee-relations/actions?validity=EXPIRED`)).body.data;
    expect(expired.some((a: { id: string }) => a.id === actionId)).toBe(true);
    const active = (await as(hrAdmin, 'get', `/api/v1/employee-relations/actions?validity=ACTIVE`)).body.data;
    expect(active.some((a: { id: string }) => a.id === actionId)).toBe(false);
    expect((await as(emp1, 'get', '/api/v1/employee-relations/my/records')).body.data[0].validity).toBe('EXPIRED');
    const restored = (await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`)).body.data.actions[0];
    expect(restored.status).toBe('ACKNOWLEDGED'); // the stored status is untouched; expiry is derived
    await prisma.disciplinaryAction.update({ where: { id: actionId }, data: { validUntil: addDays(businessToday('UTC'), 120) } });
  });
});

// ---------------------------------------------------------------------------
describe('who may see what', () => {
  it('a manager does not see a report\'s case because they manage them; HR reads; HR admin manages', async () => {
    expect(err(await as(mgr, 'get', '/api/v1/employee-relations/cases'))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `/api/v1/employee-relations/cases/${caseId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `/api/v1/employee-relations/summary/${emp.EMP003}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `/api/v1/employee-relations/cases/${caseId}`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', '/api/v1/employee-relations/reports/overview'))).toBe('403 FORBIDDEN');
    expect(err(await as(emp1, 'get', `/api/v1/employee-relations/cases/${caseId}`))).toBe('403 FORBIDDEN');

    const asHr = await as(hr, 'get', `/api/v1/employee-relations/cases/${caseId}`);
    expect(asHr.status).toBe(200);
    expect('internalNotes' in asHr.body.data).toBe(false); // view, not manage: no internal notes
    expect(err(await as(hr, 'post', '/api/v1/employee-relations/cases').send({ employeeId: emp.EMP003, incidentDate: '2026-07-01', title: 'x', description: 'x' }))).toBe('403 FORBIDDEN');
    const asAdmin = await as(hrAdmin, 'get', `/api/v1/employee-relations/cases/${caseId}`);
    expect(asAdmin.body.data.internalNotes).toMatch(/team lead/);
  });

  it('the Employee 360 hand-off counts and never narrates', async () => {
    const summary = await erCaseService.summaryFor(emp.EMP003);
    expect(summary).toMatchObject({ employeeId: emp.EMP003, totalIssued: 1, activeWarnings: 1, awaitingAcknowledgement: 0 });
    expect(summary.latestActionDate).toBeTruthy();
    expect(JSON.stringify(summary)).not.toMatch(/two days late|team lead|Dear EMP003|Written warning/);
    const viaApi = await as(hr, 'get', `/api/v1/employee-relations/summary/${emp.EMP003}`);
    expect(viaApi.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('privacy, logging and reporting', () => {
  it('the personal-data export carries the issued letter and acknowledgement, and nothing HR wrote for itself', async () => {
    const exported = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${emp.EMP003}/export`);
    expect(exported.status).toBe(200);
    const payload = exported.body && Object.keys(exported.body).length ? exported.body : JSON.parse(exported.text);
    const dto = 'formatVersion' in payload ? payload : payload.data; // the route streams the DTO itself as an attachment
    const er = dto.data.employeeRelations;
    expect(er).toHaveLength(1);
    expect(er[0].letter.bodySnapshot).toMatch(/Dear EMP003 Person/);
    expect(er[0].acknowledgement.acknowledgementTextSnapshot).toBe(ACKNOWLEDGEMENT_STATEMENT);
    const text = JSON.stringify(dto.data);
    expect(text).not.toMatch(/team lead|Third consecutive late report/); // internal notes and the proposal's reason
    expect(text).not.toMatch(/approver@erc\.local/);
    expect(dto.notIncluded.some((n: { category: string }) => /employee relations/i.test(n.category))).toBe(true);
    expect(text).not.toMatch(/passwordHash|csrf|hr_session/);
  });

  it('audit entries and notifications carry counts and numbers, never the narrative', async () => {
    const audits = await prisma.auditLog.findMany({ where: { module: 'employee_relations' }, select: { action: true, newValue: true, oldValue: true, userId: true } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining([
      'CREATE_EMPLOYEE_RELATION_CASE', 'CREATE_DISCIPLINARY_ACTION', 'UPDATE_DISCIPLINARY_ACTION', 'SUBMIT_DISCIPLINARY_ACTION',
      'APPROVE_DISCIPLINARY_ACTION', 'ISSUE_WARNING_LETTER', 'ISSUE_DISCIPLINARY_ACTION', 'ACKNOWLEDGE_DISCIPLINARY_ACTION',
      'REJECT_DISCIPLINARY_ACTION', 'CLOSE_EMPLOYEE_RELATION_CASE',
    ]));
    const payloads = JSON.stringify(audits);
    expect(payloads).not.toMatch(/two days late|team lead|Dear EMP003|Raised voice/);
    expect(payloads).toMatch(/letterBodyChanged|descriptionLength/);
    expect(audits.every((a) => !!a.userId)).toBe(true);
    const notifications = await prisma.notification.findMany({ where: { sourceModule: 'employee_relations' } });
    for (const n of notifications) expect(`${n.title} ${n.body}`).not.toMatch(/late|conduct|warning letter|Dear/i);
  });

  it('the report is aggregate, and ranks nobody', async () => {
    const report = (await as(hr, 'get', '/api/v1/employee-relations/reports/overview')).body.data;
    expect(report.actions.issued).toBe(2);
    expect(report.actions.active).toBe(2);
    expect(report.byActionType.map((t: { actionTypeName: string }) => t.actionTypeName).sort()).toEqual(['Verbal warning', 'Written warning']);
    expect(report.byDepartment.find((d: { departmentName: string }) => d.departmentName === 'Sales').issued).toBe(2);
    expect(report.byMonth.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/EMP003|EMP004|Person/);
  });
});
