/**
 * Leave ledger vocabulary + the ONE place that defines the sign convention and the balance formula.
 * Every service derives balances through computeBalanceSummary(); nobody re-interprets signs.
 *
 *   GRANT          +units      CARRY_FORWARD  +units      ADJUSTMENT  ±units
 *   RESERVE        +units      RELEASE        −units      (reserved = Σ RESERVE + Σ RELEASE)
 *   USE            +units      REFUND         −units      (used     = Σ USE + Σ REFUND)
 *   available = granted + carriedForward + adjustment − reserved − used
 * Phase 2 precision: whole and half days (units are multiples of 0.5, never 0 on a ledger row).
 */
export const LEDGER_ENTRY_TYPES = { GRANT: 'GRANT', CARRY_FORWARD: 'CARRY_FORWARD', ADJUSTMENT: 'ADJUSTMENT', RESERVE: 'RESERVE', RELEASE: 'RELEASE', USE: 'USE', REFUND: 'REFUND' } as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[keyof typeof LEDGER_ENTRY_TYPES];

/** Sign a ledger row must carry per type (ADJUSTMENT may be either). */
export const LEDGER_SIGN: Record<LedgerEntryType, 1 | -1 | 0> = { GRANT: 1, CARRY_FORWARD: 1, ADJUSTMENT: 0, RESERVE: 1, RELEASE: -1, USE: 1, REFUND: -1 };

export interface BalanceSummary {
  granted: number;
  carriedForward: number;
  adjustment: number;
  reserved: number;
  used: number;
}
export const ZERO_SUMMARY: BalanceSummary = { granted: 0, carriedForward: 0, adjustment: 0, reserved: 0, used: 0 };

/** Aggregates ledger rows (or per-type sums) into the cached summary. Rounds to half-day precision to kill float noise. */
export function computeBalanceSummary(rows: readonly { entryType: string; units: number }[]): BalanceSummary {
  const s = { ...ZERO_SUMMARY };
  for (const r of rows) {
    switch (r.entryType) {
      case LEDGER_ENTRY_TYPES.GRANT: s.granted += r.units; break;
      case LEDGER_ENTRY_TYPES.CARRY_FORWARD: s.carriedForward += r.units; break;
      case LEDGER_ENTRY_TYPES.ADJUSTMENT: s.adjustment += r.units; break;
      case LEDGER_ENTRY_TYPES.RESERVE: case LEDGER_ENTRY_TYPES.RELEASE: s.reserved += r.units; break;
      case LEDGER_ENTRY_TYPES.USE: case LEDGER_ENTRY_TYPES.REFUND: s.used += r.units; break;
    }
  }
  return { granted: halfRound(s.granted), carriedForward: halfRound(s.carriedForward), adjustment: halfRound(s.adjustment), reserved: halfRound(s.reserved), used: halfRound(s.used) };
}

export function availableUnits(s: BalanceSummary): number {
  return halfRound(s.granted + s.carriedForward + s.adjustment - s.reserved - s.used);
}

/** Rounds to the nearest 0.5 (values are always half-day multiples; this only removes IEEE noise). */
export function halfRound(n: number): number {
  return Math.round(n * 2) / 2;
}

/** Deterministic operation keys (idempotency): business flows must reuse the same key on retry. */
export const operationKeys = {
  grant: (entitlementId: string) => `grant:${entitlementId}`,
  leave: (leaveRequestId: string, op: 'reserve' | 'release' | 'use' | 'refund') => `leave:${leaveRequestId}:${op}`,
};
