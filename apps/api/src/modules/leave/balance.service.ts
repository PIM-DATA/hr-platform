import { Prisma } from '@prisma/client';
import { LEDGER_ENTRY_TYPES, LEDGER_SIGN, availableUnits, computeBalanceSummary, halfRound, isHalfDayUnit, type BalanceSummary, type LedgerEntryType } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';

/**
 * Leave balance accounting. ledger = source of truth; the entitlement row caches the summary.
 *
 * Every method takes the caller's Prisma transaction client so Leave Request (Task 11) can compose
 * request update + workflow + ledger + cache + audit in ONE transaction. The service never opens its own.
 *
 * Concurrency (Task 10.5, PostgreSQL): every mutation of an existing entitlement first takes a row-level lock
 * on that entitlement (`SELECT … FOR UPDATE` in `loadEntitlementForMutation`), so competing transactions on the
 * same entitlement run strictly one after another: lock → operationKey check → balance guard → insert → recompute
 * → cache → commit. Lock granularity is ONE entitlement row (no global mutex); a mutation never touches a second
 * entitlement, so there is no lock ordering to define yet. READ COMMITTED (PostgreSQL default) is sufficient:
 * after the lock is acquired, the following statements see the rows committed by the previous holder.
 * The referenced policy is not locked: its rule fields are immutable once referenced (LEAVE_POLICY_IN_USE).
 */
export type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export interface LedgerWrite {
  entitlementId: string;
  entryType: LedgerEntryType;
  /** Signed units as stored (helpers below apply the sign convention). */
  units: number;
  operationKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  note?: string | null;
  actorUserId: string | null;
  /**
   * RESERVE only (Task 10.6): the REQUEST policy snapshotted by the leave request. Its allowNegativeBalance rule is used
   * instead of the entitlement's grant policy. Must exist and be for the entitlement's leave type (BALANCE_POLICY_MISMATCH).
   * Internal callers only — never accepted from a client.
   */
  balancePolicyId?: string;
}
export interface LedgerResult {
  entry: { id: string; entryType: string; units: number; operationKey: string; createdAt: Date };
  summary: BalanceSummary;
  available: number;
  /** true when the operationKey already existed with an identical payload (no new row written). */
  idempotentReplay: boolean;
}

/**
 * The single place an entitlement is loaded for mutation: acquires the PostgreSQL row lock (held until the
 * caller's transaction ends), then loads the row + policy rules. Parameterised tagged template — no SQL interpolation.
 */
export async function loadEntitlementForMutation(tx: Tx, entitlementId: string) {
  await tx.$queryRaw`SELECT "id" FROM "leave_entitlements" WHERE "id" = ${entitlementId} FOR UPDATE`;
  const row = await tx.leaveEntitlement.findUnique({ where: { id: entitlementId }, include: { policy: { select: { id: true, allowNegativeBalance: true, carryForwardMaxUnits: true } } } });
  if (!row) throw new AppError(404, 'LEAVE_ENTITLEMENT_NOT_FOUND', 'Leave entitlement not found');
  return row;
}

/** Σ units grouped by entry type for ONE entitlement (never loads other employees' ledgers). */
export async function summaryFromLedger(db: Db, entitlementId: string): Promise<BalanceSummary> {
  const groups = await db.leaveLedger.groupBy({ by: ['entryType'], where: { entitlementId }, _sum: { units: true } });
  return computeBalanceSummary(groups.map((g) => ({ entryType: g.entryType, units: g._sum.units ?? 0 })));
}

const cachedSummary = (e: BalanceSummary): BalanceSummary => ({ granted: e.granted, carriedForward: e.carriedForward, adjustment: e.adjustment, reserved: e.reserved, used: e.used });

/**
 * Appends one ledger row (idempotent on operationKey), recomputes the summary from the ledger and
 * writes it to the entitlement cache — all on the caller's transaction. Guards are applied by the typed helpers.
 */
async function appendEntry(tx: Tx, w: LedgerWrite, guard: (before: BalanceSummary, after: BalanceSummary, policy: { allowNegativeBalance: boolean }) => void): Promise<LedgerResult> {
  // validate the RAW value first (0.25 must fail, not be rounded to 0.5); halfRound afterwards only removes IEEE noise
  if (w.units === 0 || !isHalfDayUnit(Math.abs(w.units))) throw new AppError(400, 'LEDGER_UNIT_INVALID', 'Ledger units must be a non-zero multiple of 0.5');
  const sign = LEDGER_SIGN[w.entryType];
  if (sign !== 0 && Math.sign(w.units) !== sign) throw new AppError(400, 'LEDGER_SIGN_INVALID', `${w.entryType} entries must be ${sign > 0 ? 'positive' : 'negative'}`);
  w = { ...w, units: halfRound(w.units) };

  // 1. lock the entitlement row, 2. only then look for a previous run of this operationKey (a concurrent
  // caller with the same key waits on the lock and then sees the committed row → idempotent replay).
  const ent = await loadEntitlementForMutation(tx, w.entitlementId);
  const existing = await tx.leaveLedger.findUnique({ where: { operationKey: w.operationKey } });
  if (existing) {
    const same = existing.entitlementId === w.entitlementId && existing.entryType === w.entryType && existing.units === w.units && (existing.referenceType ?? null) === (w.referenceType ?? null) && (existing.referenceId ?? null) === (w.referenceId ?? null);
    if (!same) throw new AppError(409, 'LEDGER_OPERATION_CONFLICT', `Operation ${w.operationKey} was already recorded with a different payload`);
    const summary = summaryFrom(ent);
    return { entry: existing, summary, available: availableUnits(summary), idempotentReplay: true };
  }

  const before = summaryFrom(ent);
  const after = computeBalanceSummary([{ entryType: w.entryType, units: w.units }, ...toRows(before)]);
  guard(before, after, w.balancePolicyId ? await balancePolicy(tx, ent.leaveTypeId, w.balancePolicyId) : ent.policy);

  const entry = await tx.leaveLedger
    .create({ data: { entitlementId: w.entitlementId, entryType: w.entryType, units: w.units, operationKey: w.operationKey, referenceType: w.referenceType ?? null, referenceId: w.referenceId ?? null, note: w.note ?? null, createdByUserId: w.actorUserId } })
    .catch((e: unknown) => {
      // same operationKey raced in from a transaction holding a DIFFERENT entitlement's lock: the unique index is the backstop
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError(409, 'LEDGER_OPERATION_CONFLICT', `Operation ${w.operationKey} was already recorded with a different payload`);
      throw e;
    });
  const summary = await summaryFromLedger(tx, w.entitlementId); // recompute from the ledger, never increment
  await tx.leaveEntitlement.update({ where: { id: w.entitlementId }, data: summary });
  return { entry, summary, available: availableUnits(summary), idempotentReplay: false };
}

const summaryFrom = (e: BalanceSummary) => cachedSummary(e);
/** Request policy rules for a reservation: exists + same leave type as the entitlement. Not locked: rule fields are immutable once referenced. */
async function balancePolicy(tx: Tx, entitlementLeaveTypeId: string, policyId: string) {
  const p = await tx.leavePolicy.findUnique({ where: { id: policyId }, select: { id: true, leaveTypeId: true, allowNegativeBalance: true, carryForwardMaxUnits: true } });
  if (!p) throw new AppError(404, 'LEAVE_POLICY_NOT_FOUND', 'Balance policy not found');
  if (p.leaveTypeId !== entitlementLeaveTypeId) throw new AppError(409, 'BALANCE_POLICY_MISMATCH', 'Balance policy is for a different leave type than the entitlement');
  return p;
}
/** Represent a summary as pseudo-rows so the projected "after" state uses the same formula. */
function toRows(s: BalanceSummary) {
  return [
    { entryType: LEDGER_ENTRY_TYPES.GRANT, units: s.granted }, { entryType: LEDGER_ENTRY_TYPES.CARRY_FORWARD, units: s.carriedForward }, { entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT, units: s.adjustment },
    { entryType: LEDGER_ENTRY_TYPES.RESERVE, units: s.reserved }, { entryType: LEDGER_ENTRY_TYPES.USE, units: s.used },
  ];
}
const noNegative = (_b: BalanceSummary, after: BalanceSummary, policy: { allowNegativeBalance: boolean }) => {
  if (!policy.allowNegativeBalance && availableUnits(after) < 0) throw new AppError(409, 'INSUFFICIENT_LEAVE_BALANCE', `Insufficient balance: available would be ${availableUnits(after)}`);
};

type Meta = { operationKey: string; actorUserId: string | null; note?: string | null; referenceType?: string | null; referenceId?: string | null };
type ReserveMeta = Meta & { balancePolicyId?: string };

export const balanceService = {
  loadEntitlementForMutation,
  summaryFromLedger,

  async getBalance(db: Db, entitlementId: string): Promise<{ summary: BalanceSummary; available: number }> {
    const e = await db.leaveEntitlement.findUnique({ where: { id: entitlementId } });
    if (!e) throw new AppError(404, 'LEAVE_ENTITLEMENT_NOT_FOUND', 'Leave entitlement not found');
    const summary = cachedSummary(e);
    return { summary, available: availableUnits(summary) };
  },

  /** +units granted (initial grant or additional grant). */
  grant: (tx: Tx, entitlementId: string, units: number, m: Meta) => appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.GRANT, units, ...m }, () => undefined),
  /** +units carried in from a previous period; capped by the policy's carryForwardMaxUnits (cumulative). */
  carryForward: (tx: Tx, entitlementId: string, units: number, m: Meta) =>
    appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.CARRY_FORWARD, units, ...m }, (_b, after, policy) => {
      const cap = (policy as { carryForwardMaxUnits?: number }).carryForwardMaxUnits ?? 0;
      if (after.carriedForward > cap) throw new AppError(409, 'CARRY_FORWARD_EXCEEDS_POLICY', `Carry-forward would be ${after.carriedForward}, policy allows at most ${cap}`);
    }),
  /** ±units manual correction; may not drive available below 0 unless the policy allows negative balance. */
  adjust: (tx: Tx, entitlementId: string, units: number, m: Meta) => appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.ADJUSTMENT, units, ...m }, noNegative),
  /**
   * +reserved for a pending request; rejects when available is insufficient unless negative balance is allowed by the
   * REQUEST policy (`m.balancePolicyId`, Task 10.6) — or by the entitlement's grant policy when no request policy is given.
   */
  reserve: (tx: Tx, entitlementId: string, units: number, m: ReserveMeta) => appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.RESERVE, units: Math.abs(units), ...m }, noNegative),
  /** −reserved (request rejected/cancelled, or converted to USE); cannot exceed what is reserved. */
  release: (tx: Tx, entitlementId: string, units: number, m: Meta) =>
    appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.RELEASE, units: -Math.abs(units), ...m }, (_b, after) => {
      if (after.reserved < 0) throw new AppError(409, 'LEDGER_RELEASE_EXCEEDS_RESERVED', 'Cannot release more than is reserved');
    }),
  /** +used (approved leave). Task 11 flow: RESERVE → RELEASE + USE, so USE never double-counts a reservation. */
  use: (tx: Tx, entitlementId: string, units: number, m: Meta) => appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.USE, units: Math.abs(units), ...m }, noNegative),
  /** −used (approved leave cancelled later); cannot exceed what was used. */
  refund: (tx: Tx, entitlementId: string, units: number, m: Meta) =>
    appendEntry(tx, { entitlementId, entryType: LEDGER_ENTRY_TYPES.REFUND, units: -Math.abs(units), ...m }, (_b, after) => {
      if (after.used < 0) throw new AppError(409, 'LEDGER_REFUND_EXCEEDS_USED', 'Cannot refund more than was used');
    }),

  /** Read-only check: does the cached summary equal the ledger? (No repair here; a repair would be an audited mutation.) */
  async reconcile(db: Db, entitlementId: string): Promise<{ matches: boolean; expected: BalanceSummary; cached: BalanceSummary }> {
    const e = await db.leaveEntitlement.findUnique({ where: { id: entitlementId } });
    if (!e) throw new AppError(404, 'LEAVE_ENTITLEMENT_NOT_FOUND', 'Leave entitlement not found');
    const expected = await summaryFromLedger(db, entitlementId);
    const cached = cachedSummary(e);
    const matches = (Object.keys(expected) as (keyof BalanceSummary)[]).every((k) => expected[k] === cached[k]);
    return { matches, expected, cached };
  },
};
