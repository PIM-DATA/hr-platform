/**
 * Workforce planning and organization design — pure domain helpers (Task 32).
 *
 * Planning sits beside the live organization, never inside it. These helpers describe a plan factually: what is,
 * what is planned, and the difference. They never say who should go, who should be hired or which scenario is best.
 */
export const WORKFORCE_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'FINALIZED', 'ARCHIVED'] as const;
export type WorkforceCycleStatus = (typeof WORKFORCE_CYCLE_STATUSES)[number];
/** Allowed transitions. Finalization freezes the plan; there is no reopen. */
export const WORKFORCE_CYCLE_TRANSITIONS: Record<WorkforceCycleStatus, WorkforceCycleStatus[]> = { DRAFT: ['ACTIVE', 'ARCHIVED'], ACTIVE: ['FINALIZED', 'DRAFT'], FINALIZED: ['ARCHIVED'], ARCHIVED: [] };

export const WORKFORCE_PLAN_REASONS = ['GROWTH', 'REPLACEMENT', 'RESTRUCTURE', 'NEW_FUNCTION', 'SEASONAL', 'OTHER'] as const;
export type WorkforcePlanReason = (typeof WORKFORCE_PLAN_REASONS)[number];
export const WORKFORCE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
export type WorkforcePriority = (typeof WORKFORCE_PRIORITIES)[number];

export const HEADCOUNT_DELTA_CLASSES = ['EXPANSION', 'NO_CHANGE', 'REDUCTION_PLANNED'] as const;
export type HeadcountDeltaClass = (typeof HEADCOUNT_DELTA_CLASSES)[number];

/** planned − current, with its factual classification. Never a recommendation. */
export function headcountDelta(plannedHeadcount: number, currentHeadcount: number): { delta: number; classification: HeadcountDeltaClass } {
  const delta = plannedHeadcount - currentHeadcount;
  return { delta, classification: delta > 0 ? 'EXPANSION' : delta < 0 ? 'REDUCTION_PLANNED' : 'NO_CHANGE' };
}
/** Planned growth not yet covered by recruitment demand already in flight. Zero when the plan shrinks or demand exceeds it. */
export const remainingDemand = (plannedHeadcount: number, currentHeadcount: number, openRecruitmentDemand: number): number =>
  Math.max(0, plannedHeadcount - currentHeadcount - Math.max(0, openRecruitmentDemand));

export const MOVEMENT_STATUSES = ['PLANNED', 'CANCELLED', 'COMPLETED_EXTERNALLY'] as const;
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export const ORG_DESIGN_SCENARIO_STATUSES = ['DRAFT', 'FINALIZED', 'ARCHIVED'] as const;
export type OrgDesignScenarioStatus = (typeof ORG_DESIGN_SCENARIO_STATUSES)[number];
export const ORG_DESIGN_NODE_TYPES = ['ORGANIZATION', 'DEPARTMENT', 'TEAM'] as const;
export type OrgDesignNodeType = (typeof ORG_DESIGN_NODE_TYPES)[number];

/** Planning projection of a live position. FILLED/VACANT are counts of active employees; PLANNED exists only in a scenario. */
export const POSITION_PLANNING_STATUSES = ['FILLED', 'VACANT', 'PLANNED'] as const;
export type PositionPlanningStatus = (typeof POSITION_PLANNING_STATUSES)[number];

/** Maps a workforce plan reason onto the recruitment requisition reasons of Task 27. Chosen by HR at handoff; this is the default. */
export const REQUISITION_REASON_FOR_PLAN: Record<WorkforcePlanReason, 'NEW_HEADCOUNT' | 'REPLACEMENT' | 'TEMPORARY' | 'OTHER'> = { GROWTH: 'NEW_HEADCOUNT', REPLACEMENT: 'REPLACEMENT', RESTRUCTURE: 'OTHER', NEW_FUNCTION: 'NEW_HEADCOUNT', SEASONAL: 'TEMPORARY', OTHER: 'OTHER' };

/** Planning grain key: department + job (a position without a job plans under "no job"). */
export const planGrainKey = (departmentId: string, jobId: string | null): string => `${departmentId}:${jobId ?? '-'}`;
