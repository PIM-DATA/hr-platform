/**
 * Task 33 — engagement surveys and eNPS.
 *
 * What these tests guard: an anonymous response is stored with no employee, user, assignment or timestamp; the
 * assignment knows only "completed"; one assignment yields one response even under a double submit; every
 * subgroup below the survey's threshold is suppressed for every actor after every filter; managers and
 * executives get aggregates only; comments cannot expose their authors; eNPS is deterministic; snapshots stay
 * historical; the audit and the logs carry no answers; and nothing in performance, talent, relations, payroll or
 * the Employee 360 changes because someone answered a survey.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enpsScore, validateAnswer } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { logger } from '../src/lib/logger';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const E = '/api/v1/engagement';
const text = (v: unknown) => JSON.stringify(v);
const SEED_TEXT = 'My manager X is never around when I need a decision';

let hrAdmin: Session, hr: Session, mgr: Session, emp: Session, exec: Session, sysAdmin: Session;
const sessions: Record<string, Session> = {};
let orgId: string, salesId: string, legalId: string, marketingId: string, repJob: string, leadJob: string, repPos: string, leadPos: string;
const employees: Record<string, string> = {};
let s1: string, q1: string, q2: string, q3: string, q4: string, bankQ1: string;

function personalDataIn(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  const forbidden = /^(employeeId|employeeCode|firstName|lastName|email|responseId|assignmentId|textValue|respondent|comments?)$/;
  const walk = (v: unknown, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (forbidden.test(k)) hits.push(`${p}.${k}`); walk(x, `${p}.${k}`); } else if (typeof v === 'string' && /SAL\d|LEG\d|Person|manager X/.test(v)) hits.push(`${p}="${v}"`); };
  walk(value, path); return hits;
}
const snapshot = async () => ({ perf: await prisma.performancePlan.count(), talent: await prisma.talentReview.count(), er: await prisma.employeeRelationCase.count(), payroll: await prisma.payrollRun.count(), audits: await prisma.auditLog.count({ where: { module: { in: ['performance', 'talent', 'employee_relations', 'payroll', 'employees'] } } }) });

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'A33', name: 'Engage Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const sales = await prisma.department.create({ data: { organizationId: org.id, code: 'SAL', name: 'Sales' } });
  const legal = await prisma.department.create({ data: { organizationId: org.id, code: 'LEG', name: 'Legal' } });
  const marketing = await prisma.department.create({ data: { organizationId: org.id, code: 'MKT', name: 'Marketing' } });
  salesId = sales.id; legalId = legal.id; marketingId = marketing.id;
  repJob = (await prisma.job.create({ data: { code: 'REP', title: 'Sales Representative', level: 2 } })).id;
  leadJob = (await prisma.job.create({ data: { code: 'LEAD', title: 'Sales Lead', level: 3 } })).id;
  const counselJob = (await prisma.job.create({ data: { code: 'CNS', title: 'Counsel', level: 3 } })).id;
  repPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'P-REP', title: 'Sales Representative', jobId: repJob } })).id;
  leadPos = (await prisma.position.create({ data: { departmentId: sales.id, code: 'P-LEAD', title: 'Sales Lead', jobId: leadJob } })).id;
  const cnsPos = (await prisma.position.create({ data: { departmentId: legal.id, code: 'P-CNS', title: 'Counsel', jobId: counselJob } })).id;
  const mktPos = (await prisma.position.create({ data: { departmentId: marketing.id, code: 'P-MKT', title: 'Marketer', jobId: repJob } })).id;
  const mk = async (code: string, departmentId: string, positionId: string) => (employees[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'Person', email: `${code.toLowerCase()}@a33.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id);
  for (let i = 1; i <= 12; i += 1) await mk(`SAL${i}`, sales.id, repPos);
  for (let i = 13; i <= 16; i += 1) await mk(`SAL${i}`, sales.id, leadPos);
  for (let i = 1; i <= 6; i += 1) await mk(`LEG${i}`, legal.id, cnsPos);
  await mk('MKT1', marketing.id, mktPos);
  await prisma.department.update({ where: { id: sales.id }, data: { headEmployeeId: employees.SAL16 } });
  await createUser({ email: 'sysadmin@a33.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@a33.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'hr@a33.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@a33.local', password: PW, role: 'MANAGER', employeeId: employees.SAL16 });
  await createUser({ email: 'exec@a33.local', password: PW, role: 'EXECUTIVE' });
  for (const code of Object.keys(employees)) if (code !== 'SAL16') await createUser({ email: `${code.toLowerCase()}@a33.local`, password: PW, role: 'EMPLOYEE', employeeId: employees[code] });
  [sysAdmin, hrAdmin, hr, mgr, exec] = await Promise.all(['sysadmin', 'hradmin', 'hr', 'mgr', 'exec'].map((u) => loginAs(app, `${u}@a33.local`, PW)));
  for (const code of Object.keys(employees)) sessions[code] = code === 'SAL16' ? mgr : await loginAs(app, `${code.toLowerCase()}@a33.local`, PW);
  emp = sessions.SAL1;
}, 240000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

const likert = (qid: string, v: number) => ({ questionId: qid, numericValue: v });
const answers = (enps: number, l1 = 4, l2 = 3, comment?: string) => ({ answers: [likert(q1, l1), likert(q2, l2), { questionId: q3, numericValue: enps }, ...(comment ? [{ questionId: q4, textValue: comment }] : [])] });

describe('question bank and survey setup', () => {
  it('pure helpers: eNPS is deterministic and scale validation is server-side', () => {
    const e = enpsScore([...Array(10).fill(9), ...Array(6).fill(7), ...Array(4).fill(3)]);
    expect(e).toMatchObject({ valid: 20, promoters: 10, passives: 6, detractors: 4, promoterPct: 50, detractorPct: 20, score: 30 });
    expect(enpsScore([]).score).toBeNull();
    const q = { questionType: 'LIKERT' as const, required: true, scaleMin: 1, scaleMax: 5, options: [], maxLength: null };
    expect(validateAnswer(q, { questionId: 'x', numericValue: 0 })).toMatch(/between 1 and 5/);
    expect(validateAnswer(q, { questionId: 'x', numericValue: 6 })).toMatch(/between 1 and 5/);
    expect(validateAnswer(q, { questionId: 'x', numericValue: 3 })).toBeNull();
    expect(validateAnswer(q, undefined)).toMatch(/required/);
  });
  it('permissions: employees cannot administer or read results; HR cannot administer; the bank validates scales', async () => {
    expect(err(await as(emp, 'get', `${E}/dashboard`))).toBe('403 FORBIDDEN');
    expect(err(await as(emp, 'get', `${E}/questions`))).toBe('403 FORBIDDEN');
    expect(err(await as(hr, 'post', `${E}/questions`).send({ code: 'X', text: 'xxx', questionType: 'TEXT' }))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${E}/questions`))).toBe('403 FORBIDDEN');
    expect(err(await as(hrAdmin, 'post', `${E}/questions`).send({ code: 'BAD', text: 'Bad scale', questionType: 'LIKERT', config: { scaleMin: 5, scaleMax: 1 } }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(hrAdmin, 'post', `${E}/questions`).send({ code: 'BAD2', text: 'No options', questionType: 'SINGLE_CHOICE' }))).toBe('400 VALIDATION_ERROR');
    const mkq = async (code: string, body: Record<string, unknown>) => { const r = await as(hrAdmin, 'post', `${E}/questions`).send({ code, ...body }); expect(err(r)).toBe('201'); return r.body.data.id as string; };
    bankQ1 = await mkq('CLARITY_1', { theme: 'Clarity', text: 'I understand what is expected of me at work', questionType: 'LIKERT', config: { scaleLabels: { '1': 'Strongly disagree', '5': 'Strongly agree' } } });
    await mkq('CLARITY_2', { theme: 'Clarity', text: 'I have the tools I need to do my work', questionType: 'LIKERT' });
    await mkq('ENPS', { text: 'How likely are you to recommend this workplace to a friend?', questionType: 'ENPS' });
    await mkq('IMPROVE', { text: 'What should we improve?', questionType: 'TEXT', required: false });
    await mkq('TEAM', { theme: 'Team', text: 'Which team rituals help you most?', questionType: 'MULTI_CHOICE', required: false, config: { options: [{ code: 'STANDUP', label: 'Stand-up' }, { code: 'RETRO', label: 'Retro' }] } });
  });
  it('a survey is built from the bank as frozen snapshots; anonymity settings are chosen in draft', async () => {
    const s = await as(hrAdmin, 'post', `${E}/surveys`).send({ code: 'ENG-2026', name: '2026 Employee Engagement Survey', organizationId: orgId, surveyType: 'ENGAGEMENT', responseMode: 'ANONYMOUS', minimumAnonymousGroupSize: 5, periodEnd: '2026-12-31' });
    expect(err(s)).toBe('201');
    s1 = s.body.data.id;
    expect(s.body.data).toMatchObject({ status: 'DRAFT', responseMode: 'ANONYMOUS', minimumAnonymousGroupSize: 5, can: { edit: true, open: true } });
    expect(err(await as(hrAdmin, 'post', `${E}/surveys`).send({ code: 'X2', name: 'Too small threshold', surveyType: 'PULSE', responseMode: 'ANONYMOUS', minimumAnonymousGroupSize: 2 }))).toBe('400 VALIDATION_ERROR');
    const bank = (await as(hrAdmin, 'get', `${E}/questions`)).body.data as { id: string; code: string }[];
    const add = async (code: string, extra: Record<string, unknown> = {}) => { const r = await as(hrAdmin, 'post', `${E}/surveys/${s1}/questions`).send({ sourceQuestionId: bank.find((b) => b.code === code)!.id, ...extra }); expect(err(r)).toBe('201'); return r.body.data.id as string; };
    q1 = await add('CLARITY_1'); q2 = await add('CLARITY_2'); q3 = await add('ENPS'); q4 = await add('IMPROVE');
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s1}/questions`).send({ text: 'Second eNPS?', questionType: 'ENPS', isEnpsPrimary: true }))).toBe('409 ENGAGEMENT_ENPS_PRIMARY_EXISTS');
    const d = (await as(hrAdmin, 'get', `${E}/surveys/${s1}`)).body.data;
    expect(d.questions.map((q: { questionType: string; isEnpsPrimary: boolean }) => `${q.questionType}${q.isEnpsPrimary ? '*' : ''}`)).toEqual(['LIKERT', 'LIKERT', 'ENPS*', 'TEXT']);
    expect(d.questions[0]).toMatchObject({ scaleMin: 1, scaleMax: 5, scaleLabels: { '1': 'Strongly disagree' }, theme: 'Clarity' });
  });
});

describe('opening', () => {
  it('refuses to open an anonymous survey to fewer people than its threshold; opens once the audience is large enough; double open is one transition', async () => {
    expect((await as(hrAdmin, 'put', `${E}/surveys/${s1}/audience`).send({ employeeIds: [employees.LEG1, employees.LEG2, employees.LEG3, employees.LEG4] })).body.data).toEqual({ assigned: 4 });
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s1}/open`))).toBe('409 ENGAGEMENT_AUDIENCE_BELOW_ANONYMITY_THRESHOLD');
    expect((await as(hrAdmin, 'put', `${E}/surveys/${s1}/audience`).send({ departmentIds: [salesId, legalId] })).body.data).toEqual({ assigned: 22 });
    const [a, b] = await Promise.all([as(hrAdmin, 'post', `${E}/surveys/${s1}/open`), as(hrAdmin, 'post', `${E}/surveys/${s1}/open`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.engagementSurveyAssignment.count({ where: { surveyId: s1 } })).toBe(22);
    expect(await prisma.engagementSurveyAssignment.count({ where: { surveyId: s1, departmentIdSnapshot: salesId } })).toBe(16);
    const notes = await prisma.notification.findMany({ where: { type: 'ENGAGEMENT_SURVEY_OPENED' } });
    expect(notes).toHaveLength(22); // one per assigned account, no duplicates
    expect(notes[0].body).toMatch(/2026 Employee Engagement Survey is open until 2026-12-31/);
    expect(text(notes)).not.toMatch(/answer|result|score/i);
    // Frozen from here: mode, threshold, questions and audience.
    expect(err(await as(hrAdmin, 'patch', `${E}/surveys/${s1}`).send({ responseMode: 'IDENTIFIED' }))).toBe('409 ENGAGEMENT_SURVEY_MODE_IMMUTABLE');
    expect(err(await as(hrAdmin, 'patch', `${E}/surveys/${s1}`).send({ minimumAnonymousGroupSize: 3 }))).toBe('409 ENGAGEMENT_SURVEY_MODE_IMMUTABLE');
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s1}/questions`).send({ text: 'Late question', questionType: 'TEXT' }))).toBe('409 ENGAGEMENT_SURVEY_NOT_DRAFT');
    expect(err(await as(hrAdmin, 'put', `${E}/surveys/${s1}/audience`).send({ departmentIds: [marketingId] }))).toBe('409 ENGAGEMENT_SURVEY_NOT_DRAFT');
    expect(err(await as(hrAdmin, 'patch', `${E}/surveys/${s1}`).send({ name: '2026 Employee Engagement Survey (annual)' }))).toBe('200');
  });
});

describe('answering', () => {
  it('the employee sees the survey with the anonymity notice; answers are validated on the server', async () => {
    const mine = (await as(emp, 'get', `${E}/my/surveys`)).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ surveyId: s1, responseMode: 'ANONYMOUS', completed: false, questionCount: 4 });
    const form = (await as(emp, 'get', `${E}/my/surveys/${s1}`)).body.data;
    expect(form.notice).toMatch(/ไม่ถูกจัดเก็บพร้อม employee\/user identifier/);
    expect(form.questions).toHaveLength(4);
    expect(err(await as(sessions.MKT1, 'get', `${E}/my/surveys/${s1}`))).toBe('404 SURVEY_NOT_FOUND'); // not in the audience
    const bad = async (body: object, re: RegExp) => { const r = await as(emp, 'post', `${E}/my/surveys/${s1}/responses`).send(body); expect(err(r)).toMatch(/^(422 (ENGAGEMENT_INVALID_ANSWERS|VALIDATION_ERROR)|400 VALIDATION_ERROR)$/); expect(text(r.body.error)).toMatch(re); };
    await bad({ answers: [likert(q1, 0), likert(q2, 3), { questionId: q3, numericValue: 9 }] }, /between 1 and 5/);
    await bad({ answers: [likert(q1, 6), likert(q2, 3), { questionId: q3, numericValue: 9 }] }, /between 1 and 5/);
    await bad({ answers: [likert(q1, 4), { questionId: q3, numericValue: 9 }] }, /required/);
    await bad({ answers: [likert(q1, 4), likert(q2, 3), { questionId: q3, numericValue: 11 }] }, /between 0 and 10/);
    await bad({ answers: [likert(q1, 4), likert(q2, 3), { questionId: q3, numericValue: 9 }, { questionId: 'nope', numericValue: 1 }] }, /Unknown question/);
    await bad({ answers: [likert(q1, 4), likert(q1, 4), likert(q2, 3), { questionId: q3, numericValue: 9 }] }, /twice/);
    await bad({ answers: [likert(q1, 4), likert(q2, 3), { questionId: q3, numericValue: 9 }, { questionId: q4, textValue: 'x'.repeat(2001) }] }, /at most|VALIDATION/);
    await bad({ answers: [likert(q1, 4), likert(q2, 3), { questionId: q3, numericValue: 9 }, { questionId: q4, numericValue: 3 }] }, /Unexpected numericValue/);
    expect(await prisma.engagementResponse.count()).toBe(0);
  });
  it('an anonymous response holds survey-local cohort tokens and a date only — no employee, user, assignment, organization, department, job, position or time; the assignment only knows "completed"; the logs never see the text', async () => {
    const captured: string[] = [];
    const record = ((obj: unknown, msg?: string) => { captured.push(JSON.stringify({ obj, msg })); }) as never;
    const spies = (['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const).map((level) => vi.spyOn(logger, level).mockImplementation(record));
    const before = await snapshot();
    let r: request.Response;
    try { r = await as(emp, 'post', `${E}/my/surveys/${s1}/responses`).send(answers(9, 4, 3, SEED_TEXT)); } finally { spies.forEach((s) => s.mockRestore()); }
    expect(err(r!)).toBe('201');
    expect(captured.join('\n')).not.toMatch(/manager X|never around/);
    // Raw storage: the response and its answers carry no master or identity key at all — structurally, not just as nulls.
    const FORBIDDEN = /^(employeeId|userId|assignmentId|employeeCode|organizationId|departmentId|jobId|positionId|organizationIdSnapshot|departmentIdSnapshot|jobIdSnapshot|positionIdSnapshot|submittedAt)$/;
    const keysOf = (v: unknown, path = ''): string[] => (Array.isArray(v) ? v.flatMap((x, i) => keysOf(x, `${path}[${i}]`)) : v && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => [`${path}.${k}`, ...keysOf(x, `${path}.${k}`)]) : []);
    const rows = await prisma.engagementResponse.findMany({ where: { surveyId: s1 }, include: { answers: true } });
    expect(rows).toHaveLength(1);
    expect(keysOf(rows).filter((k) => FORBIDDEN.test(k.split('.').pop()!))).toEqual([]);
    expect(rows[0]).toMatchObject({ responseMode: 'ANONYMOUS', submittedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    // The only context is survey-local cohort tokens: opaque ids that map to a frozen group label, shared by everyone in the group.
    const cohort = await prisma.engagementSurveyCohort.findUniqueOrThrow({ where: { id: rows[0].deptCohortId! } });
    expect(cohort).toMatchObject({ surveyId: s1, dimensionType: 'DEPARTMENT', label: 'Sales' });
    expect(rows[0].deptCohortId).not.toMatch(/^c[a-z0-9]{24}$/); // random uuid, not a time-ordered cuid
    expect(await prisma.engagementSurveyAssignment.count({ where: { surveyId: s1, deptCohortId: rows[0].deptCohortId } })).toBe(16); // a group token, not a person
    // No path from the response to a person: the identity table is never written for an anonymous survey.
    expect(await prisma.engagementIdentifiedRespondent.count({ where: { response: { surveyId: s1 } } })).toBe(0);
    expect(await prisma.engagementIdentifiedRespondent.count({ where: { employeeId: employees.SAL1 } })).toBe(0);
    const a = await prisma.engagementSurveyAssignment.findUniqueOrThrow({ where: { surveyId_employeeId: { surveyId: s1, employeeId: employees.SAL1 } } });
    expect(a.completedAt).not.toBeNull();
    expect(Object.keys(a)).not.toEqual(expect.arrayContaining(['responseId']));
    // Audit: survey-level, mode + count, no response id, no answer, no text.
    const audit = await prisma.auditLog.findMany({ where: { module: 'engagement', action: 'SUBMIT_ENGAGEMENT_RESPONSE' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].recordId).toBe(s1);
    expect(JSON.parse(audit[0].newValue as string)).toEqual({ mode: 'ANONYMOUS', answerCount: 4 });
    expect(text(audit)).not.toMatch(/manager X|responseId|"9"/);
    expect(await snapshot()).toEqual(before); // no cross-domain side effect
    expect(err(await as(emp, 'post', `${E}/my/surveys/${s1}/responses`).send(answers(9)))).toBe('409 ENGAGEMENT_ALREADY_RESPONDED');
  });
  it('a simultaneous double submit yields exactly one response and one completion', async () => {
    const [a, b] = await Promise.all([as(sessions.SAL2, 'post', `${E}/my/surveys/${s1}/responses`).send(answers(10)), as(sessions.SAL2, 'post', `${E}/my/surveys/${s1}/responses`).send(answers(10))]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.engagementResponse.count({ where: { surveyId: s1 } })).toBe(2);
    expect(await prisma.engagementResponseAnswer.count({ where: { response: { surveyId: s1 }, questionId: q3 } })).toBe(2);
  });
  it('the rest of the audience answers: 10 promoters and 6 passives in Sales, 4 detractors in Legal, 2 in Legal do not answer', async () => {
    const promoters = ['SAL3', 'SAL4', 'SAL5', 'SAL6', 'SAL7', 'SAL8', 'SAL9', 'SAL10']; // + SAL1, SAL2 = 10
    for (const c of promoters) expect(err(await as(sessions[c], 'post', `${E}/my/surveys/${s1}/responses`).send(answers(c === 'SAL3' ? 10 : 9, 5, 4)))).toBe('201');
    for (const c of ['SAL11', 'SAL12', 'SAL13', 'SAL14', 'SAL15', 'SAL16']) expect(err(await as(sessions[c], 'post', `${E}/my/surveys/${s1}/responses`).send(answers(c === 'SAL11' ? 8 : 7, 3, 3, c === 'SAL13' ? 'More stand-ups' : undefined)))).toBe('201');
    for (const c of ['LEG1', 'LEG2', 'LEG3', 'LEG4']) expect(err(await as(sessions[c], 'post', `${E}/my/surveys/${s1}/responses`).send(answers(c === 'LEG1' ? 0 : 5, 2, 2, 'Legal needs headcount')))).toBe('201');
    expect(await prisma.engagementResponse.count({ where: { surveyId: s1 } })).toBe(20);
  });
});

describe('results and suppression', () => {
  it('overall: response rate uses the frozen audience, eNPS uses valid answers only, themes average compatible scales only', async () => {
    const r = await as(hrAdmin, 'get', `${E}/surveys/${s1}/results`);
    expect(err(r)).toBe('200');
    const d = r.body.data;
    expect(d.participation).toEqual({ assigned: 22, completed: 20, responseRate: 90.9 });
    expect(d.result.suppressed).toBe(false);
    expect(d.result.responseCount).toBe(20);
    expect(d.result.enps).toMatchObject({ valid: 20, promoters: 10, passives: 6, detractors: 4, promoterPct: 50, detractorPct: 20, score: 30 });
    const qr = (id: string) => d.result.questions.find((q: { questionId: string }) => q.questionId === id);
    expect(qr(q1).responseCount).toBe(20);
    expect(qr(q1).distribution.find((x: { value: string }) => x.value === '5')).toMatchObject({ count: 8, pct: 40, label: 'Strongly agree' });
    expect(qr(q4)).toMatchObject({ commentCount: 6 });
    expect(text(qr(q4))).not.toMatch(/manager X|headcount/);
    expect(d.result.themes).toEqual([{ theme: 'Clarity', scale: 'LIKERT:1-5', questionCount: 2, average: expect.any(Number), responseCount: 40 }]);
    expect(text(d)).not.toMatch(/employeeId|employeeCode|responseId|assignmentId/);
  });
  it('threshold 5: Sales (16) visible, Legal (4) suppressed — for HR admin, the executive and SYSTEM_ADMIN alike, with no counts leaking', async () => {
    for (const who of [hrAdmin, exec, sysAdmin]) {
      const rows = (await as(who, 'get', `${E}/surveys/${s1}/breakdown?by=department`)).body.data;
      const sales = rows.find((x: { name: string }) => x.name === 'Sales'); const legal = rows.find((x: { name: string }) => x.name === 'Legal');
      expect(sales).toMatchObject({ assigned: 16, completed: 16, responseRate: 100, result: { suppressed: false, responseCount: 16 } });
      expect(sales.result.enps.score).toBe(62.5);
      expect(legal.result).toEqual({ suppressed: true, minimumGroupSize: 5, reason: expect.stringMatching(/Fewer than 5/) });
      expect(legal).toMatchObject({ assigned: 0, completed: 0, responseRate: null });
      expect(text(legal)).not.toMatch(/questions|distribution|average|"4"/);
      const filtered = (await as(who, 'get', `${E}/surveys/${s1}/results?departmentId=${legalId}`)).body.data;
      expect(filtered.result.suppressed).toBe(true);
      expect(filtered.participation).toEqual({ assigned: 0, completed: 0, responseRate: null });
    }
  });
  it('filter attack: stacking department + job (4) or position (1) can only make a group suppressed', async () => {
    const byJob = (await as(hrAdmin, 'get', `${E}/surveys/${s1}/results?departmentId=${salesId}&jobId=${leadJob}`)).body.data;
    expect(byJob.result.suppressed).toBe(true);
    expect(byJob.participation).toEqual({ assigned: 0, completed: 0, responseRate: null });
    const byPos = (await as(sysAdmin, 'get', `${E}/surveys/${s1}/results?positionId=${leadPos}`)).body.data;
    expect(byPos.result.suppressed).toBe(true);
    const jobs = (await as(hrAdmin, 'get', `${E}/surveys/${s1}/breakdown?by=job&departmentId=${salesId}`)).body.data;
    expect(jobs.find((x: { name: string }) => x.name === 'Sales Lead').result.suppressed).toBe(true);
    expect(jobs.find((x: { name: string }) => x.name === 'Sales Representative').result).toMatchObject({ suppressed: false, responseCount: 12 });
  });
  it('the manager sees their own department aggregate only: no other department, no comments, no respondents, no participation list', async () => {
    const r = (await as(mgr, 'get', `${E}/surveys/${s1}/results`)).body.data;
    expect(r.scope.teamScoped).toBe(true);
    expect(r.participation).toEqual({ assigned: 16, completed: 16, responseRate: 100 });
    expect(r.result.responseCount).toBe(16);
    expect(r.result.enps.score).toBe(62.5);
    expect(text(r)).not.toMatch(/manager X|headcount|stand-ups|employeeCode|responseId/);
    expect(err(await as(mgr, 'get', `${E}/surveys/${s1}/results?departmentId=${legalId}`))).toBe('403 FORBIDDEN');
    const bd = (await as(mgr, 'get', `${E}/surveys/${s1}/breakdown?by=department`)).body.data;
    expect(bd.map((x: { name: string }) => x.name)).toEqual(['Sales']);
    expect(err(await as(mgr, 'get', `${E}/surveys/${s1}/comments`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `${E}/surveys/${s1}/responses`))).toBe('403 FORBIDDEN');
    expect(err(await as(mgr, 'get', `${E}/surveys/${s1}/participation`))).toBe('403 FORBIDDEN');
    expect((await as(mgr, 'get', `${E}/surveys/${s1}/results?jobId=${leadJob}`)).body.data.result.suppressed).toBe(true);
  });
  it('the executive gets aggregates with no person anywhere in the payload', async () => {
    const r = (await as(exec, 'get', `${E}/surveys/${s1}/results`)).body.data;
    expect(r.result.enps.score).toBe(30);
    expect(personalDataIn(r)).toEqual([]);
    expect(personalDataIn((await as(exec, 'get', `${E}/surveys/${s1}/breakdown?by=department`)).body.data)).toEqual([]);
    expect(personalDataIn((await as(exec, 'get', `${E}/dashboard`)).body.data)).toEqual([]);
    expect(err(await as(exec, 'get', `${E}/surveys/${s1}/comments`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${E}/surveys/${s1}/participation`))).toBe('403 FORBIDDEN');
  });
  it('HR admin participation shows who completed, with no path to an answer; anonymous comments open only after close, as text alone', async () => {
    const p = (await as(hrAdmin, 'get', `${E}/surveys/${s1}/participation?completed=false`)).body;
    expect(p.meta.total).toBe(2);
    expect(p.data.map((x: { employee: { employeeCode: string } }) => x.employee.employeeCode).sort()).toEqual(['LEG5', 'LEG6']);
    expect(text(p)).not.toMatch(/responseId|answers|textValue/);
    expect(err(await as(hrAdmin, 'get', `${E}/surveys/${s1}/comments`))).toBe('409 ENGAGEMENT_COMMENTS_NOT_AVAILABLE');
    expect(err(await as(hrAdmin, 'get', `${E}/surveys/${s1}/responses`))).toBe('409 ENGAGEMENT_SURVEY_ANONYMOUS');
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s1}/close`))).toBe('200');
    expect(err(await as(sessions.LEG5, 'post', `${E}/my/surveys/${s1}/responses`).send(answers(5)))).toBe('409 ENGAGEMENT_SURVEY_NOT_OPEN');
    const c = (await as(hrAdmin, 'get', `${E}/surveys/${s1}/comments`)).body.data;
    expect(c).toHaveLength(6);
    expect(c.every((x: { respondent: unknown }) => x.respondent === null)).toBe(true);
    expect(Object.keys(c[0]).sort()).toEqual(['questionId', 'respondent', 'text']);
    expect(c.map((x: { text: string }) => x.text)).toEqual(expect.arrayContaining([SEED_TEXT, 'Legal needs headcount']));
    expect(err(await as(hr, 'get', `${E}/surveys/${s1}/comments`))).toBe('403 FORBIDDEN');
    expect(await prisma.auditLog.count({ where: { module: 'engagement', action: 'VIEW_ENGAGEMENT_COMMENTS' } })).toBe(1);
  });
  it('CSV: aggregate only, suppressed groups export as a single line', async () => {
    const all = await as(hrAdmin, 'get', `${E}/surveys/${s1}/results.csv`);
    expect(all.status).toBe(200);
    expect(all.text).toMatch(/"eNPS","30"/);
    expect(all.text).not.toMatch(/manager X|headcount|SAL\d/);
    const legal = await as(hrAdmin, 'get', `${E}/surveys/${s1}/results.csv?departmentId=${legalId}`);
    expect(legal.text).toMatch(/SUPPRESSED/);
    expect(legal.text).not.toMatch(/Average|"eNPS"/);
    expect(err(await as(emp, 'get', `${E}/surveys/${s1}/results.csv`))).toBe('403 FORBIDDEN');
  });
  it('Report Center datasets apply the same suppression and are aggregate-only', async () => {
    const run = (s: Session, datasetId: string, columns: string[]) => as(s, 'post', '/api/v1/reports/run').send({ datasetId, definition: { columns, filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50 }, page: 1 });
    const sv = await run(exec, 'engagement_survey_summary', ['survey', 'assigned', 'completed', 'responseRate', 'enps', 'suppressed']);
    expect(err(sv)).toBe('200');
    expect(sv.body.data.rows.find((x: { survey: string }) => /2026 Employee Engagement/.test(x.survey))).toMatchObject({ enps: 30, completed: 20, suppressed: false });
    const dept = await run(hr, 'engagement_department_summary', ['survey', 'department', 'suppressed', 'enps', 'completed']);
    expect(dept.body.data.rows.find((x: { department: string }) => x.department === 'Legal')).toMatchObject({ suppressed: true, enps: null, completed: null });
    expect(dept.body.data.rows.find((x: { department: string }) => x.department === 'Sales')).toMatchObject({ suppressed: false, enps: 62.5 });
    const qs = await run(exec, 'engagement_question_summary', ['survey', 'question', 'responses', 'average']);
    expect(err(qs)).toBe('200');
    expect(text(qs.body)).not.toMatch(/manager X|textValue/);
    expect(err(await run(emp, 'engagement_survey_summary', ['survey']))).toBe('403 FORBIDDEN');
    // A manager's dataset rows are their department only.
    const m = await run(mgr, 'engagement_department_summary', ['survey', 'department']);
    expect(m.body.data.rows.map((x: { department: string }) => x.department)).toEqual(['Sales']);
  });
});

describe('identified mode, races and history', () => {
  let s2: string, s2q: string;
  it('an identified survey says so, keeps respondent detail for engagement.manage only, and survives a close-vs-submit race whole', async () => {
    const s = await as(hrAdmin, 'post', `${E}/surveys`).send({ code: 'NPF', name: 'New Process Feedback', surveyType: 'CUSTOM', responseMode: 'IDENTIFIED' });
    s2 = s.body.data.id;
    s2q = (await as(hrAdmin, 'post', `${E}/surveys/${s2}/questions`).send({ text: 'The new expense process is clear', questionType: 'YES_NO' })).body.data.id;
    await as(hrAdmin, 'put', `${E}/surveys/${s2}/audience`).send({ departmentIds: [salesId] });
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s2}/open`))).toBe('200');
    const form = (await as(emp, 'get', `${E}/my/surveys/${s2}`)).body.data;
    expect(form.notice).toMatch(/ระบุตัวผู้ตอบได้/);
    expect(err(await as(emp, 'post', `${E}/my/surveys/${s2}/responses`).send({ answers: [{ questionId: s2q, booleanValue: true }] }))).toBe('201');
    const row = await prisma.engagementResponse.findFirstOrThrow({ where: { surveyId: s2 } });
    expect(row.responseMode).toBe('IDENTIFIED');
    const who = await prisma.engagementIdentifiedRespondent.findUniqueOrThrow({ where: { responseId: row.id } });
    expect(who).toMatchObject({ employeeId: employees.SAL1 });
    expect(who.assignmentId).not.toBeNull(); expect(who.submittedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { module: 'engagement', action: 'SUBMIT_ENGAGEMENT_RESPONSE', recordId: s2 } });
    expect(JSON.parse(audit!.newValue as string)).toEqual({ mode: 'IDENTIFIED', answerCount: 1, responseId: row.id });
    const detail = (await as(hrAdmin, 'get', `${E}/surveys/${s2}/responses`)).body.data;
    expect(detail).toHaveLength(1);
    expect(detail[0]).toMatchObject({ employee: { employeeCode: 'SAL1' }, answers: [{ questionId: s2q, booleanValue: true }] });
    expect(err(await as(mgr, 'get', `${E}/surveys/${s2}/responses`))).toBe('403 FORBIDDEN');
    expect(err(await as(exec, 'get', `${E}/surveys/${s2}/responses`))).toBe('403 FORBIDDEN');
    expect(personalDataIn((await as(exec, 'get', `${E}/surveys/${s2}/results`)).body.data)).toEqual([]);
    // Race: SAL2 submits while HR closes. The submission is entirely in or entirely out.
    const [close, submit] = await Promise.all([as(hrAdmin, 'post', `${E}/surveys/${s2}/close`), as(sessions.SAL2, 'post', `${E}/my/surveys/${s2}/responses`).send({ answers: [{ questionId: s2q, booleanValue: false }] })]);
    expect(close.status).toBe(200);
    expect([201, 409]).toContain(submit.status);
    const responses = await prisma.engagementResponse.count({ where: { surveyId: s2 } });
    const completed = await prisma.engagementSurveyAssignment.count({ where: { surveyId: s2, completedAt: { not: null } } });
    expect(responses).toBe(submit.status === 201 ? 2 : 1);
    expect(completed).toBe(responses);
  });
  it('question snapshots and department snapshots stay historical after a bank rename and a transfer; a new survey follows the current department', async () => {
    expect(err(await as(hrAdmin, 'patch', `${E}/questions/${bankQ1}`).send({ text: 'I understand what is expected of me (reworded)' }))).toBe('200');
    expect((await as(hrAdmin, 'get', `${E}/surveys/${s1}`)).body.data.questions[0].text).toBe('I understand what is expected of me at work');
    const mktPos = await prisma.position.findUniqueOrThrow({ where: { code: 'P-MKT' } });
    await prisma.employee.update({ where: { id: employees.SAL1 }, data: { departmentId: marketingId, positionId: mktPos.id } });
    const bd = (await as(hrAdmin, 'get', `${E}/surveys/${s1}/breakdown?by=department`)).body.data;
    expect(bd.find((x: { name: string }) => x.name === 'Sales')).toMatchObject({ assigned: 16, completed: 16 });
    expect(bd.some((x: { name: string }) => x.name === 'Marketing')).toBe(false);
    const s3 = (await as(hrAdmin, 'post', `${E}/surveys`).send({ code: 'PULSE-Q4', name: 'Q4 pulse', surveyType: 'PULSE', responseMode: 'ANONYMOUS' })).body.data.id;
    await as(hrAdmin, 'put', `${E}/surveys/${s3}/audience`).send({ employeeIds: [employees.SAL1, employees.SAL2, employees.SAL3, employees.SAL4, employees.MKT1] });
    const a = await prisma.engagementSurveyAssignment.findUniqueOrThrow({ where: { surveyId_employeeId: { surveyId: s3, employeeId: employees.SAL1 } } });
    expect(a.departmentIdSnapshot).toBe(marketingId);
    expect(err(await as(hrAdmin, 'delete', `${E}/surveys/${s3}`))).toBe('204');
  });
  it('duplicate copies the questionnaire only; archive keeps history', async () => {
    const d = await as(hrAdmin, 'post', `${E}/surveys/${s1}/duplicate`).send({ code: 'ENG-2027', name: '2027 Employee Engagement Survey' });
    expect(err(d)).toBe('201');
    expect(d.body.data).toMatchObject({ status: 'DRAFT', questionCount: 4, audienceCount: 0, responseMode: 'ANONYMOUS', minimumAnonymousGroupSize: 5, duplicatedFromId: s1 });
    expect(await prisma.engagementResponse.count({ where: { surveyId: d.body.data.id } })).toBe(0);
    expect(err(await as(hrAdmin, 'post', `${E}/surveys/${s1}/archive`))).toBe('200');
    expect((await as(hrAdmin, 'get', `${E}/surveys/${s1}/results`)).body.data.result.enps.score).toBe(30);
  });
  it('privacy export carries identified answers and participation, never an anonymous answer; the Employee 360 has no engagement', async () => {
    const x = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${employees.SAL1}/export`);
    expect(err(x)).toBe('200');
    const exported = JSON.parse(x.text); const eng = exported.data.engagement;
    expect(eng.participation.map((p: { survey: { code: string }; completed: boolean }) => `${p.survey.code}:${p.completed}`).sort()).toEqual(['ENG-2026:true', 'NPF:true']);
    expect(eng.identifiedResponses).toHaveLength(1);
    expect(eng.identifiedResponses[0]).toMatchObject({ survey: { code: 'NPF' }, answers: [{ question: 'The new expense process is clear', booleanValue: true }] });
    expect(x.text).not.toMatch(/manager X|never around/);
    expect(exported.notIncluded.some((n: { category: string }) => /anonymous survey answers/.test(n.category))).toBe(true);
    const e360 = await as(hrAdmin, 'get', `/api/v1/analytics/employee-360/${employees.SAL1}`);
    expect(err(e360)).toBe('200');
    expect(text(e360.body)).not.toMatch(/engagement|survey|eNPS|manager X/i);
    expect(text((await as(hrAdmin, 'get', `/api/v1/performance/plans?employeeId=${employees.SAL1}`)).body)).not.toMatch(/survey|eNPS/i);
  });
});
