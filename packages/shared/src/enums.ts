/**
 * String enums stored as TEXT columns (SQLite has no native enum; this keeps
 * the schema portable to PostgreSQL where they can become real enums later).
 */
export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const PRIVACY_REQUEST_TYPES = ['ACCESS', 'EXPORT', 'CORRECTION', 'DELETION', 'RESTRICTION', 'OTHER'] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];
export const PRIVACY_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];
/** Terminal states are not reopened: a new request is recorded instead, so the history of each decision stays intact. */
export const PRIVACY_REQUEST_TERMINAL: readonly PrivacyRequestStatus[] = ['COMPLETED', 'REJECTED'];

// ---------- attendance (Task 20) ----------
export const ATTENDANCE_DAY_TYPES = ['WORK', 'OFF', 'HOLIDAY'] as const;
export type AttendanceDayType = (typeof ATTENDANCE_DAY_TYPES)[number];

/** Who put a schedule row there. Leave is never stored as a schedule — it is read at calculation time. */
export const ATTENDANCE_SCHEDULE_SOURCES = ['DEFAULT', 'MANUAL'] as const;
export type AttendanceScheduleSource = (typeof ATTENDANCE_SCHEDULE_SOURCES)[number];

export const CLOCK_EVENT_TYPES = ['CLOCK_IN', 'CLOCK_OUT'] as const;
export type ClockEventType = (typeof CLOCK_EVENT_TYPES)[number];

/** WEB is the only source that exists today; the others are reserved so the model need not change to add them. */
export const CLOCK_SOURCES = ['WEB', 'ADMIN', 'IMPORT', 'API'] as const;
export type ClockSource = (typeof CLOCK_SOURCES)[number];

/**
 * One status per day, derived — never typed in by a person.
 *   NOT_SCHEDULED  the day is OFF or a holiday (any clocking is still recorded)
 *   SCHEDULED      a work day that has not finished yet and has no clock-in
 *   NORMAL         worked within the shift, allowing for the grace minutes
 *   LATE / EARLY_LEAVE / LATE_AND_EARLY  worked, outside the grace on one or both ends
 *   INCOMPLETE     clocked in but never out (or a malformed sequence)
 *   ABSENT         a work day that finished with no clocking and no full-day leave
 *   ON_LEAVE       approved full-day leave
 */
export const ATTENDANCE_STATUSES = ['NOT_SCHEDULED', 'SCHEDULED', 'NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'INCOMPLETE', 'ABSENT', 'ON_LEAVE'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type AttendanceCorrectionStatus = (typeof ATTENDANCE_CORRECTION_STATUSES)[number];
export const ATTENDANCE_CORRECTION_TERMINAL: readonly AttendanceCorrectionStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

/** The workflow engine coordinates for a correction request (same shape as LEAVE_WORKFLOW). */
export const ATTENDANCE_WORKFLOW = { module: 'attendance', entityType: 'ATTENDANCE_CORRECTION' } as const;

// ---------- overtime (Task 21) ----------
/**
 * The kind of day overtime was worked on — derived on the server from the schedule and the work calendar, never sent
 * by a client, because it selects the rate multiplier.
 */
export const OVERTIME_DAY_TYPES = ['WORKDAY', 'OFF_DAY', 'HOLIDAY'] as const;
export type OvertimeDayType = (typeof OVERTIME_DAY_TYPES)[number];

export const OVERTIME_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type OvertimeStatus = (typeof OVERTIME_STATUSES)[number];
/** A request in one of these states is settled: it never blocks a new claim for the same day. */
export const OVERTIME_SETTLED: readonly OvertimeStatus[] = ['REJECTED', 'CANCELLED'];

export const OVERTIME_WORKFLOW = { module: 'attendance', entityType: 'OVERTIME_REQUEST' } as const;

// ---------- payroll (Task 22) ----------
/** Monthly only in this release; the enum exists so adding a frequency later is a data change, not a schema change. */
export const PAY_FREQUENCIES = ['MONTHLY'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const PAY_COMPONENT_TYPES = ['EARNING', 'DEDUCTION'] as const;
export type PayComponentType = (typeof PAY_COMPONENT_TYPES)[number];

/**
 * How a component gets its amount.
 *   FIXED  — a configured amount (recurring allowances, fixed deductions)
 *   MANUAL — typed in by a payroll administrator during review
 *   SYSTEM — produced by the engine from attendance, leave, overtime or compensation
 */
export const PAY_COMPONENT_CALCULATION_TYPES = ['FIXED', 'MANUAL', 'SYSTEM'] as const;
export type PayComponentCalculationType = (typeof PAY_COMPONENT_CALCULATION_TYPES)[number];

/** Where a payslip line came from — the answer to "why am I being paid this?". */
export const PAYROLL_ITEM_SOURCES = ['BASE', 'RECURRING', 'OT', 'ATTENDANCE', 'LEAVE', 'MANUAL', 'STATUTORY'] as const;
export type PayrollItemSource = (typeof PAYROLL_ITEM_SOURCES)[number];

/** The system components the engine writes. Codes are stable: payslip history refers to them. */
export const SYSTEM_PAY_COMPONENTS = {
  BASE_SALARY: 'BASE_SALARY',
  OT_PAY: 'OT_PAY',
  UNPAID_LEAVE_DEDUCTION: 'UNPAID_LEAVE_DEDUCTION',
  ABSENCE_DEDUCTION: 'ABSENCE_DEDUCTION',
  LATE_DEDUCTION: 'LATE_DEDUCTION',
  MANUAL_EARNING: 'MANUAL_EARNING',
  MANUAL_DEDUCTION: 'MANUAL_DEDUCTION',
} as const;

export const PAYROLL_PERIOD_STATUSES = ['OPEN', 'PROCESSING', 'REVIEW', 'APPROVED', 'CLOSED'] as const;
export type PayrollPeriodStatus = (typeof PAYROLL_PERIOD_STATUSES)[number];
/** From REVIEW onwards the period's boundaries are frozen; CLOSED is immutable and cannot be reopened. */
export const PAYROLL_PERIOD_FROZEN: readonly PayrollPeriodStatus[] = ['REVIEW', 'APPROVED', 'CLOSED'];

export const PAYROLL_RUN_STATUSES = ['REVIEW', 'APPROVED', 'CLOSED'] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/** How a part-month is prorated for somebody who joined or left inside the period. */
export const PRORATION_BASES = ['CALENDAR_DAYS', 'WORKING_DAYS'] as const;
export type ProrationBasis = (typeof PRORATION_BASES)[number];

export const PAYROLL_WORKFLOW = { module: 'payroll', entityType: 'PAYROLL_RUN' } as const;

// ---------- performance (Task 23) ----------
/**
 * How a KPI is measured. It decides how a target and an actual are *displayed and entered* — it does not decide a
 * score. Turning "sold 92 of 100" into a rating needs rules nobody has agreed yet (higher-better, lower-better,
 * thresholds, ranges), so this release lets a reviewer judge it instead of guessing.
 */
export const KPI_MEASUREMENT_TYPES = ['NUMBER', 'PERCENTAGE', 'BOOLEAN', 'MILESTONE', 'QUALITATIVE'] as const;
export type KpiMeasurementType = (typeof KPI_MEASUREMENT_TYPES)[number];

/**
 * A cycle's own state, which is not a plan's state.
 *
 *   DRAFT  — configuration and plan structure can still change
 *   ACTIVE — employees record progress against their plans
 *   REVIEW — self and manager assessments happen
 *   CLOSED — history; nothing inside it ever changes again
 */
export const PERFORMANCE_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'REVIEW', 'CLOSED'] as const;
export type PerformanceCycleStatus = (typeof PERFORMANCE_CYCLE_STATUSES)[number];

/**
 * One plan's state. Deliberately linear and non-overlapping: a plan is somebody's to act on at every moment, and
 * exactly one person's.
 *
 *   DRAFT → ACTIVE → SELF_REVIEW → MANAGER_REVIEW → FINALIZED
 *
 * A cycle whose `selfReviewRequired` is false goes ACTIVE → MANAGER_REVIEW: not every employer asks people to
 * appraise themselves, and one that does not should not be made to.
 */
export const PERFORMANCE_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'FINALIZED'] as const;
export type PerformancePlanStatus = (typeof PERFORMANCE_PLAN_STATUSES)[number];

/** Weights are percentage points and a plan's must add up to exactly this before anybody reviews it. */
export const PERFORMANCE_TOTAL_WEIGHT = '100.00';

// ---------- competency (Task 24) ----------
/**
 * A competency cycle's own state, which is not an assessment's state. Stage changes are made by a person; there is
 * no scheduler in this release.
 */
export const COMPETENCY_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'REVIEW', 'CLOSED'] as const;
export type CompetencyCycleStatus = (typeof COMPETENCY_CYCLE_STATUSES)[number];

/**
 * One assessment's state — linear and non-overlapping, the same shape performance plans use.
 *
 *   DRAFT → ACTIVE → SELF_REVIEW → MANAGER_REVIEW → FINALIZED
 *
 * "Self submitted" is not a state of its own: it is the same instant as MANAGER_REVIEW, and two names for one moment
 * is how state machines start lying. A cycle whose `selfAssessmentRequired` is false goes ACTIVE → MANAGER_REVIEW.
 */
export const COMPETENCY_ASSESSMENT_STATUSES = ['DRAFT', 'ACTIVE', 'SELF_REVIEW', 'MANAGER_REVIEW', 'FINALIZED'] as const;
export type CompetencyAssessmentStatus = (typeof COMPETENCY_ASSESSMENT_STATUSES)[number];

/**
 * What a competency's gap says. **UNASSESSED is not zero**: nobody has looked, which is a different fact from
 * "assessed and found at level 0" and must never be reported as a deficiency.
 */
export const GAP_STATUSES = ['UNASSESSED', 'GAP', 'NO_GAP', 'EXCEEDS_REQUIREMENT'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

// ---------- training and development (Task 25) ----------
/** Why a development need exists. A gap-based need carries the numbers it was created from. */
export const TRAINING_NEED_SOURCES = ['COMPETENCY_GAP', 'MANUAL'] as const;
export type TrainingNeedSource = (typeof TRAINING_NEED_SOURCES)[number];

/**
 * A need's life. FULFILLED means somebody completed the development that was planned for it — **not** that their
 * competency level has changed, which only a competency assessment can do.
 */
export const TRAINING_NEED_STATUSES = ['OPEN', 'PLANNED', 'IN_PROGRESS', 'FULFILLED', 'CANCELLED'] as const;
export type TrainingNeedStatus = (typeof TRAINING_NEED_STATUSES)[number];

/** User-chosen, deliberately coarse: no severity is inferred from the size of a gap. */
export const TRAINING_NEED_PRIORITIES = ['NORMAL', 'HIGH'] as const;
export type TrainingNeedPriority = (typeof TRAINING_NEED_PRIORITIES)[number];

export const TRAINING_DELIVERY_METHODS = ['CLASSROOM', 'VIRTUAL', 'SELF_STUDY', 'BLENDED', 'OTHER'] as const;
export type TrainingDeliveryMethod = (typeof TRAINING_DELIVERY_METHODS)[number];

export const TRAINING_PROVIDER_TYPES = ['INTERNAL', 'EXTERNAL'] as const;
export type TrainingProviderType = (typeof TRAINING_PROVIDER_TYPES)[number];

export const TRAINING_SESSION_STATUSES = ['DRAFT', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type TrainingSessionStatus = (typeof TRAINING_SESSION_STATUSES)[number];

/**
 * One person's place on one session. A session being complete says nothing about any individual: one attendee may
 * have completed it, another failed it and a third never turned up.
 */
export const TRAINING_ENROLLMENT_STATUSES = ['ENROLLED', 'ATTENDED', 'COMPLETED', 'FAILED', 'NO_SHOW', 'CANCELLED'] as const;
export type TrainingEnrollmentStatus = (typeof TRAINING_ENROLLMENT_STATUSES)[number];
/** Once one of these is recorded the enrolment is finished; there is no correction workflow in this release. */
export const TRAINING_ENROLLMENT_TERMINAL: readonly TrainingEnrollmentStatus[] = ['COMPLETED', 'FAILED', 'NO_SHOW', 'CANCELLED'];

/** Why somebody was enrolled — so a training record can explain itself later. */
export const TRAINING_ENROLLMENT_SOURCES = ['MANUAL', 'TNA', 'IDP'] as const;
export type TrainingEnrollmentSource = (typeof TRAINING_ENROLLMENT_SOURCES)[number];

export const IDP_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type IdpStatus = (typeof IDP_STATUSES)[number];

export const IDP_ITEM_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type IdpItemStatus = (typeof IDP_ITEM_STATUSES)[number];

/** How somebody develops. Training is one way of several, which is the point of a development plan. */
export const DEVELOPMENT_TYPES = ['TRAINING', 'OJT', 'COACHING', 'MENTORING', 'SELF_STUDY', 'PROJECT', 'OTHER'] as const;
export type DevelopmentType = (typeof DEVELOPMENT_TYPES)[number];

// ---------- employee relations (Task 26) ----------
/**
 * A case's life. The record is operational — what was reported, what was proposed, what was decided — and none of
 * these states is a legal conclusion about anybody.
 */
export const EMPLOYEE_RELATION_CASE_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'ACTION_ISSUED', 'CLOSED', 'CANCELLED'] as const;
export type EmployeeRelationCaseStatus = (typeof EMPLOYEE_RELATION_CASE_STATUSES)[number];

/**
 * A disciplinary action's life. REJECTED is terminal for that proposal: the approver said no, and HR drafts a new one
 * rather than silently editing the one that was refused. Nothing moves to ISSUED except a final workflow approval.
 */
export const DISCIPLINARY_ACTION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED'] as const;
export type DisciplinaryActionStatus = (typeof DISCIPLINARY_ACTION_STATUSES)[number];

/** Derived on read from `validUntil` — there is no scheduler and no row is mutated when a warning lapses. */
export const DISCIPLINARY_VALIDITY_STATES = ['ACTIVE', 'EXPIRED', 'NOT_APPLICABLE'] as const;
export type DisciplinaryValidityState = (typeof DISCIPLINARY_VALIDITY_STATES)[number];

export const EMPLOYEE_RELATIONS_WORKFLOW = { module: 'employee_relations', entityType: 'DISCIPLINARY_ACTION' } as const;

/**
 * What acknowledging means, stated once and copied onto every acknowledgement: receipt of a document, and nothing
 * more. It is never an admission.
 */
export const ACKNOWLEDGEMENT_STATEMENT = 'I confirm that I have received this document. Acknowledging receipt does not mean that I agree with its contents or admit to the matters described in it.';

// ---------- recruitment (Task 27) ----------
export const REQUISITION_REASONS = ['NEW_HEADCOUNT', 'REPLACEMENT', 'TEMPORARY', 'OTHER'] as const;
export type RequisitionReason = (typeof REQUISITION_REASONS)[number];
export const REQUISITION_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];
/** OPEN means the opening takes applications inside the ATS. Nothing is published anywhere. */
export const OPENING_STATUSES = ['DRAFT', 'OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];
export const CANDIDATE_SOURCES = ['MANUAL', 'REFERRAL', 'AGENCY', 'JOB_BOARD', 'CAREER_SITE', 'OTHER'] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export const CANDIDATE_STATUSES = ['ACTIVE', 'HIRED', 'ARCHIVED'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
/**
 * The pipeline. Forward moves are explicit human actions with a reason; nothing advances on its own — not when an
 * interview completes, not when feedback says PROCEED, not when an offer is accepted. HIRED is reached only by the
 * hire action, which creates the employee.
 */
export const APPLICATION_STAGES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export const APPLICATION_ACTIVE_STAGES: readonly ApplicationStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
export const APPLICATION_STAGE_ORDER: readonly ApplicationStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'];
/** A rejection is a person's decision and carries a reason. The codes are for reporting; the note is for the file. */
export const REJECTION_REASONS = ['NOT_A_FIT', 'EXPERIENCE', 'COMPENSATION', 'POSITION_FILLED', 'NO_RESPONSE', 'OTHER'] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];
export const INTERVIEW_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];
/** Feedback informs a person. It never ranks a candidate or picks a winner. */
export const INTERVIEW_RECOMMENDATIONS = ['PROCEED', 'HOLD', 'DO_NOT_PROCEED'] as const;
export type InterviewRecommendation = (typeof INTERVIEW_RECOMMENDATIONS)[number];
/** SENT and ACCEPTED/DECLINED are HR-recorded facts: there is no candidate portal and no delivery channel. */
export const OFFER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const RECRUITMENT_WORKFLOW = { module: 'recruitment', requisition: 'RECRUITMENT_REQUISITION', offer: 'JOB_OFFER' } as const;

// ---------- career, talent and succession (Task 28) ----------
/** What a readiness projection may say. Facts about competency requirements — never a recommendation to promote. */
export const CAREER_READINESS_STATUSES = ['READY_REQUIREMENTS_MET', 'GAPS_EXIST', 'ASSESSMENT_REQUIRED', 'NO_REQUIREMENTS_DEFINED'] as const;
export type CareerReadinessStatus = (typeof CAREER_READINESS_STATUSES)[number];
export const TALENT_CYCLE_STATUSES = ['DRAFT', 'ACTIVE', 'REVIEW', 'CLOSED'] as const;
export type TalentCycleStatus = (typeof TALENT_CYCLE_STATUSES)[number];
export const TALENT_REVIEW_STATUSES = ['ASSIGNED', 'SUBMITTED', 'FINALIZED'] as const;
export type TalentReviewStatus = (typeof TALENT_REVIEW_STATUSES)[number];
/** The three buckets of the 3×3 matrix, on both axes. */
export const TALENT_BUCKETS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TalentBucket = (typeof TALENT_BUCKETS)[number];
export const TALENT_MEMBERSHIP_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export const SUCCESSION_PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED'] as const;
export type SuccessionPlanStatus = (typeof SUCCESSION_PLAN_STATUSES)[number];
export const SUCCESSION_CRITICALITIES = ['NORMAL', 'IMPORTANT', 'CRITICAL'] as const;
export type SuccessionCriticality = (typeof SUCCESSION_CRITICALITIES)[number];
/** A human's judgment, recorded as given. Never derived from a score. */
export const SUCCESSOR_READINESS = ['READY_NOW', 'READY_SOON', 'DEVELOPING'] as const;
export type SuccessorReadiness = (typeof SUCCESSOR_READINESS)[number];
export const DEVELOPMENT_ACTION_SOURCES = ['CAREER', 'SUCCESSION', 'TALENT_REVIEW'] as const;

export const NOTIFICATION_TYPES = {
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  LEAVE_SUBMITTED: 'LEAVE_SUBMITTED',
  LEAVE_APPROVED: 'LEAVE_APPROVED',
  LEAVE_REJECTED: 'LEAVE_REJECTED',
  /** Reserved: a requester cancelling their own request needs no notification (they performed the action). */
  LEAVE_CANCELLED: 'LEAVE_CANCELLED',
  ATTENDANCE_CORRECTION_APPROVED: 'ATTENDANCE_CORRECTION_APPROVED',
  ATTENDANCE_CORRECTION_REJECTED: 'ATTENDANCE_CORRECTION_REJECTED',
  OVERTIME_APPROVED: 'OVERTIME_APPROVED',
  OVERTIME_REJECTED: 'OVERTIME_REJECTED',
  PAYSLIP_AVAILABLE: 'PAYSLIP_AVAILABLE',
  /** Performance notifications carry a cycle and a name — never a score, a rating or a review comment. */
  PERFORMANCE_REVIEW_OPENED: 'PERFORMANCE_REVIEW_OPENED',
  PERFORMANCE_SELF_REVIEW_SUBMITTED: 'PERFORMANCE_SELF_REVIEW_SUBMITTED',
  PERFORMANCE_MANAGER_REVIEW_REQUIRED: 'PERFORMANCE_MANAGER_REVIEW_REQUIRED',
  PERFORMANCE_FINALIZED: 'PERFORMANCE_FINALIZED',
  /** Competency notifications carry a cycle and a name — never a level, a gap breakdown or an assessment comment. */
  COMPETENCY_ASSESSMENT_OPENED: 'COMPETENCY_ASSESSMENT_OPENED',
  COMPETENCY_SELF_ASSESSMENT_SUBMITTED: 'COMPETENCY_SELF_ASSESSMENT_SUBMITTED',
  COMPETENCY_MANAGER_ASSESSMENT_REQUIRED: 'COMPETENCY_MANAGER_ASSESSMENT_REQUIRED',
  COMPETENCY_ASSESSMENT_FINALIZED: 'COMPETENCY_ASSESSMENT_FINALIZED',
  /** Training and development notifications name a course, a session date or a plan — never a result or a comment. */
  TRAINING_ENROLLED: 'TRAINING_ENROLLED',
  TRAINING_SESSION_UPDATED: 'TRAINING_SESSION_UPDATED',
  TRAINING_COMPLETED: 'TRAINING_COMPLETED',
  IDP_ACTIVATED: 'IDP_ACTIVATED',
  IDP_COMPLETED: 'IDP_COMPLETED',
  /** Employee relations notifications say that a document exists, and nothing about what it says. */
  DISCIPLINARY_ACTION_ISSUED: 'DISCIPLINARY_ACTION_ISSUED',
  DISCIPLINARY_ACTION_ACKNOWLEDGED: 'DISCIPLINARY_ACTION_ACKNOWLEDGED',
  /** Recruitment notifications carry an opening title and a time — never a candidate's details, feedback or a salary. */
  INTERVIEW_ASSIGNED: 'INTERVIEW_ASSIGNED',
  INTERVIEW_FEEDBACK_REQUIRED: 'INTERVIEW_FEEDBACK_REQUIRED',
  HIRING_COMPLETED: 'HIRING_COMPLETED',
  TALENT_REVIEW_REQUIRED: 'TALENT_REVIEW_REQUIRED',
  TALENT_REVIEW_COMPLETED: 'TALENT_REVIEW_COMPLETED',
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_CHANNELS = { IN_APP: 'IN_APP', EMAIL: 'EMAIL', LINE: 'LINE', LARK: 'LARK', PUSH: 'PUSH' } as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];
export const NOTIFICATION_DELIVERY_STATUS = { PENDING: 'PENDING', SENT: 'SENT', FAILED: 'FAILED' } as const;

export const LEAVE_REQUEST_STATUS = { DRAFT: 'DRAFT', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED' } as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUS)[keyof typeof LEAVE_REQUEST_STATUS];
export const LEAVE_REQUEST_STATUSES = Object.values(LEAVE_REQUEST_STATUS);
/** Statuses that occupy the dates (overlap check) and hold a reservation. */
export const LEAVE_BLOCKING_STATUSES = [LEAVE_REQUEST_STATUS.PENDING, LEAVE_REQUEST_STATUS.APPROVED] as const;

export const EMPLOYMENT_STATUSES = ['ACTIVE', 'INACTIVE', 'TERMINATED'] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** Known audit modules (audit_logs.module). Used to validate the module filter. */
export const AUDIT_MODULES = ['auth', 'users', 'roles', 'organization', 'employees', 'workflow', 'calendar', 'leave', 'attendance', 'ot', 'payroll', 'performance', 'competency', 'training', 'employee_relations', 'recruitment', 'talent', 'onboarding', 'account', 'privacy'] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

/** Audit action codes. Convention: <VERB>_<ENTITY>. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER: 'UPDATE_USER',
  ACTIVATE_USER: 'ACTIVATE_USER',
  DEACTIVATE_USER: 'DEACTIVATE_USER',
  UPDATE_USER_ROLES: 'UPDATE_USER_ROLES',
  RESET_USER_PASSWORD: 'RESET_USER_PASSWORD',
  UPDATE_ROLE_PERMISSIONS: 'UPDATE_ROLE_PERMISSIONS',
  CREATE_ORGANIZATION: 'CREATE_ORGANIZATION',
  UPDATE_ORGANIZATION: 'UPDATE_ORGANIZATION',
  ACTIVATE_ORGANIZATION: 'ACTIVATE_ORGANIZATION',
  DEACTIVATE_ORGANIZATION: 'DEACTIVATE_ORGANIZATION',
  CREATE_DEPARTMENT: 'CREATE_DEPARTMENT',
  UPDATE_DEPARTMENT: 'UPDATE_DEPARTMENT',
  ACTIVATE_DEPARTMENT: 'ACTIVATE_DEPARTMENT',
  DEACTIVATE_DEPARTMENT: 'DEACTIVATE_DEPARTMENT',
  CREATE_JOB: 'CREATE_JOB',
  UPDATE_JOB: 'UPDATE_JOB',
  ACTIVATE_JOB: 'ACTIVATE_JOB',
  DEACTIVATE_JOB: 'DEACTIVATE_JOB',
  CREATE_POSITION: 'CREATE_POSITION',
  UPDATE_POSITION: 'UPDATE_POSITION',
  ACTIVATE_POSITION: 'ACTIVATE_POSITION',
  DEACTIVATE_POSITION: 'DEACTIVATE_POSITION',
  // settings.* actions are added when the Settings module is built (no orphan codes: every code here has a writer)
  CREATE_EMPLOYEE: 'CREATE_EMPLOYEE',
  UPDATE_EMPLOYEE: 'UPDATE_EMPLOYEE',
  ACTIVATE_EMPLOYEE: 'ACTIVATE_EMPLOYEE',
  DEACTIVATE_EMPLOYEE: 'DEACTIVATE_EMPLOYEE',
  CHANGE_EMPLOYEE_POSITION: 'CHANGE_EMPLOYEE_POSITION',
  CHANGE_EMPLOYEE_MANAGER: 'CHANGE_EMPLOYEE_MANAGER',
  UPDATE_DEPARTMENT_HEAD: 'UPDATE_DEPARTMENT_HEAD',
  CREATE_WORKFLOW_DEFINITION: 'CREATE_WORKFLOW_DEFINITION',
  ACTIVATE_WORKFLOW_DEFINITION: 'ACTIVATE_WORKFLOW_DEFINITION',
  DEACTIVATE_WORKFLOW_DEFINITION: 'DEACTIVATE_WORKFLOW_DEFINITION',
  WORKFLOW_SUBMIT: 'WORKFLOW_SUBMIT',
  WORKFLOW_APPROVE: 'WORKFLOW_APPROVE',
  WORKFLOW_REJECT: 'WORKFLOW_REJECT',
  WORKFLOW_CANCEL: 'WORKFLOW_CANCEL',
  CREATE_CALENDAR: 'CREATE_CALENDAR',
  UPDATE_CALENDAR: 'UPDATE_CALENDAR',
  ACTIVATE_CALENDAR: 'ACTIVATE_CALENDAR',
  DEACTIVATE_CALENDAR: 'DEACTIVATE_CALENDAR',
  SET_DEFAULT_CALENDAR: 'SET_DEFAULT_CALENDAR',
  CREATE_HOLIDAY: 'CREATE_HOLIDAY',
  UPDATE_HOLIDAY: 'UPDATE_HOLIDAY',
  ACTIVATE_HOLIDAY: 'ACTIVATE_HOLIDAY',
  DEACTIVATE_HOLIDAY: 'DEACTIVATE_HOLIDAY',
  CREATE_LEAVE_TYPE: 'CREATE_LEAVE_TYPE',
  UPDATE_LEAVE_TYPE: 'UPDATE_LEAVE_TYPE',
  ACTIVATE_LEAVE_TYPE: 'ACTIVATE_LEAVE_TYPE',
  DEACTIVATE_LEAVE_TYPE: 'DEACTIVATE_LEAVE_TYPE',
  CREATE_LEAVE_POLICY: 'CREATE_LEAVE_POLICY',
  UPDATE_LEAVE_POLICY: 'UPDATE_LEAVE_POLICY',
  ACTIVATE_LEAVE_POLICY: 'ACTIVATE_LEAVE_POLICY',
  DEACTIVATE_LEAVE_POLICY: 'DEACTIVATE_LEAVE_POLICY',
  GENERATE_LEAVE_ENTITLEMENT: 'GENERATE_LEAVE_ENTITLEMENT',
  ADJUST_LEAVE_ENTITLEMENT: 'ADJUST_LEAVE_ENTITLEMENT',
  CARRY_FORWARD_LEAVE_ENTITLEMENT: 'CARRY_FORWARD_LEAVE_ENTITLEMENT',
  CREATE_LEAVE_REQUEST: 'CREATE_LEAVE_REQUEST',
  UPDATE_LEAVE_REQUEST: 'UPDATE_LEAVE_REQUEST',
  SUBMIT_LEAVE_REQUEST: 'SUBMIT_LEAVE_REQUEST',
  APPROVE_LEAVE_REQUEST: 'APPROVE_LEAVE_REQUEST',
  REJECT_LEAVE_REQUEST: 'REJECT_LEAVE_REQUEST',
  CANCEL_LEAVE_REQUEST: 'CANCEL_LEAVE_REQUEST',
  IMPORT_CUSTOMER_ONBOARDING: 'IMPORT_CUSTOMER_ONBOARDING',

  CREATE_SHIFT: 'CREATE_SHIFT',
  UPDATE_SHIFT: 'UPDATE_SHIFT',
  ASSIGN_SCHEDULE: 'ASSIGN_SCHEDULE',
  CLOCK_IN: 'CLOCK_IN',
  CLOCK_OUT: 'CLOCK_OUT',
  RECALCULATE_ATTENDANCE: 'RECALCULATE_ATTENDANCE',
  CREATE_COMPENSATION: 'CREATE_COMPENSATION',
  UPDATE_COMPENSATION: 'UPDATE_COMPENSATION',
  CREATE_PAY_COMPONENT: 'CREATE_PAY_COMPONENT',
  UPDATE_PAY_COMPONENT: 'UPDATE_PAY_COMPONENT',
  ASSIGN_PAY_ITEM: 'ASSIGN_PAY_ITEM',
  UPDATE_PAY_ITEM: 'UPDATE_PAY_ITEM',
  CREATE_PAYROLL_POLICY: 'CREATE_PAYROLL_POLICY',
  UPDATE_PAYROLL_POLICY: 'UPDATE_PAYROLL_POLICY',
  CREATE_PAYROLL_PERIOD: 'CREATE_PAYROLL_PERIOD',
  UPDATE_PAYROLL_PERIOD: 'UPDATE_PAYROLL_PERIOD',
  CALCULATE_PAYROLL: 'CALCULATE_PAYROLL',
  ADD_PAYROLL_ADJUSTMENT: 'ADD_PAYROLL_ADJUSTMENT',
  REMOVE_PAYROLL_ADJUSTMENT: 'REMOVE_PAYROLL_ADJUSTMENT',
  SUBMIT_PAYROLL_RUN: 'SUBMIT_PAYROLL_RUN',
  APPROVE_PAYROLL_RUN: 'APPROVE_PAYROLL_RUN',
  REJECT_PAYROLL_RUN: 'REJECT_PAYROLL_RUN',
  CLOSE_PAYROLL_RUN: 'CLOSE_PAYROLL_RUN',
  CREATE_PERFORMANCE_CYCLE: 'CREATE_PERFORMANCE_CYCLE',
  UPDATE_PERFORMANCE_CYCLE: 'UPDATE_PERFORMANCE_CYCLE',
  ACTIVATE_PERFORMANCE_CYCLE: 'ACTIVATE_PERFORMANCE_CYCLE',
  OPEN_PERFORMANCE_REVIEW: 'OPEN_PERFORMANCE_REVIEW',
  CLOSE_PERFORMANCE_CYCLE: 'CLOSE_PERFORMANCE_CYCLE',
  CREATE_PERFORMANCE_KPI: 'CREATE_PERFORMANCE_KPI',
  UPDATE_PERFORMANCE_KPI: 'UPDATE_PERFORMANCE_KPI',
  ASSIGN_PERFORMANCE_PLAN: 'ASSIGN_PERFORMANCE_PLAN',
  UPDATE_PERFORMANCE_PLAN: 'UPDATE_PERFORMANCE_PLAN',
  SUBMIT_SELF_REVIEW: 'SUBMIT_SELF_REVIEW',
  SUBMIT_MANAGER_REVIEW: 'SUBMIT_MANAGER_REVIEW',
  FINALIZE_PERFORMANCE_PLAN: 'FINALIZE_PERFORMANCE_PLAN',
  CREATE_COMPETENCY_CATEGORY: 'CREATE_COMPETENCY_CATEGORY',
  UPDATE_COMPETENCY_CATEGORY: 'UPDATE_COMPETENCY_CATEGORY',
  CREATE_COMPETENCY_SCALE: 'CREATE_COMPETENCY_SCALE',
  UPDATE_COMPETENCY_SCALE: 'UPDATE_COMPETENCY_SCALE',
  CREATE_COMPETENCY: 'CREATE_COMPETENCY',
  UPDATE_COMPETENCY: 'UPDATE_COMPETENCY',
  UPDATE_JOB_COMPETENCY_PROFILE: 'UPDATE_JOB_COMPETENCY_PROFILE',
  CREATE_COMPETENCY_CYCLE: 'CREATE_COMPETENCY_CYCLE',
  UPDATE_COMPETENCY_CYCLE: 'UPDATE_COMPETENCY_CYCLE',
  ASSIGN_COMPETENCY_ASSESSMENT: 'ASSIGN_COMPETENCY_ASSESSMENT',
  REASSIGN_COMPETENCY_REVIEWER: 'REASSIGN_COMPETENCY_REVIEWER',
  SUBMIT_COMPETENCY_SELF_ASSESSMENT: 'SUBMIT_COMPETENCY_SELF_ASSESSMENT',
  SUBMIT_COMPETENCY_MANAGER_ASSESSMENT: 'SUBMIT_COMPETENCY_MANAGER_ASSESSMENT',
  FINALIZE_COMPETENCY_ASSESSMENT: 'FINALIZE_COMPETENCY_ASSESSMENT',
  CREATE_TRAINING_NEED: 'CREATE_TRAINING_NEED',
  UPDATE_TRAINING_NEED: 'UPDATE_TRAINING_NEED',
  GENERATE_TNA: 'GENERATE_TNA',
  CREATE_TRAINING_COURSE: 'CREATE_TRAINING_COURSE',
  UPDATE_TRAINING_COURSE: 'UPDATE_TRAINING_COURSE',
  CREATE_TRAINING_SESSION: 'CREATE_TRAINING_SESSION',
  UPDATE_TRAINING_SESSION: 'UPDATE_TRAINING_SESSION',
  ENROLL_TRAINING: 'ENROLL_TRAINING',
  CANCEL_TRAINING_ENROLLMENT: 'CANCEL_TRAINING_ENROLLMENT',
  RECORD_TRAINING_ATTENDANCE: 'RECORD_TRAINING_ATTENDANCE',
  RECORD_TRAINING_RESULT: 'RECORD_TRAINING_RESULT',
  CREATE_IDP: 'CREATE_IDP',
  UPDATE_IDP: 'UPDATE_IDP',
  ACTIVATE_IDP: 'ACTIVATE_IDP',
  UPDATE_IDP_ITEM: 'UPDATE_IDP_ITEM',
  COMPLETE_IDP: 'COMPLETE_IDP',
  CREATE_EMPLOYEE_RELATION_CASE: 'CREATE_EMPLOYEE_RELATION_CASE',
  UPDATE_EMPLOYEE_RELATION_CASE: 'UPDATE_EMPLOYEE_RELATION_CASE',
  CLOSE_EMPLOYEE_RELATION_CASE: 'CLOSE_EMPLOYEE_RELATION_CASE',
  CREATE_DISCIPLINARY_ACTION: 'CREATE_DISCIPLINARY_ACTION',
  UPDATE_DISCIPLINARY_ACTION: 'UPDATE_DISCIPLINARY_ACTION',
  SUBMIT_DISCIPLINARY_ACTION: 'SUBMIT_DISCIPLINARY_ACTION',
  APPROVE_DISCIPLINARY_ACTION: 'APPROVE_DISCIPLINARY_ACTION',
  REJECT_DISCIPLINARY_ACTION: 'REJECT_DISCIPLINARY_ACTION',
  ISSUE_DISCIPLINARY_ACTION: 'ISSUE_DISCIPLINARY_ACTION',
  ISSUE_WARNING_LETTER: 'ISSUE_WARNING_LETTER',
  ACKNOWLEDGE_DISCIPLINARY_ACTION: 'ACKNOWLEDGE_DISCIPLINARY_ACTION',
  RECORD_ACKNOWLEDGEMENT_DECLINED: 'RECORD_ACKNOWLEDGEMENT_DECLINED',
  CREATE_DISCIPLINARY_ACTION_TYPE: 'CREATE_DISCIPLINARY_ACTION_TYPE',
  UPDATE_DISCIPLINARY_ACTION_TYPE: 'UPDATE_DISCIPLINARY_ACTION_TYPE',
  UPDATE_DISCIPLINARY_POLICY: 'UPDATE_DISCIPLINARY_POLICY',
  CREATE_RECRUITMENT_REQUISITION: 'CREATE_RECRUITMENT_REQUISITION',
  UPDATE_RECRUITMENT_REQUISITION: 'UPDATE_RECRUITMENT_REQUISITION',
  SUBMIT_RECRUITMENT_REQUISITION: 'SUBMIT_RECRUITMENT_REQUISITION',
  APPROVE_RECRUITMENT_REQUISITION: 'APPROVE_RECRUITMENT_REQUISITION',
  REJECT_RECRUITMENT_REQUISITION: 'REJECT_RECRUITMENT_REQUISITION',
  CREATE_RECRUITMENT_OPENING: 'CREATE_RECRUITMENT_OPENING',
  UPDATE_RECRUITMENT_OPENING: 'UPDATE_RECRUITMENT_OPENING',
  OPEN_RECRUITMENT_OPENING: 'OPEN_RECRUITMENT_OPENING',
  CLOSE_RECRUITMENT_OPENING: 'CLOSE_RECRUITMENT_OPENING',
  CREATE_CANDIDATE: 'CREATE_CANDIDATE',
  UPDATE_CANDIDATE: 'UPDATE_CANDIDATE',
  CREATE_APPLICATION: 'CREATE_APPLICATION',
  MOVE_APPLICATION_STAGE: 'MOVE_APPLICATION_STAGE',
  REJECT_APPLICATION: 'REJECT_APPLICATION',
  WITHDRAW_APPLICATION: 'WITHDRAW_APPLICATION',
  SCHEDULE_INTERVIEW: 'SCHEDULE_INTERVIEW',
  UPDATE_INTERVIEW: 'UPDATE_INTERVIEW',
  SUBMIT_INTERVIEW_FEEDBACK: 'SUBMIT_INTERVIEW_FEEDBACK',
  CREATE_JOB_OFFER: 'CREATE_JOB_OFFER',
  UPDATE_JOB_OFFER: 'UPDATE_JOB_OFFER',
  SUBMIT_JOB_OFFER: 'SUBMIT_JOB_OFFER',
  APPROVE_JOB_OFFER: 'APPROVE_JOB_OFFER',
  REJECT_JOB_OFFER: 'REJECT_JOB_OFFER',
  MARK_JOB_OFFER_SENT: 'MARK_JOB_OFFER_SENT',
  RECORD_JOB_OFFER_ACCEPTED: 'RECORD_JOB_OFFER_ACCEPTED',
  RECORD_JOB_OFFER_DECLINED: 'RECORD_JOB_OFFER_DECLINED',
  WITHDRAW_JOB_OFFER: 'WITHDRAW_JOB_OFFER',
  HIRE_CANDIDATE: 'HIRE_CANDIDATE',
  UPDATE_RECRUITMENT_POLICY: 'UPDATE_RECRUITMENT_POLICY',
  EXPORT_CANDIDATE_PERSONAL_DATA: 'EXPORT_CANDIDATE_PERSONAL_DATA',
  // career, talent and succession
  CREATE_CAREER_PATH: 'CREATE_CAREER_PATH',
  UPDATE_CAREER_PATH: 'UPDATE_CAREER_PATH',
  CREATE_TALENT_CYCLE: 'CREATE_TALENT_CYCLE',
  UPDATE_TALENT_CYCLE: 'UPDATE_TALENT_CYCLE',
  ASSIGN_TALENT_REVIEW: 'ASSIGN_TALENT_REVIEW',
  SUBMIT_POTENTIAL_ASSESSMENT: 'SUBMIT_POTENTIAL_ASSESSMENT',
  FINALIZE_TALENT_REVIEW: 'FINALIZE_TALENT_REVIEW',
  CREATE_TALENT_POOL: 'CREATE_TALENT_POOL',
  UPDATE_TALENT_POOL: 'UPDATE_TALENT_POOL',
  ADD_TALENT_POOL_MEMBER: 'ADD_TALENT_POOL_MEMBER',
  REMOVE_TALENT_POOL_MEMBER: 'REMOVE_TALENT_POOL_MEMBER',
  CREATE_SUCCESSION_PLAN: 'CREATE_SUCCESSION_PLAN',
  UPDATE_SUCCESSION_PLAN: 'UPDATE_SUCCESSION_PLAN',
  NOMINATE_SUCCESSOR: 'NOMINATE_SUCCESSOR',
  UPDATE_SUCCESSOR_READINESS: 'UPDATE_SUCCESSOR_READINESS',
  REMOVE_SUCCESSOR: 'REMOVE_SUCCESSOR',
  CREATE_DEVELOPMENT_ACTION_FROM_TALENT: 'CREATE_DEVELOPMENT_ACTION_FROM_TALENT',
  CREATE_OT_POLICY: 'CREATE_OT_POLICY',
  UPDATE_OT_POLICY: 'UPDATE_OT_POLICY',
  CREATE_OVERTIME_REQUEST: 'CREATE_OVERTIME_REQUEST',
  UPDATE_OVERTIME_REQUEST: 'UPDATE_OVERTIME_REQUEST',
  SUBMIT_OVERTIME_REQUEST: 'SUBMIT_OVERTIME_REQUEST',
  APPROVE_OVERTIME_REQUEST: 'APPROVE_OVERTIME_REQUEST',
  REJECT_OVERTIME_REQUEST: 'REJECT_OVERTIME_REQUEST',
  CANCEL_OVERTIME_REQUEST: 'CANCEL_OVERTIME_REQUEST',
  SUBMIT_ATTENDANCE_CORRECTION: 'SUBMIT_ATTENDANCE_CORRECTION',
  APPROVE_ATTENDANCE_CORRECTION: 'APPROVE_ATTENDANCE_CORRECTION',
  REJECT_ATTENDANCE_CORRECTION: 'REJECT_ATTENDANCE_CORRECTION',
  CANCEL_ATTENDANCE_CORRECTION: 'CANCEL_ATTENDANCE_CORRECTION',
  CHANGE_OWN_PASSWORD: 'CHANGE_OWN_PASSWORD',
  ISSUE_PASSWORD_RESET: 'ISSUE_PASSWORD_RESET',
  REVOKE_OTHER_SESSIONS: 'REVOKE_OTHER_SESSIONS',
  ADMIN_REVOKE_USER_SESSIONS: 'ADMIN_REVOKE_USER_SESSIONS',
  CREATE_PRIVACY_REQUEST: 'CREATE_PRIVACY_REQUEST',
  UPDATE_PRIVACY_REQUEST: 'UPDATE_PRIVACY_REQUEST',
  EXPORT_EMPLOYEE_PERSONAL_DATA: 'EXPORT_EMPLOYEE_PERSONAL_DATA',
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Human-readable label for an audit action; unknown codes fall back to the raw code. */
export function auditActionLabel(action: string): string {
  const known: Record<string, string> = {
    LOGIN_SUCCESS: 'Login success',
    LOGIN_FAILED: 'Login failed',
    LOGOUT: 'Logout',
    RESET_USER_PASSWORD: 'Reset user password',
    UPDATE_USER_ROLES: 'Update user roles',
    UPDATE_ROLE_PERMISSIONS: 'Update role permissions',
    UPDATE_DEPARTMENT_HEAD: 'Update department head',
    CHANGE_EMPLOYEE_POSITION: 'Change employee position',
    CHANGE_EMPLOYEE_MANAGER: 'Change employee manager',
    WORKFLOW_SUBMIT: 'Workflow submitted',
    WORKFLOW_APPROVE: 'Workflow step approved',
    WORKFLOW_REJECT: 'Workflow step rejected',
    WORKFLOW_CANCEL: 'Workflow cancelled',
  };
  if (known[action]) return known[action];
  // generic <VERB>_<ENTITY> → "Verb entity"
  const [verb, ...rest] = action.split('_');
  if (!verb || rest.length === 0) return action;
  const text = `${verb} ${rest.join(' ')}`.toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const AUDIT_MODULE_LABELS: Record<string, string> = {
  auth: 'Authentication',
  users: 'Users',
  roles: 'Roles',
  organization: 'Organization',
  employees: 'Employees',
  workflow: 'Workflow',
  calendar: 'Calendar',
  leave: 'Leave',
  attendance: 'Attendance',
  ot: 'Overtime',
  payroll: 'Payroll',
  performance: 'Performance',
  competency: 'Competency',
  training: 'Training & development',
  employee_relations: 'Employee relations',
  recruitment: 'Recruitment',
  talent: 'Career & talent',
  onboarding: 'Onboarding',
  account: 'Account security',
  privacy: 'Privacy',
};
