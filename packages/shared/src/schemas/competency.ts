import { z } from 'zod';
import { COMPETENCY_ASSESSMENT_STATUSES, COMPETENCY_CYCLE_STATUSES, GAP_STATUSES } from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Competency contracts (Task 24).
 *
 * A competency framework answers one question: *what does this job need, how good is this person, and where is the
 * difference?* Everything here exists to keep those three things separately true — the requirement belongs to the
 * job, the level belongs to the assessment, and the gap is derived, never stored as an opinion.
 *
 * Levels are small integers on a **configurable** scale. Nothing assumes 1–5.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscore, starting with a letter');
const levelField = z.number().int().min(1).max(20);

// ---------- categories ----------
export const createCompetencyCategorySchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type CreateCompetencyCategoryInput = z.infer<typeof createCompetencyCategorySchema>;

export const updateCompetencyCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompetencyCategoryInput = z.infer<typeof updateCompetencyCategorySchema>;

export interface CompetencyCategoryDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  competencyCount: number;
}

// ---------- proficiency scales ----------
export const scaleLevelSchema = z.object({
  level: levelField,
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
});
export type ScaleLevelInput = z.infer<typeof scaleLevelSchema>;

export const createCompetencyScaleSchema = z
  .object({
    code: codeField,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullable().optional(),
    /** At least two: a scale with one level cannot express a gap. */
    levels: z.array(scaleLevelSchema).min(2, 'A scale needs at least two levels').max(20),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    for (const level of value.levels) {
      if (seen.has(level.level)) ctx.addIssue({ code: 'custom', path: ['levels'], message: `Level ${level.level} is listed twice` });
      seen.add(level.level);
    }
  });
export type CreateCompetencyScaleInput = z.infer<typeof createCompetencyScaleSchema>;

/**
 * What can be changed about a scale that assessments already refer to: its name, and the wording of its levels.
 * Adding or removing a level changes what a recorded number *means*, so it is refused once the scale is in use.
 */
export const updateCompetencyScaleSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    levels: z.array(scaleLevelSchema).min(2).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompetencyScaleInput = z.infer<typeof updateCompetencyScaleSchema>;

export interface ScaleLevelDto {
  id: string;
  level: number;
  label: string;
  description: string | null;
}

export interface CompetencyScaleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  levels: ScaleLevelDto[];
  isActive: boolean;
  /** True once a competency uses it, which freezes what its levels mean. */
  inUse: boolean;
}

// ---------- competency library ----------
export const levelIndicatorSchema = z.object({
  level: levelField,
  description: z.string().trim().min(1).max(500),
});
export type LevelIndicatorInput = z.infer<typeof levelIndicatorSchema>;

export const createCompetencySchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  categoryId: z.string().min(1),
  scaleId: z.string().min(1),
  /** What each level looks like in practice, so two reviewers mean the same thing by "level 3". */
  indicators: z.array(levelIndicatorSchema).max(20).default([]),
});
export type CreateCompetencyInput = z.infer<typeof createCompetencySchema>;

export const updateCompetencySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    categoryId: z.string().min(1).optional(),
    indicators: z.array(levelIndicatorSchema).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompetencyInput = z.infer<typeof updateCompetencySchema>;

export const competencyListQuerySchema = paginationQuerySchema.extend({
  categoryId: z.string().min(1).optional(),
  scaleId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type CompetencyListQuery = z.infer<typeof competencyListQuerySchema>;

export interface CompetencyDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: { id: string; code: string; name: string };
  scale: { id: string; code: string; name: string; levels: ScaleLevelDto[] };
  indicators: { level: number; description: string }[];
  isActive: boolean;
  /** True once a job profile or an assessment refers to it — it can be deactivated, never deleted. */
  inUse: boolean;
}

// ---------- job competency profile ----------
export const setJobRequirementSchema = z.object({
  competencyId: z.string().min(1),
  requiredLevel: levelField,
  /** A priority, not a percentage: a competency framework weights what matters, it does not add up to 100. */
  weight: z.number().min(0).max(100).nullable().optional(),
  isMandatory: z.boolean().default(true),
});
export type SetJobRequirementInput = z.infer<typeof setJobRequirementSchema>;

export interface JobRequirementDto {
  id: string;
  competency: { id: string; code: string; name: string; category: string; scaleName: string; maxLevel: number };
  requiredLevel: number;
  requiredLevelLabel: string | null;
  weight: number | null;
  isMandatory: boolean;
}

export interface JobProfileDto {
  job: { id: string; code: string; title: string; level: number };
  employeeCount: number;
  requirements: JobRequirementDto[];
}

// ---------- assessment cycles ----------
export const createCompetencyCycleSchema = z
  .object({
    code: codeField,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    periodStart: businessDate,
    periodEnd: businessDate,
    selfAssessmentRequired: z.boolean().default(true),
  })
  .refine((v) => v.periodStart <= v.periodEnd, { message: 'periodEnd must be on or after periodStart', path: ['periodEnd'] });
export type CreateCompetencyCycleInput = z.infer<typeof createCompetencyCycleSchema>;

export const updateCompetencyCycleSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    periodStart: businessDate.optional(),
    periodEnd: businessDate.optional(),
    selfAssessmentRequired: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCompetencyCycleInput = z.infer<typeof updateCompetencyCycleSchema>;

export const competencyCycleListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(COMPETENCY_CYCLE_STATUSES).optional(),
});
export type CompetencyCycleListQuery = z.infer<typeof competencyCycleListQuerySchema>;

export interface CompetencyCycleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  periodStart: string;
  periodEnd: string;
  selfAssessmentRequired: boolean;
  status: (typeof COMPETENCY_CYCLE_STATUSES)[number];
  assessmentCount: number;
  createdAt: string;
}

// ---------- assessments ----------
export const assignAssessmentsSchema = z
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
export type AssignAssessmentsInput = z.infer<typeof assignAssessmentsSchema>;

export interface AssignAssessmentsResultDto {
  created: number;
  alreadyAssigned: number;
  /** Everybody who could not be assigned and why — an empty job profile is the common one. */
  skipped: { employeeCode: string; reason: string }[];
}

export const reassignReviewerSchema = z.object({ reviewerEmployeeId: z.string().min(1).nullable() });
export type ReassignReviewerInput = z.infer<typeof reassignReviewerSchema>;

export const selfAssessmentItemSchema = z
  .object({
    selfLevel: levelField.nullable().optional(),
    selfComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type SelfAssessmentItemInput = z.infer<typeof selfAssessmentItemSchema>;

export const managerAssessmentItemSchema = z
  .object({
    managerLevel: levelField.nullable().optional(),
    managerComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ManagerAssessmentItemInput = z.infer<typeof managerAssessmentItemSchema>;

export const assessmentListQuerySchema = paginationQuerySchema.extend({
  cycleId: z.string().min(1).optional(),
  status: z.enum(COMPETENCY_ASSESSMENT_STATUSES).optional(),
  departmentId: z.string().min(1).optional(),
  view: z.enum(['mine', 'reviewing', 'all']).default('mine'),
});
export type AssessmentListQuery = z.infer<typeof assessmentListQuerySchema>;

export interface AssessmentItemDto {
  id: string;
  competencyId: string | null;
  competencyCode: string;
  competencyName: string;
  category: string;
  scaleName: string | null;
  /** The levels as they read, snapshotted with the item so an old assessment still explains itself. */
  levelLabels: { level: number; label: string }[];
  indicators: { level: number; description: string }[];
  requiredLevel: number;
  weight: number | null;
  isMandatory: boolean;
  selfLevel: number | null;
  managerLevel: number | null;
  finalLevel: number | null;
  selfComment: string | null;
  managerComment: string | null;
  /** Against the requirement **as it was when this assessment was made**. */
  gap: number | null;
  gapNeeded: number | null;
  gapStatus: (typeof GAP_STATUSES)[number];
}

export interface AssessmentSummaryDto {
  id: string;
  cycle: { id: string; code: string; name: string; status: string; selfAssessmentRequired: boolean };
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  snapshot: { organizationName: string | null; departmentName: string | null; positionTitle: string | null; jobTitle: string | null };
  reviewer: { employeeId: string | null; name: string | null; hasAccount: boolean };
  status: (typeof COMPETENCY_ASSESSMENT_STATUSES)[number];
  selfSubmittedAt: string | null;
  managerSubmittedAt: string | null;
  finalizedAt: string | null;
  itemCount: number;
  /** How many competencies are below their requirement, once the assessment is finalized. */
  gapCount: number;
  /** True when the employee has no active account, so nobody can fill in the self assessment. */
  selfAssessmentUnavailable: boolean;
}

export interface AssessmentDetailDto extends AssessmentSummaryDto {
  items: AssessmentItemDto[];
}

// ---------- current skill profile ----------
export interface SkillProfileEntryDto {
  competencyId: string;
  competencyCode: string;
  competencyName: string;
  category: string;
  /** What the employee's **current** job asks for, or null when the job does not require this competency. */
  requiredLevel: number | null;
  requiredLevelLabel: string | null;
  /** The latest finalized level, or null when nobody has assessed it — which is not the same as zero. */
  currentLevel: number | null;
  currentLevelLabel: string | null;
  gap: number | null;
  gapNeeded: number | null;
  gapStatus: (typeof GAP_STATUSES)[number];
  lastAssessedAt: string | null;
  sourceCycle: { id: string; code: string; name: string } | null;
  isMandatory: boolean;
}

export interface SkillProfileDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  job: { id: string; code: string; title: string } | null;
  entries: SkillProfileEntryDto[];
  summary: { required: number; assessed: number; withGap: number; unassessed: number; exceeding: number };
}

// ---------- reporting ----------
export const gapReportQuerySchema = z.object({
  cycleId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  competencyId: z.string().min(1).optional(),
  gapOnly: z.coerce.boolean().optional(),
});
export type GapReportQuery = z.infer<typeof gapReportQuerySchema>;

export interface GapReportDto {
  coverage: { assigned: number; selfSubmitted: number; finalized: number; coveragePercent: number };
  totals: { employeesAssessed: number; competenciesAssessed: number; employeesWithGap: number; gapItems: number; averageGapNeeded: string | null };
  topGaps: { competencyId: string; competencyCode: string; competencyName: string; assessed: number; belowRequirement: number; averageGap: string | null; maxGap: number | null }[];
  byDepartment: { departmentName: string; assessed: number; withGap: number; gapItems: number }[];
  byJob: { jobTitle: string; assessed: number; withGap: number; gapItems: number }[];
}

/** The minimal shape development planning (Task 25) consumes. It never recalculates a gap of its own. */
export interface SkillGapRowDto {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  competencyId: string;
  competencyCode: string;
  competencyName: string;
  currentLevel: number | null;
  requiredLevel: number;
  gapNeeded: number | null;
  gapStatus: (typeof GAP_STATUSES)[number];
  jobId: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  assessmentDate: string | null;
}

export const skillGapQuerySchema = z.object({
  employeeId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  gapOnly: z.coerce.boolean().optional(),
});
export type SkillGapQuery = z.infer<typeof skillGapQuerySchema>;
