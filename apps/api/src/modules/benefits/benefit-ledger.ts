import { Prisma } from '@prisma/client';
import { BENEFIT_LEDGER_SIGN, type BenefitBalanceDto, type BenefitLedgerEntryType } from '@hr/shared';
import { AppError } from '../../lib/errors';
import { ZERO, dec, money, toMoneyString } from '../payroll/money';
import type { Db, Tx } from './benefits.types';

/**
 * The entitlement ledger. Append-only rows are the financial truth; the entitlement row caches the sums.
 *
 * Every mutation of an entitlement runs behind `SELECT … FOR UPDATE` on that entitlement row, so competing claims on
 * the same balance are serialized: lock → operationKey check → balance guard → insert → recompute → cache. All
 * arithmetic is `Prisma.Decimal` at two places, rounded half-up once through the payroll money helper. Nothing here
 * reads `Number(amount)`.
 *
 *   available = granted + adjustment − reserved − consumed
 *   reserved  = Σ RESERVE (+) + Σ RELEASE (−)
 */
export interface BalanceSums { granted: Prisma.Decimal; adjustment: Prisma.Decimal; reserved: Prisma.Decimal; consumed: Prisma.Decimal }
export const availableOf = (s: BalanceSums): Prisma.Decimal => money(s.granted.plus(s.adjustment).minus(s.reserved).minus(s.consumed));
export const balanceDto = (currency: string, s: BalanceSums): BenefitBalanceDto => ({ currency, granted: toMoneyString(s.granted), adjustment: toMoneyString(s.adjustment), reserved: toMoneyString(s.reserved), consumed: toMoneyString(s.consumed), available: toMoneyString(availableOf(s)) });
export const sumsOf = (row: { grantedAmount: Prisma.Decimal; adjustmentAmount: Prisma.Decimal; reservedAmount: Prisma.Decimal; consumedAmount: Prisma.Decimal }): BalanceSums => ({ granted: row.grantedAmount, adjustment: row.adjustmentAmount, reserved: row.reservedAmount, consumed: row.consumedAmount });

/** Σ per type for ONE entitlement, from the ledger rows themselves. */
export async function sumsFromLedger(db: Db, entitlementId: string): Promise<BalanceSums> {
  const rows = await db.benefitEntitlementLedger.findMany({ where: { entitlementId }, select: { entryType: true, amount: true } });
  const s: BalanceSums = { granted: ZERO, adjustment: ZERO, reserved: ZERO, consumed: ZERO };
  for (const r of rows) {
    switch (r.entryType) {
      case 'GRANT': s.granted = s.granted.plus(r.amount); break;
      case 'ADJUSTMENT': s.adjustment = s.adjustment.plus(r.amount); break;
      case 'RESERVE': case 'RELEASE': s.reserved = s.reserved.plus(r.amount); break;
      case 'CONSUME': s.consumed = s.consumed.plus(r.amount); break;
    }
  }
  return { granted: money(s.granted), adjustment: money(s.adjustment), reserved: money(s.reserved), consumed: money(s.consumed) };
}

/** The single place an entitlement is loaded for mutation: takes the row lock, then reads the row. */
export async function loadEntitlementForMutation(tx: Tx, entitlementId: string) {
  await tx.$executeRaw`SELECT "id" FROM "benefit_entitlements" WHERE "id" = ${entitlementId} FOR UPDATE`;
  const row = await tx.benefitEntitlement.findUnique({ where: { id: entitlementId }, include: { period: { select: { status: true, periodStart: true, periodEnd: true, perClaimMaximumSnapshot: true, requiresDocumentSnapshot: true, currencySnapshot: true } } } });
  if (!row) throw new AppError(404, 'BENEFIT_ENTITLEMENT_NOT_FOUND', 'Benefit entitlement not found');
  return row;
}

export interface LedgerWrite { entitlementId: string; entryType: BenefitLedgerEntryType; amount: Prisma.Decimal; claimId?: string | null; operationKey?: string | null; reasonCode?: string | null; note?: string | null; actorUserId: string | null }
export interface LedgerResult { sums: BalanceSums; available: Prisma.Decimal; idempotentReplay: boolean; entryId: string }

/**
 * Appends one row and refreshes the cache. Caller holds the entitlement lock. The amount is signed as stored:
 * callers pass a positive figure and the type's sign is applied here (ADJUSTMENT keeps the caller's sign).
 * `guardAvailable`: refuse when the movement would take `available` below zero (RESERVE and negative ADJUSTMENT).
 */
export async function appendLedger(tx: Tx, w: LedgerWrite, opts: { guardAvailable?: boolean } = {}): Promise<LedgerResult> {
  const sign = BENEFIT_LEDGER_SIGN[w.entryType];
  const stored = money(sign === 0 ? w.amount : dec(w.amount).abs().times(sign));
  if (stored.isZero()) throw new AppError(422, 'BENEFIT_LEDGER_ZERO', 'A ledger movement cannot be zero');
  if (w.operationKey) {
    const existing = await tx.benefitEntitlementLedger.findUnique({ where: { operationKey: w.operationKey } });
    if (existing) {
      if (existing.entitlementId !== w.entitlementId || !existing.amount.equals(stored) || existing.entryType !== w.entryType) throw new AppError(409, 'BENEFIT_LEDGER_KEY_CONFLICT', 'That operation was already recorded with a different amount');
      const sums = await sumsFromLedger(tx, w.entitlementId);
      return { sums, available: availableOf(sums), idempotentReplay: true, entryId: existing.id };
    }
  }
  const before = await sumsFromLedger(tx, w.entitlementId);
  if (opts.guardAvailable) {
    const after = { ...before };
    if (w.entryType === 'RESERVE') after.reserved = after.reserved.plus(stored);
    if (w.entryType === 'ADJUSTMENT') after.adjustment = after.adjustment.plus(stored);
    if (w.entryType === 'CONSUME') after.consumed = after.consumed.plus(stored);
    if (availableOf(after).isNegative()) throw new AppError(422, 'BENEFIT_INSUFFICIENT_BALANCE', `Only ${toMoneyString(availableOf(before))} is available`, [{ field: 'claimedAmount', message: `Available ${toMoneyString(availableOf(before))}` }]);
  }
  const entry = await tx.benefitEntitlementLedger.create({ data: { entitlementId: w.entitlementId, entryType: w.entryType, amount: stored, claimId: w.claimId ?? null, operationKey: w.operationKey ?? null, reasonCode: w.reasonCode ?? null, note: w.note ?? null, createdByUserId: w.actorUserId } });
  const sums = await sumsFromLedger(tx, w.entitlementId);
  await tx.benefitEntitlement.update({ where: { id: w.entitlementId }, data: { grantedAmount: sums.granted, adjustmentAmount: sums.adjustment, reservedAmount: sums.reserved, consumedAmount: sums.consumed } });
  return { sums, available: availableOf(sums), idempotentReplay: false, entryId: entry.id };
}
