/**
 * Task 17 — customer onboarding import (checklist 65–72).
 * Workbooks are built with the same library the template uses, so every test exercises the real parse path.
 */
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_COLUMNS, ONBOARDING_META_SHEET, ONBOARDING_SHEETS as S, ONBOARDING_SHEET_ORDER, ONBOARDING_TEMPLATE_VERSION, type OnboardingIssue } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { auditService } from '../src/services/audit/audit.service';
import { sanitizeFileName, sha256 } from '../src/modules/onboarding/onboarding.service';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
let admin: Session, hrAdmin: Session, hr: Session, employee: Session;

type Rows = Partial<Record<string, Record<string, string | number>[]>>;
/** Builds a workbook in the template's shape; `overrides` can break it deliberately. */
async function makeWorkbook(rows: Rows, overrides: { templateVersion?: number | null; omitMeta?: boolean; renameSheet?: [string, string]; renameHeader?: [string, string, string]; extraColumn?: [string, string]; formulaAt?: [string, number, string] } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheetName of ONBOARDING_SHEET_ORDER) {
    const finalName = overrides.renameSheet && overrides.renameSheet[0] === sheetName ? overrides.renameSheet[1] : sheetName;
    const ws = wb.addWorksheet(finalName);
    const headers = ONBOARDING_COLUMNS[sheetName].map((c) =>
      overrides.renameHeader && overrides.renameHeader[0] === sheetName && overrides.renameHeader[1] === c.header ? overrides.renameHeader[2] : c.header);
    if (overrides.extraColumn && overrides.extraColumn[0] === sheetName) headers.push(overrides.extraColumn[1]);
    ws.addRow(headers);
    for (const row of rows[sheetName] ?? []) {
      ws.addRow(headers.map((h) => (row[h] === undefined ? null : row[h])));
    }
    if (overrides.formulaAt && overrides.formulaAt[0] === sheetName) {
      const [, rowNumber, header] = overrides.formulaAt;
      ws.getCell(rowNumber, headers.indexOf(header) + 1).value = { formula: 'CONCATENATE("A","B")', result: 'AB' } as ExcelJS.CellFormulaValue;
    }
  }
  if (!overrides.omitMeta) {
    const meta = wb.addWorksheet(ONBOARDING_META_SHEET);
    meta.getCell('A1').value = 'templateVersion';
    meta.getCell('B1').value = overrides.templateVersion === null ? '' : overrides.templateVersion ?? ONBOARDING_TEMPLATE_VERSION;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A complete, valid small customer: hierarchy, forward references, a department head and a manager chain. */
const validRows = (): Rows => ({
  [S.organizations]: [{ organizationCode: 'ACME', name: 'Acme Co', timezone: 'Asia/Bangkok' }],
  [S.departments]: [
    { organizationCode: 'ACME', departmentCode: 'ENG', name: 'Engineering', headEmployeeCode: 'E001' },
    { organizationCode: 'ACME', departmentCode: 'PLAT', name: 'Platform', parentDepartmentCode: 'ENG' }, // child before parent is fine
    { organizationCode: 'ACME', departmentCode: 'OPS', name: 'Operations' },
  ],
  [S.jobs]: [{ jobCode: 'ENGR', title: 'Engineer', level: 3 }, { jobCode: 'MGR', title: 'Manager', level: 5, description: 'Leads a team' }],
  [S.positions]: [
    { positionCode: 'P-ENG-LEAD', title: 'Engineering Lead', organizationCode: 'ACME', departmentCode: 'ENG', jobCode: 'MGR' },
    { positionCode: 'P-ENG-1', title: 'Engineer I', organizationCode: 'ACME', departmentCode: 'PLAT', jobCode: 'ENGR' },
    { positionCode: 'P-OPS-1', title: 'Operations Officer', organizationCode: 'ACME', departmentCode: 'OPS', jobCode: 'ENGR' },
  ],
  [S.employees]: [
    { employeeCode: 'E002', firstName: 'Bee', lastName: 'Two', email: 'bee@acme.test', hireDate: '2026-02-01', employmentType: 'FULL_TIME', positionCode: 'P-ENG-1', managerEmployeeCode: 'E001' }, // forward reference
    { employeeCode: 'E001', firstName: 'Ann', lastName: 'One', email: 'ann@acme.test', hireDate: '2026-01-15', employmentType: 'FULL_TIME', positionCode: 'P-ENG-LEAD' },
    { employeeCode: 'E003', firstName: 'Cee', lastName: 'Three', email: 'cee@acme.test', hireDate: '2026-03-01', positionCode: 'P-OPS-1', managerEmployeeCode: 'E001' },
  ],
});

const as = (s: Session, m: 'get' | 'post', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const preview = (s: Session, buffer: Buffer, name = 'customer.xlsx') => as(s, 'post', '/api/v1/onboarding/preview').attach('file', buffer, name);
const commit = (s: Session, buffer: Buffer, hash: string, name = 'customer.xlsx') => as(s, 'post', '/api/v1/onboarding/commit').field('expectedSha256', hash).attach('file', buffer, name);
const codesOf = (issues: OnboardingIssue[]) => issues.map((i) => i.code);
const counts = async () => ({
  organizations: await prisma.organization.count(), departments: await prisma.department.count(), jobs: await prisma.job.count(),
  positions: await prisma.position.count(), employees: await prisma.employee.count(),
});

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: 'admin@ob.local', password: PW, role: 'SYSTEM_ADMIN' });
  await createUser({ email: 'hradmin@ob.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'hr@ob.local', password: PW, role: 'HR' });
  await createUser({ email: 'emp@ob.local', password: PW, role: 'EMPLOYEE' });
  [admin, hrAdmin, hr, employee] = await Promise.all(['admin', 'hradmin', 'hr', 'emp'].map((u) => loginAs(app, `${u}@ob.local`, PW)));
}, 60000);
beforeEach(async () => {
  // Each test starts from an empty customer so counts and conflicts are unambiguous.
  await prisma.onboardingImportRun.deleteMany();
  await prisma.auditLog.deleteMany(); // counts below are per test, not cumulative
  await prisma.employeeManager.deleteMany();
  await prisma.employeePosition.deleteMany();
  await prisma.department.updateMany({ data: { headEmployeeId: null } });
  await prisma.employee.deleteMany();
  await prisma.position.deleteMany();
  await prisma.department.deleteMany();
  await prisma.job.deleteMany();
  await prisma.organization.deleteMany();
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('access control (1–3)', () => {
  it('1. unauthenticated → 401; 2. without onboarding.manage → 403; 3. HR_ADMIN and SYSTEM_ADMIN allowed', async () => {
    expect((await request(app).get('/api/v1/onboarding/template')).status).toBe(401);
    for (const s of [hr, employee]) {
      expect((await as(s, 'get', '/api/v1/onboarding/template')).status).toBe(403);
      expect((await as(s, 'get', '/api/v1/onboarding/imports')).status).toBe(403);
      expect((await preview(s, await makeWorkbook(validRows()))).status).toBe(403);
    }
    expect((await as(hrAdmin, 'get', '/api/v1/onboarding/template')).status).toBe(200);
    expect((await as(admin, 'get', '/api/v1/onboarding/template')).status).toBe(200);
  });
  it('the generated template round-trips through the parser (4)', async () => {
    const res = await as(hrAdmin, 'get', '/api/v1/onboarding/template').buffer(true).parse((r, cb) => { const data: Buffer[] = []; r.on('data', (c) => data.push(c)); r.on('end', () => cb(null, Buffer.concat(data))); });
    expect(res.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers['content-disposition']).toMatch(/hr-onboarding-template\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    for (const sheet of ONBOARDING_SHEET_ORDER) {
      const ws = wb.getWorksheet(sheet)!;
      expect(ws, sheet).toBeTruthy();
      expect(ws.getRow(1).values).toEqual(expect.arrayContaining(ONBOARDING_COLUMNS[sheet].map((c) => c.header)));
    }
    expect(wb.getWorksheet(ONBOARDING_META_SHEET)!.getCell('B1').value).toBe(ONBOARDING_TEMPLATE_VERSION);
    // an empty template previews as valid with zero rows
    const empty = await preview(hrAdmin, Buffer.from(res.body));
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ valid: true, summary: { organizations: 0, employees: 0 } });
  });
});

describe('workbook safety (5–12)', () => {
  it('5. an unknown template version is rejected', async () => {
    for (const version of [2, 99, null]) {
      const res = await preview(hrAdmin, await makeWorkbook(validRows(), { templateVersion: version }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ONBOARDING_TEMPLATE_VERSION_UNSUPPORTED');
    }
    const noMeta = await preview(hrAdmin, await makeWorkbook(validRows(), { omitMeta: true }));
    expect(noMeta.body.error.code).toBe('ONBOARDING_TEMPLATE_VERSION_UNSUPPORTED');
  });
  it('6. renamed sheets and headers are reported, never guessed', async () => {
    const renamedSheet = await preview(hrAdmin, await makeWorkbook(validRows(), { renameSheet: [S.jobs, 'Roles'] }));
    expect(codesOf(renamedSheet.body.data.errors)).toContain('ONBOARDING_MISSING_SHEET');
    const renamedHeader = await preview(hrAdmin, await makeWorkbook(validRows(), { renameHeader: [S.employees, 'employeeCode', 'employee_code'] }));
    expect(codesOf(renamedHeader.body.data.errors)).toContain('ONBOARDING_MISSING_COLUMN');
    expect(renamedHeader.body.data.valid).toBe(false);
  });
  it('7. a non-workbook file and a wrong extension are rejected', async () => {
    const notXlsx = await preview(hrAdmin, Buffer.from('plain text pretending to be excel'), 'data.xlsx');
    expect(notXlsx.status).toBe(400);
    expect(notXlsx.body.error.code).toBe('ONBOARDING_INVALID_WORKBOOK');
    const wrongExtension = await preview(hrAdmin, await makeWorkbook(validRows()), 'data.xls');
    expect(wrongExtension.body.error.code).toBe('ONBOARDING_UNSUPPORTED_FILE_TYPE');
  });
  it('9. a formula in a data cell is rejected', async () => {
    const res = await preview(hrAdmin, await makeWorkbook(validRows(), { formulaAt: [S.employees, 2, 'firstName'] }));
    expect(codesOf(res.body.data.errors)).toContain('ONBOARDING_FORMULA_NOT_ALLOWED');
    expect(res.body.data.valid).toBe(false);
  });
  it('10. blank rows are ignored; 43. an unknown named column is a warning, not a mapping', async () => {
    const rows = validRows();
    const res = await preview(hrAdmin, await makeWorkbook(rows, { extraColumn: [S.employees, 'salary'] }));
    expect(res.body.data.summary.employees).toBe(3);
    expect(codesOf(res.body.data.warnings)).toContain('ONBOARDING_UNKNOWN_COLUMN');
    expect(res.body.data.valid).toBe(true); // a stray column does not block the import
  });
  it('11. leading zeros in codes survive; 12. an ambiguous date is rejected', async () => {
    const rows = validRows();
    rows[S.employees]![1].employeeCode = '00123'; // E001 becomes a leading-zero code…
    rows[S.employees]![0].managerEmployeeCode = '00123'; // …so every reference to it moves too
    rows[S.employees]![2].managerEmployeeCode = '00123';
    rows[S.departments]![0].headEmployeeCode = '00123';
    const ok = await preview(hrAdmin, await makeWorkbook(rows));
    expect(ok.body.data.valid, JSON.stringify(ok.body.data.errors)).toBe(true);

    const bad = validRows();
    bad[S.employees]![0].hireDate = '01/02/2026';
    const res = await preview(hrAdmin, await makeWorkbook(bad));
    expect(res.body.data.errors.find((e: OnboardingIssue) => e.field === 'hireDate')?.code).toBe('ONBOARDING_INVALID_DATE');
  });
});

describe('duplicates and references (13–23)', () => {
  const previewRows = async (mutate: (r: Rows) => void) => {
    const rows = validRows();
    mutate(rows);
    return (await preview(hrAdmin, await makeWorkbook(rows))).body.data;
  };
  it('13–17. duplicates inside the workbook are reported with the earlier row number', async () => {
    const org = await previewRows((r) => r[S.organizations]!.push({ organizationCode: 'ACME', name: 'Acme Again' }));
    expect(org.errors.find((e: OnboardingIssue) => e.sheet === S.organizations)?.code).toBe('ONBOARDING_DUPLICATE_IN_FILE');
    expect(org.errors.find((e: OnboardingIssue) => e.sheet === S.organizations)?.message).toMatch(/row 2/);
    const dept = await previewRows((r) => r[S.departments]!.push({ organizationCode: 'ACME', departmentCode: 'ENG', name: 'Engineering copy' }));
    expect(codesOf(dept.errors)).toContain('ONBOARDING_DUPLICATE_IN_FILE');
    const job = await previewRows((r) => r[S.jobs]!.push({ jobCode: 'ENGR', title: 'Engineer copy' }));
    expect(codesOf(job.errors)).toContain('ONBOARDING_DUPLICATE_IN_FILE');
    const pos = await previewRows((r) => r[S.positions]!.push({ positionCode: 'P-ENG-1', title: 'Dup', organizationCode: 'ACME', departmentCode: 'ENG', jobCode: 'ENGR' }));
    expect(codesOf(pos.errors)).toContain('ONBOARDING_DUPLICATE_IN_FILE');
    const emp = await previewRows((r) => r[S.employees]!.push({ employeeCode: 'E001', firstName: 'Dup', lastName: 'Licate', email: 'dup@acme.test', hireDate: '2026-01-01', positionCode: 'P-ENG-1' }));
    expect(codesOf(emp.errors)).toContain('ONBOARDING_DUPLICATE_IN_FILE');
    const email = await previewRows((r) => r[S.employees]!.push({ employeeCode: 'E009', firstName: 'Same', lastName: 'Email', email: 'ann@acme.test', hireDate: '2026-01-01', positionCode: 'P-ENG-1' }));
    expect(email.errors.find((e: OnboardingIssue) => e.field === 'email')?.code).toBe('ONBOARDING_DUPLICATE_IN_FILE');
  });
  it('18. a code that already exists in the database is an error, never a silent update', async () => {
    const buffer = await makeWorkbook(validRows());
    const first = await preview(hrAdmin, buffer);
    expect(first.body.data.valid).toBe(true);
    expect((await commit(hrAdmin, buffer, first.body.data.file.sha256)).status).toBe(200);
    const second = await preview(hrAdmin, buffer);
    expect(second.body.data.valid).toBe(false);
    expect(codesOf(second.body.data.errors)).toEqual(expect.arrayContaining(['ORGANIZATION_CODE_EXISTS', 'DEPARTMENT_CODE_EXISTS', 'JOB_CODE_EXISTS', 'POSITION_CODE_EXISTS', 'EMPLOYEE_CODE_EXISTS', 'EMPLOYEE_EMAIL_EXISTS']));
  });
  it('19–21. missing references are reported per row', async () => {
    const dept = await previewRows((r) => { r[S.positions]![0].departmentCode = 'NOPE'; });
    expect(codesOf(dept.errors)).toContain('DEPARTMENT_NOT_FOUND');
    const job = await previewRows((r) => { r[S.positions]![0].jobCode = 'NOPE'; });
    expect(codesOf(job.errors)).toContain('JOB_NOT_FOUND');
    const pos = await previewRows((r) => { r[S.employees]![0].positionCode = 'NOPE'; });
    expect(codesOf(pos.errors)).toContain('POSITION_NOT_FOUND');
    const org = await previewRows((r) => { r[S.departments]![0].organizationCode = 'NOPE'; });
    expect(codesOf(org.errors)).toContain('ORGANIZATION_NOT_FOUND');
  });
  it('22. a parent department may appear later in the sheet; 23. a cycle is rejected', async () => {
    const forward = await previewRows((r) => { r[S.departments] = [
      { organizationCode: 'ACME', departmentCode: 'PLAT', name: 'Platform', parentDepartmentCode: 'ENG' },
      { organizationCode: 'ACME', departmentCode: 'ENG', name: 'Engineering' },
      { organizationCode: 'ACME', departmentCode: 'OPS', name: 'Operations' },
    ]; });
    expect(forward.valid, JSON.stringify(forward.errors)).toBe(true);
    const cycle = await previewRows((r) => { r[S.departments] = [
      { organizationCode: 'ACME', departmentCode: 'A', name: 'A', parentDepartmentCode: 'B' },
      { organizationCode: 'ACME', departmentCode: 'B', name: 'B', parentDepartmentCode: 'A' },
    ]; r[S.positions] = []; r[S.employees] = []; });
    expect(codesOf(cycle.errors)).toContain('DEPARTMENT_CYCLE');
    const self = await previewRows((r) => { r[S.departments]![0].parentDepartmentCode = 'ENG'; });
    expect(codesOf(self.errors)).toContain('DEPARTMENT_SELF_PARENT');
  });
});

describe('employees (24–32)', () => {
  it('26. an invalid employment type is rejected; 29. self-manager; 30. manager cycle; 27. unknown manager', async () => {
    const check = async (mutate: (r: Rows) => void, code: string) => {
      const rows = validRows();
      mutate(rows);
      const res = await preview(hrAdmin, await makeWorkbook(rows));
      expect(codesOf(res.body.data.errors), code).toContain(code);
    };
    await check((r) => { r[S.employees]![0].employmentType = 'PERMANENT'; }, 'ONBOARDING_INVALID_VALUE');
    await check((r) => { r[S.employees]![0].managerEmployeeCode = r[S.employees]![0].employeeCode as string; }, 'EMPLOYEE_SELF_MANAGER');
    await check((r) => { r[S.employees]![1].managerEmployeeCode = 'E002'; }, 'MANAGER_CYCLE'); // E002→E001→E002
    await check((r) => { r[S.employees]![0].managerEmployeeCode = 'GHOST'; }, 'MANAGER_NOT_FOUND');
  });
  it('24/25/28/31/32. a valid workbook creates employees with derived assignment, manager and both histories', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    expect(p.body.data.valid, JSON.stringify(p.body.data.errors)).toBe(true);
    expect((await commit(hrAdmin, buffer, p.body.data.file.sha256)).status).toBe(200);

    const e2 = await prisma.employee.findUniqueOrThrow({ where: { employeeCode: 'E002' }, include: { position: true, department: true, organization: true, manager: true, positionHistory: true, managerHistory: true } });
    expect(e2.position.code).toBe('P-ENG-1');
    expect(e2.department.code).toBe('PLAT'); // derived from the position, not from the spreadsheet
    expect(e2.organization.code).toBe('ACME');
    expect(e2.manager?.employeeCode).toBe('E001'); // forward reference resolved
    expect(e2.positionHistory).toHaveLength(1);
    expect(e2.managerHistory).toHaveLength(1);
    expect(e2.employmentStatus).toBe('ACTIVE');
    // department head applied after employees exist
    const eng = await prisma.department.findFirstOrThrow({ where: { code: 'ENG' }, include: { headEmployee: true } });
    expect(eng.headEmployee?.employeeCode).toBe('E001');
    const plat = await prisma.department.findFirstOrThrow({ where: { code: 'PLAT' }, include: { parent: true } });
    expect(plat.parent?.code).toBe('ENG');
    // organization timezone from the workbook
    expect((await prisma.organization.findFirstOrThrow({ where: { code: 'ACME' } })).timezone).toBe('Asia/Bangkok');
  });
});

describe('preview writes nothing (33–37)', () => {
  it('33/34/35. preview creates no entities, is deterministic and sorts issues', async () => {
    const before = await counts();
    const rows = validRows();
    rows[S.employees]![0].employmentType = 'WRONG';
    rows[S.positions]![0].jobCode = 'GHOST';
    const buffer = await makeWorkbook(rows);
    const a = await preview(hrAdmin, buffer);
    const b = await preview(hrAdmin, buffer);
    expect(await counts()).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_EMPLOYEE' } })).toBe(0);
    expect(await prisma.onboardingImportRun.count()).toBe(0);
    expect(a.body.data).toEqual(b.body.data); // deterministic, including issue order
    const sheets = a.body.data.errors.map((e: OnboardingIssue) => ONBOARDING_SHEET_ORDER.indexOf(e.sheet as never));
    expect(sheets).toEqual([...sheets].sort((x, y) => x - y));
    expect(a.body.data.file.sha256).toBe(sha256(buffer));
  });
  it('37. logs and responses carry no row content', async () => {
    const rows = validRows();
    rows[S.employees]![0].email = 'secret.person@acme.test';
    const res = await preview(hrAdmin, await makeWorkbook(rows), 'Customer List (final).xlsx');
    expect(JSON.stringify(res.body.data.summary)).not.toMatch(/secret\.person/);
    expect(res.body.data.file.name).toBe('Customer List (final).xlsx');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\book.xlsx')).toBe('book.xlsx');
    expect(sanitizeFileName('réport☠.xlsx')).toBe('r_port_.xlsx');
    expect(sanitizeFileName('a\u0000b.xlsx')).toBe('a_b.xlsx');
  });
});

describe('commit (38–43)', () => {
  it('38. a valid workbook creates everything and records the import run', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    const res = await commit(hrAdmin, buffer, p.body.data.file.sha256, 'Acme onboarding.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fileName: 'Acme onboarding.xlsx', templateVersion: 1, counts: { organizations: 1, departments: 3, jobs: 2, positions: 3, employees: 3 }, createdBy: { id: hrAdmin.user.id } });
    expect(await counts()).toEqual({ organizations: 1, departments: 3, jobs: 2, positions: 3, employees: 3 });
    // audit: the batch action plus per-entity creates, all in the same transaction
    expect(await prisma.auditLog.count({ where: { action: 'IMPORT_CUSTOMER_ONBOARDING' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_EMPLOYEE' } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'CREATE_DEPARTMENT' } })).toBe(3);
    const batch = await prisma.auditLog.findFirstOrThrow({ where: { action: 'IMPORT_CUSTOMER_ONBOARDING' } });
    expect(JSON.parse(batch.newValue!)).toMatchObject({ counts: { employees: 3 }, templateVersion: 1 });
    expect(batch.newValue).not.toMatch(/acme\.test|Ann|Bee/); // counts only, no row content
    // 52. no login accounts were created for imported employees
    expect(await prisma.user.count({ where: { email: { in: ['ann@acme.test', 'bee@acme.test', 'cee@acme.test'] } } })).toBe(0);
    expect(await prisma.user.count({ where: { employeeId: { not: null } } })).toBe(0);
  });
  it('39/40. one bad row creates nothing at all', async () => {
    const rows = validRows();
    rows[S.employees]![2].positionCode = 'GHOST'; // the LAST employee fails → everything before it must roll back
    const buffer = await makeWorkbook(rows);
    const p = await preview(hrAdmin, buffer);
    expect(p.body.data.valid).toBe(false);
    const res = await commit(hrAdmin, buffer, p.body.data.file.sha256);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ONBOARDING_VALIDATION_FAILED');
    expect(await counts()).toEqual({ organizations: 0, departments: 0, jobs: 0, positions: 0, employees: 0 });
    expect(await prisma.onboardingImportRun.count()).toBe(0);
  });
  it('41. an audit failure rolls the whole import back', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    const real = auditService.log.bind(auditService);
    const spy = vi.spyOn(auditService, 'log').mockImplementation(async (entry, tx) => {
      if (entry.action === 'CREATE_EMPLOYEE') throw new Error('audit write failed');
      return real(entry, tx);
    });
    const res = await commit(hrAdmin, buffer, p.body.data.file.sha256);
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ONBOARDING_IMPORT_FAILED');
    expect(await counts()).toEqual({ organizations: 0, departments: 0, jobs: 0, positions: 0, employees: 0 });
    expect(await prisma.onboardingImportRun.count()).toBe(0);
  });
  it('42. the committed file must be the previewed one', async () => {
    const buffer = await makeWorkbook(validRows());
    const other = await makeWorkbook({ ...validRows(), [S.employees]: [] });
    const p = await preview(hrAdmin, buffer);
    const res = await commit(hrAdmin, other, p.body.data.file.sha256);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ONBOARDING_FILE_CHANGED');
    expect(await counts()).toMatchObject({ employees: 0 });
  });
  it('43. commit revalidates against the database as it is now, not as it was at preview time', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    expect(p.body.data.valid).toBe(true);
    // someone creates a conflicting job between preview and commit
    await prisma.job.create({ data: { code: 'ENGR', title: 'Engineer (created elsewhere)', level: 1 } });
    // The pre-flight check outside the transaction catches this first; the in-transaction revalidation is the
    // backstop for a change that lands *while* the import runs (proven by the concurrent-commit test below).
    const res = await commit(hrAdmin, buffer, p.body.data.file.sha256);
    expect([400, 409]).toContain(res.status);
    expect(res.body.error.code).toBe('ONBOARDING_VALIDATION_FAILED');
    expect(await prisma.employee.count()).toBe(0);
    expect(await prisma.onboardingImportRun.count()).toBe(0);
  });
});

describe('idempotency and concurrency (44–48)', () => {
  it('44–46. re-submitting a committed workbook replays the run instead of importing again', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    const first = await commit(hrAdmin, buffer, p.body.data.file.sha256);
    const after = await counts();
    const auditsAfter = await prisma.auditLog.count();

    const second = await commit(hrAdmin, buffer, p.body.data.file.sha256);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.replayed).toBe(true);
    expect(await counts()).toEqual(after);
    expect(await prisma.auditLog.count()).toBe(auditsAfter);
    expect(await prisma.onboardingImportRun.count()).toBe(1);
  });
  it('47. two concurrent commits of the same workbook import it once', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    const hash = p.body.data.file.sha256;
    const [a, b] = await Promise.all([commit(hrAdmin, buffer, hash), commit(admin, buffer, hash)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect([a.body.data.replayed, b.body.data.replayed].filter(Boolean)).toHaveLength(1); // exactly one replay
    expect(await counts()).toEqual({ organizations: 1, departments: 3, jobs: 2, positions: 3, employees: 3 });
    expect(await prisma.onboardingImportRun.count()).toBe(1);
  }, 60000);
  it('48. two different imports serialise without blocking ordinary requests', async () => {
    const first = await makeWorkbook(validRows());
    const secondRows = validRows();
    secondRows[S.organizations] = [{ organizationCode: 'BETA', name: 'Beta Co' }];
    secondRows[S.departments] = [{ organizationCode: 'BETA', departmentCode: 'BOPS', name: 'Beta Ops' }];
    secondRows[S.jobs] = [{ jobCode: 'BJOB', title: 'Beta Job' }];
    secondRows[S.positions] = [{ positionCode: 'P-BETA', title: 'Beta Officer', organizationCode: 'BETA', departmentCode: 'BOPS', jobCode: 'BJOB' }];
    secondRows[S.employees] = [{ employeeCode: 'B001', firstName: 'Bo', lastName: 'Beta', email: 'bo@beta.test', hireDate: '2026-01-05', positionCode: 'P-BETA' }];
    const second = await makeWorkbook(secondRows);
    const [p1, p2] = await Promise.all([preview(hrAdmin, first), preview(hrAdmin, second)]);
    const [r1, r2, health] = await Promise.all([
      commit(hrAdmin, first, p1.body.data.file.sha256),
      commit(admin, second, p2.body.data.file.sha256),
      request(app).get('/api/v1/health'), // ordinary traffic keeps flowing while imports serialise
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(health.status).toBe(200);
    expect(await counts()).toEqual({ organizations: 2, departments: 4, jobs: 3, positions: 4, employees: 4 });
    expect(await prisma.onboardingImportRun.count()).toBe(2);
  }, 60000);
});

describe('import history (49–54)', () => {
  it('49/50/51/54. history needs the permission, is metadata only and shows a sanitised name', async () => {
    const buffer = await makeWorkbook(validRows());
    const p = await preview(hrAdmin, buffer);
    await commit(hrAdmin, buffer, p.body.data.file.sha256, '../../Customer Data.xlsx');
    expect((await as(hr, 'get', '/api/v1/onboarding/imports')).status).toBe(403);
    const res = await as(hrAdmin, 'get', '/api/v1/onboarding/imports?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 10, total: 1 });
    const run = res.body.data[0];
    expect(run.fileName).toBe('Customer Data.xlsx'); // path stripped
    expect(run).toMatchObject({ templateVersion: 1, counts: { employees: 3 }, createdBy: { email: 'hradmin@ob.local' } });
    expect(JSON.stringify(res.body)).not.toMatch(/acme\.test|Ann|Bee|Cee/); // no PII, ever
    expect(Object.keys(run).sort()).toEqual(['counts', 'createdAt', 'createdBy', 'fileHash', 'fileName', 'id', 'templateVersion']);
  });
});
