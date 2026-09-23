import { Prisma } from '@prisma/client';

/**
 * Every piece of money arithmetic in the system goes through this file.
 *
 * Currency is decimal, and JavaScript numbers are binary: `0.1 + 0.2` is `0.30000000000000004`, and a salary run that
 * does that ten thousand times produces a total nobody can reconcile. So amounts are `Prisma.Decimal` (PostgreSQL
 * `NUMERIC`) from the database, through the calculation, to the response — where they leave as **strings**, because a
 * JSON number would undo the whole exercise at the last step.
 *
 * Two scales, deliberately:
 *   - **money**: 2 decimal places, rounded half-up, for anything that appears as an amount;
 *   - **rate**: 6 decimal places, for derived per-day and per-minute rates that are multiplied back up. Rounding a
 *     minute rate to satang first and multiplying by 120 minutes would lose several baht.
 *
 * One rounding rule, applied in one place: a calculator that rounds differently from its neighbour is how payslips
 * stop adding up.
 */
export const MONEY_SCALE = 2;
export const RATE_SCALE = 6;
export const ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

export type Money = Prisma.Decimal;
export type DecimalLike = Prisma.Decimal | string | number;

/** A decimal from anything the database or a validated request can hand us. Never parses through a float. */
export const dec = (value: DecimalLike): Prisma.Decimal => new Prisma.Decimal(value ?? 0);

/** Rounds to the money scale (2dp, half-up). Everything stored in an `amount` column passes through here. */
export const money = (value: DecimalLike): Prisma.Decimal => dec(value).toDecimalPlaces(MONEY_SCALE, ROUNDING);

/** Rounds to the rate scale (6dp). For daily and per-minute rates that will be multiplied again. */
export const rate = (value: DecimalLike): Prisma.Decimal => dec(value).toDecimalPlaces(RATE_SCALE, ROUNDING);

export const ZERO = new Prisma.Decimal(0);

/** Sum of money amounts, rounded once at the end rather than at every step. */
export const sumMoney = (values: DecimalLike[]): Prisma.Decimal => money(values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), ZERO));

/** `toMoneyString(d)` → `"30000.00"`: always two places, always a string on the wire. */
export const toMoneyString = (value: DecimalLike | null | undefined): string => (value === null || value === undefined ? '0.00' : money(value).toFixed(MONEY_SCALE));

/** `toRateString(d)` → `"1.562500"`. */
export const toRateString = (value: DecimalLike | null | undefined): string => (value === null || value === undefined ? '0.000000' : rate(value).toFixed(RATE_SCALE));

/** Quantities (days, units, hours) are decimal too, but they are not money: two places, no currency semantics. */
export const toQuantityString = (value: DecimalLike | null | undefined): string => (value === null || value === undefined ? '0.00' : dec(value).toDecimalPlaces(2, ROUNDING).toFixed(2));

export const isNegative = (value: DecimalLike): boolean => dec(value).isNegative();
export const equals = (a: DecimalLike, b: DecimalLike): boolean => dec(a).equals(dec(b));

/**
 * The rates a monthly salary implies, under a customer's policy.
 *
 * `monthlyDivisorDays` and `dailyWorkHours` are configuration: nothing here assumes 30 days, 26 days or 8 hours,
 * because those are contractual decisions that differ between customers and between countries.
 */
export function deriveRates(baseSalary: DecimalLike, monthlyDivisorDays: DecimalLike, dailyWorkHours: DecimalLike) {
  const divisor = dec(monthlyDivisorDays);
  const hours = dec(dailyWorkHours);
  if (divisor.lessThanOrEqualTo(0) || hours.lessThanOrEqualTo(0)) {
    throw new Error('Payroll policy must have a positive monthly divisor and daily work hours');
  }
  const dailyRate = rate(dec(baseSalary).dividedBy(divisor));
  const hourlyRate = rate(dailyRate.dividedBy(hours));
  const minuteRate = rate(hourlyRate.dividedBy(60));
  return { dailyRate, hourlyRate, minuteRate };
}
