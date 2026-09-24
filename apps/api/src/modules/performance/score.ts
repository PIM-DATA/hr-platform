import { Prisma } from '@prisma/client';

/**
 * Score and weight arithmetic.
 *
 * Performance is not money, but the same reasoning applies: three KPIs weighted 33.33, 33.33 and 33.34 must add up to
 * exactly 100, and a weighted score must come out the same for everybody every time. Floats would make both a matter
 * of luck, so everything here is `Prisma.Decimal` and leaves as a **string**.
 *
 * One scale (2 decimal places, half-up) for scores, weights and the weighted result, applied in one place.
 */
export const SCORE_SCALE = 2;
export const ROUNDING = Prisma.Decimal.ROUND_HALF_UP;
export const TOTAL_WEIGHT = new Prisma.Decimal(100);
export const ZERO = new Prisma.Decimal(0);

export type DecimalLike = Prisma.Decimal | string | number;

export const dec = (value: DecimalLike): Prisma.Decimal => new Prisma.Decimal(value ?? 0);

/** Rounds to the score scale. Everything stored in a score or weight column passes through here. */
export const score = (value: DecimalLike): Prisma.Decimal => dec(value).toDecimalPlaces(SCORE_SCALE, ROUNDING);

/** `"3.50"` — always two places, always a string on the wire. */
export const toScoreString = (value: DecimalLike | null | undefined): string | null =>
  value === null || value === undefined ? null : score(value).toFixed(SCORE_SCALE);

export const equals = (a: DecimalLike, b: DecimalLike) => dec(a).equals(dec(b));

/** Sum of weights, rounded once at the end. */
export const sumWeights = (values: DecimalLike[]): Prisma.Decimal =>
  score(values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), ZERO));

/**
 * A plan's weighted score: `SUM(managerScore × weight / 100)`.
 *
 * The division happens inside the sum at full precision and the result is rounded **once**, at the end. Rounding each
 * term first would let three KPIs at 33.33% drift away from the score the reviewer thought they were giving.
 */
export function weightedScore(items: { managerScore: DecimalLike | null; weight: DecimalLike }[]): Prisma.Decimal {
  const total = items.reduce<Prisma.Decimal>(
    (acc, item) => (item.managerScore === null ? acc : acc.plus(dec(item.managerScore).times(dec(item.weight)).dividedBy(TOTAL_WEIGHT))),
    ZERO,
  );
  return score(total);
}

/** Whether a score sits on the cycle's scale, including its step (a 0.1-step scale refuses 3.55). */
export function scoreIsOnScale(value: DecimalLike, min: DecimalLike, max: DecimalLike, step: DecimalLike): boolean {
  const v = dec(value);
  if (v.lessThan(dec(min)) || v.greaterThan(dec(max))) return false;
  const stepValue = dec(step);
  if (stepValue.lessThanOrEqualTo(0)) return true;
  const steps = v.minus(dec(min)).dividedBy(stepValue);
  return steps.equals(steps.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP));
}
