import { z } from 'zod';
import { HEADCOUNT_DELTA_CLASSES, MOVEMENT_STATUSES, ORG_DESIGN_NODE_TYPES, ORG_DESIGN_SCENARIO_STATUSES, POSITION_PLANNING_STATUSES, WORKFORCE_CYCLE_STATUSES, WORKFORCE_PLAN_REASONS, WORKFORCE_PRIORITIES } from '../workforce';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();

// ---------- planning cycles ----------
export const createWorkforceCycleSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/i, 'Letters, digits, - and _ only'),
  name: z.string().trim().min(2).max(120),
  organizationId: z.string().min(1).nullable().optional(),
  periodStart: date,
  periodEnd: date,
  description: text(2000),
}).strict().refine((v) => v.periodStart <= v.periodEnd, { message: 'periodEnd must not be before periodStart', path: ['periodEnd'] });
export type CreateWorkforceCycleInput = z.infer<typeof createWorkforceCycleSchema>;
export const updateWorkforceCycleSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), periodStart: date.optional(), periodEnd: date.optional(), description: text(2000) }).strict();
export type UpdateWorkforceCycleInput = z.infer<typeof updateWorkforceCycleSchema>;
export const transitionWorkforceCycleSchema = z.object({ status: z.enum(WORKFORCE_CYCLE_STATUSES) }).strict();
export const workforceCycleListQuerySchema = paginationQuerySchema.extend({ status: z.enum(WORKFORCE_CYCLE_STATUSES).optional(), organizationId: z.string().min(1).optional() });
export type WorkforceCycleListQuery = z.infer<typeof workforceCycleListQuerySchema>;

// ---------- plan items ----------
export const addWorkforcePlanItemSchema = z.object({ departmentId: z.string().min(1), jobId: z.string().min(1).nullable().optional(), plannedHeadcount: z.number().int().min(0).max(100000).optional() }).strict();
export type AddWorkforcePlanItemInput = z.infer<typeof addWorkforcePlanItemSchema>;
export const updateWorkforcePlanItemSchema = z.object({
  plannedHeadcount: z.number().int().min(0).max(100000).optional(),
  reason: z.enum(WORKFORCE_PLAN_REASONS).nullable().optional(),
  priority: z.enum(WORKFORCE_PRIORITIES).nullable().optional(),
  targetDate: date.nullable().optional(),
  notes: text(2000),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateWorkforcePlanItemInput = z.infer<typeof updateWorkforcePlanItemSchema>;
export const workforcePlanItemsQuerySchema = z.object({ departmentId: z.string().min(1).optional(), jobId: z.string().min(1).optional(), classification: z.enum(HEADCOUNT_DELTA_CLASSES).optional() });
export type WorkforcePlanItemsQuery = z.infer<typeof workforcePlanItemsQuerySchema>;

/** Handoff: HR chooses the openings explicitly; the plan only shows the factual numbers. */
export const requisitionFromPlanSchema = z.object({
  requestedOpenings: z.number().int().min(1).max(500),
  reason: z.enum(['NEW_HEADCOUNT', 'REPLACEMENT', 'TEMPORARY', 'OTHER']).optional(),
  hiringManagerEmployeeId: z.string().min(1).nullable().optional(),
  desiredStartDate: date.nullable().optional(),
  justification: text(2000),
}).strict();
export type RequisitionFromPlanInput = z.infer<typeof requisitionFromPlanSchema>;

// ---------- planned movements ----------
export const createPlannedMovementSchema = z.object({
  employeeId: z.string().min(1).nullable().optional(),
  fromDepartmentId: z.string().min(1).nullable().optional(),
  toDepartmentId: z.string().min(1).nullable().optional(),
  fromJobId: z.string().min(1).nullable().optional(),
  toJobId: z.string().min(1).nullable().optional(),
  targetDate: date.nullable().optional(),
  notes: text(1000),
}).strict().refine((v) => v.toDepartmentId || v.toJobId, { message: 'A planned movement needs a target department or job' });
export type CreatePlannedMovementInput = z.infer<typeof createPlannedMovementSchema>;
export const updatePlannedMovementSchema = z.object({ status: z.enum(MOVEMENT_STATUSES).optional(), targetDate: date.nullable().optional(), notes: text(1000) }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePlannedMovementInput = z.infer<typeof updatePlannedMovementSchema>;

// ---------- organization design ----------
export const createOrgDesignScenarioSchema = z.object({ name: z.string().trim().min(2).max(120), description: text(2000), organizationId: z.string().min(1), planningCycleId: z.string().min(1).nullable().optional() }).strict();
export type CreateOrgDesignScenarioInput = z.infer<typeof createOrgDesignScenarioSchema>;
export const updateOrgDesignScenarioSchema = z.object({ name: z.string().trim().min(2).max(120).optional(), description: text(2000), planningCycleId: z.string().min(1).nullable().optional() }).strict();
export type UpdateOrgDesignScenarioInput = z.infer<typeof updateOrgDesignScenarioSchema>;
export const transitionOrgDesignScenarioSchema = z.object({ status: z.enum(ORG_DESIGN_SCENARIO_STATUSES) }).strict();
export const orgDesignScenarioListQuerySchema = paginationQuerySchema.extend({ status: z.enum(ORG_DESIGN_SCENARIO_STATUSES).optional(), organizationId: z.string().min(1).optional() });
export type OrgDesignScenarioListQuery = z.infer<typeof orgDesignScenarioListQuerySchema>;

export const createOrgDesignNodeSchema = z.object({
  nodeType: z.enum(ORG_DESIGN_NODE_TYPES),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(30).nullable().optional(),
  parentNodeId: z.string().min(1).nullable().optional(),
  sourceDepartmentId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
}).strict();
export type CreateOrgDesignNodeInput = z.infer<typeof createOrgDesignNodeSchema>;
export const updateOrgDesignNodeSchema = createOrgDesignNodeSchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOrgDesignNodeInput = z.infer<typeof updateOrgDesignNodeSchema>;

export const createOrgDesignPositionSchema = z.object({
  nodeId: z.string().min(1),
  jobId: z.string().min(1).nullable().optional(),
  plannedJobTitle: z.string().trim().max(120).nullable().optional(),
  plannedHeadcount: z.number().int().min(0).max(100000),
  reportsToNodeId: z.string().min(1).nullable().optional(),
  notes: text(1000),
}).strict().refine((v) => v.jobId || v.plannedJobTitle, { message: 'Choose a job or give the planned job a title' });
export type CreateOrgDesignPositionInput = z.infer<typeof createOrgDesignPositionSchema>;
export const updateOrgDesignPositionSchema = z.object({ jobId: z.string().min(1).nullable().optional(), plannedJobTitle: z.string().trim().max(120).nullable().optional(), plannedHeadcount: z.number().int().min(0).max(100000).optional(), reportsToNodeId: z.string().min(1).nullable().optional(), notes: text(1000) }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOrgDesignPositionInput = z.infer<typeof updateOrgDesignPositionSchema>;
export const duplicateOrgDesignScenarioSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
export const compareScenariosQuerySchema = z.object({ with: z.string().min(1) });

// ---------- DTOs ----------
export interface WorkforceCycleDto { id: string; code: string; name: string; organizationId: string | null; organizationName: string | null; periodStart: string; periodEnd: string; status: (typeof WORKFORCE_CYCLE_STATUSES)[number]; description: string | null; itemCount: number; finalizedAt: string | null; archivedAt: string | null; createdByUserId: string; createdAt: string; updatedAt: string; can: { edit: boolean; finalize: boolean } }
export interface RecruitmentContextDto { approvedRequisitions: number; approvedOpenings: number; pendingRequisitions: number; openOpenings: number; hired: number; openRecruitmentDemand: number }
export interface WorkforcePlanItemDto {
  id: string; cycleId: string; organizationId: string; departmentId: string; departmentName: string; jobId: string | null; jobTitle: string | null;
  currentHeadcountSnapshot: number; snapshotAt: string; currentHeadcountLive: number | null; plannedHeadcount: number; delta: number; classification: (typeof HEADCOUNT_DELTA_CLASSES)[number];
  reason: (typeof WORKFORCE_PLAN_REASONS)[number] | null; priority: (typeof WORKFORCE_PRIORITIES)[number] | null; targetDate: string | null; notes: string | null;
  recruitment: RecruitmentContextDto; remainingDemand: number; requisitions: { id: string; requisitionNumber: string; status: string; requestedOpenings: number }[]; updatedAt: string;
}
export interface WorkforceDashboardDto {
  cycle: { id: string; code: string; name: string; status: string } | null;
  currentHeadcount: number; plannedHeadcount: number; netDelta: number; expansionDemand: number; plannedReductions: number; noChangeRows: number;
  vacantPositions: number; openRecruitmentDemand: number; remainingDemand: number;
  byDepartment: { departmentId: string; departmentName: string; current: number; planned: number; delta: number; classification: (typeof HEADCOUNT_DELTA_CLASSES)[number] }[];
  byJob: { jobId: string | null; jobTitle: string; current: number; planned: number; delta: number }[];
  generatedAt: string;
}
export interface VacancyDto { positionId: string; positionCode: string; positionTitle: string; departmentId: string; departmentName: string; jobId: string | null; jobTitle: string | null; activeEmployees: number; status: (typeof POSITION_PLANNING_STATUSES)[number] }
export interface PlannedMovementDto { id: string; cycleId: string; employee: { id: string; employeeCode: string; firstName: string; lastName: string } | null; fromDepartment: { id: string; name: string } | null; toDepartment: { id: string; name: string } | null; fromJob: { id: string; title: string } | null; toJob: { id: string; title: string } | null; targetDate: string | null; status: (typeof MOVEMENT_STATUSES)[number]; notes: string | null; createdAt: string; updatedAt: string }

export interface OrgDesignScenarioDto { id: string; name: string; description: string | null; organizationId: string; organizationName: string; planningCycleId: string | null; planningCycleName: string | null; status: (typeof ORG_DESIGN_SCENARIO_STATUSES)[number]; nodeCount: number; plannedHeadcount: number; finalizedAt: string | null; createdByUserId: string; createdAt: string; updatedAt: string; can: { edit: boolean } }
export interface OrgDesignPositionDto { id: string; nodeId: string; jobId: string | null; jobTitle: string | null; plannedJobTitle: string | null; plannedHeadcount: number; reportsToNodeId: string | null; notes: string | null }
export interface OrgDesignNodeDto { id: string; nodeType: (typeof ORG_DESIGN_NODE_TYPES)[number]; name: string; code: string | null; parentNodeId: string | null; sourceDepartmentId: string | null; sourceDepartmentName: string | null; plannedOnly: boolean; sortOrder: number; plannedHeadcount: number; currentHeadcount: number; positions: OrgDesignPositionDto[]; children: OrgDesignNodeDto[] }
export interface OrgDesignTreeDto { scenario: OrgDesignScenarioDto; roots: OrgDesignNodeDto[]; totals: { planned: number; current: number; delta: number; plannedOnlyNodes: number } }
export interface OrgDesignComparisonDto {
  scenario: { id: string; name: string; status: string };
  totals: { current: number; planned: number; delta: number };
  byDepartment: { name: string; sourceDepartmentId: string | null; plannedOnly: boolean; current: number; planned: number; delta: number }[];
  byJob: { jobId: string | null; jobTitle: string; current: number; planned: number; delta: number }[];
}
export interface ScenarioComparisonDto {
  a: { id: string; name: string; planned: number }; b: { id: string; name: string; planned: number }; delta: number;
  byDepartment: { name: string; a: number; b: number; delta: number }[];
  byJob: { jobTitle: string; a: number; b: number; delta: number }[];
}
