/**
 * Task 27 — Recruitment / ATS MVP.
 *
 * What these tests guard: that a candidate is seen only by the people hiring them, that every stage move is a
 * person's explicit act, that a salary figure reaches only `recruitment.manage_offers` and the approver, that two
 * simultaneous hires of one person produce one employee, and that a hire never quietly creates a login or a payroll
 * record.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { averageTimeToHireDays, formatRecruitmentNumber, normalizeEmail, normalizePhone, stageMoveCheck } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const R = '/api/v1/recruitment';

let hrAdmin: Session, approver: Session, hr: Session, hm: Session, otherMgr: Session, interviewer: Session, emp: Session, exec: Session;
let orgId: string, deptId: string, jobId: string, positionId: string;
const employees: Record<string, string> = {};
let requisitionId: string, openingId: string, candidateId: string, applicationId: string, interviewId: string, offerId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'RCR', name: 'Recruit Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const dept = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  deptId = dept.id;
  const job = await prisma.job.create({ data: { code: 'SWE', title: 'Software Engineer', level: 2 } });
  jobId = job.id;
  const position = await prisma.position.create({ data: { departmentId: dept.id, code: 'SWE1', title: 'Software Engineer I', jobId: job.id } });
  positionId = position.id;
  const mk = async (code: string) =>
    (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@rcr.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept.id, positionId: position.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  for (const code of ['HRADM', 'APPROVER', 'HRX', 'HM', 'OTHERMGR', 'INTERVIEWER', 'EMP']) employees[code] = await mk(code);

  await createUser({ email: 'hradmin@rcr.local', password: PW, role: 'HR_ADMIN', employeeId: employees.HRADM });
  await createUser({ email: 'approver@rcr.local', password: PW, role: 'HR_ADMIN', employeeId: employees.APPROVER });
  await createUser({ email: 'hr@rcr.local', password: PW, role: 'HR', employeeId: employees.HRX });
  await createUser({ email: 'hm@rcr.local', password: PW, role: 'MANAGER', employeeId: employees.HM });
  await createUser({ email: 'othermgr@rcr.local', password: PW, role: 'MANAGER', employeeId: employees.OTHERMGR });
  await createUser({ email: 'interviewer@rcr.local', password: PW, role: 'MANAGER', employeeId: employees.INTERVIEWER });
  await createUser({ email: 'emp@rcr.local', password: PW, role: 'EMPLOYEE', employeeId: employees.EMP });
  await createUser({ email: 'exec@rcr.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, approver, hr, hm, otherMgr, interviewer, emp, exec] = await Promise.all(
    ['hradmin', 'approver', 'hr', 'hm', 'othermgr', 'interviewer', 'emp', 'exec'].map((u) => loginAs(app, `${u}@rcr.local`, PW)),
  );

  for (const [code, entityType] of [['REQ_STD', 'RECRUITMENT_REQUISITION'], ['OFR_STD', 'JOB_OFFER']]) {
    const def = await as(hrAdmin, 'post', '/api/v1/workflow/definitions').send({
      code, name: code, module: 'recruitment', entityType, steps: [{ name: 'Approver', approverType: 'SPECIFIC_USER', approverUserId: approver.user.id }],
    });
    expect(def.status).toBe(201);
    await as(hrAdmin, 'post', `/api/v1/workflow/definitions/${def.body.data.id}/activate`);
  }
  const policy = await as(hrAdmin, 'put', `${R}/policies`).send({ organizationId: org.id, requisitionWorkflowCode: 'REQ_STD', offerWorkflowCode: 'OFR_STD' });
  expect(err(policy)).toBe('200');
}, 180000);

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('pure rules', () => {
  it('formats numbers and normalizes contact details for exact duplicate detection', () => {
    expect(formatRecruitmentNumber('candidate', 2026, 7)).toBe('CND-2026-000007');
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    expect(normalizePhone('+66 (0)81-234 5678')).toBe('+660812345678');
    expect(normalizePhone('081 234 5678')).toBe('0812345678');
    expect(normalizePhone('   ')).toBeNull();
  });
  it('allows forward moves, needs a reason to move back, and never reaches a terminal stage by moving', () => {
    expect(stageMoveCheck('APPLIED', 'SCREENING', null)).toEqual({ ok: true, backwards: false });
    expect(stageMoveCheck('INTERVIEW', 'SCREENING', null)).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(stageMoveCheck('INTERVIEW', 'SCREENING', 'Panel unavailable')).toEqual({ ok: true, backwards: true });
    expect(stageMoveCheck('OFFER', 'HIRED', 'x')).toMatchObject({ ok: false, code: 'INVALID_STAGE' });
    expect(stageMoveCheck('REJECTED', 'SCREENING', 'x')).toMatchObject({ ok: false, code: 'APPLICATION_CLOSED' });
    expect(stageMoveCheck('SCREENING', 'SCREENING', null)).toMatchObject({ ok: false, code: 'SAME_STAGE' });
  });
  it('averages time to hire and returns null for no hires', () => {
    expect(averageTimeToHireDays([])).toBeNull();
    expect(averageTimeToHireDays([{ appliedAt: '2026-01-01', hiredAt: new Date('2026-01-11T09:00:00Z') }, { appliedAt: '2026-01-01', hiredAt: new Date('2026-01-16T00:00:00Z') }])).toBe(12.5);
  });
});

describe('requisitions and openings', () => {
  it('creates a requisition, numbers it, and only HR-side roles may', async () => {
    const body = { organizationId: orgId, departmentId: deptId, jobId, positionId, hiringManagerEmployeeId: employees.HM, requestedOpenings: 2, reason: 'NEW_HEADCOUNT', justification: 'Team growth' };
    expect(err(await as(hm, 'post', `${R}/requisitions`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'post', `${R}/requisitions`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${R}/requisitions`))).toBe('403 FORBIDDEN');
    const created = await as(hr, 'post', `${R}/requisitions`).send(body);
    expect(err(created)).toBe('201');
    requisitionId = created.body.data.id;
    expect(created.body.data.requisitionNumber).toMatch(/^REQ-\d{4}-000001$/);
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.hiringManager.userId).toBe(hm.user.id);
  });

  it('cannot open a vacancy from an unapproved requisition', async () => {
    expect(err(await as(hr, 'post', `${R}/openings`).send({ requisitionId, openingsCount: 1 }))).toBe('409 REQUISITION_NOT_APPROVED');
  });

  it('submits once under concurrency; the approver sees it in the inbox and approves it once', async () => {
    const pair = await Promise.all([as(hr, 'post', `${R}/requisitions/${requisitionId}/submit`), as(hr, 'post', `${R}/requisitions/${requisitionId}/submit`)]);
    expect(pair.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.workflowInstance.count({ where: { entityId: requisitionId } }))).toBe(1);
    const detail = await as(hr, 'get', `${R}/requisitions/${requisitionId}`);
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');
    expect(detail.body.data.snapshot.departmentName).toBe('Engineering');
    expect(err(await as(hr, 'patch', `${R}/requisitions/${requisitionId}`).send({ requestedOpenings: 5 }))).toBe('409 REQUISITION_NOT_DRAFT');

    const inbox = await as(approver, 'get', '/api/v1/workflow/inbox?module=recruitment');
    expect(inbox.body.data.some((i: { entityId: string }) => i.entityId === requisitionId)).toBe(true);
    const instanceId = detail.body.data.workflowInstanceId;
    const decisions = await Promise.all([
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' }),
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' }),
    ]);
    expect(decisions.filter((d) => d.status === 200).length).toBe(1);
    expect((await as(hr, 'get', `${R}/requisitions/${requisitionId}`)).body.data.status).toBe('APPROVED');
  });

  it('rejection is terminal for a requisition', async () => {
    const other = await as(hr, 'post', `${R}/requisitions`).send({ organizationId: orgId, jobId, requestedOpenings: 1, reason: 'REPLACEMENT' });
    await as(hr, 'post', `${R}/requisitions/${other.body.data.id}/submit`);
    const instanceId = (await as(hr, 'get', `${R}/requisitions/${other.body.data.id}`)).body.data.workflowInstanceId;
    expect(err(await as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'REJECT', comment: 'Not now' }))).toBe('200');
    expect((await as(hr, 'get', `${R}/requisitions/${other.body.data.id}`)).body.data.status).toBe('REJECTED');
    expect(err(await as(hr, 'post', `${R}/requisitions/${other.body.data.id}/submit`))).toBe('409 REQUISITION_NOT_DRAFT');
  });

  it('openings stay within approved headcount, open explicitly, and publish nothing', async () => {
    expect(err(await as(hr, 'post', `${R}/openings`).send({ requisitionId, openingsCount: 3 }))).toBe('422 REQUISITION_HEADCOUNT_EXCEEDED');
    const created = await as(hr, 'post', `${R}/openings`).send({ requisitionId, openingsCount: 1, description: 'Build things' });
    expect(err(created)).toBe('201');
    openingId = created.body.data.id;
    expect(created.body.data.status).toBe('DRAFT');
    expect(created.body.data.snapshot.title).toBe('Software Engineer I');
    expect(created.body.data.hiringManager.userId).toBe(hm.user.id);
    expect(err(await as(hr, 'post', `${R}/openings`).send({ requisitionId, openingsCount: 2 }))).toBe('422 REQUISITION_HEADCOUNT_EXCEEDED');
    const opened = await as(hr, 'post', `${R}/openings/${openingId}/open`);
    expect(opened.body.data.status).toBe('OPEN');
    expect(opened.body.data.openedAt).toBeTruthy();
  });

  it('a hiring manager sees their own requisition and opening; another manager and an executive see nothing', async () => {
    expect((await as(hm, 'get', `${R}/requisitions`)).body.data.map((r: { id: string }) => r.id)).toEqual([requisitionId]);
    expect((await as(otherMgr, 'get', `${R}/requisitions`)).body.data).toEqual([]);
    expect(err(await as(otherMgr, 'get', `${R}/openings/${openingId}`))).toBe('404 OPENING_NOT_FOUND');
    expect(err(await as(exec, 'get', `${R}/openings`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${R}/dashboard`))).toBe('403 FORBIDDEN');
  });
});

describe('candidates and applications', () => {
  it('creates a candidate with no protected fields, warns on duplicates, never deletes', async () => {
    const created = await as(hr, 'post', `${R}/candidates`).send({ firstName: 'Jane', lastName: 'Doe', email: 'Jane.Doe@Example.com', phone: '+66 81 234 5678', source: 'REFERRAL', summary: 'Strong backend' });
    expect(err(created)).toBe('201');
    candidateId = created.body.data.id;
    expect(created.body.data.candidateNumber).toMatch(/^CND-/);
    expect(created.body.data.email).toBe('jane.doe@example.com');
    expect(Object.keys(created.body.data)).not.toEqual(expect.arrayContaining(['nationalId', 'birthDate', 'religion']));
    expect(err(await as(hr, 'post', `${R}/candidates`).send({ firstName: 'J', lastName: 'D', nationalId: '1234567890123' }))).toBe('400 VALIDATION_ERROR');

    const dup = await as(hr, 'post', `${R}/candidates`).send({ firstName: 'Janet', lastName: 'Doe', phone: '+66-812-345-678' });
    expect(err(dup)).toBe('409 CANDIDATE_POSSIBLE_DUPLICATE');
    expect(dup.body.error.details[0].field).toBe('phone');
    const check = await as(hr, 'get', `${R}/candidates/duplicates?email=JANE.DOE@example.com`);
    expect(check.body.data[0]).toMatchObject({ id: candidateId, matchedOn: 'email' });
    const forced = await as(hr, 'post', `${R}/candidates`).send({ firstName: 'Janet', lastName: 'Doe', phone: '+66-812-345-678', allowDuplicate: true });
    expect(err(forced)).toBe('201');
    expect(forced.body.meta.duplicates.length).toBe(1);
    expect((await as(hr, 'delete', `${R}/candidates/${candidateId}`)).status).toBe(404);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CREATE_CANDIDATE', recordId: candidateId } });
    expect(JSON.stringify(audit?.newValue)).not.toMatch(/jane|doe|example\.com|2345/i);
  });

  it('creates an application with history, only against an OPEN opening, once per candidate+opening', async () => {
    const created = await as(hr, 'post', `${R}/applications`).send({ candidateId, openingId, appliedAt: '2026-09-01' });
    expect(err(created)).toBe('201');
    applicationId = created.body.data.id;
    expect(created.body.data.stage).toBe('APPLIED');
    expect(created.body.data.applicationNumber).toMatch(/^APP-/);
    expect(err(await as(hr, 'post', `${R}/applications`).send({ candidateId, openingId }))).toBe('409 APPLICATION_EXISTS');
    const detail = await as(hr, 'get', `${R}/applications/${applicationId}`);
    expect(detail.body.data.stageHistory).toHaveLength(1);
    expect(detail.body.data.stageHistory[0]).toMatchObject({ fromStage: null, toStage: 'APPLIED' });
  });

  it('moves stages explicitly; concurrent identical moves apply once; backwards needs a reason', async () => {
    const race = await Promise.all([
      as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'SCREENING' }),
      as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'SCREENING' }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.recruitmentApplicationStageHistory.count({ where: { applicationId } })).toBe(2);
    expect(err(await as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'HIRED' }))).toBe('400 VALIDATION_ERROR');
    const fwd = await as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'INTERVIEW' });
    expect(fwd.body.data.stage).toBe('INTERVIEW');
    expect(err(await as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'SCREENING' }))).toBe('422 REASON_REQUIRED');
    expect(err(await as(hm, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'OFFER' }))).toBe('403 FORBIDDEN');
  });

  it('the hiring manager sees the application; an unrelated manager gets 404; the candidate list is scoped the same way', async () => {
    expect(err(await as(hm, 'get', `${R}/applications/${applicationId}`))).toBe('200');
    expect(err(await as(otherMgr, 'get', `${R}/applications/${applicationId}`))).toBe('404 APPLICATION_NOT_FOUND');
    expect((await as(otherMgr, 'get', `${R}/candidates`)).body.data).toEqual([]);
    expect((await as(hm, 'get', `${R}/candidates`)).body.data.map((c: { id: string }) => c.id)).toEqual([candidateId]);
  });
});

describe('interviews and feedback', () => {
  it('schedules an interview with a panel, notifies interviewers, and grants them access to just that application', async () => {
    const created = await as(hr, 'post', `${R}/applications/${applicationId}/interviews`).send({
      title: 'Technical round', roundNumber: 1, scheduledStart: '2026-10-01T02:00:00.000Z', scheduledEnd: '2026-10-01T03:00:00.000Z', interviewerUserIds: [interviewer.user.id, hm.user.id],
    });
    expect(err(created)).toBe('201');
    interviewId = created.body.data.id;
    expect(created.body.data.timezone).toBe('Asia/Bangkok');
    expect(created.body.data.interviewers).toHaveLength(2);
    const note = await prisma.notification.findFirst({ where: { userId: interviewer.user.id, type: 'INTERVIEW_ASSIGNED' } });
    expect(note?.body).toContain('Software Engineer I');
    expect(note?.body).not.toMatch(/jane|doe/i);
    expect(err(await as(interviewer, 'get', `${R}/applications/${applicationId}`))).toBe('200');
    expect((await as(interviewer, 'get', `${R}/interviews?view=mine`)).body.data.map((i: { id: string }) => i.id)).toEqual([interviewId]);
    expect(err(await as(otherMgr, 'get', `${R}/interviews/${interviewId}`))).toBe('404 INTERVIEW_NOT_FOUND');
    expect(err(await as(hr, 'post', `${R}/applications/${applicationId}/interviews`).send({ title: 'x', scheduledStart: '2026-10-01T03:00:00.000Z', scheduledEnd: '2026-10-01T02:00:00.000Z', interviewerUserIds: [hm.user.id] }))).toBe('400 VALIDATION_ERROR');
  });

  it('feedback is submitted once by an assigned interviewer, seen by the panel member only for their own, and kept out of the audit log', async () => {
    const body = { recommendation: 'PROCEED', overallScore: 4, strengths: 'Clear thinking', concerns: 'Limited Go' };
    expect(err(await as(otherMgr, 'post', `${R}/interviews/${interviewId}/feedback`).send(body))).toBe('404 INTERVIEW_NOT_FOUND');
    expect(err(await as(emp, 'post', `${R}/interviews/${interviewId}/feedback`).send(body))).toBe('403 FORBIDDEN');
    const first = await as(interviewer, 'post', `${R}/interviews/${interviewId}/feedback`).send(body);
    expect(err(first)).toBe('201');
    expect(first.body.data.myFeedback.recommendation).toBe('PROCEED');
    expect(err(await as(interviewer, 'post', `${R}/interviews/${interviewId}/feedback`).send(body))).toBe('409 FEEDBACK_ALREADY_SUBMITTED');
    await as(hm, 'post', `${R}/interviews/${interviewId}/feedback`).send({ recommendation: 'HOLD', comments: 'Second round' });
    // The hiring manager sees both; the other interviewer sees only their own.
    expect((await as(hm, 'get', `${R}/interviews/${interviewId}`)).body.data.feedback).toHaveLength(2);
    expect((await as(interviewer, 'get', `${R}/interviews/${interviewId}`)).body.data.feedback).toHaveLength(1);
    const hrView = await as(hr, 'get', `${R}/interviews/${interviewId}`);
    expect(err(hrView)).toBe('200');
    expect(hrView.body.data.feedback).toHaveLength(2);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'SUBMIT_INTERVIEW_FEEDBACK', recordId: interviewId } });
    expect(JSON.stringify(audit?.newValue)).not.toMatch(/clear thinking|limited go|PROCEED/i);
    const marked = await as(hr, 'patch', `${R}/interviews/${interviewId}`).send({ status: 'COMPLETED' });
    expect(marked.body.data.status).toBe('COMPLETED');
    expect(err(await as(hr, 'patch', `${R}/interviews/${interviewId}`).send({ title: 'Renamed' }))).toBe('409 INTERVIEW_NOT_SCHEDULED');
  });
});

describe('offers', () => {
  it('an offer needs the OFFER stage and manage_offers; the salary is hidden from everyone else', async () => {
    const body = { applicationId, proposedStartDate: '2026-11-01', employmentType: 'FULL_TIME', positionId, baseSalaryProposal: '65000.00', currencyCode: 'THB', otherTermsText: 'Standard benefits' };
    expect(err(await as(hr, 'post', `${R}/offers`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${R}/offers`).send(body))).toBe('409 APPLICATION_NOT_AT_OFFER_STAGE');
    await as(hr, 'post', `${R}/applications/${applicationId}/move-stage`).send({ toStage: 'OFFER' });
    const created = await as(hrAdmin, 'post', `${R}/offers`).send(body);
    expect(err(created)).toBe('201');
    offerId = created.body.data.id;
    expect(created.body.data.baseSalaryProposal).toBe('65000.00');
    expect(created.body.data.compensationVisible).toBe(true);
    expect(err(await as(hrAdmin, 'post', `${R}/offers`).send(body))).toBe('409 OFFER_EXISTS');

    const asHm = await as(hm, 'get', `${R}/offers/${offerId}`);
    expect(err(asHm)).toBe('200');
    expect(asHm.body.data.baseSalaryProposal).toBeNull();
    expect(asHm.body.data.otherTermsText).toBeNull();
    expect(asHm.body.data.compensationVisible).toBe(false);
    const asHr = await as(hr, 'get', `${R}/offers/${offerId}`);
    expect(asHr.body.data.baseSalaryProposal).toBeNull();
    expect(err(await as(otherMgr, 'get', `${R}/offers/${offerId}`))).toBe('404 OFFER_NOT_FOUND');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CREATE_JOB_OFFER', recordId: offerId } });
    expect(JSON.stringify(audit?.newValue)).not.toContain('65000');
  });

  it('approval freezes the offer; the approver sees the figure; double approval applies once; mark-sent then outcome are HR records', async () => {
    expect(err(await as(hrAdmin, 'post', `${R}/offers/${offerId}/mark-sent`))).toBe('409 OFFER_NOT_APPROVED');
    expect(err(await as(hrAdmin, 'post', `${R}/offers/${offerId}/submit`))).toBe('200');
    const pending = await as(hrAdmin, 'get', `${R}/offers/${offerId}`);
    expect(pending.body.data.status).toBe('PENDING_APPROVAL');
    expect(err(await as(hrAdmin, 'patch', `${R}/offers/${offerId}`).send({ baseSalaryProposal: '70000' }))).toBe('409 OFFER_NOT_DRAFT');
    const seenByApprover = await as(approver, 'get', `${R}/offers/${offerId}`);
    expect(seenByApprover.body.data.baseSalaryProposal).toBe('65000.00');

    const instanceId = pending.body.data.workflowInstanceId;
    const decisions = await Promise.all([
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' }),
      as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' }),
    ]);
    expect(decisions.filter((d) => d.status === 200).length).toBe(1);
    expect((await as(hrAdmin, 'get', `${R}/offers/${offerId}`)).body.data.status).toBe('APPROVED');
    expect(err(await as(hrAdmin, 'patch', `${R}/offers/${offerId}`).send({ baseSalaryProposal: '70000' }))).toBe('409 OFFER_NOT_DRAFT');
    expect(err(await as(hrAdmin, 'post', `${R}/offers/${offerId}/record-accepted`))).toBe('409 OFFER_NOT_SENT');
    expect((await as(hrAdmin, 'post', `${R}/offers/${offerId}/mark-sent`)).body.data.status).toBe('SENT');
    expect(err(await as(hr, 'post', `${R}/offers/${offerId}/record-accepted`))).toBe('403 FORBIDDEN');
    const accepted = await as(hrAdmin, 'post', `${R}/offers/${offerId}/record-accepted`);
    expect(accepted.body.data.status).toBe('ACCEPTED');
    expect(accepted.body.data.outcomeRecordedBy).toBe(hrAdmin.user.id);
    // Accepting changes nothing about the application or the employee master.
    expect((await as(hr, 'get', `${R}/applications/${applicationId}`)).body.data.stage).toBe('OFFER');
    expect(await prisma.employee.count({ where: { firstName: 'Jane' } })).toBe(0);
  });

  it('a workflow-rejected offer returns to DRAFT for revision', async () => {
    const cand = await as(hr, 'post', `${R}/candidates`).send({ firstName: 'Rej', lastName: 'Offer', email: 'rej@example.com' });
    const app2 = await as(hr, 'post', `${R}/applications`).send({ candidateId: cand.body.data.id, openingId });
    await as(hr, 'post', `${R}/applications/${app2.body.data.id}/move-stage`).send({ toStage: 'OFFER' });
    const offer = await as(hrAdmin, 'post', `${R}/offers`).send({ applicationId: app2.body.data.id, proposedStartDate: '2026-11-01', baseSalaryProposal: '50000' });
    await as(hrAdmin, 'post', `${R}/offers/${offer.body.data.id}/submit`);
    const instanceId = (await as(hrAdmin, 'get', `${R}/offers/${offer.body.data.id}`)).body.data.workflowInstanceId;
    await as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'REJECT', comment: 'Too high' });
    const after = await as(hrAdmin, 'get', `${R}/offers/${offer.body.data.id}`);
    expect(after.body.data.status).toBe('DRAFT');
    expect(err(await as(hrAdmin, 'patch', `${R}/offers/${offer.body.data.id}`).send({ baseSalaryProposal: '48000' }))).toBe('200');
    await as(hrAdmin, 'post', `${R}/offers/${offer.body.data.id}/withdraw`);
    expect(err(await as(hr, 'post', `${R}/applications/${app2.body.data.id}/reject`).send({ reasonCode: 'COMPENSATION' }))).toBe('200');
  });
});

describe('hire', () => {
  it('needs recruitment.hire, an accepted offer, and a unique employee code; a failed employee creation rolls everything back', async () => {
    const body = { employeeCode: 'NEW001', hireDate: '2026-11-01', positionId, employmentType: 'FULL_TIME', email: 'jane.doe@rcr.local', managerId: employees.HM };
    expect(err(await as(hr, 'post', `${R}/applications/${applicationId}/hire`).send(body))).toBe('403 FORBIDDEN');
    expect(err(await as(hm, 'post', `${R}/applications/${applicationId}/hire`).send(body))).toBe('403 FORBIDDEN');
    // A code that already exists: createEmployeeWithTx refuses, and the application is untouched.
    const clash = await as(hrAdmin, 'post', `${R}/applications/${applicationId}/hire`).send({ ...body, employeeCode: 'HM' });
    expect(clash.status).toBe(409);
    const untouched = await as(hr, 'get', `${R}/applications/${applicationId}`);
    expect(untouched.body.data.stage).toBe('OFFER');
    expect(untouched.body.data.hiredEmployeeId).toBeNull();
    expect(await prisma.recruitmentApplicationStageHistory.count({ where: { applicationId, toStage: 'HIRED' } })).toBe(0);
  });

  it('two concurrent hires of one application produce exactly one employee, no user, no compensation', async () => {
    const body = { employeeCode: 'NEW001', hireDate: '2026-11-01', positionId, employmentType: 'FULL_TIME', email: 'jane.doe@rcr.local', managerId: employees.HM };
    const race = await Promise.all([as(hrAdmin, 'post', `${R}/applications/${applicationId}/hire`).send(body), as(hrAdmin, 'post', `${R}/applications/${applicationId}/hire`).send({ ...body, employeeCode: 'NEW002', email: 'jane2@rcr.local' })]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    const ok = race.find((r) => r.status === 201)!;
    expect(ok.body.data).toMatchObject({ applicationId, candidateId, userAccountCreated: false, payrollCompensationCreated: false });
    expect(await prisma.employee.count({ where: { firstName: 'Jane', lastName: 'Doe' } })).toBe(1);
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: ok.body.data.employeeId }, include: { user: true, positionHistory: true } });
    expect(employee.user).toBeNull();
    expect(employee.positionHistory).toHaveLength(1);
    expect(employee.phone).toBe('+66 81 234 5678');
    expect(await prisma.employeeCompensation.count({ where: { employeeId: employee.id } })).toBe(0);
    const detail = await as(hr, 'get', `${R}/applications/${applicationId}`);
    expect(detail.body.data.stage).toBe('HIRED');
    expect(detail.body.data.hiredEmployeeId).toBe(employee.id);
    expect(detail.body.data.stageHistory.at(-1)).toMatchObject({ toStage: 'HIRED' });
    expect((await as(hr, 'get', `${R}/candidates/${candidateId}`)).body.data).toMatchObject({ status: 'HIRED', hiredEmployeeId: employee.id });
    const note = await prisma.notification.findFirst({ where: { userId: hm.user.id, type: 'HIRING_COMPLETED' } });
    expect(note?.body).not.toMatch(/jane|doe|65000/i);
    expect(err(await as(hrAdmin, 'post', `${R}/applications/${applicationId}/hire`).send(body))).toBe('409 ALREADY_HIRED');
    expect(err(await as(hrAdmin, 'post', `${R}/offers/${offerId}/withdraw`))).toBe('409 APPLICATION_HIRED');
  });

  it('the headcount cap holds: a second accepted candidate on a 1-head opening cannot be hired, and the opening reports full', async () => {
    const opening = await as(hr, 'get', `${R}/openings/${openingId}`);
    expect(opening.body.data).toMatchObject({ filledCount: 1, isFull: true, status: 'OPEN' });
    const cand = await as(hr, 'post', `${R}/candidates`).send({ firstName: 'Second', lastName: 'Person', email: 'second@example.com' });
    const app2 = await as(hr, 'post', `${R}/applications`).send({ candidateId: cand.body.data.id, openingId });
    await as(hr, 'post', `${R}/applications/${app2.body.data.id}/move-stage`).send({ toStage: 'OFFER' });
    const offer = await as(hrAdmin, 'post', `${R}/offers`).send({ applicationId: app2.body.data.id, proposedStartDate: '2026-11-01' });
    await as(hrAdmin, 'post', `${R}/offers/${offer.body.data.id}/submit`);
    const instanceId = (await as(hrAdmin, 'get', `${R}/offers/${offer.body.data.id}`)).body.data.workflowInstanceId;
    await as(approver, 'post', `/api/v1/workflow/instances/${instanceId}/actions`).send({ action: 'APPROVE' });
    await as(hrAdmin, 'post', `${R}/offers/${offer.body.data.id}/mark-sent`);
    await as(hrAdmin, 'post', `${R}/offers/${offer.body.data.id}/record-accepted`);
    const hire = await as(hrAdmin, 'post', `${R}/applications/${app2.body.data.id}/hire`).send({ employeeCode: 'NEW003', hireDate: '2026-11-01', positionId, email: 'second@rcr.local' });
    expect(err(hire)).toBe('409 OPENING_FULL');
    expect(await prisma.employee.count({ where: { employeeCode: 'NEW003' } })).toBe(0);
    // Closing is explicit — the opening is still OPEN until somebody closes it.
    expect((await as(hr, 'post', `${R}/openings/${openingId}/close`)).body.data.status).toBe('CLOSED');
    expect(err(await as(hr, 'post', `${R}/applications`).send({ candidateId: cand.body.data.id, openingId }))).toBe('409 OPENING_NOT_OPEN');
  });
});

describe('reports, privacy and audit', () => {
  it('dashboard and report aggregate without ranking anybody', async () => {
    const dash = await as(hr, 'get', `${R}/dashboard`);
    expect(dash.body.data.hires).toBe(1);
    expect(dash.body.data.funnel.find((f: { stage: string }) => f.stage === 'HIRED').count).toBe(1);
    const report = await as(hr, 'get', `${R}/reports/summary?from=2026-01-01&to=2026-12-31`);
    expect(err(report)).toBe('200');
    expect(report.body.data.hires).toBe(1);
    expect(report.body.data.averageTimeToHireDays).toBeGreaterThan(0);
    expect(report.body.data.bySource.find((s: { source: string }) => s.source === 'REFERRAL')).toMatchObject({ applications: 1, hires: 1 });
    expect(report.body.data.rejectionsByReason).toEqual([{ reasonCode: 'COMPENSATION', count: 1 }]);
    expect(JSON.stringify(report.body.data)).not.toMatch(/jane|rank|score/i);
    expect(err(await as(hm, 'get', `${R}/reports/summary`))).toBe('403 FORBIDDEN');
  });

  it('candidate export is behind privacy.export_data, carries the candidate’s record, and excludes interviewer feedback', async () => {
    expect(err(await as(hr, 'post', `/api/v1/privacy/candidates/${candidateId}/export`))).toBe('403 FORBIDDEN');
    const exported = await as(hrAdmin, 'post', `/api/v1/privacy/candidates/${candidateId}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    const dto = exported.body && Object.keys(exported.body).length ? exported.body : JSON.parse(exported.text);
    expect(dto.subject.firstName).toBe('Jane');
    expect(dto.data.applications).toHaveLength(1);
    expect(dto.data.applications[0].offers[0].baseSalaryProposal).toBe('65000.00');
    expect(JSON.stringify(dto.data)).not.toMatch(/clear thinking|limited go/i);
    expect(dto.notIncluded.some((n: { category: string }) => n.category === 'interviewer feedback')).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'EXPORT_CANDIDATE_PERSONAL_DATA', recordId: candidateId } });
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit?.newValue)).not.toMatch(/jane|example\.com/i);
  });

  it('the audit trail names every decision with an actor and never a narrative', async () => {
    const actions = (await prisma.auditLog.findMany({ where: { module: 'recruitment' }, select: { action: true } })).map((a) => a.action);
    for (const a of ['CREATE_RECRUITMENT_REQUISITION', 'SUBMIT_RECRUITMENT_REQUISITION', 'APPROVE_RECRUITMENT_REQUISITION', 'REJECT_RECRUITMENT_REQUISITION', 'CREATE_RECRUITMENT_OPENING', 'OPEN_RECRUITMENT_OPENING', 'CLOSE_RECRUITMENT_OPENING', 'CREATE_CANDIDATE', 'CREATE_APPLICATION', 'MOVE_APPLICATION_STAGE', 'REJECT_APPLICATION', 'SCHEDULE_INTERVIEW', 'UPDATE_INTERVIEW', 'SUBMIT_INTERVIEW_FEEDBACK', 'CREATE_JOB_OFFER', 'SUBMIT_JOB_OFFER', 'APPROVE_JOB_OFFER', 'REJECT_JOB_OFFER', 'MARK_JOB_OFFER_SENT', 'RECORD_JOB_OFFER_ACCEPTED', 'WITHDRAW_JOB_OFFER', 'HIRE_CANDIDATE', 'UPDATE_RECRUITMENT_POLICY']) {
      expect(actions, a).toContain(a);
    }
    const all = await prisma.auditLog.findMany({ where: { module: 'recruitment' }, select: { newValue: true, oldValue: true } });
    expect(JSON.stringify(all)).not.toMatch(/strong backend|standard benefits|clear thinking/i);
  });
});
