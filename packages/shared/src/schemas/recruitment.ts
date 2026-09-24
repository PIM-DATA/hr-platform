import { z } from 'zod';
import {
  APPLICATION_STAGES, CANDIDATE_SOURCES, CANDIDATE_STATUSES, EMPLOYMENT_TYPES, INTERVIEW_RECOMMENDATIONS,
  INTERVIEW_STATUSES, OFFER_STATUSES, OPENING_STATUSES, REJECTION_REASONS, REQUISITION_REASONS, REQUISITION_STATUSES,
} from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Recruitment contracts (Task 27).
 *
 * Two things shape every field here. **Candidates are people who have not agreed to work for us yet**, so the
 * profile carries the minimum a recruiter needs and nothing protected — no national id, no birth date, no health,
 * no marital status, no religion, no politics. And **every decision is a person's**: a stage moves because somebody
 * moved it, an offer is accepted because HR recorded that it was, a candidate is hired because somebody with the
 * permission pressed the button. Feedback and scores inform; they never rank.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const isoDateTime = z.string().datetime({ offset: true });
const moneyField = z.string().trim().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Use an amount like 45000 or 45000.50');

// ---------- policy ----------
export const upsertRecruitmentPolicySchema = z.object({
  organizationId: z.string().min(1),
  requisitionWorkflowCode: z.string().trim().min(1).max(50),
  offerWorkflowCode: z.string().trim().min(1).max(50),
});
export type UpsertRecruitmentPolicyInput = z.infer<typeof upsertRecruitmentPolicySchema>;
export interface RecruitmentPolicyDto {
  id: string;
  organization: { id: string; code: string; name: string };
  requisitionWorkflowCode: string;
  offerWorkflowCode: string;
}

// ---------- requisitions ----------
export const createRequisitionSchema = z.object({
  organizationId: z.string().min(1),
  departmentId: z.string().min(1).nullable().optional(),
  jobId: z.string().min(1),
  positionId: z.string().min(1).nullable().optional(),
  hiringManagerEmployeeId: z.string().min(1).nullable().optional(),
  requestedOpenings: z.number().int().min(1).max(500),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
  reason: z.enum(REQUISITION_REASONS),
  desiredStartDate: businessDate.nullable().optional(),
  justification: z.string().trim().max(2000).nullable().optional(),
});
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;

export const updateRequisitionSchema = createRequisitionSchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionSchema>;

export const requisitionListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(REQUISITION_STATUSES).optional(),
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
});
export type RequisitionListQuery = z.infer<typeof requisitionListQuerySchema>;

export interface RequisitionDto {
  id: string;
  requisitionNumber: string;
  organization: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  job: { id: string; code: string; title: string };
  position: { id: string; code: string; title: string } | null;
  hiringManager: { employeeId: string | null; userId: string | null; name: string | null };
  requestedOpenings: number;
  employmentType: string | null;
  reason: (typeof REQUISITION_REASONS)[number];
  desiredStartDate: string | null;
  justification: string | null;
  status: (typeof REQUISITION_STATUSES)[number];
  workflowInstanceId: string | null;
  /** Frozen at submit — what the approver approved, whatever the masters say later. */
  snapshot: { organizationName: string | null; departmentName: string | null; jobTitle: string | null; positionTitle: string | null; hiringManagerName: string | null } | null;
  openings: { id: string; openingNumber: string; status: string; openingsCount: number; filledCount: number }[];
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
}

// ---------- openings ----------
export const createOpeningSchema = z.object({
  requisitionId: z.string().min(1),
  openingsCount: z.number().int().min(1).max(500),
  description: z.string().trim().max(5000).nullable().optional(),
  requirementsText: z.string().trim().max(5000).nullable().optional(),
  targetCloseDate: businessDate.nullable().optional(),
});
export type CreateOpeningInput = z.infer<typeof createOpeningSchema>;

export const updateOpeningSchema = z
  .object({
    openingsCount: z.number().int().min(1).max(500).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    requirementsText: z.string().trim().max(5000).nullable().optional(),
    targetCloseDate: businessDate.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOpeningInput = z.infer<typeof updateOpeningSchema>;

export const openingListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(OPENING_STATUSES).optional(),
  organizationId: z.string().min(1).optional(),
});
export type OpeningListQuery = z.infer<typeof openingListQuerySchema>;

export interface OpeningDto {
  id: string;
  openingNumber: string;
  requisitionId: string;
  requisitionNumber: string;
  job: { id: string; code: string; title: string };
  position: { id: string; code: string; title: string } | null;
  snapshot: { title: string; departmentName: string | null; organizationName: string | null };
  hiringManager: { employeeId: string | null; userId: string | null; name: string | null };
  description: string | null;
  requirementsText: string | null;
  openingsCount: number;
  /** Derived from HIRED applications, never a counter that can drift. */
  filledCount: number;
  isFull: boolean;
  activeApplications: number;
  openedAt: string | null;
  targetCloseDate: string | null;
  status: (typeof OPENING_STATUSES)[number];
  createdAt: string;
}

// ---------- candidates ----------
const nameField = z.string().trim().min(1).max(80);
export const createCandidateSchema = z.object({
  firstName: nameField,
  lastName: nameField,
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  currentCompany: z.string().trim().max(120).nullable().optional(),
  currentTitle: z.string().trim().max(120).nullable().optional(),
  locationText: z.string().trim().max(120).nullable().optional(),
  source: z.enum(CANDIDATE_SOURCES).default('MANUAL'),
  sourceDetail: z.string().trim().max(120).nullable().optional(),
  summary: z.string().trim().max(4000).nullable().optional(),
  /** A likely duplicate is reported, not merged; the recruiter says "create anyway" explicitly. */
  allowDuplicate: z.boolean().default(false),
}).strict(); // strict on purpose: a national id, birth date or anything protected is refused, never silently dropped
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;

export const updateCandidateSchema = createCandidateSchema.omit({ allowDuplicate: true }).partial().extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;

export const candidateListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CANDIDATE_STATUSES).optional(),
  source: z.enum(CANDIDATE_SOURCES).optional(),
});
export type CandidateListQuery = z.infer<typeof candidateListQuerySchema>;

export interface CandidateDto {
  id: string;
  candidateNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  currentCompany: string | null;
  currentTitle: string | null;
  locationText: string | null;
  source: (typeof CANDIDATE_SOURCES)[number];
  sourceDetail: string | null;
  summary: string | null;
  status: (typeof CANDIDATE_STATUSES)[number];
  hiredEmployeeId: string | null;
  applicationCount: number;
  createdAt: string;
}

export interface DuplicateCandidateDto {
  id: string;
  candidateNumber: string;
  firstName: string;
  lastName: string;
  matchedOn: 'email' | 'phone';
}

// ---------- applications ----------
export const createApplicationSchema = z.object({
  candidateId: z.string().min(1),
  openingId: z.string().min(1),
  appliedAt: businessDate.optional(),
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const moveStageSchema = z.object({
  toStage: z.enum(['SCREENING', 'INTERVIEW', 'OFFER']),
  reason: z.string().trim().max(500).nullable().optional(),
});
export type MoveStageInput = z.infer<typeof moveStageSchema>;

export const rejectApplicationSchema = z.object({
  reasonCode: z.enum(REJECTION_REASONS),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type RejectApplicationInput = z.infer<typeof rejectApplicationSchema>;

export const withdrawApplicationSchema = z.object({ note: z.string().trim().max(500).nullable().optional() });
export type WithdrawApplicationInput = z.infer<typeof withdrawApplicationSchema>;

export const applicationListQuerySchema = paginationQuerySchema.extend({
  openingId: z.string().min(1).optional(),
  candidateId: z.string().min(1).optional(),
  stage: z.enum(APPLICATION_STAGES).optional(),
  /** active = every stage that is still in play. */
  active: z.coerce.boolean().optional(),
});
export type ApplicationListQuery = z.infer<typeof applicationListQuerySchema>;

export interface StageHistoryDto {
  fromStage: string | null;
  toStage: string;
  changedBy: string | null;
  changedAt: string;
  reason: string | null;
}

export interface ApplicationDto {
  id: string;
  applicationNumber: string;
  candidate: { id: string; candidateNumber: string; firstName: string; lastName: string; email: string | null; source: string };
  opening: { id: string; openingNumber: string; title: string; departmentName: string | null; status: string };
  stage: (typeof APPLICATION_STAGES)[number];
  appliedAt: string;
  recruiterUserId: string | null;
  hiringManagerUserId: string | null;
  rejection: { reasonCode: string; note: string | null; at: string } | null;
  withdrawal: { note: string | null; at: string } | null;
  hiredEmployeeId: string | null;
  hiredAt: string | null;
  interviewCount: number;
  offerStatus: string | null;
  createdAt: string;
}

export interface ApplicationDetailDto extends ApplicationDto {
  stageHistory: StageHistoryDto[];
  interviews: InterviewDto[];
}

// ---------- interviews ----------
export const scheduleInterviewSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    roundNumber: z.number().int().min(1).max(20).nullable().optional(),
    scheduledStart: isoDateTime,
    scheduledEnd: isoDateTime,
    timezone: z.string().trim().min(1).max(60).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    meetingUrl: z.string().trim().url().max(500).nullable().optional(),
    interviewerUserIds: z.array(z.string().min(1)).min(1).max(10),
  })
  .refine((v) => new Date(v.scheduledStart) < new Date(v.scheduledEnd), { message: 'The interview ends before it starts', path: ['scheduledEnd'] });
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;

export const updateInterviewSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    roundNumber: z.number().int().min(1).max(20).nullable().optional(),
    scheduledStart: isoDateTime.optional(),
    scheduledEnd: isoDateTime.optional(),
    timezone: z.string().trim().min(1).max(60).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    meetingUrl: z.string().trim().url().max(500).nullable().optional(),
    interviewerUserIds: z.array(z.string().min(1)).min(1).max(10).optional(),
    status: z.enum(['COMPLETED', 'CANCELLED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateInterviewInput = z.infer<typeof updateInterviewSchema>;

export const submitFeedbackSchema = z.object({
  recommendation: z.enum(INTERVIEW_RECOMMENDATIONS),
  /** 1–5 when given. It is one interviewer's view; nothing adds these up into a ranking. */
  overallScore: z.number().int().min(1).max(5).nullable().optional(),
  strengths: z.string().trim().max(4000).nullable().optional(),
  concerns: z.string().trim().max(4000).nullable().optional(),
  comments: z.string().trim().max(4000).nullable().optional(),
});
export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

export const interviewListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(INTERVIEW_STATUSES).optional(),
  applicationId: z.string().min(1).optional(),
  view: z.enum(['mine', 'all']).default('all'),
});
export type InterviewListQuery = z.infer<typeof interviewListQuerySchema>;

export interface InterviewFeedbackDto {
  interviewerUserId: string;
  interviewerName: string;
  recommendation: (typeof INTERVIEW_RECOMMENDATIONS)[number];
  overallScore: number | null;
  strengths: string | null;
  concerns: string | null;
  comments: string | null;
  submittedAt: string;
}

export interface InterviewDto {
  id: string;
  applicationId: string;
  applicationNumber: string;
  candidate: { id: string; firstName: string; lastName: string };
  opening: { id: string; title: string };
  roundNumber: number | null;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  status: (typeof INTERVIEW_STATUSES)[number];
  interviewers: { userId: string; name: string; roleLabel: string | null; feedbackSubmitted: boolean }[];
  /** Submitted feedback. An interviewer sees their own; recruiters and the hiring manager see all of it. */
  feedback: InterviewFeedbackDto[];
  myFeedback: InterviewFeedbackDto | null;
  createdAt: string;
}

// ---------- offers ----------
export const createOfferSchema = z.object({
  applicationId: z.string().min(1),
  proposedStartDate: businessDate,
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable().optional(),
  positionId: z.string().min(1).nullable().optional(),
  /** Decimal string. A recruitment proposal, not a payroll record — payroll is told nothing by this. */
  baseSalaryProposal: moneyField.nullable().optional(),
  currencyCode: z.string().trim().length(3).regex(/^[A-Z]{3}$/).default('THB'),
  otherTermsText: z.string().trim().max(5000).nullable().optional(),
});
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

export const updateOfferSchema = createOfferSchema.omit({ applicationId: true }).partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

export const offerListQuerySchema = paginationQuerySchema.extend({ status: z.enum(OFFER_STATUSES).optional() });
export type OfferListQuery = z.infer<typeof offerListQuerySchema>;

export interface OfferDto {
  id: string;
  offerNumber: string;
  applicationId: string;
  applicationNumber: string;
  candidate: { id: string; firstName: string; lastName: string };
  opening: { id: string; title: string };
  status: (typeof OFFER_STATUSES)[number];
  proposedStartDate: string;
  employmentType: string | null;
  position: { id: string; title: string } | null;
  /** Present only for `recruitment.manage_offers` and the workflow approver; null for everybody else. */
  baseSalaryProposal: string | null;
  currencyCode: string;
  otherTermsText: string | null;
  compensationVisible: boolean;
  workflowInstanceId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  withdrawnAt: string | null;
  outcomeRecordedBy: string | null;
  createdAt: string;
}

// ---------- hire ----------
/** Only what the employee record actually needs. Everything else about the candidate stays in the ATS. */
export const hireCandidateSchema = z.object({
  employeeCode: z.string().trim().min(1).max(20),
  hireDate: businessDate,
  positionId: z.string().min(1),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  /** The work email the employee record will carry; the candidate's contact email is not assumed to be it. */
  email: z.string().trim().toLowerCase().email().max(254),
  managerId: z.string().min(1).nullable().optional(),
});
export type HireCandidateInput = z.infer<typeof hireCandidateSchema>;

export interface HireResultDto {
  employeeId: string;
  employeeCode: string;
  applicationId: string;
  candidateId: string;
  /** Said explicitly, so nobody assumes it: no user account and no payroll compensation were created. */
  userAccountCreated: false;
  payrollCompensationCreated: false;
}

// ---------- dashboard and reports ----------
export interface RecruitmentDashboardDto {
  openRequisitions: number;
  openOpenings: number;
  activeApplications: number;
  interviewsScheduled: number;
  offersPending: number;
  hires: number;
  funnel: { stage: string; count: number }[];
}

export const recruitmentReportQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  organizationId: z.string().min(1).optional(),
});
export type RecruitmentReportQuery = z.infer<typeof recruitmentReportQuerySchema>;

export interface RecruitmentReportDto {
  funnel: { stage: string; count: number }[];
  bySource: { source: string; applications: number; interviews: number; offers: number; hires: number }[];
  byDepartment: { departmentName: string; applications: number; hires: number }[];
  byJob: { jobTitle: string; applications: number; hires: number }[];
  interviews: { scheduled: number; completed: number; cancelled: number; feedbackSubmitted: number };
  offers: { approved: number; accepted: number; declined: number; withdrawn: number };
  hires: number;
  /** Average days from `appliedAt` to `hiredAt` over HIRED applications in the range. Time-to-fill is deferred. */
  averageTimeToHireDays: number | null;
  rejectionsByReason: { reasonCode: string; count: number }[];
}

// ---------- candidate personal-data export ----------
export interface CandidateDataExportDto {
  formatVersion: 1;
  generatedAt: string;
  subject: { candidateId: string; candidateNumber: string; firstName: string; lastName: string };
  data: Record<string, unknown>;
  notIncluded: { category: string; reason: string }[];
}
