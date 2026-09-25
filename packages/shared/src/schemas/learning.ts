import { z } from 'zod';
import { CERTIFICATION_ISSUER_TYPES, CERTIFICATION_STATUSES, LEARNING_STEP_TYPES, OBSERVATION_RESULTS, OJT_ACTIVITY_STATUSES, OJT_ACTIVITY_TYPES, OJT_ASSESSMENT_OUTCOMES, OJT_COMMENT_MAX_CHARS, OJT_IMPORTANCE, OJT_PLAN_STATUSES, OJT_REFLECTION_MAX_CHARS, PATH_ASSIGNMENT_STATUSES, PATH_STEP_STATES } from '../learning';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i);

// ---------- OJT programs ----------
export const ojtCriterionSchema = z.object({ criterion: z.string().trim().min(2).max(300), required: z.boolean().optional() }).strict();
export const ojtProgramActivitySchema = z.object({ title: z.string().trim().min(2).max(160), description: text(2000), activityType: z.enum(OJT_ACTIVITY_TYPES), required: z.boolean().optional(), expectedDays: z.number().int().min(0).max(365).nullable().optional(), documentEvidenceRequired: z.boolean().optional(), criteria: z.array(ojtCriterionSchema).max(30).optional() }).strict();
export type OjtProgramActivityInput = z.infer<typeof ojtProgramActivitySchema>;
export const ojtProgramCompetencySchema = z.object({ competencyId: z.string().min(1), targetLevel: z.number().int().min(1).max(20).nullable().optional(), importance: z.enum(OJT_IMPORTANCE).nullable().optional(), description: text(500) }).strict();
export const createOjtProgramSchema = z.object({ code, name: z.string().trim().min(2).max(160), description: text(2000), organizationId: z.string().min(1).nullable().optional(), jobId: z.string().min(1).nullable().optional(), durationDays: z.number().int().min(1).max(730).nullable().optional(), competencies: z.array(ojtProgramCompetencySchema).max(30).optional(), activities: z.array(ojtProgramActivitySchema).min(1, 'A program needs at least one activity').max(50) }).strict();
export type CreateOjtProgramInput = z.infer<typeof createOjtProgramSchema>;
export const updateOjtProgramSchema = createOjtProgramSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOjtProgramInput = z.infer<typeof updateOjtProgramSchema>;

// ---------- OJT plans ----------
export const createOjtPlanSchema = z.object({ employeeId: z.string().min(1), programId: z.string().min(1), trainerEmployeeId: z.string().min(1).nullable().optional(), startDate: date, targetEndDate: date.nullable().optional(), trainingNeedId: z.string().min(1).nullable().optional(), idpItemId: z.string().min(1).nullable().optional() }).strict();
export type CreateOjtPlanInput = z.infer<typeof createOjtPlanSchema>;
export const updateOjtPlanSchema = z.object({ trainerEmployeeId: z.string().min(1).nullable().optional(), startDate: date.optional(), targetEndDate: date.nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOjtPlanInput = z.infer<typeof updateOjtPlanSchema>;
export const ojtPlanListQuerySchema = paginationQuerySchema.extend({ status: z.enum(OJT_PLAN_STATUSES).optional(), programId: z.string().min(1).optional(), departmentId: z.string().min(1).optional(), mine: z.enum(['trainee', 'trainer']).optional(), search: z.string().trim().max(120).optional() });
/** Activity update: the trainee moves status and writes a reflection; the trainer writes the trainer comment; either may link evidence. */
export const updateOjtActivitySchema = z.object({ status: z.enum(OJT_ACTIVITY_STATUSES).optional(), employeeReflection: z.string().trim().max(OJT_REFLECTION_MAX_CHARS).nullable().optional(), trainerComment: z.string().trim().max(OJT_COMMENT_MAX_CHARS).nullable().optional(), documentId: z.string().min(1).nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOjtActivityInput = z.infer<typeof updateOjtActivitySchema>;
export const submitObservationSchema = z.object({ criterionId: z.string().min(1), result: z.enum(OBSERVATION_RESULTS), comment: text(1000), observedAt: date.optional() }).strict();
export type SubmitObservationInput = z.infer<typeof submitObservationSchema>;
export const submitOjtAssessmentSchema = z.object({ outcome: z.enum(OJT_ASSESSMENT_OUTCOMES), comment: text(OJT_COMMENT_MAX_CHARS) }).strict();
export type SubmitOjtAssessmentInput = z.infer<typeof submitOjtAssessmentSchema>;
export const competencyEvidenceSchema = z.object({ competencyIds: z.array(z.string().min(1)).min(1).max(30).optional(), note: text(500) }).strict();

// ---------- learning paths ----------
export const learningPathStepSchema = z.object({ stepType: z.enum(LEARNING_STEP_TYPES), referenceId: z.string().min(1).nullable().optional(), title: z.string().trim().min(2).max(160).optional(), required: z.boolean().optional(), prerequisiteIndex: z.number().int().min(0).max(100).nullable().optional() }).strict()
  .refine((v) => v.stepType === 'IDP_ACTIVITY' ? !!v.title : !!v.referenceId, { message: 'Course, OJT program and certification steps need a reference; an IDP activity step needs a title', path: ['referenceId'] });
export type LearningPathStepInput = z.infer<typeof learningPathStepSchema>;
export const createLearningPathSchema = z.object({ code, name: z.string().trim().min(2).max(160), description: text(2000), organizationId: z.string().min(1).nullable().optional(), targetJobId: z.string().min(1).nullable().optional(), steps: z.array(learningPathStepSchema).max(30).optional() }).strict();
export type CreateLearningPathInput = z.infer<typeof createLearningPathSchema>;
export const updateLearningPathSchema = createLearningPathSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateLearningPathInput = z.infer<typeof updateLearningPathSchema>;
export const assignLearningPathSchema = z.object({ employeeId: z.string().min(1), targetDate: date.nullable().optional() }).strict();
export const pathAssignmentListQuerySchema = paginationQuerySchema.extend({ status: z.enum(PATH_ASSIGNMENT_STATUSES).optional(), pathId: z.string().min(1).optional(), departmentId: z.string().min(1).optional() });
/** A human marks an IDP-activity step fulfilled, citing the completed IDP item; nothing infers it. */
export const fulfilStepSchema = z.object({ idpItemId: z.string().min(1).nullable().optional(), note: text(500) }).strict();

// ---------- certifications ----------
export const createCertificationDefinitionSchema = z.object({ code, name: z.string().trim().min(2).max(160), description: text(2000), issuerType: z.enum(CERTIFICATION_ISSUER_TYPES), issuerName: text(160), organizationId: z.string().min(1).nullable().optional(), validityDays: z.number().int().min(1).max(3650).nullable().optional(), expiryWindowDays: z.number().int().min(1).max(365).nullable().optional() }).strict();
export type CreateCertificationDefinitionInput = z.infer<typeof createCertificationDefinitionSchema>;
export const updateCertificationDefinitionSchema = createCertificationDefinitionSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCertificationDefinitionInput = z.infer<typeof updateCertificationDefinitionSchema>;
export const issueCertificationSchema = z.object({ employeeId: z.string().min(1), definitionId: z.string().min(1), certificateNumber: text(80), issuedDate: date, expiryDate: date.nullable().optional(), issuerName: text(160), documentId: z.string().min(1).nullable().optional(), note: text(500) }).strict();
export type IssueCertificationInput = z.infer<typeof issueCertificationSchema>;
export const renewCertificationSchema = issueCertificationSchema.omit({ employeeId: true, definitionId: true }).strict();
export type RenewCertificationInput = z.infer<typeof renewCertificationSchema>;
export const revokeCertificationSchema = z.object({ reason: text(500) }).strict();
export const certificationListQuerySchema = paginationQuerySchema.extend({ status: z.enum(CERTIFICATION_STATUSES).optional(), definitionId: z.string().min(1).optional(), departmentId: z.string().min(1).optional(), employeeId: z.string().min(1).optional() });
export const learningReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), organizationId: z.string().min(1).optional() });

// ---------- DTOs ----------
export interface OjtCriterionDto { id: string; criterion: string; required: boolean; sequence: number }
export interface OjtProgramActivityDto { id: string; title: string; description: string | null; activityType: (typeof OJT_ACTIVITY_TYPES)[number]; sequence: number; required: boolean; expectedDays: number | null; documentEvidenceRequired: boolean; criteria: OjtCriterionDto[] }
export interface OjtProgramCompetencyDto { competencyId: string; competencyCode: string; competencyName: string; targetLevel: number | null; importance: string | null; description: string | null }
export interface OjtProgramDto { id: string; code: string; name: string; description: string | null; organizationId: string | null; organizationName: string | null; jobId: string | null; jobTitle: string | null; durationDays: number | null; isActive: boolean; competencies: OjtProgramCompetencyDto[]; activities: OjtProgramActivityDto[]; planCount: number; createdAt: string; updatedAt: string }
export interface LearningSnapshotDto { employeeCode: string; employeeName: string; organization: string | null; department: string | null; job: string | null; position: string | null }
export interface OjtObservationDto { criterionId: string; criterion: string; required: boolean; result: (typeof OBSERVATION_RESULTS)[number] | null; comment: string | null; observerName: string | null; observedAt: string | null }
export interface OjtPlanActivityDto { id: string; title: string; description: string | null; activityType: (typeof OJT_ACTIVITY_TYPES)[number]; sequence: number; required: boolean; expectedDays: number | null; requiresEvidence: boolean; documentId: string | null; documentTitle: string | null; status: (typeof OJT_ACTIVITY_STATUSES)[number]; startedAt: string | null; completedAt: string | null; employeeReflection: string | null; trainerComment: string | null; observations: OjtObservationDto[]; blockers: string[]; can: { updateStatus: boolean; reflect: boolean; observe: boolean; linkEvidence: boolean } }
export interface OjtPlanDto {
  id: string; planNumber: string; employeeId: string; programId: string | null; programName: string; snapshot: LearningSnapshotDto; trainer: { employeeId: string | null; userId: string | null; name: string | null } | null;
  startDate: string; targetEndDate: string | null; status: (typeof OJT_PLAN_STATUSES)[number]; competencies: OjtProgramCompetencyDto[]; progress: { total: number; completed: number; pct: number; requiredOpen: number; ready: boolean };
  assessment: { outcome: (typeof OJT_ASSESSMENT_OUTCOMES)[number]; comment: string | null; assessorName: string | null; submittedAt: string }[]; evidenceHandoffs: { competencyId: string; competencyName: string; createdAt: string }[]; trainingNeedId: string | null; idpItemId: string | null;
  activatedAt: string | null; completedAt: string | null; cancelledAt: string | null; createdAt: string; updatedAt: string; can: { manage: boolean; train: boolean; assess: boolean; complete: boolean; handoff: boolean };
}
export interface OjtPlanDetailDto extends OjtPlanDto { activities: OjtPlanActivityDto[] }
export interface CompetencyEvidenceDto { id: string; employeeId: string; competencyId: string; competencyName: string; sourceType: string; sourceId: string; sourceLabel: string; /** what the source aimed at (OJT objective) */ objectiveLevel: number | null; /** an explicit human level observation; always null for OJT handoffs in this release */ observedLevel: number | null; note: string | null; createdAt: string; createdByName: string | null }

export interface LearningPathStepDto { id: string; stepType: (typeof LEARNING_STEP_TYPES)[number]; referenceId: string | null; title: string; sequence: number; required: boolean; prerequisiteStepId: string | null }
export interface LearningPathDto { id: string; code: string; name: string; description: string | null; organizationId: string | null; targetJobId: string | null; targetJobTitle: string | null; isActive: boolean; steps: LearningPathStepDto[]; assignmentCount: number; createdAt: string; updatedAt: string }
export interface PathAssignmentStepDto { id: string; stepType: (typeof LEARNING_STEP_TYPES)[number]; referenceId: string | null; title: string; sequence: number; required: boolean; prerequisiteStepId: string | null; state: (typeof PATH_STEP_STATES)[number]; fulfilledAt: string | null; fulfilledBy: string | null; sourceLabel: string | null }
export interface PathAssignmentDto { id: string; pathId: string; pathName: string; employeeId: string; snapshot: LearningSnapshotDto; targetJobTitle: string | null; assignedByName: string | null; assignedAt: string; targetDate: string | null; status: (typeof PATH_ASSIGNMENT_STATUSES)[number]; completedAt: string | null; progress: { total: number; fulfilled: number; pct: number; requiredOpen: number }; steps: PathAssignmentStepDto[]; can: { manage: boolean } }

export interface CertificationDefinitionDto { id: string; code: string; name: string; description: string | null; issuerType: (typeof CERTIFICATION_ISSUER_TYPES)[number]; issuerName: string | null; organizationId: string | null; validityDays: number | null; expiryWindowDays: number; isActive: boolean; activeCount: number; createdAt: string; updatedAt: string }
export interface EmployeeCertificationDto { id: string; employeeId: string; employee: { employeeCode: string; name: string; department: string | null } | null; definitionId: string; definitionName: string; definitionCode: string; issuerType: string; certificateNumber: string | null; issuedDate: string; expiryDate: string | null; issuerName: string | null; status: (typeof CERTIFICATION_STATUSES)[number]; daysToExpiry: number | null; documentId: string | null; documentTitle: string | null; renewedFromId: string | null; renewedById: string | null; revokedAt: string | null; revokeReason: string | null; note: string | null; createdAt: string }

export interface MyLearningDto { ojt: OjtPlanDetailDto[]; trainerQueue: OjtPlanDto[]; paths: PathAssignmentDto[]; certifications: EmployeeCertificationDto[]; evidence: CompetencyEvidenceDto[] }
export interface LearningDashboardDto {
  training: { openNeeds: number; completedEnrollmentsLast90Days: number; upcomingSessions: number; activeIdps: number };
  ojt: { active: number; completedLast90Days: number; awaitingAssessment: number; activitiesNeedingObservation: number };
  paths: { active: number; completedLast90Days: number; avgProgressPct: number | null };
  certifications: { active: number; expiringSoon: number; expired: number; revoked: number };
  definitions: Record<string, string>;
  generatedAt: string;
}
export interface LearningReportDto {
  range: { from: string; to: string };
  ojt: { plans: number; completed: number; active: number; cancelled: number; avgCompletionDays: number | null; byDepartment: { department: string; plans: number; completed: number }[]; byProgram: { program: string; plans: number; completed: number; activities: number; activitiesCompleted: number }[] };
  paths: { assigned: number; inProgress: number; completed: number; byPath: { path: string; assigned: number; completed: number; stepsFulfilledPct: number | null }[]; byDepartment: { department: string; assigned: number; completed: number }[] };
  certifications: { active: number; expiringSoon: number; expired: number; revoked: number; byDefinition: { certification: string; active: number; expiringSoon: number; expired: number; revoked: number }[]; byDepartment: { department: string; active: number; expiringSoon: number; expired: number }[] };
}
