/**
 * Task 47 — confidentiality and privacy regressions for Task 44 findings T44-P1-05, P1-07, P1-17, P1-20 and P1-24
 * (engagement differencing, P1-06, lives in engagement.test.ts; audit free text, P1-18, in audit-free-text.test.ts).
 *
 * Fixture: one organization with a 6-person department (BIG) and a 1-person department (TINY, "SOLO"); a finalized
 * performance cycle covering all seven; a subject employee (SUBJ) with records in every personal-data domain; a
 * service-desk role with organization-wide ticket access but no payroll authority.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const text = (v: unknown) => JSON.stringify(v);

const E: Record<string, string> = {};
let orgId: string, bigId: string, tinyId: string, cycleId: string, subjectId: string;
let hrAdmin: Session, exec: Session, employee: Session, manager: Session, serviceDesk: Session, subject: Session, sysAdmin: Session;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'C47', name: 'Conf Co', timezone: 'Asia/Bangkok' } });
  orgId = org.id;
  const big = await prisma.department.create({ data: { organizationId: org.id, code: 'BIG', name: 'Big Dept' } });
  const tiny = await prisma.department.create({ data: { organizationId: org.id, code: 'TINY', name: 'Tiny Dept' } });
  bigId = big.id; tinyId = tiny.id;
  const job = await prisma.job.create({ data: { code: 'J47', title: 'Analyst', level: 2 } });
  const posB = await prisma.position.create({ data: { departmentId: big.id, code: 'PB', title: 'Analyst B', jobId: job.id } });
  const posT = await prisma.position.create({ data: { departmentId: tiny.id, code: 'PT', title: 'Analyst T', jobId: job.id } });
  const mk = async (code: string, dept: string, pos: string, managerId: string | null = null) =>
    (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'P', email: `${code.toLowerCase()}@c47.local`, hireDate: new Date('2022-01-01T00:00:00Z'), organizationId: org.id, departmentId: dept, positionId: pos, managerId, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  E.MGR = await mk('MGR', big.id, posB.id);
  for (const c of ['B1', 'B2', 'B3', 'B4', 'SUBJ']) E[c] = await mk(c, big.id, posB.id, E.MGR);
  E.SOLO = await mk('SOLO', tiny.id, posT.id);
  subjectId = E.SUBJ!;
  await createUser({ email: 'hradmin@c47.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'exec@c47.local', password: PW, role: 'EXECUTIVE' });
  await createUser({ email: 'sys@c47.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'emp@c47.local', password: PW, role: 'EMPLOYEE', employeeId: E.B1 });
  await createUser({ email: 'mgr@c47.local', password: PW, role: 'MANAGER', employeeId: E.MGR });
  await createUser({ email: 'subj@c47.local', password: PW, role: 'EMPLOYEE', employeeId: subjectId });
  // Organization-wide service desk: tickets and letters in scope, no payroll authority.
  const perms = await prisma.permission.findMany({ where: { code: { in: ['service_request.view', 'service_request.fulfill', 'hr_letter.view_own', 'dashboard.view'] } } });
  await prisma.role.create({ data: { code: 'SERVICE_DESK', name: 'Service desk', dataScope: 'ALL', rolePermissions: { create: perms.map((p) => ({ permissionId: p.id })) } } });
  await createUser({ email: 'desk@c47.local', password: PW, role: 'SERVICE_DESK' });
  [hrAdmin, exec, sysAdmin, employee, manager, subject, serviceDesk] = await Promise.all(['hradmin', 'exec', 'sys', 'emp', 'mgr', 'subj', 'desk'].map((u) => loginAs(app, `${u}@c47.local`, PW)));

  // Finalized performance cycle: BIG has six scored plans, TINY one (SOLO's 1.20 is the value a small-group leak exposes).
  const pc = await prisma.performanceCycle.create({ data: { code: 'P47', name: 'Performance 2026', organizationId: org.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED', ratingBands: { create: [{ code: 'LOW', label: 'Low', minScore: 1, maxScore: 2.99 }, { code: 'HIGH', label: 'High', minScore: 3, maxScore: 5 }] } } });
  cycleId = pc.id;
  const plan = async (code: string, dept: { id: string; name: string }, score: number) => prisma.performancePlan.create({ data: {
    cycleId: pc.id, employeeId: E[code]!, employeeCodeSnapshot: code, employeeNameSnapshot: `${code} P`, departmentId: dept.id, departmentName: dept.name, status: 'FINALIZED', finalizedAt: new Date('2026-06-30T00:00:00Z'),
    weightedScore: score, ratingCode: score >= 3 ? 'HIGH' : 'LOW', ratingLabelSnapshot: score >= 3 ? 'High' : 'Low', reviewerEmployeeId: E.MGR, reviewerNameSnapshot: 'MGR P', reviewerUserId: manager.user.id,
  } });
  for (const [c, s] of [['MGR', 4], ['B1', 3.5], ['B2', 3.6], ['B3', 3.7], ['B4', 3.8], ['SUBJ', 3.9]] as const) await plan(c, { id: big.id, name: 'Big Dept' }, s);
  await plan('SOLO', { id: tiny.id, name: 'Tiny Dept' }, 1.2);

  // Subject's personal data across domains.
  await prisma.employeeCompensation.create({ data: { employeeId: subjectId, effectiveFrom: '2025-01-01', baseSalary: '41234.00', currencyCode: 'THB', createdByUserId: hrAdmin.user.id } });
  const period = await prisma.payrollPeriod.create({ data: { organizationId: org.id, year: 2026, month: 1, periodStart: '2026-01-01', periodEnd: '2026-01-31', attendanceFrom: '2026-01-01', attendanceTo: '2026-01-31', status: 'CLOSED', currencyCode: 'THB' } });
  const run = await prisma.payrollRun.create({ data: { periodId: period.id, startedByUserId: hrAdmin.user.id, status: 'CLOSED', closedAt: new Date('2026-02-01T00:00:00Z'), currencyCode: 'THB' } });
  await prisma.payrollResult.create({ data: { runId: run.id, employeeId: subjectId, employeeCode: 'SUBJ', employeeName: 'SUBJ P', baseSalary: '41234.00', dailyRate: '1374.466667', minuteRate: '2.863472', grossPay: '41234.00', totalDeductions: '750.00', netPay: '40484.00', currencyCode: 'THB',
    items: { create: [{ componentCodeSnapshot: 'BASE', componentNameSnapshot: 'Base salary', type: 'EARNING', source: 'GENERATED', amount: '41234.00' }] } } });
  await prisma.payrollResult.create({ data: { runId: run.id, employeeId: E.B2!, employeeCode: 'B2', employeeName: 'B2 P', baseSalary: '55555.00', dailyRate: '1', minuteRate: '1', grossPay: '55555.00', totalDeductions: '0', netPay: '55555.00', currencyCode: 'THB' } });
  E.RUN = run.id;
  await prisma.attendanceRecord.create({ data: { employeeId: subjectId, attendanceDate: '2026-03-02', dayType: 'WORKDAY', workMinutes: 480, status: 'NORMAL', calculatedAt: new Date() } });
  const course = await prisma.trainingCourse.create({ data: { code: 'SAFE', title: 'Safety basics', deliveryMethod: 'CLASSROOM' } });
  const session = await prisma.trainingSession.create({ data: { courseId: course.id, courseCodeSnapshot: 'SAFE', courseTitleSnapshot: 'Safety basics', startAt: new Date('2026-04-01T02:00:00Z'), endAt: new Date('2026-04-01T09:00:00Z'), timezone: 'Asia/Bangkok' } });
  await prisma.trainingEnrollment.create({ data: { sessionId: session.id, employeeId: subjectId, employeeCodeSnapshot: 'SUBJ', employeeNameSnapshot: 'SUBJ P', status: 'COMPLETED' } });
  const cat = await as(hrAdmin, 'post', '/api/v1/documents/categories').send({ code: 'CONTRACTS', name: 'Contracts', defaultClassification: 'EMPLOYEE_PRIVATE' });
  const doc = await as(hrAdmin, 'post', '/api/v1/documents').field('title', 'Employment contract SUBJ').field('categoryId', cat.body.data.id).field('ownerEmployeeId', subjectId)
    .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'contract.pdf', contentType: 'application/pdf' });
  expect(doc.status).toBe(201);

  // A salary certificate issued by an authorized HR admin (letter permission + payroll authority).
  const tpl = await as(hrAdmin, 'post', '/api/v1/employee-services/letter-templates').send({ code: 'SALCERT', name: 'Salary certificate', letterType: 'SALARY_CERTIFICATE', subjectTemplate: 'Salary certificate for {{employee.firstName}}', bodyTemplate: 'This certifies that {{employee.firstName}} earns {{compensation.baseSalary}} {{compensation.currency}} per month.' });
  expect(tpl.status).toBe(201);
  const letter = await as(hrAdmin, 'post', '/api/v1/employee-services/letters').send({ employeeId: subjectId, templateId: tpl.body.data.id, issueDate: '2026-05-01' });
  expect(letter.status).toBe(201);
  E.LETTER = letter.body.data.id;
  E.TPL = tpl.body.data.id;
}, 120000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('T44-P1-05 — organization performance report is a reporting authority, not an employee right', () => {
  it('EMPLOYEE (and MANAGER) direct requests for the organization report and the competency gap report are refused, with no data', async () => {
    for (const s of [employee, manager]) {
      const r = await as(s, 'get', `/api/v1/performance/cycles/${cycleId}/report`);
      expect(err(r)).toBe('403 FORBIDDEN');
      expect(text(r.body)).not.toMatch(/averageScore|1\.20|Tiny Dept/);
      expect(err(await as(s, 'get', `/api/v1/performance/cycles/${cycleId}/report?departmentId=${tinyId}`))).toBe('403 FORBIDDEN');
      expect(err(await as(s, 'get', '/api/v1/competency/reports/gaps'))).toBe('403 FORBIDDEN');
    }
  });
  it('the employee still reads their own finalized plan', async () => {
    const mine = await as(subject, 'get', '/api/v1/performance/plans');
    expect(mine.status).toBe(200);
    expect(text(mine.body)).toMatch(/3\.9/);
  });
  it('an authorized reader gets aggregates with small groups suppressed — never SOLO’s score, not even by subtraction', async () => {
    for (const s of [hrAdmin, exec, sysAdmin]) {
      const r = (await as(s, 'get', `/api/v1/performance/cycles/${cycleId}/report`)).body.data;
      expect(r.averageFinalScore).not.toBeNull(); // 7 scored plans overall
      const tinyRow = r.byDepartment.find((d: { departmentName: string }) => d.departmentName === 'Tiny Dept');
      const bigRow = r.byDepartment.find((d: { departmentName: string }) => d.departmentName === 'Big Dept');
      expect(tinyRow).toMatchObject({ averageScore: null, suppression: { suppressed: true, reason: 'SMALL_GROUP' } });
      // complement: overall − Big would be Tiny, so Big's average is withheld too
      expect(bigRow).toMatchObject({ averageScore: null, suppression: { suppressed: true, reason: 'COMPLEMENT' } });
      expect(text(r)).not.toMatch(/"1\.20"/);
      const filtered = (await as(s, 'get', `/api/v1/performance/cycles/${cycleId}/report?departmentId=${tinyId}`)).body.data;
      expect(filtered).toMatchObject({ averageFinalScore: null, suppression: { suppressed: true } });
      expect(filtered.ratingDistribution.every((b: { count: number | null }) => b.count === null)).toBe(true);
      expect(text(filtered)).not.toMatch(/"1\.20"/);
    }
  });
});

describe('T44-P1-07 — executive analytics and Report Center do not isolate small groups', () => {
  it('executive overview filtered to the one-person department shows performance as suppressed, not SOLO’s score', async () => {
    const r = (await as(exec, 'get', `/api/v1/analytics/executive/overview?from=2026-01-01&to=2026-12-31&departmentId=${tinyId}`)).body.data;
    const perf = r.sections.performance;
    expect(text(perf)).not.toMatch(/"1\.20"/);
    expect(perf.cycles[0]).toMatchObject({ averageFinalScore: null, suppression: { suppressed: true } });
  });
  it('an aggregate-only dataset cannot be listed row by row, and groups of fewer than five people are withheld and counted', async () => {
    // per-person datasets (one row per claim, case, letter…) must be aggregated — the row listing was the Task 44 leak
    const rows = await as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'hr_letter_summary', definition: { columns: ['letterType'] } });
    expect(err(rows)).toBe('422 REPORT_AGGREGATION_REQUIRED');
    // one salary certificate = one person: the group is withheld and counted, in the API and in the CSV export
    const letters = await as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'hr_letter_summary', definition: { columns: ['letterType'], groupBy: ['letterType'], aggregations: [{ fieldId: 'letterType', function: 'COUNT' }] } });
    expect(letters.status).toBe(200);
    expect(letters.body.data.rows).toEqual([]);
    expect(letters.body.data.suppression).toMatchObject({ suppressedGroups: 1, minimumGroupSize: 5 });
    const csv = await as(hrAdmin, 'post', '/api/v1/reports/export').send({ datasetId: 'hr_letter_summary', definition: { columns: ['letterType'], groupBy: ['letterType'], aggregations: [{ fieldId: 'letterType', function: 'COUNT' }] } });
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/SUPPRESSED/);
    expect(csv.text).not.toMatch(/SALARY_CERTIFICATE","1"/);
    const payroll = await as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'payroll_period_summary', definition: { columns: ['currencyCode'], groupBy: ['currencyCode'], aggregations: [{ fieldId: 'netTotal', function: 'SUM' }] } });
    expect(payroll.status).toBe(200);
    // the only closed run paid two people: its totals are two salaries, so the group is withheld
    expect(payroll.body.data.rows).toEqual([]);
    expect(payroll.body.data.suppression).toMatchObject({ suppressedGroups: 1, minimumGroupSize: 5 });
    expect(text(payroll.body)).not.toMatch(/96039|40484|55555/);
  });
});

describe('Report Center privacy contract', () => {
  it('every aggregate-only dataset declares how its rows relate to people', async () => {
    const { listDatasets } = await import('../src/modules/reports/registry');
    await import('../src/modules/reports/datasets');
    const missing = listDatasets().filter((d) => d.aggregateOnly && !d.privacy).map((d) => d.id);
    expect(missing).toEqual([]);
    expect(listDatasets().filter((d) => d.aggregateOnly).length).toBeGreaterThanOrEqual(23);
  });
});

describe('T44-P1-20 — salary-bearing letters are readable only by the employee and by payroll authority', () => {
  it('the Task 44 path: an organization-wide service desk without payroll authority reads the letter → content withheld', async () => {
    for (const path of [`/api/v1/employee-services/letters/${E.LETTER}`, '/api/v1/employee-services/letters']) {
      const r = await as(serviceDesk, 'get', path);
      expect(r.status).toBe(200);
      const l = Array.isArray(r.body.data) ? r.body.data[0] : r.body.data;
      expect(l).toMatchObject({ body: null, salaryAmount: null, salaryCurrency: null, subject: null, contentRestricted: true });
      expect(text(r.body)).not.toMatch(/41234|41,234/);
    }
  });
  it('the employee and the payroll-authorized issuer still read it; issuing without payroll authority stays refused', async () => {
    for (const s of [subject, hrAdmin]) {
      const l = (await as(s, 'get', `/api/v1/employee-services/letters/${E.LETTER}`)).body.data;
      expect(l.body).toMatch(/41234\.00 THB/);
      expect(l.salaryAmount).toBe('41234.00');
      expect(l.contentRestricted).toBe(false);
    }
    const letters = await prisma.hrLetter.count();
    expect(err(await as(serviceDesk, 'post', '/api/v1/employee-services/letters').send({ employeeId: subjectId, templateId: E.TPL, issueDate: '2026-05-02' }))).toBe('403 FORBIDDEN');
    expect(await prisma.hrLetter.count()).toBe(letters);
    const audit = await prisma.auditLog.findMany({ where: { module: 'employee_services' } });
    expect(text(audit)).not.toMatch(/41234/);
  });
});

describe('T44-P1-24 — the payroll run export is audited, without its contents', () => {
  it('one EXPORT_PAYROLL_RUN event with run, period and row count; no salary in the event; formula-safe CSV; unknown run is 404', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'EXPORT_PAYROLL_RUN' } });
    const r = await as(hrAdmin, 'get', `/api/v1/payroll/runs/${E.RUN}/export`);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/SUBJ/);
    const events = await prisma.auditLog.findMany({ where: { action: 'EXPORT_PAYROLL_RUN' } });
    expect(events.length).toBe(before + 1);
    const e = events.at(-1)!;
    expect(e).toMatchObject({ module: 'payroll', recordId: E.RUN, userId: hrAdmin.user.id });
    expect(JSON.parse(e.newValue!)).toMatchObject({ rowCount: 2, format: 'CSV' });
    expect(text(e)).not.toMatch(/41234|55555|SUBJ/);
    expect(err(await as(hrAdmin, 'get', '/api/v1/payroll/runs/does-not-exist/export'))).toBe('404 PAYROLL_RUN_NOT_FOUND');
    expect(err(await as(employee, 'get', `/api/v1/payroll/runs/${E.RUN}/export`))).toBe('403 FORBIDDEN');
    expect(await prisma.auditLog.count({ where: { action: 'EXPORT_PAYROLL_RUN' } })).toBe(before + 1);
  });
});

describe('T44-P1-17 — the personal-data export covers every major domain or says why not', () => {
  it('compensation, payroll, attendance, performance, training and documents are exported; exclusions carry reasons; nobody else is in it', async () => {
    const r = await as(hrAdmin, 'post', `/api/v1/privacy/employees/${subjectId}/export`);
    expect(r.status).toBe(200);
    const { data: x, notIncluded } = JSON.parse(r.text);
    expect(x.compensation.history).toEqual([expect.objectContaining({ baseSalary: '41234.00', currencyCode: 'THB', effectiveFrom: '2025-01-01' })]);
    expect(x.payroll.results).toEqual([expect.objectContaining({ netPay: '40484.00', periodLabel: '2026-01', items: [expect.objectContaining({ amount: '41234.00' })] })]);
    expect(x.attendance.records).toEqual([expect.objectContaining({ attendanceDate: '2026-03-02', workMinutes: 480 })]);
    expect(x.performance.plans).toEqual([expect.objectContaining({ cycleName: 'Performance 2026', weightedScore: '3.90', ratingLabel: 'High', status: 'FINALIZED' })]);
    expect(x.training.enrollments).toEqual([expect.objectContaining({ courseTitle: 'Safety basics', status: 'COMPLETED' })]);
    expect(x.documents.owned).toEqual([expect.objectContaining({ title: 'Employment contract SUBJ', fileName: 'contract.pdf' })]);
    for (const key of ['competency', 'recruitment']) expect(x).toHaveProperty(key);
    // Nothing about anybody else: B2's salary and SOLO's score never appear.
    expect(r.text).not.toMatch(/55555|"1\.20"|SOLO/);
    // Every exclusion is stated with a reason; the binaries are named as delivered through the Document Center.
    expect(notIncluded.every((n: { category: string; reason: string }) => n.category && n.reason)).toBe(true);
    expect(text(notIncluded)).toMatch(/document file contents/i);
    expect(text(notIncluded)).not.toMatch(/payroll export rules/);
    // The subject cannot use the admin export to read someone else; an employee has no export permission at all.
    expect(err(await as(subject, 'post', `/api/v1/privacy/employees/${E.B2}/export`))).toBe('403 FORBIDDEN');
  });
});
