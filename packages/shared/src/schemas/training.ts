import { z } from 'zod';
import {
  DEVELOPMENT_TYPES, IDP_ITEM_STATUSES, IDP_STATUSES, TRAINING_DELIVERY_METHODS, TRAINING_ENROLLMENT_SOURCES,
  TRAINING_ENROLLMENT_STATUSES, TRAINING_NEED_PRIORITIES, TRAINING_NEED_SOURCES, TRAINING_NEED_STATUSES,
  TRAINING_PROVIDER_TYPES, TRAINING_SESSION_STATUSES,
} from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Training and development contracts (Task 25).
 *
 * A development need carries **the gap it was created from**, frozen: the job's requirement may well move later, and
 * a need that quietly re-describes itself could never explain why somebody was sent on a course.
 *
 * Nothing in these contracts can change a competency level. Training is development history and evidence; a level
 * moves only through a competency assessment.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscore, starting with a letter');
const isoDateTime = z.string().datetime({ offset: true });

// ---------- training needs ----------
/** Turning the competency module's gaps into development needs. The filters pick the population, nothing else. */
export const generateTnaSchema = z.object({
  organizationId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  priority: z.enum(TRAINING_NEED_PRIORITIES).default('NORMAL'),
});
export type GenerateTnaInput = z.infer<typeof generateTnaSchema>;

export interface GenerateTnaResultDto {
  created: number;
  /** Gaps that already had an open need — re-running a generation is normal and must not duplicate anything. */
  alreadyOpen: number;
  /**
   * Competencies nobody has assessed. They are **not** training needs: "no one has looked" is a reason to assess,
   * not evidence of a deficiency, and inventing a need from it would fabricate a gap the size of the requirement.
   */
  assessmentRequired: { employeeCode: string; competencyCode: string }[];
}

export const createTrainingNeedSchema = z.object({
  employeeId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  competencyId: z.string().min(1).nullable().optional(),
  priority: z.enum(TRAINING_NEED_PRIORITIES).default('NORMAL'),
});
export type CreateTrainingNeedInput = z.infer<typeof createTrainingNeedSchema>;

export const updateTrainingNeedSchema = z
  .object({
    status: z.enum(TRAINING_NEED_STATUSES).optional(),
    priority: z.enum(TRAINING_NEED_PRIORITIES).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateTrainingNeedInput = z.infer<typeof updateTrainingNeedSchema>;

export const trainingNeedListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  competencyId: z.string().min(1).optional(),
  status: z.enum(TRAINING_NEED_STATUSES).optional(),
  source: z.enum(TRAINING_NEED_SOURCES).optional(),
  view: z.enum(['mine', 'team', 'all']).default('all'),
});
export type TrainingNeedListQuery = z.infer<typeof trainingNeedListQuerySchema>;

export interface TrainingNeedDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  snapshot: { departmentName: string | null; jobTitle: string | null };
  source: (typeof TRAINING_NEED_SOURCES)[number];
  title: string;
  description: string | null;
  competency: { id: string; code: string; name: string } | null;
  /** The gap as it stood when the need was raised — never rewritten when the job's requirement moves. */
  gapSnapshot: { currentLevel: number | null; requiredLevel: number | null; gap: number | null } | null;
  sourceAssessmentDate: string | null;
  priority: (typeof TRAINING_NEED_PRIORITIES)[number];
  status: (typeof TRAINING_NEED_STATUSES)[number];
  /** What the competency module says **today**, so HR can see a need whose gap has since closed. */
  currentGapStatus: string | null;
  enrollments: { id: string; sessionId: string; courseTitle: string; status: string }[];
  createdAt: string;
}

// ---------- course catalogue ----------
export const createCourseSchema = z.object({
  code: codeField,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  deliveryMethod: z.enum(TRAINING_DELIVERY_METHODS),
  durationMinutes: z.number().int().min(1).max(100000).nullable().optional(),
  providerName: z.string().trim().max(120).nullable().optional(),
  providerType: z.enum(TRAINING_PROVIDER_TYPES).default('INTERNAL'),
  /** Which competencies this course is **relevant to developing** — not a promise about anybody's level. */
  competencyIds: z.array(z.string().min(1)).max(20).default([]),
});
export type CreateCourseInput = z.infer<typeof createCourseSchema>;

export const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    category: z.string().trim().max(60).nullable().optional(),
    durationMinutes: z.number().int().min(1).max(100000).nullable().optional(),
    providerName: z.string().trim().max(120).nullable().optional(),
    providerType: z.enum(TRAINING_PROVIDER_TYPES).optional(),
    competencyIds: z.array(z.string().min(1)).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCourseInput = z.infer<typeof updateCourseSchema>;

export const courseListQuerySchema = paginationQuerySchema.extend({
  category: z.string().trim().max(60).optional(),
  deliveryMethod: z.enum(TRAINING_DELIVERY_METHODS).optional(),
  competencyId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type CourseListQuery = z.infer<typeof courseListQuerySchema>;

export interface CourseDto {
  id: string;
  code: string;
  title: string;
  description: string | null;
  category: string | null;
  deliveryMethod: (typeof TRAINING_DELIVERY_METHODS)[number];
  durationMinutes: number | null;
  providerName: string | null;
  providerType: (typeof TRAINING_PROVIDER_TYPES)[number];
  competencies: { id: string; code: string; name: string }[];
  isActive: boolean;
  sessionCount: number;
}

// ---------- sessions ----------
export const createSessionSchema = z
  .object({
    courseId: z.string().min(1),
    organizationId: z.string().min(1).nullable().optional(),
    startAt: isoDateTime,
    endAt: isoDateTime,
    /** IANA, e.g. Asia/Bangkok. Instants are stored in UTC and displayed in the session's own zone. */
    timezone: z.string().trim().min(1).max(60),
    location: z.string().trim().max(200).nullable().optional(),
    meetingUrl: z.string().trim().url().max(500).nullable().optional(),
    capacity: z.number().int().min(1).max(10000).nullable().optional(),
    instructorName: z.string().trim().max(120).nullable().optional(),
  })
  .refine((v) => new Date(v.startAt) < new Date(v.endAt), { message: 'The session ends before it starts', path: ['endAt'] });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z
  .object({
    startAt: isoDateTime.optional(),
    endAt: isoDateTime.optional(),
    timezone: z.string().trim().min(1).max(60).optional(),
    location: z.string().trim().max(200).nullable().optional(),
    meetingUrl: z.string().trim().url().max(500).nullable().optional(),
    capacity: z.number().int().min(1).max(10000).nullable().optional(),
    instructorName: z.string().trim().max(120).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .refine((v) => !v.startAt || !v.endAt || new Date(v.startAt) < new Date(v.endAt), { message: 'The session ends before it starts', path: ['endAt'] });
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

export const sessionListQuerySchema = paginationQuerySchema.extend({
  courseId: z.string().min(1).optional(),
  status: z.enum(TRAINING_SESSION_STATUSES).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

export interface SessionDto {
  id: string;
  course: { id: string; code: string; title: string; deliveryMethod: string; durationMinutes: number | null };
  organization: { id: string; code: string; name: string } | null;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  capacity: number | null;
  instructorName: string | null;
  status: (typeof TRAINING_SESSION_STATUSES)[number];
  enrolledCount: number;
  /** Null when the session has no capacity limit. */
  seatsLeft: number | null;
}

// ---------- enrolment ----------
export const enrollSchema = z.object({
  employeeIds: z.array(z.string().min(1)).min(1).max(500),
  source: z.enum(TRAINING_ENROLLMENT_SOURCES).default('MANUAL'),
  trainingNeedId: z.string().min(1).nullable().optional(),
  idpItemId: z.string().min(1).nullable().optional(),
});
export type EnrollInput = z.infer<typeof enrollSchema>;

export interface EnrollResultDto {
  enrolled: number;
  alreadyEnrolled: number;
  skipped: { employeeCode: string; reason: string }[];
}

export const recordAttendanceSchema = z.object({
  status: z.enum(['ATTENDED', 'NO_SHOW']),
  note: z.string().trim().max(500).nullable().optional(),
});
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;

export const recordResultSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED']),
  score: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a score like 82 or 82.50').nullable().optional(),
  resultNote: z.string().trim().max(500).nullable().optional(),
});
export type RecordResultInput = z.infer<typeof recordResultSchema>;

export const enrollmentListQuerySchema = paginationQuerySchema.extend({
  sessionId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  status: z.enum(TRAINING_ENROLLMENT_STATUSES).optional(),
  view: z.enum(['mine', 'team', 'all']).default('all'),
});
export type EnrollmentListQuery = z.infer<typeof enrollmentListQuerySchema>;

export interface EnrollmentDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; departmentName: string | null };
  session: { id: string; startAt: string; endAt: string; timezone: string; status: string; location: string | null };
  course: { id: string; code: string; title: string; deliveryMethod: string; durationMinutes: number | null };
  status: (typeof TRAINING_ENROLLMENT_STATUSES)[number];
  source: (typeof TRAINING_ENROLLMENT_SOURCES)[number];
  trainingNeedId: string | null;
  idpItemId: string | null;
  enrolledAt: string;
  completionAt: string | null;
  score: string | null;
  resultNote: string | null;
}

// ---------- IDP ----------
export const createIdpSchema = z
  .object({
    employeeId: z.string().min(1),
    title: z.string().trim().min(1).max(160),
    periodStart: businessDate,
    periodEnd: businessDate,
  })
  .refine((v) => v.periodStart <= v.periodEnd, { message: 'periodEnd must be on or after periodStart', path: ['periodEnd'] });
export type CreateIdpInput = z.infer<typeof createIdpSchema>;

export const updateIdpSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    periodStart: businessDate.optional(),
    periodEnd: businessDate.optional(),
    status: z.enum(['CANCELLED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateIdpInput = z.infer<typeof updateIdpSchema>;

export const addIdpItemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  developmentType: z.enum(DEVELOPMENT_TYPES),
  trainingNeedId: z.string().min(1).nullable().optional(),
  competencyId: z.string().min(1).nullable().optional(),
  linkedCourseId: z.string().min(1).nullable().optional(),
  targetDate: businessDate.nullable().optional(),
});
export type AddIdpItemInput = z.infer<typeof addIdpItemSchema>;

/** What HR may change about an item. Progress and the employee's own words have their own endpoint. */
export const updateIdpItemSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    targetDate: businessDate.nullable().optional(),
    status: z.enum(IDP_ITEM_STATUSES).optional(),
    managerComment: z.string().trim().max(2000).nullable().optional(),
    hrComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateIdpItemInput = z.infer<typeof updateIdpItemSchema>;

export const updateIdpProgressSchema = z
  .object({
    progressPercent: z.number().int().min(0).max(100).optional(),
    employeeComment: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateIdpProgressInput = z.infer<typeof updateIdpProgressSchema>;

export const idpListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  status: z.enum(IDP_STATUSES).optional(),
  view: z.enum(['mine', 'team', 'all']).default('all'),
});
export type IdpListQuery = z.infer<typeof idpListQuerySchema>;

export interface IdpItemDto {
  id: string;
  title: string;
  description: string | null;
  developmentType: (typeof DEVELOPMENT_TYPES)[number];
  trainingNeedId: string | null;
  competency: { id: string; code: string; name: string } | null;
  linkedCourse: { id: string; code: string; title: string } | null;
  linkedSessionId: string | null;
  targetDate: string | null;
  status: (typeof IDP_ITEM_STATUSES)[number];
  progressPercent: number;
  employeeComment: string | null;
  managerComment: string | null;
  /** HR's own note. Visible to HR only — see docs/training-development.md. */
  hrComment?: string | null;
  completedAt: string | null;
}

export interface IdpSummaryDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; departmentName: string | null };
  title: string;
  periodStart: string;
  periodEnd: string;
  status: (typeof IDP_STATUSES)[number];
  manager: { employeeId: string | null; name: string | null };
  itemCount: number;
  completedItemCount: number;
  progressPercent: number;
  activatedAt: string | null;
  completedAt: string | null;
}

export interface IdpDetailDto extends IdpSummaryDto {
  items: IdpItemDto[];
}

// ---------- employee development view ----------
export interface MyDevelopmentDto {
  needs: TrainingNeedDto[];
  upcoming: EnrollmentDto[];
  history: EnrollmentDto[];
  idps: IdpSummaryDto[];
  summary: { openNeeds: number; upcomingSessions: number; completedCourses: number; trainingHours: number };
}

// ---------- reporting ----------
export const trainingReportQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export type TrainingReportQuery = z.infer<typeof trainingReportQuerySchema>;

export interface TrainingReportDto {
  enrollments: { total: number; completed: number; failed: number; noShow: number; cancelled: number; enrolled: number };
  /** completed ÷ (completed + failed + no-show); cancelled and still-enrolled are excluded. */
  completionRate: number | null;
  trainingHours: number;
  byDepartment: { departmentName: string; enrollments: number; completed: number; noShow: number; hours: number }[];
  byCourse: { courseId: string; courseCode: string; courseTitle: string; enrollments: number; completed: number; competencies: string[] }[];
  byDeliveryMethod: { deliveryMethod: string; enrollments: number; completed: number; hours: number }[];
  needs: { open: number; planned: number; inProgress: number; fulfilled: number; cancelled: number; fromGap: number; manual: number };
  topNeedCompetencies: { competencyCode: string; competencyName: string; needs: number }[];
  idps: { draft: number; active: number; completed: number; cancelled: number };
}

export interface TeamDevelopmentDto {
  teamSize: number;
  openNeeds: number;
  activeIdps: number;
  upcomingSessions: number;
  completedTraining: number;
  members: {
    employeeId: string; employeeCode: string; name: string;
    openNeeds: number; activeIdp: boolean; upcoming: number; completed: number;
  }[];
}
