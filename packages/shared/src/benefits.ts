/**
 * Benefits / welfare vocabulary (Task 36) and the ONE place the entitlement ledger sign convention is written down.
 * The arithmetic itself runs on `Prisma.Decimal` in the API (`apps/api/src/modules/benefits/benefit-ledger.ts`);
 * nothing in this package touches a JavaScript number for money.
 *
 *   GRANT       +amount   what a period gives
 *   ADJUSTMENT  ±amount   an explicit HR correction, reason required
 *   RESERVE     +amount   a submitted claim holds this until decided   (reserved = Σ RESERVE + Σ RELEASE)
 *   RELEASE     −amount   the hold comes back (reject, cancel, or approval converting it)
 *   CONSUME     +amount   an approved claim spends this permanently
 *   available = granted + adjustment − reserved − consumed
 */
export const BENEFIT_PLAN_TYPES = ['REIMBURSEMENT', 'ALLOWANCE', 'COVERAGE_ONLY'] as const;
export const BENEFIT_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export const BENEFIT_SENSITIVITIES = ['NORMAL', 'CONFIDENTIAL'] as const;
export const BENEFIT_PERIOD_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;
export const BENEFIT_ENROLLMENT_STATUSES = ['ELIGIBLE', 'ENROLLED', 'WAIVED', 'ENDED'] as const;
export const BENEFIT_ENROLLMENT_SOURCES = ['SELF', 'HR'] as const;
/** Allow-listed employee-master dimensions. No protected attribute can be expressed: there is no field for one. */
export const BENEFIT_RULE_TYPES = ['ORGANIZATION', 'DEPARTMENT', 'JOB', 'POSITION', 'EMPLOYMENT_TYPE', 'EMPLOYMENT_STATUS', 'MIN_TENURE_MONTHS'] as const;
export const BENEFIT_OVERRIDE_MODES = ['INCLUDE', 'EXCLUDE'] as const;
export const BENEFIT_OVERRIDE_REASONS = ['CONTRACT_TERM', 'TRANSFER', 'POLICY_EXCEPTION', 'DATA_CORRECTION', 'OTHER'] as const;
export const BENEFIT_LEDGER_ENTRY_TYPES = ['GRANT', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'CONSUME'] as const;
export type BenefitLedgerEntryType = (typeof BENEFIT_LEDGER_ENTRY_TYPES)[number];
/** Sign a ledger row must carry per type (ADJUSTMENT may be either, never zero). */
export const BENEFIT_LEDGER_SIGN: Record<BenefitLedgerEntryType, 1 | -1 | 0> = { GRANT: 1, ADJUSTMENT: 0, RESERVE: 1, RELEASE: -1, CONSUME: 1 };
export const BENEFIT_ADJUSTMENT_REASONS = ['PRORATION', 'TRANSFER', 'POLICY_CHANGE', 'DATA_CORRECTION', 'GOODWILL', 'OTHER'] as const;
/**
 * APPROVED and READY_FOR_PAYMENT are one state here: final approval makes a reimbursement ready for payment at once,
 * and nothing sits between them. SENT_TO_PAYROLL says the amount was handed to a payroll run; only PAID says money moved.
 */
export const BENEFIT_CLAIM_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID', 'REJECTED', 'CANCELLED'] as const;
export type BenefitClaimStatus = (typeof BENEFIT_CLAIM_STATUSES)[number];
export const BENEFIT_PAYMENT_METHODS = ['EXTERNAL', 'PAYROLL', 'OTHER'] as const;
export const BENEFIT_CLAIM_DESCRIPTION_MAX = 500;
export const BENEFIT_WORKFLOW = { module: 'benefits', entityType: 'BENEFIT_CLAIM' } as const;
/** Deterministic ledger operation keys: a retried transition can never settle twice. */
export const benefitOperationKeys = {
  grant: (entitlementId: string) => `benefit-grant:${entitlementId}`,
  claim: (claimId: string, op: 'reserve' | 'release' | 'consume') => `benefit-claim:${claimId}:${op}`,
};
/** Whole months of service between two YYYY-MM-DD dates (calendar months, day-of-month respected). */
export function tenureMonths(hireDate: string, asOf: string): number {
  const [hy, hm, hd] = hireDate.split('-').map(Number); const [ay, am, ad] = asOf.split('-').map(Number);
  let months = (ay - hy) * 12 + (am - hm);
  if (ad < hd) months -= 1;
  return Math.max(0, months);
}
