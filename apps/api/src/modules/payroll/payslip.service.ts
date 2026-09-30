import { payrollPeriodLabel, type PayslipDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import type { AuthContext } from '../auth/auth.types';
import { toMoneyString, toQuantityString, toRateString } from './money';
import { isSourceLinkedLine } from './payroll.types';

/**
 * Payslips — the one payroll surface an ordinary employee sees.
 *
 * Two rules, both absolute. **Only your own**: the query is keyed by the session's employee id, never by a parameter,
 * so there is no id to tamper with. And **only closed runs**: a payslip is a statement of what was paid, and a run in
 * review is a work in progress that may still change. A manager's team scope grants nothing here — salary is not team
 * data.
 */
const STATUTORY_NOTICE =
  'This payslip is produced by the payroll module in its current release. It does not include automatically calculated withholding tax, social security or provident fund contributions — any such amounts appear only if they were entered as pay components.';

const itemDto = (row: { id: string; componentCodeSnapshot: string; componentNameSnapshot: string; type: string; source: string; quantity: unknown; rate: unknown; multiplier: unknown; amount: unknown; description: string | null; referenceType: string | null; referenceId: string | null; isManual: boolean }) => ({
  id: row.id,
  componentCode: row.componentCodeSnapshot,
  componentName: row.componentNameSnapshot,
  type: row.type as 'EARNING' | 'DEDUCTION',
  source: row.source as PayslipDto['earnings'][number]['source'],
  quantity: row.quantity === null ? null : toQuantityString(row.quantity as string),
  rate: row.rate === null ? null : toRateString(row.rate as string),
  multiplier: row.multiplier === null ? null : String(row.multiplier),
  amount: toMoneyString(row.amount as string),
  description: row.description,
  referenceType: row.referenceType,
  referenceId: row.referenceId,
  isManual: row.isManual,
  sourceLinked: isSourceLinkedLine(row),
});

function requireEmployee(auth: AuthContext): string {
  if (!auth.employeeId) throw new AppError(409, 'EMPLOYEE_PROFILE_REQUIRED', 'This account is not linked to an employee record, so it has no payslips');
  return auth.employeeId;
}

export const payslipService = {
  /** The caller's own payslips, most recent first. Closed runs only. */
  async listMine(auth: AuthContext): Promise<{ id: string; period: { id: string; label: string; paymentDate: string | null }; netPay: string; currencyCode: string }[]> {
    const employeeId = requireEmployee(auth);
    const rows = await prisma.payrollResult.findMany({
      where: { employeeId, run: { status: 'CLOSED' } },
      select: { id: true, netPay: true, currencyCode: true, run: { select: { period: { select: { id: true, year: true, month: true, paymentDate: true } } } } },
      orderBy: [{ run: { period: { year: 'desc' } } }, { run: { period: { month: 'desc' } } }],
      take: 60,
    });
    return rows.map((r) => ({
      id: r.id,
      period: { id: r.run.period.id, label: payrollPeriodLabel(r.run.period.year, r.run.period.month), paymentDate: r.run.period.paymentDate },
      netPay: toMoneyString(r.netPay),
      currencyCode: r.currencyCode,
    }));
  },

  /** One of the caller's own payslips. Somebody else's id is a 404 — the endpoint never confirms it exists. */
  async getMine(auth: AuthContext, resultId: string): Promise<PayslipDto> {
    const employeeId = requireEmployee(auth);
    const row = await prisma.payrollResult.findFirst({
      where: { id: resultId, employeeId, run: { status: 'CLOSED' } },
      include: { items: { orderBy: [{ type: 'asc' }, { source: 'asc' }, { createdAt: 'asc' }] }, run: { include: { period: true } } },
    });
    if (!row) throw new AppError(404, 'PAYSLIP_NOT_FOUND', 'Payslip not found');

    const items = row.items.map(itemDto);
    return {
      id: row.id,
      period: {
        id: row.run.period.id,
        label: payrollPeriodLabel(row.run.period.year, row.run.period.month),
        periodStart: row.run.period.periodStart,
        periodEnd: row.run.period.periodEnd,
        paymentDate: row.run.period.paymentDate,
      },
      employee: {
        employeeCode: row.employeeCode,
        firstName: row.employeeName.split(' ')[0] ?? row.employeeName,
        lastName: row.employeeName.split(' ').slice(1).join(' '),
        department: row.departmentName,
        position: row.positionTitle,
      },
      baseSalary: toMoneyString(row.baseSalary),
      grossPay: toMoneyString(row.grossPay),
      totalDeductions: toMoneyString(row.totalDeductions),
      netPay: toMoneyString(row.netPay),
      currencyCode: row.currencyCode,
      earnings: items.filter((i) => i.type === 'EARNING'),
      deductions: items.filter((i) => i.type === 'DEDUCTION'),
      notice: STATUTORY_NOTICE,
    };
  },
};

/**
 * CSV export of a run, for a payroll administrator.
 *
 * Every field is escaped and any value that begins with a formula character is prefixed with an apostrophe: a
 * spreadsheet that opens this file must not execute somebody's employee code. There is no bank format here — a bank
 * file has a schema per bank, and inventing one would be worse than not having it.
 */
export function payrollResultsCsv(rows: { employeeCode: string; employeeName: string; departmentName: string | null; baseSalary: unknown; grossPay: unknown; totalDeductions: unknown; netPay: unknown; currencyCode: string }[]): string {
  const escape = (value: string | null) => {
    const text = value ?? '';
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const header = ['Employee code', 'Employee', 'Department', 'Base salary', 'Gross', 'Deductions', 'Net', 'Currency'];
  const lines = rows.map((r) =>
    [
      escape(r.employeeCode),
      escape(r.employeeName),
      escape(r.departmentName),
      toMoneyString(r.baseSalary as string),
      toMoneyString(r.grossPay as string),
      toMoneyString(r.totalDeductions as string),
      toMoneyString(r.netPay as string),
      escape(r.currencyCode),
    ].join(','),
  );
  return [header.map(escape).join(','), ...lines].join('\r\n');
}

export { STATUTORY_NOTICE };
