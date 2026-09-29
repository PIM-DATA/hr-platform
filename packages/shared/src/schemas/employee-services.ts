import { z } from 'zod';
import {
  HR_LETTER_BODY_MAX, HR_LETTER_SUBJECT_MAX, HR_LETTER_STATUSES, HR_LETTER_TYPES, HR_LETTER_VOID_REASONS, SERVICE_CATEGORIES, SERVICE_FIELD_TYPES, SERVICE_FIELD_VALUE_MAX, SERVICE_FULFILLMENT_TYPES,
  SERVICE_MESSAGE_VISIBILITY, SERVICE_REJECT_REASONS, SERVICE_REQUEST_STATUSES, SERVICE_TARGET_DAYS_MAX, SERVICE_TEXT_MAX, type HrLetterType, type ServiceCategory, type ServiceFieldType, type ServiceRequestStatus,
} from '../employee-services';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const code = z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i);
/** A form field key is an identifier, never a path: it can address nothing outside its own answer row. */
const fieldKey = z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/i, 'Use letters, digits and underscore, starting with a letter');

// ---------- service catalogue ----------
export const serviceFieldSchema = z.object({
  key: fieldKey, label: z.string().trim().min(1).max(120), fieldType: z.enum(SERVICE_FIELD_TYPES), required: z.boolean().optional(), displayOrder: z.number().int().min(0).max(200).optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(), maxLength: z.number().int().min(1).max(SERVICE_FIELD_VALUE_MAX).nullable().optional(), employeeVisible: z.boolean().optional(), helpText: text(300),
}).strict();
export type ServiceFieldInput = z.infer<typeof serviceFieldSchema>;

export const createServiceRequestTypeSchema = z.object({
  code, name: z.string().trim().min(2).max(160), description: text(1000), category: z.enum(SERVICE_CATEGORIES), organizationId: z.string().min(1).nullable().optional(),
  workflowCode: z.string().trim().min(1).max(40).nullable().optional(), targetDays: z.number().int().min(1).max(SERVICE_TARGET_DAYS_MAX).nullable().optional(),
  requiresAttachment: z.boolean().optional(), employeeSelectable: z.boolean().optional(), fulfillmentType: z.enum(SERVICE_FULFILLMENT_TYPES).optional(),
  letterTemplateId: z.string().min(1).nullable().optional(), fields: z.array(serviceFieldSchema).max(30).optional(),
}).strict();
export type CreateServiceRequestTypeInput = z.infer<typeof createServiceRequestTypeSchema>;
export const updateServiceRequestTypeSchema = createServiceRequestTypeSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateServiceRequestTypeInput = z.infer<typeof updateServiceRequestTypeSchema>;

// ---------- service requests ----------
/** One answer per configured field. A value is a string, a boolean, a number or a list of strings; never an object. */
export const serviceAnswerSchema = z.object({ key: fieldKey, value: z.union([z.string().trim().max(SERVICE_FIELD_VALUE_MAX), z.boolean(), z.number(), z.array(z.string().trim().max(200)).max(50)]) }).strict();
export type ServiceAnswerInput = z.infer<typeof serviceAnswerSchema>;

export const createServiceRequestSchema = z.object({ requestTypeId: z.string().min(1), subject: z.string().trim().min(2).max(160), description: text(SERVICE_TEXT_MAX), answers: z.array(serviceAnswerSchema).max(30).optional() }).strict();
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;
export const updateServiceRequestSchema = z.object({ subject: z.string().trim().min(2).max(160).optional(), description: text(SERVICE_TEXT_MAX), answers: z.array(serviceAnswerSchema).max(30).optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateServiceRequestInput = z.infer<typeof updateServiceRequestSchema>;

export const assignServiceRequestSchema = z.object({ assignedToUserId: z.string().min(1).nullable() }).strict();
export type AssignServiceRequestInput = z.infer<typeof assignServiceRequestSchema>;
export const serviceMessageSchema = z.object({ body: z.string().trim().min(1).max(SERVICE_TEXT_MAX), visibility: z.enum(SERVICE_MESSAGE_VISIBILITY) }).strict();
export type ServiceMessageInput = z.infer<typeof serviceMessageSchema>;
export const fulfillServiceRequestSchema = z.object({ resultNote: text(SERVICE_TEXT_MAX), letterTemplateId: z.string().min(1).nullable().optional() }).strict();
export type FulfillServiceRequestInput = z.infer<typeof fulfillServiceRequestSchema>;
export const rejectServiceRequestSchema = z.object({ reasonCode: z.enum(SERVICE_REJECT_REASONS), explanation: text(SERVICE_TEXT_MAX) }).strict();
export type RejectServiceRequestInput = z.infer<typeof rejectServiceRequestSchema>;
export const serviceRequestListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SERVICE_REQUEST_STATUSES).optional(), requestTypeId: z.string().min(1).optional(), category: z.enum(SERVICE_CATEGORIES).optional(), assignedToUserId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(), overdue: z.coerce.boolean().optional(), from: date.optional(), to: date.optional(), search: z.string().trim().max(120).optional(),
});

// ---------- HR letters ----------
export const createHrLetterTemplateSchema = z.object({
  code, name: z.string().trim().min(2).max(160), organizationId: z.string().min(1).nullable().optional(), letterType: z.enum(HR_LETTER_TYPES),
  subjectTemplate: z.string().trim().max(HR_LETTER_SUBJECT_MAX).nullable().optional(), bodyTemplate: z.string().trim().min(10).max(HR_LETTER_BODY_MAX),
}).strict();
export type CreateHrLetterTemplateInput = z.infer<typeof createHrLetterTemplateSchema>;
export const updateHrLetterTemplateSchema = createHrLetterTemplateSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateHrLetterTemplateInput = z.infer<typeof updateHrLetterTemplateSchema>;

export const issueHrLetterSchema = z.object({ employeeId: z.string().min(1), templateId: z.string().min(1), serviceRequestId: z.string().min(1).nullable().optional(), issueDate: date.optional() }).strict();
export type IssueHrLetterInput = z.infer<typeof issueHrLetterSchema>;
export const voidHrLetterSchema = z.object({ reasonCode: z.enum(HR_LETTER_VOID_REASONS) }).strict();
export type VoidHrLetterInput = z.infer<typeof voidHrLetterSchema>;
export const hrLetterListQuerySchema = paginationQuerySchema.extend({ letterType: z.enum(HR_LETTER_TYPES).optional(), status: z.enum(HR_LETTER_STATUSES).optional(), employeeId: z.string().min(1).optional(), from: date.optional(), to: date.optional(), search: z.string().trim().max(120).optional() });
export const serviceReportQuerySchema = z.object({ from: date.optional(), to: date.optional(), organizationId: z.string().min(1).optional() });
export const linkServiceDocumentSchema = z.object({ documentId: z.string().min(1) }).strict();

// ---------- DTOs ----------
export interface ServiceFieldDto { id: string; key: string; label: string; fieldType: ServiceFieldType; required: boolean; displayOrder: number; options: string[]; maxLength: number | null; employeeVisible: boolean; helpText: string | null }
export interface ServiceRequestTypeDto {
  id: string; code: string; name: string; description: string | null; category: ServiceCategory; organizationId: string | null; organizationName: string | null; workflowCode: string | null; targetDays: number | null;
  requiresAttachment: boolean; employeeSelectable: boolean; fulfillmentType: (typeof SERVICE_FULFILLMENT_TYPES)[number]; letterTemplateId: string | null; letterTemplateName: string | null; isActive: boolean;
  fields: ServiceFieldDto[]; requestCount: number; createdAt: string; updatedAt: string;
}
export interface ServiceSnapshotDto { employeeCode: string; employeeName: string; organization: string | null; department: string | null; job: string | null; position: string | null }
/** The answer as it was submitted, with the label and type frozen at that moment. */
export interface ServiceAnswerDto { key: string; label: string; fieldType: ServiceFieldType; value: string; employeeVisible: boolean }
export interface ServiceMessageDto { id: string; visibility: (typeof SERVICE_MESSAGE_VISIBILITY)[number]; body: string; authorName: string | null; isMine: boolean; createdAt: string }
export interface ServiceHistoryDto { from: string | null; to: string; actorName: string | null; reasonCode: string | null; at: string }
export interface ServiceDocumentDto { documentId: string; documentNumber: string; title: string; accessible: boolean }
export interface ServiceRequestDto {
  id: string; requestNumber: string; employeeId: string; requestTypeId: string; requestTypeCode: string; requestTypeName: string; category: ServiceCategory; fulfillmentType: (typeof SERVICE_FULFILLMENT_TYPES)[number];
  snapshot: ServiceSnapshotDto; subject: string; status: ServiceRequestStatus; assignedToUserId: string | null; assignedToName: string | null; workflowInstanceId: string | null; workflowStatus: string | null;
  submittedAt: string | null; dueDate: string | null; overdue: boolean; fulfilledAt: string | null; letterCount: number; attachmentCount: number; messageCount: number; createdAt: string; updatedAt: string;
  can: { edit: boolean; submit: boolean; cancel: boolean; assign: boolean; message: boolean; internalMessage: boolean; fulfill: boolean; reject: boolean };
}
export interface ServiceRequestDetailDto extends ServiceRequestDto {
  description: string | null; answers: ServiceAnswerDto[]; messages: ServiceMessageDto[]; history: ServiceHistoryDto[]; documents: ServiceDocumentDto[]; letters: HrLetterSummaryDto[];
  resultNote: string | null; rejectReasonCode: string | null; rejectExplanation: string | null; blockers: string[];
}
export interface HrLetterTemplateDto {
  id: string; code: string; name: string; organizationId: string | null; organizationName: string | null; letterType: HrLetterType; subjectTemplate: string | null; bodyTemplate: string;
  requiresSalaryAccess: boolean; tokens: string[]; isActive: boolean; letterCount: number; createdAt: string; updatedAt: string;
}
export interface HrLetterSummaryDto { id: string; letterNumber: string; letterType: HrLetterType; status: (typeof HR_LETTER_STATUSES)[number]; issuedDate: string; subject: string | null }
export interface HrLetterDto extends HrLetterSummaryDto {
  employeeId: string; serviceRequestId: string | null; serviceRequestNumber: string | null; templateId: string; templateCode: string; templateName: string; snapshot: ServiceSnapshotDto;
  body: string; salaryAmount: string | null; salaryCurrency: string | null; issuedByName: string | null; voidedAt: string | null; voidReasonCode: string | null; documents: ServiceDocumentDto[];
  organizationName: string | null; createdAt: string; can: { void: boolean };
}
export interface MyServicesDto {
  requests: ServiceRequestDto[]; letters: HrLetterSummaryDto[]; catalog: { id: string; code: string; name: string; description: string | null; category: ServiceCategory; requiresAttachment: boolean; targetDays: number | null; fields: ServiceFieldDto[] }[];
  queue: { instanceId: string; entityId: string; stepName: string; requesterName: string; submittedAt: string }[];
}
export interface ServiceDashboardDto {
  requests: { draft: number; submitted: number; inProgress: number; waitingEmployee: number; overdue: number; fulfilled: number; rejected: number; cancelled: number };
  letters: { issued: number; voided: number; byType: { letterType: HrLetterType; count: number }[] };
  averageFulfillmentDays: number | null; definitions: Record<string, string>; generatedAt: string;
}
export interface ServiceReportsDto {
  range: { from: string; to: string };
  totals: { submitted: number; fulfilled: number; rejected: number; open: number; averageFulfillmentDays: number | null };
  byType: { requestType: string; category: ServiceCategory; submitted: number; fulfilled: number; rejected: number; open: number; averageFulfillmentDays: number | null }[];
  byCategory: { category: ServiceCategory; submitted: number; fulfilled: number }[];
  byMonth: { month: string; submitted: number; fulfilled: number }[];
  letters: { byType: { letterType: HrLetterType; issued: number; voided: number }[]; byMonth: { month: string; issued: number }[] };
}
