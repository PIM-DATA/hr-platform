/**
 * Payroll domain helpers that involve **no money**: which days a period covers, how much of a month somebody was
 * employed for, and how a date range overlaps a cut-off window.
 *
 * Money arithmetic deliberately lives in the API, where `Prisma.Decimal` is available. Nothing in this file multiplies
 * a salary — floating-point currency is exactly the bug this separation prevents.
 */
import { compareBusinessDate, enumerateDates, enumerateWorkingDays, type WorkingCalendar } from './business-date';
import type { ProrationBasis } from './enums';

/** A `YYYY-MM` label for a period, as payslips and filenames use it. */
export const payrollPeriodLabel = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

/** The first and last calendar day of a month, as business dates. */
export function calendarMonthRange(year: number, month: number): { start: string; end: string } {
  const start = `${payrollPeriodLabel(year, month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: `${payrollPeriodLabel(year, month)}-${String(lastDay).padStart(2, '0')}` };
}

/** The overlap of two inclusive date ranges, or null when they do not touch. */
export function intersectRanges(aFrom: string, aTo: string, bFrom: string, bTo: string): { from: string; to: string } | null {
  const from = compareBusinessDate(aFrom, bFrom) >= 0 ? aFrom : bFrom;
  const to = compareBusinessDate(aTo, bTo) <= 0 ? aTo : bTo;
  return compareBusinessDate(from, to) <= 0 ? { from, to } : null;
}

export interface ProrationInput {
  periodStart: string;
  periodEnd: string;
  /** When the employee joined, if that happened inside the period. */
  hireDate?: string | null;
  /** When the employee left, if that happened inside the period. */
  terminationDate?: string | null;
  basis: ProrationBasis;
  calendar: WorkingCalendar;
}

export interface Proration {
  /** Days the employee was employed for inside the period, on the chosen basis. */
  employedDays: number;
  /** Days in the whole period, on the same basis — the denominator. */
  periodDays: number;
  /** True when the employee was employed for the entire period, so nothing is prorated. */
  full: boolean;
  from: string;
  to: string;
}

/**
 * How much of a period somebody was actually employed for.
 *
 * The basis is a customer decision: calendar days treats every day of the month alike, working days counts only the
 * days the organization works. Nothing here assumes 30 days or 26 — the payroll policy supplies both the basis and,
 * separately, the divisor used to turn a monthly salary into a daily rate.
 */
export function calculateProration(input: ProrationInput): Proration {
  const start = input.hireDate && compareBusinessDate(input.hireDate, input.periodStart) > 0 ? input.hireDate : input.periodStart;
  const end = input.terminationDate && compareBusinessDate(input.terminationDate, input.periodEnd) < 0 ? input.terminationDate : input.periodEnd;
  const count = (from: string, to: string) =>
    compareBusinessDate(from, to) > 0 ? 0 : input.basis === 'WORKING_DAYS' ? enumerateWorkingDays(input.calendar, from, to).length : enumerateDates(from, to).length;

  const periodDays = count(input.periodStart, input.periodEnd);
  const employedDays = count(start, end);
  return {
    employedDays,
    periodDays,
    full: employedDays >= periodDays,
    from: start,
    to: end,
  };
}

/** Formats an amount that arrives from the API as a string, for display. Never parses money into a float first. */
export function formatMoney(amount: string | null | undefined, currencyCode = 'THB'): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const negative = amount.trim().startsWith('-');
  const [whole, fraction = '00'] = amount.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${fraction.padEnd(2, '0').slice(0, 2)} ${currencyCode}`;
}
