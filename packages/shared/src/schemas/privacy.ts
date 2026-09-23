import { z } from 'zod';
import { PRIVACY_REQUEST_STATUSES, PRIVACY_REQUEST_TYPES } from '../enums';
import { paginationQuerySchema } from './common';

/**
 * Privacy operations are a *record-keeping* tool: they track what a data subject asked for and what the organization
 * did about it. The system never decides on its own that data must be erased — retention periods and legal basis are
 * customer policy, so a DELETION request is recorded for review, not executed.
 */
export const createPrivacyRequestSchema = z
  .object({
    requestType: z.enum(PRIVACY_REQUEST_TYPES),
    employeeId: z.string().min(1).nullable().optional(),
    userId: z.string().min(1).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    assignedToUserId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => !!v.employeeId || !!v.userId, { message: 'A privacy request must identify an employee or a user', path: ['employeeId'] });
export type CreatePrivacyRequestInput = z.infer<typeof createPrivacyRequestSchema>;

export const updatePrivacyRequestSchema = z
  .object({
    status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
    dueAt: z.string().datetime().nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    assignedToUserId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdatePrivacyRequestInput = z.infer<typeof updatePrivacyRequestSchema>;

export const privacyRequestListQuerySchema = paginationQuerySchema.omit({ search: true }).extend({
  status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
  requestType: z.enum(PRIVACY_REQUEST_TYPES).optional(),
});
export type PrivacyRequestListQuery = z.infer<typeof privacyRequestListQuerySchema>;

export interface PrivacyRequestDto {
  id: string;
  requestType: string;
  status: string;
  subject: { employee: { id: string; employeeCode: string; firstName: string; lastName: string } | null; user: { id: string; email: string } | null };
  requestedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  assignedTo: { id: string; email: string } | null;
  createdBy: { id: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
  /** Free text supplied by the administrator; only returned on the detail endpoint, never in the list. */
  notes?: string | null;
}

export interface PrivacyEmployeeOptionDto {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  employmentStatus: string;
}

/** Envelope of a personal-data export. `formatVersion` lets the shape evolve without breaking earlier exports. */
export interface PersonalDataExportDto {
  formatVersion: 1;
  generatedAt: string;
  subject: { employeeId: string; employeeCode: string; firstName: string; lastName: string; userId: string | null };
  data: Record<string, unknown>;
  /** Categories the system cannot attribute to one person reliably, listed so the export is honest about its limits. */
  notIncluded: { category: string; reason: string }[];
}
