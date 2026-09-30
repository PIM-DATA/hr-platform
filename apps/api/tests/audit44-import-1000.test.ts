/**
 * Task 44 audit evidence: a 1,000-employee customer through the real onboarding import (preview → commit → replay),
 * all-or-nothing on one bad row, formula cells, and a sanity pass over key read endpoints at that size.
 * Timings are printed for the audit report; they are observations on a developer machine, not an SLA.
 */
import ExcelJS from 'exceljs';
import { appendFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ONBOARDING_COLUMNS, ONBOARDING_META_SHEET, ONBOARDING_SHEETS as S, ONBOARDING_SHEET_ORDER, ONBOARDING_TEMPLATE_VERSION } from '@hr/shared';
import { prisma } from '../src/lib/prisma';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app = createTestServer();
/** Evidence lines for the audit report; written to AUDIT44_OUT when set (vitest hides console output of passing tests). */
const note = (...parts: unknown[]) => { const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '); if (process.env.AUDIT44_OUT) appendFileSync(process.env.AUDIT44_OUT, `${line}\n`); };
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string };
let hrAdmin: Session, hr: Session;
const N = 1000;
const DEPTS = 10;

type Rows = Partial<Record<string, Record<string, string | number>[]>>;
async function workbook(rows: Rows, mutate?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const name of ONBOARDING_SHEET_ORDER) {
    const ws = wb.addWorksheet(name);
    const headers = ONBOARDING_COLUMNS[name].map((c) => c.header);
    ws.addRow(headers);
    for (const row of rows[name] ?? []) ws.addRow(headers.map((h) => (row[h] === undefined ? null : row[h])));
  }
  const meta = wb.addWorksheet(ONBOARDING_META_SHEET);
  meta.getCell('A1').value = 'templateVersion';
  meta.getCell('B1').value = ONBOARDING_TEMPLATE_VERSION;
  mutate?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const customer = (badRow = false): Rows => ({
  [S.organizations]: [{ organizationCode: 'K1', name: 'Kilo Co', timezone: 'Asia/Bangkok' }],
  [S.departments]: Array.from({ length: DEPTS }, (_, d) => ({ organizationCode: 'K1', departmentCode: `D${d}`, name: `Dept ${d}` })),
  [S.jobs]: [{ jobCode: 'STAFF', title: 'Staff', level: 1 }, { jobCode: 'LEAD', title: 'Lead', level: 4 }],
  [S.positions]: Array.from({ length: DEPTS }, (_, d) => [
    { positionCode: `L${d}`, title: `Lead ${d}`, organizationCode: 'K1', departmentCode: `D${d}`, jobCode: 'LEAD' },
    { positionCode: `S${d}`, title: `Staff ${d}`, organizationCode: 'K1', departmentCode: `D${d}`, jobCode: 'STAFF' },
  ]).flat(),
  [S.employees]: Array.from({ length: N }, (_, i) => {
    const d = i % DEPTS;
    const lead = i < DEPTS;
    const code = `K${String(i + 1).padStart(4, '0')}`;
    return {
      employeeCode: code, firstName: `F${i}`, lastName: `L${i}`, email: `${code.toLowerCase()}@kilo.test`, hireDate: '2025-01-15',
      employmentType: badRow && i === N - 1 ? 'NOT_A_TYPE' : 'FULL_TIME', positionCode: lead ? `L${d}` : `S${d}`,
      ...(lead ? {} : { managerEmployeeCode: `K${String(d + 1).padStart(4, '0')}` }),
    };
  }),
});

const as = (s: Session, m: 'get' | 'post', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
const preview = (buffer: Buffer) => as(hrAdmin, 'post', '/api/v1/onboarding/preview').attach('file', buffer, 'kilo.xlsx');
const commit = (buffer: Buffer, hash: string) => as(hrAdmin, 'post', '/api/v1/onboarding/commit').field('expectedSha256', hash).attach('file', buffer, 'kilo.xlsx');
const timed = async <T>(label: string, f: () => Promise<T>) => { const t = Date.now(); const r = await f(); note(`[audit44] ${label}: ${Date.now() - t} ms`); return r; };

beforeAll(async () => {
  await resetDatabase();
  await createUser({ email: 'hradmin@kilo.local', password: PW, role: 'HR_ADMIN' });
  await createUser({ email: 'hr@kilo.local', password: PW, role: 'HR' });
  [hrAdmin, hr] = await Promise.all(['hradmin', 'hr'].map((u) => loginAs(app, `${u}@kilo.local`, PW)));
}, 60000);
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe(`${N}-employee onboarding import`, () => {
  it('an importer without onboarding.manage is refused', async () => {
    expect((await as(hr, 'post', '/api/v1/onboarding/preview').attach('file', await workbook(customer()), 'kilo.xlsx')).status).toBe(403);
  });

  it('one bad row in 1,000 creates nothing and names the row', async () => {
    const buffer = await workbook(customer(true));
    const p = await timed('preview 1,000 rows (1 bad)', () => preview(buffer));
    expect(p.status).toBe(200);
    const errors = p.body.data.errors as { row: number; sheet: string; code: string }[];
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ row: N + 1 });
    expect((await commit(buffer, p.body.data.file.sha256)).status).not.toBe(200);
    expect(await prisma.employee.count()).toBe(0);
  }, 120000);

  it('a shared-formula cell is not silently imported as text', async () => {
    const buffer = await workbook(customer(), (wb) => {
      const ws = wb.getWorksheet(S.employees)!;
      const col = ONBOARDING_COLUMNS[S.employees].findIndex((c) => c.header === 'lastName') + 1;
      ws.getCell(2, col).value = { formula: 'UPPER("a")', result: 'A', shareType: 'shared', ref: `${ws.getCell(2, col).address}:${ws.getCell(3, col).address}` } as ExcelJS.CellFormulaValue;
      ws.getCell(3, col).value = { sharedFormula: ws.getCell(2, col).address, result: 'B' } as unknown as ExcelJS.CellValue;
    });
    const p = await preview(buffer);
    const codes = (p.body.data?.errors ?? []).map((i: { code: string; row: number }) => `${i.code}@${i.row}`);
    note('[audit44] shared-formula preview errors:', JSON.stringify(codes));
    expect(codes.some((c: string) => c.endsWith('@2'))).toBe(true); // master formula cell rejected
    // Evidence only: is the shared-formula CHILD (row 3) also rejected? (agent claim: it becomes "[object Object]")
    note('[audit44] shared-formula child row 3 rejected:', codes.some((c: string) => c.endsWith('@3')));
  }, 120000);

  it('commits 1,000 employees in one transaction, replays instead of re-importing, and key reads stay whole', async () => {
    const buffer = await workbook(customer());
    const p = await preview(buffer);
    expect(p.body.data.errors).toEqual([]);
    const c = await timed('commit 1,000 employees', () => commit(buffer, p.body.data.file.sha256));
    expect(c.status).toBe(200);
    expect(await prisma.employee.count()).toBe(N);
    expect(await prisma.employeeManager.count()).toBe(N - DEPTS);
    const again = await commit(buffer, p.body.data.file.sha256);
    expect(again.body.data?.replayed).toBe(true);
    expect(await prisma.employee.count()).toBe(N);

    const list = await timed('employee list page 1 (50)', () => as(hrAdmin, 'get', '/api/v1/employees?page=1&pageSize=50'));
    expect(list.status).toBe(200);
    expect(list.body.meta?.total ?? list.body.data?.total).toBe(N);
    const last = await timed('employee list last page', () => as(hrAdmin, 'get', `/api/v1/employees?page=${N / 50}&pageSize=50`));
    expect(last.body.data.length ?? last.body.data.items.length).toBe(50);
    for (const [label, url] of [
      ['attendance report (month, all)', '/api/v1/attendance/reports/overview?from=2026-09-01&to=2026-09-30'],
      ['leave overview', '/api/v1/leave/reports/overview?from=2026-01-01&to=2026-12-31'],
      ['payroll periods', '/api/v1/payroll/periods'],
      ['performance cycles', '/api/v1/performance/cycles'],
      ['training report', '/api/v1/training/reports/overview?from=2026-01-01&to=2026-12-31'],
      ['executive overview', '/api/v1/analytics/executive/overview?from=2026-01-01&to=2026-09-30'],
      ['dashboard', '/api/v1/dashboard/summary'],
    ] as const) {
      const r = await timed(label, () => as(hrAdmin, 'get', url));
      note(`[audit44]   ${label} status ${r.status}`);
      expect(r.status).toBeLessThan(500);
    }
    // Report Center at this size is covered by reports.test.ts; its export cap is REPORT_LIMITS.exportRows.
  }, 300000);
});
