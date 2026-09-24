/**
 * Task 30 — Report center.
 *
 * What these tests guard: that a request can never carry SQL, a table, a column or a join; that every field,
 * operator and value is validated server-side against the registry; that a dataset returns the caller's own
 * source scope whoever saved the report; that sharing a report shares nothing but its definition; that grouping,
 * aggregation and export are bounded, decimal-exact and formula-safe; and that the sensitive datasets stay behind
 * their modules' permissions.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORT_LIMITS, csvCell, reportDefinitionSchema } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const err = (r: request.Response) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();
const R = '/api/v1/reports';
const def = (over: Record<string, unknown>) => ({ columns: ['employeeCode'], filters: [], sort: [], groupBy: [], aggregations: [], pageSize: 50, ...over });

let hrAdmin: Session, hr: Session, mgr: Session, otherMgr: Session, emp: Session, exec: Session;
let engDeptId: string, opsDeptId: string, sqlId: string, sharedReportId: string;

beforeAll(async () => {
  await resetDatabase();
  const org = await prisma.organization.create({ data: { code: 'RPT', name: 'Report Co', timezone: 'Asia/Bangkok' } });
  const eng = await prisma.department.create({ data: { organizationId: org.id, code: 'ENG', name: 'Engineering' } });
  const ops = await prisma.department.create({ data: { organizationId: org.id, code: 'OPS', name: '=HYPERLINK("http://x")' } });
  engDeptId = eng.id; opsDeptId = ops.id;
  const job = await prisma.job.create({ data: { code: 'ENG', title: 'Engineer', level: 2 } });
  const pEng = await prisma.position.create({ data: { departmentId: eng.id, code: 'ENG1', title: 'Engineer', jobId: job.id } });
  const pOps = await prisma.position.create({ data: { departmentId: ops.id, code: 'OPS1', title: '+CMD Officer', jobId: job.id } });
  const mk = async (code: string, positionId: string, departmentId: string, managerId: string | null, status = 'ACTIVE') => (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: code === 'EMP005' ? '-CMD' : 'Person', email: `${code.toLowerCase()}@rpt.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: org.id, departmentId, positionId, managerId, employmentType: code === 'EMP004' ? 'CONTRACT' : 'FULL_TIME', employmentStatus: status } })).id;
  const ids: Record<string, string> = {};
  ids.HRADM = await mk('HRADM', pOps.id, ops.id, null);
  ids.MGR = await mk('MGR', pEng.id, eng.id, null);
  ids.OTHERMGR = await mk('OTHERMGR', pOps.id, ops.id, null);
  ids.EMP003 = await mk('EMP003', pEng.id, eng.id, ids.MGR);
  ids.EMP004 = await mk('EMP004', pEng.id, eng.id, ids.MGR);
  ids.EMP005 = await mk('EMP005', pOps.id, ops.id, ids.OTHERMGR);
  ids.EMP006 = await mk('EMP006', pOps.id, ops.id, ids.OTHERMGR, 'INACTIVE');
  await createUser({ email: 'hradmin@rpt.local', password: PW, role: 'HR_ADMIN', employeeId: ids.HRADM });
  await createUser({ email: 'hr@rpt.local', password: PW, role: 'HR' });
  await createUser({ email: 'mgr@rpt.local', password: PW, role: 'MANAGER', employeeId: ids.MGR });
  await createUser({ email: 'othermgr@rpt.local', password: PW, role: 'MANAGER', employeeId: ids.OTHERMGR });
  await createUser({ email: 'emp@rpt.local', password: PW, role: 'EMPLOYEE', employeeId: ids.EMP003 });
  await createUser({ email: 'exec@rpt.local', password: PW, role: 'EXECUTIVE' });
  [hrAdmin, hr, mgr, otherMgr, emp, exec] = await Promise.all(['hradmin', 'hr', 'mgr', 'othermgr', 'emp', 'exec'].map((u) => loginAs(app, `${u}@rpt.local`, PW)));
  // Attendance for EMP003/EMP004 (team of MGR) and EMP005 (other team).
  for (const [code, minutes] of [['EMP003', 480], ['EMP004', 450], ['EMP005', 500]] as const) {
    for (let d = 1; d <= 3; d++) await prisma.attendanceRecord.create({ data: { employeeId: ids[code]!, attendanceDate: `2026-06-0${d}`, dayType: 'WORKDAY', status: d === 2 ? 'LATE' : 'NORMAL', workMinutes: minutes, lateMinutes: d === 2 ? 15 : 0, earlyLeaveMinutes: 0, extraMinutes: 0, calculatedAt: new Date() } });
  }
  // Competency: SQL required 4 on Engineer; EMP003 at 3 (gap), EMP004 unassessed.
  const scale = await prisma.competencyScale.create({ data: { code: 'STD5', name: 'Five', levels: { create: [1, 2, 3, 4, 5].map((level) => ({ level, label: `L${level}` })) } } });
  const category = await prisma.competencyCategory.create({ data: { code: 'CORE', name: 'Core' } });
  sqlId = (await prisma.competency.create({ data: { code: 'SQL', name: 'SQL', categoryId: category.id, scaleId: scale.id } })).id;
  await prisma.jobCompetencyRequirement.create({ data: { jobId: job.id, competencyId: sqlId, requiredLevel: 4 } });
  const cc = await prisma.competencyAssessmentCycle.create({ data: { code: 'C2026', name: 'Competency 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'CLOSED' } });
  await prisma.competencyAssessment.create({ data: { cycleId: cc.id, employeeId: ids.EMP003, employeeCodeSnapshot: 'EMP003', employeeNameSnapshot: 'EMP003 Person', status: 'FINALIZED', finalizedAt: new Date(), items: { create: [{ competencyId: sqlId, competencyCodeSnapshot: 'SQL', competencyNameSnapshot: 'SQL', categorySnapshot: 'Core', requiredLevelSnapshot: 4, finalLevel: 3, managerLevel: 3 }] } } });
  // Payroll: one closed run with exact decimals; ER: one issued action.
  const period = await prisma.payrollPeriod.create({ data: { organizationId: org.id, year: 2026, month: 3, periodStart: '2026-03-01', periodEnd: '2026-03-31', attendanceFrom: '2026-03-01', attendanceTo: '2026-03-31', currencyCode: 'THB', status: 'CLOSED' } });
  await prisma.payrollRun.create({ data: { periodId: period.id, status: 'CLOSED', closedAt: new Date(), startedByUserId: hrAdmin.user.id, employeeCount: 3, grossTotal: '123456.78', deductionTotal: '0.10', netTotal: '123456.68', currencyCode: 'THB' } });
  const at = await prisma.disciplinaryActionType.create({ data: { code: 'WW', name: 'Written warning', severityOrder: 2, requiresWarningLetter: false, requiresAcknowledgement: true } });
  const erCase = await prisma.employeeRelationCase.create({ data: { caseNumber: 'ER-2026-000001', employeeId: ids.EMP005, employeeCodeSnapshot: 'EMP005', employeeNameSnapshot: 'EMP005 -CMD', departmentName: 'Operations', incidentDate: '2026-04-01', title: 'Case', description: 'Narrative that must not be exported', createdByUserId: hrAdmin.user.id } });
  await prisma.disciplinaryAction.create({ data: { caseId: erCase.id, actionTypeId: at.id, actionTypeCodeSnapshot: 'WW', actionTypeNameSnapshot: 'Written warning', employeeId: ids.EMP005, reason: 'Secret reason', status: 'ISSUED', issuedDate: '2026-04-10', requiresWarningLetter: false, requiresAcknowledgement: true, createdByUserId: hrAdmin.user.id } });
}, 180000);

afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('no SQL, strict definitions', () => {
  it('the definition schema rejects anything that is not a registry reference', () => {
    for (const bad of [{ sql: 'SELECT 1' }, { where: 'x' }, { table: 'users' }, { join: 'payroll' }, { selectRaw: '*' }, { orderByRaw: 'id' }, { columns: ['employeeCode'], filters: [{ fieldId: 'x', operator: 'LIKE', value: 'y' }] }, { columns: ['employeeCode; DROP TABLE'] }, { columns: [] }, { columns: Array.from({ length: 31 }, (_, i) => `c${i}`) }]) {
      expect(reportDefinitionSchema.safeParse({ columns: ['employeeCode'], ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+CMD')).toBe(`"'+CMD"`);
    expect(csvCell('-CMD')).toBe(`"'-CMD"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('123456.68')).toBe('"123456.68"');
  });

  it('the API refuses unknown datasets, unknown fields, disallowed operators, bad values and over-cap definitions', async () => {
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'users', definition: def({}), page: 1 }))).toBe('404 REPORT_DATASET_NOT_FOUND');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ columns: ['salary'] }), page: 1 }))).toBe('422 REPORT_FIELD_UNKNOWN');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ filters: [{ fieldId: 'employeeCode', operator: 'GT', value: 'x' }] }), page: 1 }))).toBe('422 REPORT_OPERATOR_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ filters: [{ fieldId: 'employmentStatus', operator: 'EQ', value: 'ROBOT' }] }), page: 1 }))).toBe('422 REPORT_FILTER_VALUE_INVALID');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ filters: [{ fieldId: 'hireDate', operator: 'BEFORE', value: 'yesterday' }] }), page: 1 }))).toBe('422 REPORT_FILTER_VALUE_INVALID');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ sort: [{ fieldId: 'job', direction: 'ASC' }] }), page: 1 }))).toBe('422 REPORT_SORT_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ columns: ['department'], groupBy: ['department'] }), page: 1 }))).toBe('422 REPORT_AGGREGATION_REQUIRED');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ aggregations: [{ fieldId: 'employeeCode', function: 'SUM' }] }), page: 1 }))).toBe('422 REPORT_AGGREGATION_NOT_ALLOWED');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'attendance_summary', definition: def({ columns: ['attendanceDate'] }), page: 1 }))).toBe('422 REPORT_DATE_RANGE_REQUIRED');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'attendance_summary', definition: def({ columns: ['attendanceDate'], filters: [{ fieldId: 'attendanceDate', operator: 'BETWEEN', value: ['2024-01-01', '2026-12-31'] }] }), page: 1 }))).toBe('422 REPORT_DATE_RANGE_TOO_LARGE');
    expect(err(await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: { ...def({}), sql: 'SELECT 1' }, page: 1 }))).toBe('400 VALIDATION_ERROR');
  });
});

describe('datasets and scope', () => {
  it('lists only datasets the caller may use; the executive sees aggregate-only datasets', async () => {
    const ids = (s: Session) => as(s, 'get', `${R}/datasets`).then((r) => (r.body.data ?? []).map((d: { id: string }) => d.id) as string[]);
    expect((await ids(hrAdmin)).sort()).toEqual(['attendance_summary', 'competency_gaps', 'employee_directory', 'employee_relations_aggregate', 'headcount_summary', 'leave_requests', 'organization_design_summary', 'overtime_approved', 'payroll_period_summary', 'performance_results', 'recruitment_applications', 'talent_review_summary', 'training_history', 'workforce_plan_summary']);
    const m = await ids(mgr);
    expect(m).toContain('employee_directory');
    expect(m).not.toContain('employee_relations_aggregate');
    expect(m).not.toContain('payroll_period_summary');
    expect(m).not.toContain('recruitment_applications');
    expect(m).not.toContain('competency_gaps');
    expect((await ids(exec)).sort()).toEqual(['headcount_summary', 'organization_design_summary', 'workforce_plan_summary']); // Task 32 datasets are aggregate-only
    expect((await as(emp, 'get', `${R}/datasets`)).status).toBe(403);
    const fields = (await as(hrAdmin, 'get', `${R}/datasets`)).body.data.find((d: { id: string }) => d.id === 'employee_directory').fields.map((f: { id: string }) => f.id);
    expect(fields).not.toEqual(expect.arrayContaining(['email', 'phone', 'salary', 'baseSalary', 'potentialComment', 'storageKey']));
    expect(JSON.stringify((await as(hrAdmin, 'get', `${R}/datasets`)).body.data)).not.toMatch(/"column"|groupKey|delegate/);
  });

  it('a manager gets TEAM rows only, and cannot widen the scope through the definition', async () => {
    const r = await as(mgr, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ columns: ['employeeCode', 'department'] }), page: 1 });
    expect(err(r)).toBe('200');
    expect(r.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode).sort()).toEqual(['EMP003', 'EMP004', 'MGR']);
    const att = await as(mgr, 'post', `${R}/run`).send({ datasetId: 'attendance_summary', definition: def({ columns: ['employeeCode', 'attendanceDate', 'status', 'workMinutes'], filters: [{ fieldId: 'attendanceDate', operator: 'BETWEEN', value: ['2026-06-01', '2026-06-30'] }] }), page: 1 });
    expect(att.body.data.meta.total).toBe(6);
    expect(new Set(att.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode))).toEqual(new Set(['EMP003', 'EMP004']));
    // An "all" scope cannot be asked for: there is no such field, and a filter on somebody else's code returns nothing.
    const widen = await as(mgr, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ filters: [{ fieldId: 'employeeCode', operator: 'EQ', value: 'EMP005' }] }), page: 1 });
    expect(widen.body.data.rows).toEqual([]);
    expect(err(await as(mgr, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: { ...def({}), scope: 'ALL' }, page: 1 }))).toBe('400 VALIDATION_ERROR');
    expect(err(await as(mgr, 'post', `${R}/run`).send({ datasetId: 'employee_relations_aggregate', definition: def({ columns: ['department'], groupBy: ['department'], aggregations: [{ fieldId: 'actions', function: 'COUNT' }] }), page: 1 }))).toBe('404 REPORT_DATASET_NOT_FOUND');
    expect(err(await as(exec, 'post', `${R}/run`).send({ datasetId: 'payroll_period_summary', definition: def({ columns: ['netTotal'] }), page: 1 }))).toBe('404 REPORT_DATASET_NOT_FOUND');
    expect(err(await as(exec, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({}), page: 1 }))).toBe('404 REPORT_DATASET_NOT_FOUND');
  });

  it('grouping and aggregation run in the database and match the source counts', async () => {
    const r = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_directory', definition: def({ columns: ['department'], filters: [{ fieldId: 'employmentStatus', operator: 'EQ', value: 'ACTIVE' }], groupBy: ['department'], aggregations: [{ fieldId: 'employeeCode', function: 'COUNT', alias: 'Employees' }, { fieldId: 'employmentType', function: 'COUNT_DISTINCT', alias: 'Types' }] }), page: 1 });
    expect(err(r), JSON.stringify(r.body)).toBe('200');
    expect(r.body.data.meta.grouped).toBe(true);
    const rows = Object.fromEntries(r.body.data.rows.map((x: { department: string; Employees: number; Types: number }) => [x.department, x]));
    expect(rows.Engineering).toMatchObject({ Employees: 3, Types: 2 });
    expect(rows['=HYPERLINK("http://x")']).toMatchObject({ Employees: 3, Types: 1 });
    expect(await prisma.employee.count({ where: { departmentId: engDeptId, employmentStatus: 'ACTIVE' } })).toBe(3);
    const hc = await as(exec, 'post', `${R}/run`).send({ datasetId: 'headcount_summary', definition: def({ columns: ['employmentStatus'], groupBy: ['employmentStatus'], aggregations: [{ fieldId: 'employees', function: 'COUNT' }] }), page: 1 });
    expect(hc.body.data.rows.find((x: { employmentStatus: string }) => x.employmentStatus === 'ACTIVE').employees_count).toBe(6);
    const att = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'attendance_summary', definition: def({ columns: ['status'], filters: [{ fieldId: 'attendanceDate', operator: 'BETWEEN', value: ['2026-06-01', '2026-06-30'] }], groupBy: ['status'], aggregations: [{ fieldId: 'workMinutes', function: 'SUM', alias: 'Minutes' }, { fieldId: 'lateMinutes', function: 'AVG', alias: 'AvgLate' }, { fieldId: 'workMinutes', function: 'MAX', alias: 'Max' }] }), page: 1 });
    const late = att.body.data.rows.find((x: { status: string }) => x.status === 'LATE');
    expect(late).toMatchObject({ Minutes: 1430, Max: 500 }); // integer columns aggregate as numbers; decimals stay strings (payroll below)
    expect(Number(late.AvgLate)).toBe(15);
  });

  it('competency gaps use the competency module’s rule: not assessed is not a gap', async () => {
    const r = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'competency_gaps', definition: def({ columns: ['employeeCode', 'competency', 'currentLevel', 'requiredLevel', 'gapNeeded', 'status'], filters: [{ fieldId: 'competencyCode', operator: 'EQ', value: 'SQL' }], sort: [{ fieldId: 'employeeCode', direction: 'ASC' }] }), page: 1 });
    expect(err(r)).toBe('200');
    const byCode = Object.fromEntries(r.body.data.rows.map((x: { employeeCode: string }) => [x.employeeCode, x]));
    expect(byCode.EMP003).toMatchObject({ currentLevel: 3, requiredLevel: 4, gapNeeded: 1, status: 'GAP' });
    expect(byCode.EMP004).toMatchObject({ currentLevel: null, gapNeeded: null, status: 'UNASSESSED' });
    const gapsOnly = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'competency_gaps', definition: def({ columns: ['employeeCode'], filters: [{ fieldId: 'competencyCode', operator: 'EQ', value: 'SQL' }, { fieldId: 'status', operator: 'EQ', value: 'GAP' }] }), page: 1 });
    expect(gapsOnly.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode)).toEqual(['EMP003']);
    expect(err(await as(mgr, 'post', `${R}/run`).send({ datasetId: 'competency_gaps', definition: def({}), page: 1 }))).toBe('404 REPORT_DATASET_NOT_FOUND');
  });

  it('payroll totals stay decimal strings; the ER dataset is counts only', async () => {
    const p = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'payroll_period_summary', definition: def({ columns: ['year', 'month', 'employeeCount', 'grossTotal', 'netTotal'] }), page: 1 });
    expect(p.body.data.rows[0]).toMatchObject({ grossTotal: '123456.78', netTotal: '123456.68', employeeCount: 3 });
    const sum = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'payroll_period_summary', definition: def({ columns: ['currencyCode'], groupBy: ['currencyCode'], aggregations: [{ fieldId: 'netTotal', function: 'SUM', alias: 'Net' }] }), page: 1 });
    expect(sum.body.data.rows[0].Net).toBe('123456.68');
    const er = await as(hrAdmin, 'post', `${R}/run`).send({ datasetId: 'employee_relations_aggregate', definition: def({ columns: ['department', 'actionType'], groupBy: ['department', 'actionType'], aggregations: [{ fieldId: 'actions', function: 'COUNT', alias: 'Count' }] }), page: 1 });
    expect(er.body.data.rows).toEqual([{ department: 'Operations', actionType: 'Written warning', Count: 1 }]);
    expect(JSON.stringify(er.body.data)).not.toMatch(/EMP005|Secret reason|Narrative|ER-2026/);
  });
});

describe('saved reports, sharing and export', () => {
  it('HR saves a SHARED recruitment report; a manager without recruitment authority does not see it, cannot run or export it', async () => {
    const created = await as(hrAdmin, 'post', `${R}/saved`).send({ name: 'Applications by stage', datasetId: 'recruitment_applications', visibility: 'SHARED', definition: def({ columns: ['stage'], filters: [{ fieldId: 'appliedAt', operator: 'BETWEEN', value: ['2026-01-01', '2026-12-31'] }], groupBy: ['stage'], aggregations: [{ fieldId: 'applicationNumber', function: 'COUNT' }] }) });
    expect(err(created)).toBe('201');
    sharedReportId = created.body.data.id;
    expect((await as(mgr, 'get', `${R}/saved`)).body.data.map((r: { id: string }) => r.id)).not.toContain(sharedReportId);
    expect(err(await as(mgr, 'get', `${R}/saved/${sharedReportId}`))).toBe('404 REPORT_NOT_FOUND');
    expect(err(await as(mgr, 'post', `${R}/saved/${sharedReportId}/run`).send({ page: 1 }))).toBe('404 REPORT_NOT_FOUND');
    expect((await as(mgr, 'get', `${R}/saved/${sharedReportId}/export`)).status).toBe(404);
    expect((await as(hr, 'get', `${R}/saved`)).body.data.map((r: { id: string }) => r.id)).toContain(sharedReportId); // HR holds recruitment.manage
    expect(err(await as(mgr, 'post', `${R}/saved`).send({ name: 'x', datasetId: 'employee_directory', visibility: 'SHARED', definition: def({}) }))).toBe('403 FORBIDDEN'); // no reports.share
  });

  it('a shared employee-directory report runs in the runner’s scope, not the author’s', async () => {
    const created = await as(hrAdmin, 'post', `${R}/saved`).send({ name: 'All active employees', datasetId: 'employee_directory', visibility: 'SHARED', definition: def({ columns: ['employeeCode', 'department'], filters: [{ fieldId: 'employmentStatus', operator: 'EQ', value: 'ACTIVE' }] }) });
    const id = created.body.data.id;
    expect((await as(hrAdmin, 'post', `${R}/saved/${id}/run`).send({ page: 1 })).body.data.meta.total).toBe(6);
    const asManager = await as(mgr, 'post', `${R}/saved/${id}/run`).send({ page: 1 });
    expect(err(asManager)).toBe('200');
    expect(asManager.body.data.rows.map((x: { employeeCode: string }) => x.employeeCode).sort()).toEqual(['EMP003', 'EMP004', 'MGR']);
    expect(err(await as(mgr, 'patch', `${R}/saved/${id}`).send({ name: 'Renamed' }))).toBe('404 REPORT_NOT_FOUND');
    expect(err(await as(mgr, 'delete', `${R}/saved/${id}`))).toBe('404 REPORT_NOT_FOUND');
    const mine = await as(mgr, 'post', `${R}/saved`).send({ name: 'My team', datasetId: 'employee_directory', definition: def({}) });
    expect(err(mine)).toBe('201');
    expect((await as(hrAdmin, 'get', `${R}/saved`)).body.data.map((r: { id: string }) => r.id)).not.toContain(mine.body.data.id); // PRIVATE
    expect((await as(mgr, 'delete', `${R}/saved/${mine.body.data.id}`)).status).toBe(204);
    expect(await prisma.employee.count()).toBe(7); // deleting a definition deletes no business data
  });

  it('CSV export is formula-safe, decimal-exact, permission-bound and audited; over the cap it fails deterministically', async () => {
    const r = await as(hrAdmin, 'post', `${R}/export`).send({ datasetId: 'employee_directory', name: 'Directory export', definition: def({ columns: ['employeeCode', 'lastName', 'department', 'position'], sort: [{ fieldId: 'employeeCode', direction: 'ASC' }] }) });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('Directory-export.csv');
    expect(r.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(r.text).toContain(`"'+CMD Officer"`);
    expect(r.text).toContain(`"'-CMD"`);
    const pay = await as(hrAdmin, 'post', `${R}/export`).send({ datasetId: 'payroll_period_summary', definition: def({ columns: ['year', 'month', 'grossTotal', 'netTotal'] }) });
    expect(pay.text).toContain('"123456.78","123456.68"');
    expect((await as(mgr, 'post', `${R}/export`).send({ datasetId: 'payroll_period_summary', definition: def({ columns: ['netTotal'] }) })).status).toBe(404);
    expect((await as(emp, 'post', `${R}/export`).send({ datasetId: 'employee_directory', definition: def({}) })).status).toBe(403);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'EXPORT_REPORT', module: 'reports' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(audit!.newValue!)).toMatchObject({ datasetId: 'payroll_period_summary', rowCount: 1 });
    expect(JSON.stringify(audit?.newValue)).not.toContain('123456');
    // Over the cap: a deterministic 413 before any rows are built.
    const original = REPORT_LIMITS.exportRows;
    (REPORT_LIMITS as { exportRows: number }).exportRows = 2;
    try {
      const big = await as(hrAdmin, 'post', `${R}/export`).send({ datasetId: 'employee_directory', definition: def({}) });
      expect(err(big)).toBe('413 REPORT_EXPORT_TOO_LARGE');
    } finally { (REPORT_LIMITS as { exportRows: number }).exportRows = original; }
  });

  it('templates are served for accessible datasets only and never carry privileged columns', async () => {
    const t = await as(exec, 'get', `${R}/templates`);
    expect(t.body.data.map((x: { datasetId: string }) => x.datasetId)).toEqual(['headcount_summary']);
    const all = await as(hrAdmin, 'get', `${R}/templates`);
    expect(all.body.data.length).toBeGreaterThan(5);
    expect(JSON.stringify(all.body.data)).not.toMatch(/salary|netPay|potentialComment|storageKey/);
  });
});
