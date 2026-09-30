import type { AggregateSuppression } from '../privacy-aggregates';
import { z } from 'zod';
import {
  KPI_MEASUREMENT_TYPES, PERFORMANCE_CYCLE_STATUSES, PERFORMANCE_PLAN_STATUSES,
} from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Performance contracts (Task 23).
 *
 * Scores and weights cross the wire as **decimal strings**, like money: a weight of `33.33` three times must add up
 * to exactly `100.00`, and a float would make that a coin toss. The server is the only thing that calculates a
 * weighted score — the UI formats what it is given.
 *
 * A KPI's *definition* lives in the library; what an employee was actually measured on is **snapshotted onto their
 * plan**, so renaming a KPI next year cannot rewrite last year's review.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscore, starting with a letter');
/** A score or a weight: positive, at most two decimal places, as a string. */
const decimalField = z.string().trim().regex(/^\d{1,5}(\.\d{1,2})?$/, 'Use a number with at most two decimal places');
/** What a KPI is measured in. A sales target is 1,000,000, not a score, so it gets its own range. */
const measureField = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use a number with at most two decimal places');

// ---------- rating bands ----------
export const ratingBandSchema = z
  .object({
    code: codeField,
    label: z.string().trim().min(1).max(60),
    minScore: decimalField,
    maxScore: decimalField,
  })
  .refine((v) => Number(v.minScore) <= Number(v.maxScore), { message: 'minScore must be at or below maxScore', path: ['maxScore'] });
export type RatingBandInput = z.infer<typeof ratingBandSchema>;

export interface RatingBandDto {
  id: string;
  code: string;
  label: string;
  minScore: string;
  maxScore: string;
}

// ---------- cycle ----------
const cycleBase = {
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  organizationId: z.string().min(1).nullable().optional(),
  periodStart: businessDate,
  periodEnd: businessDate,
  selfReviewStart: businessDate.nullable().optional(),
  selfReviewEnd: businessDate.nullable().optional(),
  managerReviewStart: businessDate.nullable().optional(),
  managerReviewEnd: businessDate.nullable().optional(),
  /** Not every employer asks people to appraise themselves; one that does not should not be made to. */
  selfReviewRequired: z.boolean().default(true),
  minScore: decimalField.default('1'),
  maxScore: decimalField.default('5'),
  scoreStep: decimalField.default('0.1'),
  ratingBands: z.array(ratingBandSchema).max(12).default([]),
};

/** Review windows must sit inside the period, and the manager window must not open before the self window does. */
const chronology = (v: {
  periodStart: string; periodEnd: string;
  selfReviewStart?: string | null; selfReviewEnd?: string | null;
  managerReviewStart?: string | null; managerReviewEnd?: string | null;
}) => {
  const issues: { path: string; message: string }[] = [];
  if (v.periodStart > v.periodEnd) issues.push({ path: 'periodEnd', message: 'periodEnd must be on or after periodStart' });
  if (v.selfReviewStart && v.selfReviewEnd && v.selfReviewStart > v.selfReviewEnd) issues.push({ path: 'selfReviewEnd', message: 'The self-review window ends before it starts' });
  if (v.managerReviewStart && v.managerReviewEnd && v.managerReviewStart > v.managerReviewEnd) issues.push({ path: 'managerReviewEnd', message: 'The manager-review window ends before it starts' });
  if (v.selfReviewStart && v.selfReviewStart < v.periodStart) issues.push({ path: 'selfReviewStart', message: 'The self-review window starts before the period does' });
  if (v.managerReviewStart && v.selfReviewStart && v.managerReviewStart < v.selfReviewStart) {
    issues.push({ path: 'managerReviewStart', message: 'The manager review cannot open before the self review does' });
  }
  return issues;
};

const withChronology = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const v = value as Parameters<typeof chronology>[0] & { minScore?: string; maxScore?: string };
    if (v.periodStart && v.periodEnd) {
      for (const issue of chronology(v)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
    if (v.minScore && v.maxScore && Number(v.minScore) >= Number(v.maxScore)) {
      ctx.addIssue({ code: 'custom', path: ['maxScore'], message: 'maxScore must be above minScore' });
    }
  });

export const createPerformanceCycleSchema = withChronology(z.object(cycleBase));
export type CreatePerformanceCycleInput = z.infer<typeof createPerformanceCycleSchema>;

export const updatePerformanceCycleSchema = withChronology(
  z.object({
    name: cycleBase.name.optional(),
    description: cycleBase.description,
    periodStart: businessDate.optional(),
    periodEnd: businessDate.optional(),
    selfReviewStart: cycleBase.selfReviewStart,
    selfReviewEnd: cycleBase.selfReviewEnd,
    managerReviewStart: cycleBase.managerReviewStart,
    managerReviewEnd: cycleBase.managerReviewEnd,
    selfReviewRequired: z.boolean().optional(),
    minScore: decimalField.optional(),
    maxScore: decimalField.optional(),
    scoreStep: decimalField.optional(),
    ratingBands: z.array(ratingBandSchema).max(12).optional(),
  }),
);
export type UpdatePerformanceCycleInput = z.infer<typeof updatePerformanceCycleSchema>;

export const performanceCycleListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  status: z.enum(PERFORMANCE_CYCLE_STATUSES).optional(),
});
export type PerformanceCycleListQuery = z.infer<typeof performanceCycleListQuerySchema>;

export interface PerformanceCycleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  organization: { id: string; code: string; name: string } | null;
  periodStart: string;
  periodEnd: string;
  selfReviewStart: string | null;
  selfReviewEnd: string | null;
  managerReviewStart: string | null;
  managerReviewEnd: string | null;
  selfReviewRequired: boolean;
  minScore: string;
  maxScore: string;
  scoreStep: string;
  status: (typeof PERFORMANCE_CYCLE_STATUSES)[number];
  ratingBands: RatingBandDto[];
  planCount: number;
  createdAt: string;
}

// ---------- KPI library ----------
export const createKpiSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  measurementType: z.enum(KPI_MEASUREMENT_TYPES),
  unit: z.string().trim().max(20).nullable().optional(),
  defaultWeight: decimalField.nullable().optional(),
  organizationId: z.string().min(1).nullable().optional(),
});
export type CreateKpiInput = z.infer<typeof createKpiSchema>;

export const updateKpiSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    category: z.string().trim().max(60).nullable().optional(),
    unit: z.string().trim().max(20).nullable().optional(),
    defaultWeight: decimalField.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateKpiInput = z.infer<typeof updateKpiSchema>;

export const kpiListQuerySchema = paginationQuerySchema.extend({
  category: z.string().trim().max(60).optional(),
  measurementType: z.enum(KPI_MEASUREMENT_TYPES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  organizationId: z.string().min(1).optional(),
});
export type KpiListQuery = z.infer<typeof kpiListQuerySchema>;

export interface KpiDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  measurementType: (typeof KPI_MEASUREMENT_TYPES)[number];
  unit: string | null;
  defaultWeight: string | null;
  organization: { id: string; code: string; name: string } | null;
  isActive: boolean;
}

// ---------- plans ----------
/** Assign a whole population at once: HR picks a filter or a list, never one person at a time. */
export const assignPlansSchema = z
  .object({
    employeeIds: z.array(z.string().min(1)).max(500).optional(),
    organizationId: z.string().min(1).optional(),
    departmentId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    positionId: z.string().min(1).optional(),
  })
  .refine((v) => v.employeeIds?.length || v.organizationId || v.departmentId || v.jobId || v.positionId, {
    message: 'Choose employees, or a filter that selects them',
  });
export type AssignPlansInput = z.infer<typeof assignPlansSchema>;

export interface AssignPlansResultDto {
  created: number;
  alreadyAssigned: number;
  skipped: { employeeCode: string; reason: string }[];
}

export const updatePlanSchema = z
  .object({
    /** HR can name a reviewer when the direct manager has no account, or none is set. */
    reviewerEmployeeId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const planListQuerySchema = paginationQuerySchema.extend({
  cycleId: z.string().min(1).optional(),
  status: z.enum(PERFORMANCE_PLAN_STATUSES).optional(),
  departmentId: z.string().min(1).optional(),
  /** mine = my own plan, reviewing = the plans I am the snapshot reviewer for, all = everyone (managers of cycles). */
  view: z.enum(['mine', 'reviewing', 'all']).default('mine'),
});
export type PlanListQuery = z.infer<typeof planListQuerySchema>;

// ---------- plan items ----------
export const addPlanItemSchema = z
  .object({
    kpiId: z.string().min(1).optional(),
    /** Without a library KPI, the plan item stands on its own — these are then required. */
    name: z.string().trim().min(1).max(120).optional(),
    measurementType: z.enum(KPI_MEASUREMENT_TYPES).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    weight: decimalField,
    targetValue: measureField.nullable().optional(),
    targetText: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => v.kpiId || (v.name && v.measurementType), { message: 'Choose a KPI from the library, or give a name and how it is measured' });
export type AddPlanItemInput = z.infer<typeof addPlanItemSchema>;

export const updatePlanItemSchema = z
  .object({
    weight: decimalField.optional(),
    targetValue: measureField.nullable().optional(),
    targetText: z.string().trim().max(300).nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePlanItemInput = z.infer<typeof updatePlanItemSchema>;

/** What an employee records as the period runs: where they have got to, and what they can show for it. */
export const updateProgressSchema = z
  .object({
    actualValue: measureField.nullable().optional(),
    actualText: z.string().trim().max(300).nullable().optional(),
    progressPercent: z.number().int().min(0).max(100).nullable().optional(),
    employeeComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;

export const selfAssessmentSchema = z
  .object({
    selfScore: decimalField.nullable().optional(),
    employeeComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type SelfAssessmentInput = z.infer<typeof selfAssessmentSchema>;

export const managerAssessmentSchema = z
  .object({
    managerScore: decimalField.nullable().optional(),
    managerComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ManagerAssessmentInput = z.infer<typeof managerAssessmentSchema>;

export interface PlanItemDto {
  id: string;
  kpiId: string | null;
  kpiCode: string;
  kpiName: string;
  description: string | null;
  measurementType: (typeof KPI_MEASUREMENT_TYPES)[number];
  weight: string;
  targetValue: string | null;
  targetText: string | null;
  actualValue: string | null;
  actualText: string | null;
  progressPercent: number | null;
  employeeComment: string | null;
  managerComment: string | null;
  selfScore: string | null;
  managerScore: string | null;
  finalScore: string | null;
}

export interface PlanSummaryDto {
  id: string;
  cycle: { id: string; code: string; name: string; status: string; selfReviewRequired: boolean; minScore: string; maxScore: string };
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  /** Where the employee sat when the plan was created — reporting uses this, not today's assignment. */
  snapshot: { organizationName: string | null; departmentName: string | null; positionTitle: string | null; jobTitle: string | null };
  reviewer: { employeeId: string | null; name: string | null; hasAccount: boolean };
  status: (typeof PERFORMANCE_PLAN_STATUSES)[number];
  selfSubmittedAt: string | null;
  managerSubmittedAt: string | null;
  finalizedAt: string | null;
  weightedScore: string | null;
  ratingCode: string | null;
  ratingLabel: string | null;
  totalWeight: string;
  progressPercent: number;
  itemCount: number;
  /** True when the employee has no active account, so nobody can fill in the self assessment. */
  selfReviewUnavailable: boolean;
}

export interface PlanDetailDto extends PlanSummaryDto {
  items: PlanItemDto[];
}

// ---------- reporting ----------
export const cycleReportQuerySchema = z.object({ departmentId: z.string().min(1).optional() });

export interface CycleReportDto {
  cycle: { id: string; code: string; name: string; status: string };
  completion: { assigned: number; selfSubmitted: number; managerSubmitted: number; finalized: number };
  averageFinalScore: string | null;
  /** Task 47: set when the scores of this (filtered) population are withheld; the average and distribution are then null. */
  suppression: AggregateSuppression | null;
  /** `count` is null when the distribution is suppressed. */
  ratingDistribution: { code: string; label: string; count: number | null }[];
  byDepartment: { departmentName: string; assigned: number; finalized: number; averageScore: string | null; suppression: AggregateSuppression | null }[];
  byKpi: { kpiCode: string; kpiName: string; plans: number; averageManagerScore: string | null; suppression: AggregateSuppression | null }[];
}
