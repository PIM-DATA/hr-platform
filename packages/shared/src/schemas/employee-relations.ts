import type { AggregateSuppression } from '../privacy-aggregates';
import { z } from 'zod';
import { DISCIPLINARY_ACTION_STATUSES, DISCIPLINARY_VALIDITY_STATES, EMPLOYEE_RELATION_CASE_STATUSES } from '../enums';
import { isBusinessDate } from '../business-date';
import { paginationQuerySchema } from './common';

/**
 * Employee relations contracts (Task 26).
 *
 * The most sensitive text in the system passes through these: what somebody is said to have done, and what was
 * written to them about it. Narrative fields exist in exactly two places — the case and the issued letter — and the
 * shapes below are deliberate about which callers get which fields.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const codeField = z.string().trim().min(1).max(40).regex(/^[A-Z][A-Z0-9_]*$/, 'Use upper-case letters, digits and underscore, starting with a letter');

// ---------- action types ----------
export const createActionTypeSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  /** Display order only. It is not a ladder the system climbs — no action ever follows another automatically. */
  severityOrder: z.number().int().min(0).max(100).default(0),
  requiresWarningLetter: z.boolean().default(true),
  requiresAcknowledgement: z.boolean().default(true),
  /** A default HR may override before submitting. There is no built-in number: 90 days and a year are both wrong for somebody. */
  defaultValidityDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export type CreateActionTypeInput = z.infer<typeof createActionTypeSchema>;

export const updateActionTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    severityOrder: z.number().int().min(0).max(100).optional(),
    requiresWarningLetter: z.boolean().optional(),
    requiresAcknowledgement: z.boolean().optional(),
    defaultValidityDays: z.number().int().min(1).max(3650).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateActionTypeInput = z.infer<typeof updateActionTypeSchema>;

export interface ActionTypeDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  severityOrder: number;
  requiresWarningLetter: boolean;
  requiresAcknowledgement: boolean;
  defaultValidityDays: number | null;
  isActive: boolean;
  inUse: boolean;
}

// ---------- categories ----------
export const createCaseCategorySchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type CreateCaseCategoryInput = z.infer<typeof createCaseCategorySchema>;

export interface CaseCategoryDto {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

// ---------- policy ----------
export const upsertPolicySchema = z.object({
  organizationId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  workflowDefinitionCode: z.string().trim().min(1).max(50),
  defaultAcknowledgementDueDays: z.number().int().min(1).max(365).nullable().optional(),
  effectiveFrom: businessDate,
  effectiveTo: businessDate.nullable().optional(),
});
export type UpsertPolicyInput = z.infer<typeof upsertPolicySchema>;

export interface DisciplinaryPolicyDto {
  id: string;
  organization: { id: string; code: string; name: string };
  name: string;
  workflowDefinitionCode: string;
  defaultAcknowledgementDueDays: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

// ---------- letter templates ----------
export const upsertLetterTemplateSchema = z.object({
  code: codeField,
  name: z.string().trim().min(1).max(100),
  subjectTemplate: z.string().trim().min(1).max(200),
  bodyTemplate: z.string().trim().min(1).max(10000),
  isActive: z.boolean().default(true),
});
export type UpsertLetterTemplateInput = z.infer<typeof upsertLetterTemplateSchema>;

export interface LetterTemplateDto {
  id: string;
  code: string;
  name: string;
  subjectTemplate: string;
  bodyTemplate: string;
  isActive: boolean;
}

// ---------- cases ----------
export const createCaseSchema = z.object({
  employeeId: z.string().min(1),
  incidentDate: businessDate,
  categoryId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(10000),
  internalNotes: z.string().trim().max(10000).nullable().optional(),
});
export type CreateCaseInput = z.infer<typeof createCaseSchema>;

export const updateCaseSchema = z
  .object({
    incidentDate: businessDate.optional(),
    categoryId: z.string().min(1).nullable().optional(),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(10000).optional(),
    internalNotes: z.string().trim().max(10000).nullable().optional(),
    assignedToUserId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateCaseInput = z.infer<typeof updateCaseSchema>;

export const caseListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  status: z.enum(EMPLOYEE_RELATION_CASE_STATUSES).optional(),
  actionTypeId: z.string().min(1).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export type CaseListQuery = z.infer<typeof caseListQuerySchema>;

export interface CaseSummaryDto {
  id: string;
  caseNumber: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  /** Where the employee was when the case was opened. A later transfer does not move it. */
  snapshot: { organizationName: string | null; departmentName: string | null; positionTitle: string | null; jobTitle: string | null };
  incidentDate: string;
  reportedAt: string;
  category: { id: string; name: string } | null;
  title: string;
  status: (typeof EMPLOYEE_RELATION_CASE_STATUSES)[number];
  /** The current proposal or issued action, if any. Rejected proposals are kept on the case but are not "current". */
  currentAction: { id: string; actionTypeName: string; status: string; issuedDate: string | null; validUntil: string | null; validity: (typeof DISCIPLINARY_VALIDITY_STATES)[number]; acknowledgedAt: string | null } | null;
  createdAt: string;
}

export interface CaseDetailDto extends CaseSummaryDto {
  description: string;
  /** HR only. Omitted entirely for anybody without `employee_relations.manage`. */
  internalNotes?: string | null;
  assignedTo: { id: string; email: string } | null;
  actions: DisciplinaryActionDto[];
  /** What else currently stands against the employee — shown so a person can decide, never so the system can. */
  priorActiveActions: PriorActionDto[];
  timeline: TimelineEntryDto[];
  closedAt: string | null;
  cancelledAt: string | null;
}

export interface PriorActionDto {
  actionId: string;
  caseNumber: string;
  actionTypeName: string;
  issuedDate: string | null;
  validUntil: string | null;
  validity: (typeof DISCIPLINARY_VALIDITY_STATES)[number];
}

export interface TimelineEntryDto {
  at: string;
  kind: string;
  label: string;
  actor: string | null;
  comment: string | null;
}

// ---------- disciplinary actions ----------
export const createActionSchema = z.object({
  actionTypeId: z.string().min(1),
  reason: z.string().trim().min(1).max(4000),
  effectiveDate: businessDate.nullable().optional(),
  /** Overrides the action type's default; null means the warning stands until something says otherwise. */
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
  letterTemplateId: z.string().min(1).nullable().optional(),
  letterSubject: z.string().trim().max(200).nullable().optional(),
  letterBody: z.string().trim().max(10000).nullable().optional(),
});
export type CreateActionInput = z.infer<typeof createActionSchema>;

export const updateActionSchema = z
  .object({
    reason: z.string().trim().min(1).max(4000).optional(),
    effectiveDate: businessDate.nullable().optional(),
    validityDays: z.number().int().min(1).max(3650).nullable().optional(),
    letterSubject: z.string().trim().max(200).nullable().optional(),
    letterBody: z.string().trim().max(10000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateActionInput = z.infer<typeof updateActionSchema>;

export const declineAcknowledgementSchema = z.object({ note: z.string().trim().min(1).max(1000) });
export type DeclineAcknowledgementInput = z.infer<typeof declineAcknowledgementSchema>;

export const actionListQuerySchema = paginationQuerySchema.extend({
  employeeId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  actionTypeId: z.string().min(1).optional(),
  status: z.enum(DISCIPLINARY_ACTION_STATUSES).optional(),
  validity: z.enum(DISCIPLINARY_VALIDITY_STATES).optional(),
  awaitingAcknowledgement: z.coerce.boolean().optional(),
});
export type ActionListQuery = z.infer<typeof actionListQuerySchema>;

export interface DisciplinaryActionDto {
  id: string;
  caseId: string;
  caseNumber: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  actionType: { id: string; code: string; name: string };
  requiresWarningLetter: boolean;
  requiresAcknowledgement: boolean;
  reason: string;
  effectiveDate: string | null;
  validityDays: number | null;
  issuedDate: string | null;
  validUntil: string | null;
  validity: (typeof DISCIPLINARY_VALIDITY_STATES)[number];
  status: (typeof DISCIPLINARY_ACTION_STATUSES)[number];
  workflowInstanceId: string | null;
  /** Editable until submitted; after issue the letter is its own frozen record. */
  letterSubject: string | null;
  letterBody: string | null;
  letter: WarningLetterDto | null;
  acknowledgementDueDate: string | null;
  acknowledgedAt: string | null;
  declinedAt: string | null;
  submittedAt: string | null;
  issuedAt: string | null;
  createdAt: string;
}

export interface WarningLetterDto {
  id: string;
  letterNumber: string;
  subject: string;
  employeeName: string;
  employeeCode: string;
  position: string | null;
  department: string | null;
  organization: string | null;
  incidentDate: string;
  actionName: string;
  body: string;
  issuedAt: string;
  validUntil: string | null;
  acknowledgementText: string;
}

/** What an approver sees: enough to decide, and no internal notes. */
export interface ApprovalProjectionDto {
  action: DisciplinaryActionDto;
  caseSummary: { caseNumber: string; title: string; category: string | null; incidentDate: string; description: string };
  priorActiveActions: PriorActionDto[];
  workflowInstanceId: string;
  stepName: string;
}

/** What an employee sees of their own issued record. No case narrative, no internal notes, no proposal history. */
export interface MyDisciplinaryRecordDto {
  id: string;
  caseNumber: string;
  actionTypeName: string;
  issuedDate: string;
  validUntil: string | null;
  validity: (typeof DISCIPLINARY_VALIDITY_STATES)[number];
  requiresAcknowledgement: boolean;
  acknowledgementDueDate: string | null;
  acknowledgedAt: string | null;
  letter: WarningLetterDto | null;
}

export interface AcknowledgementDto {
  id: string;
  actionId: string;
  acknowledgedAt: string;
  acknowledgementText: string;
}

// ---------- summary and reporting ----------
/** The hand-off for a future Employee 360: counts only, never narrative. */
export interface EmployeeRelationsSummaryDto {
  employeeId: string;
  activeWarnings: number;
  totalIssued: number;
  latestActionDate: string | null;
  awaitingAcknowledgement: number;
}

export const erReportQuerySchema = z.object({
  departmentId: z.string().min(1).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export type ErReportQuery = z.infer<typeof erReportQuerySchema>;

/**
 * Task 47 (T44-P1-07): counts about a department of fewer than MIN_AGGREGATE_GROUP_SIZE people identify somebody's
 * disciplinary record. Such departments (and their complement) are withheld: counts null, `suppression` set. A
 * department filter onto a withheld department withholds the whole report (`suppression` at the top, lists empty).
 */
export interface EmployeeRelationsReportDto {
  suppression: AggregateSuppression | null;
  casesByStatus: { status: string; count: number }[];
  actions: { issued: number; active: number; expired: number; awaitingAcknowledgement: number; overdueAcknowledgement: number } | null;
  byDepartment: { departmentName: string; cases: number | null; issued: number | null; active: number | null; suppression: AggregateSuppression | null }[];
  byActionType: { actionTypeName: string; issued: number; active: number }[];
  byMonth: { month: string; cases: number; issued: number }[];
}
