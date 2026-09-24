import { z } from 'zod';
import {
  CAREER_READINESS_STATUSES, DEVELOPMENT_ACTION_SOURCES, GAP_STATUSES, SUCCESSION_CRITICALITIES, SUCCESSION_PLAN_STATUSES, SUCCESSOR_READINESS,
  TALENT_BUCKETS, TALENT_CYCLE_STATUSES, TALENT_REVIEW_STATUSES, TRAINING_NEED_PRIORITIES,
} from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Career, talent and succession contracts (Task 28).
 *
 * Decision support, not decisions. The API shows performance history, competency gaps, development context,
 * readiness against a target job and a reviewer's potential judgment; it never says "promote", never ranks
 * employees 1..N and never picks a successor. Every field here that looks like a verdict is a person's recorded
 * choice with the person's name on it.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().toUpperCase().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, numbers, dash or underscore');

// ---------- career paths ----------
export const createCareerPathSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  organizationId: z.string().min(1).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateCareerPathInput = z.infer<typeof createCareerPathSchema>;
export const updateCareerPathSchema = createCareerPathSchema.omit({ code: true }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCareerPathInput = z.infer<typeof updateCareerPathSchema>;

export const addCareerStepSchema = z.object({
  fromJobId: z.string().min(1),
  toJobId: z.string().min(1),
  stepOrder: z.number().int().min(1).max(100).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
}).refine((v) => v.fromJobId !== v.toJobId, { message: 'A step must lead to a different job', path: ['toJobId'] });
export type AddCareerStepInput = z.infer<typeof addCareerStepSchema>;

export interface CareerStepDto {
  id: string;
  pathId: string;
  fromJob: { id: string; code: string; title: string };
  toJob: { id: string; code: string; title: string };
  stepOrder: number | null;
  description: string | null;
}
export interface CareerPathDto {
  id: string;
  code: string;
  name: string;
  organization: { id: string; name: string } | null;
  description: string | null;
  isActive: boolean;
  steps: CareerStepDto[];
  createdAt: string;
}

// ---------- career readiness ----------
export interface CareerReadinessRowDto {
  competencyId: string;
  competencyCode: string;
  competencyName: string;
  currentLevel: number | null;
  requiredLevel: number;
  gapNeeded: number | null;
  status: (typeof GAP_STATUSES)[number];
  assessmentDate: string | null;
}
export interface CareerReadinessDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  currentJob: { id: string; code: string; title: string } | null;
  targetJob: { id: string; code: string; title: string };
  competencies: CareerReadinessRowDto[];
  summary: { requirements: number; assessed: number; met: number; gaps: number; unassessed: number };
  /** Competency requirements only. Never a promotion recommendation. */
  status: (typeof CAREER_READINESS_STATUSES)[number];
  development: { openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null };
}
export interface MyCareerDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  currentJob: { id: string; code: string; title: string } | null;
  paths: { id: string; code: string; name: string; description: string | null; steps: CareerStepDto[] }[];
  /** Jobs reachable in one step from the current job, with readiness against each. */
  nextJobs: CareerReadinessDto[];
}

// ---------- talent review cycles ----------
const potentialLevelSchema = z.object({ code: z.enum(TALENT_BUCKETS), label: z.string().trim().min(1).max(60), description: z.string().trim().max(500).nullable().optional() });
export const createTalentCycleSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  periodStart: businessDate,
  periodEnd: businessDate,
  organizationId: z.string().min(1).nullable().optional(),
  performanceCycleId: z.string().min(1).nullable().optional(),
  /** The organization's own wording for the three potential levels. The meaning is theirs to define. */
  potentialLevels: z.array(potentialLevelSchema).length(3).optional(),
}).refine((v) => v.periodStart <= v.periodEnd, { message: 'The period ends before it starts', path: ['periodEnd'] });
export type CreateTalentCycleInput = z.infer<typeof createTalentCycleSchema>;
export const updateTalentCycleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  periodStart: businessDate.optional(),
  periodEnd: businessDate.optional(),
  performanceCycleId: z.string().min(1).nullable().optional(),
  potentialLevels: z.array(potentialLevelSchema).length(3).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTalentCycleInput = z.infer<typeof updateTalentCycleSchema>;

/** Rating code → bucket, one rule per rating band of the linked performance cycle. */
export const setBucketRulesSchema = z.object({ rules: z.array(z.object({ ratingCode: z.string().trim().min(1).max(30), bucket: z.enum(TALENT_BUCKETS) })).min(1).max(20) });
export type SetBucketRulesInput = z.infer<typeof setBucketRulesSchema>;

export const assignTalentReviewsSchema = z.object({
  employeeIds: z.array(z.string().min(1)).max(500).optional(),
  departmentId: z.string().min(1).optional(),
}).refine((v) => (v.employeeIds?.length ?? 0) > 0 || !!v.departmentId, { message: 'Choose employees or a department' });
export type AssignTalentReviewsInput = z.infer<typeof assignTalentReviewsSchema>;

export const reassignTalentReviewerSchema = z.object({ reviewerEmployeeId: z.string().min(1) });
export type ReassignTalentReviewerInput = z.infer<typeof reassignTalentReviewerSchema>;

export const submitPotentialSchema = z.object({
  potentialLevel: z.enum(TALENT_BUCKETS),
  potentialComment: z.string().trim().max(4000).nullable().optional(),
});
export type SubmitPotentialInput = z.infer<typeof submitPotentialSchema>;

export const talentCycleListQuerySchema = paginationQuerySchema.extend({ status: z.enum(TALENT_CYCLE_STATUSES).optional() });
export type TalentCycleListQuery = z.infer<typeof talentCycleListQuerySchema>;
export const talentReviewListQuerySchema = paginationQuerySchema.extend({
  cycleId: z.string().min(1).optional(),
  status: z.enum(TALENT_REVIEW_STATUSES).optional(),
  departmentId: z.string().min(1).optional(),
  nineBoxCell: z.string().max(60).optional(),
  view: z.enum(['mine', 'team', 'all']).default('all'),
});
export type TalentReviewListQuery = z.infer<typeof talentReviewListQuerySchema>;

export interface TalentCycleDto {
  id: string;
  code: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  organization: { id: string; name: string } | null;
  performanceCycle: { id: string; code: string; name: string; status: string; ratingBands: { code: string; label: string }[] } | null;
  potentialLevels: { code: (typeof TALENT_BUCKETS)[number]; label: string; description: string | null }[];
  bucketRules: { ratingCode: string; bucket: (typeof TALENT_BUCKETS)[number] }[];
  status: (typeof TALENT_CYCLE_STATUSES)[number];
  counts: { assigned: number; submitted: number; finalized: number };
  activatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface TalentReviewDto {
  id: string;
  cycle: { id: string; code: string; name: string; status: string };
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  snapshot: { organizationName: string | null; departmentName: string | null; jobTitle: string | null; positionTitle: string | null };
  reviewer: { employeeId: string | null; userId: string | null; name: string | null };
  performance: { planId: string | null; score: string | null; ratingCode: string | null; ratingLabel: string | null; bucket: (typeof TALENT_BUCKETS)[number] | null; cycleName: string | null };
  /** Present only for the reviewer and cycle managers; null for a team summary. */
  potentialLevel: (typeof TALENT_BUCKETS)[number] | null;
  /** The most sensitive field in the module: reviewer and cycle managers only. */
  potentialComment: string | null;
  commentVisible: boolean;
  nineBoxCell: string | null;
  status: (typeof TALENT_REVIEW_STATUSES)[number];
  submittedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
}

/** What the reviewer sees while assessing: facts, no verdicts. */
export interface TalentReviewContextDto {
  review: TalentReviewDto;
  competencySummary: { requirements: number; assessed: number; gaps: number; unassessed: number; status: (typeof CAREER_READINESS_STATUSES)[number] } | null;
  development: { openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null };
  priorReviews: { cycleName: string; nineBoxCell: string | null; finalizedAt: string | null }[];
}

export interface NineBoxDto {
  cycle: { id: string; name: string; status: string };
  cells: { cell: string; performance: string; potential: string; count: number }[];
  unplaced: { noPerformance: number; noPotential: number };
  total: number;
}

// ---------- talent pools ----------
export const createTalentPoolSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  organizationId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().default(true),
});
export type CreateTalentPoolInput = z.infer<typeof createTalentPoolSchema>;
export const updateTalentPoolSchema = createTalentPoolSchema.omit({ code: true }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTalentPoolInput = z.infer<typeof updateTalentPoolSchema>;
export const addPoolMemberSchema = z.object({
  employeeId: z.string().min(1),
  reason: z.string().trim().max(1000).nullable().optional(),
  sourceTalentReviewId: z.string().min(1).nullable().optional(),
});
export type AddPoolMemberInput = z.infer<typeof addPoolMemberSchema>;
export const removePoolMemberSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() });
export type RemovePoolMemberInput = z.infer<typeof removePoolMemberSchema>;

export interface TalentPoolMemberDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; jobTitle: string | null; departmentName: string | null };
  addedAt: string;
  addedBy: string | null;
  reason: string | null;
  sourceTalentReview: { id: string; cycleName: string } | null;
  status: 'ACTIVE' | 'REMOVED';
  removedAt: string | null;
  removedBy: string | null;
  removalReason: string | null;
}
export interface TalentPoolDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string } | null;
  isActive: boolean;
  activeMembers: number;
  createdAt: string;
}

// ---------- succession ----------
export const createSuccessionPlanSchema = z.object({
  positionId: z.string().min(1),
  criticality: z.enum(SUCCESSION_CRITICALITIES).default('NORMAL'),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type CreateSuccessionPlanInput = z.infer<typeof createSuccessionPlanSchema>;
export const updateSuccessionPlanSchema = z.object({
  criticality: z.enum(SUCCESSION_CRITICALITIES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(SUCCESSION_PLAN_STATUSES).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSuccessionPlanInput = z.infer<typeof updateSuccessionPlanSchema>;
export const nominateSuccessorSchema = z.object({
  employeeId: z.string().min(1),
  readiness: z.enum(SUCCESSOR_READINESS),
  targetReadinessDate: businessDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type NominateSuccessorInput = z.infer<typeof nominateSuccessorSchema>;
export const updateSuccessorSchema = z.object({
  readiness: z.enum(SUCCESSOR_READINESS).optional(),
  targetReadinessDate: businessDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateSuccessorInput = z.infer<typeof updateSuccessorSchema>;
export const removeSuccessorSchema = z.object({ reason: z.string().trim().max(1000).nullable().optional() });
export type RemoveSuccessorInput = z.infer<typeof removeSuccessorSchema>;
export const successionListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SUCCESSION_PLAN_STATUSES).optional(),
  criticality: z.enum(SUCCESSION_CRITICALITIES).optional(),
  departmentId: z.string().min(1).optional(),
});
export type SuccessionListQuery = z.infer<typeof successionListQuerySchema>;

export interface SuccessionCandidateDto {
  id: string;
  planId: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  /** The candidate's job and department as they were when nominated. A later transfer does not rewrite this. */
  snapshot: { jobTitle: string | null; departmentName: string | null; positionTitle: string | null };
  readiness: (typeof SUCCESSOR_READINESS)[number];
  targetReadinessDate: string | null;
  /** Succession notes: `succession.manage` only. */
  notes: string | null;
  nominatedAt: string;
  nominatedBy: string | null;
  status: 'ACTIVE' | 'REMOVED';
  removedAt: string | null;
  removedBy: string | null;
  removalReason: string | null;
}
export interface SuccessionPlanDto {
  id: string;
  position: { id: string; code: string; title: string };
  snapshot: { organizationName: string | null; departmentName: string | null; jobTitle: string | null; positionTitle: string };
  jobId: string | null;
  incumbents: { id: string; employeeCode: string; firstName: string; lastName: string }[];
  criticality: (typeof SUCCESSION_CRITICALITIES)[number];
  notes: string | null;
  status: (typeof SUCCESSION_PLAN_STATUSES)[number];
  candidates: SuccessionCandidateDto[];
  counts: { active: number; readyNow: number; readySoon: number; developing: number };
  createdAt: string;
  closedAt: string | null;
}

/** Current facts about a nominee, next to the nomination as it was made. No composite score. */
export interface SuccessionCandidateContextDto {
  candidate: SuccessionCandidateDto;
  plan: { id: string; positionTitle: string; jobTitle: string | null; jobId: string | null };
  currentJob: { id: string; code: string; title: string } | null;
  readiness: CareerReadinessDto | null;
  performance: { cycleName: string; score: string | null; ratingLabel: string | null; finalizedAt: string | null } | null;
  talentReview: { cycleName: string; nineBoxCell: string | null; finalizedAt: string | null } | null;
  development: { openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null };
}

// ---------- development handoff ----------
export const createDevelopmentActionSchema = z.object({
  employeeId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  competencyId: z.string().min(1).nullable().optional(),
  priority: z.enum(TRAINING_NEED_PRIORITIES).default('NORMAL'),
  source: z.object({ type: z.enum(DEVELOPMENT_ACTION_SOURCES), id: z.string().min(1).nullable().optional() }),
});
export type CreateDevelopmentActionInput = z.infer<typeof createDevelopmentActionSchema>;

// ---------- summary and reports ----------
export interface TalentSummaryDto {
  employeeId: string;
  careerTargetCount: number;
  latestTalentReview: { cycleName: string; status: string; nineBoxCell: string | null; finalizedAt: string | null } | null;
  talentPoolCount: number;
  activeSuccessionNominations: number;
  development: { openNeeds: number; activeIdpId: string | null; activeIdpTitle: string | null };
}
export interface TalentReportDto {
  cycles: { id: string; name: string; status: string; assigned: number; submitted: number; finalized: number; completionRate: number | null }[];
  nineBox: { cell: string; count: number }[];
  potentialDistribution: { level: string; count: number }[];
  byDepartment: { departmentName: string; reviews: number; submitted: number }[];
  pools: { name: string; activeMembers: number }[];
}
export interface SuccessionReportDto {
  plans: { total: number; active: number; withSuccessor: number; withReadyNow: number; withoutSuccessor: number };
  byDepartment: { departmentName: string; plans: number; withSuccessor: number; withoutSuccessor: number }[];
  byCriticality: { criticality: string; plans: number; withSuccessor: number; withReadyNow: number }[];
  candidatesByReadiness: { readiness: string; count: number }[];
  criticalWithoutSuccessor: number;
}
