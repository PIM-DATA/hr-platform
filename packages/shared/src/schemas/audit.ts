import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_MODULES } from '../enums';

/**
 * Audit list query. Timestamps are UTC ISO strings:
 *   dateFrom = inclusive (createdAt >= dateFrom), dateTo = EXCLUSIVE (createdAt < dateTo).
 * The frontend converts a local calendar range to [startOfDay, startOfNextDay) in ISO.
 */
export const auditListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    userId: z.string().min(1).max(64).optional(),
    module: z.enum(AUDIT_MODULES).optional(),
    action: z.enum(Object.values(AUDIT_ACTIONS) as [string, ...string[]]).optional(),
    recordType: z.string().trim().min(1).max(50).regex(/^[A-Za-z]+$/, 'Invalid record type').optional(),
    recordId: z.string().trim().min(1).max(64).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { message: 'dateFrom must be before dateTo', path: ['dateTo'] });
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export interface AuditActor {
  userId: string;
  /** Current email of the user (not a snapshot at event time). */
  email: string;
}

export interface AuditLogListItem {
  id: string;
  createdAt: string;
  /** null = system / anonymous (e.g. failed login for an unknown email). */
  actor: AuditActor | null;
  module: string;
  action: string;
  recordType: string;
  recordId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  hasChanges: boolean;
}

export interface AuditLogDetail extends AuditLogListItem {
  oldValue: unknown;
  newValue: unknown;
}
