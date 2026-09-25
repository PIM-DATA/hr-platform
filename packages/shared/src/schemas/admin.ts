import { z } from 'zod';
import { ADMIN_CAPABILITIES, type AdminCapability } from '../admin';
import { WORKFLOW_INSTANCE_STATUS } from '../workflow';
import { paginationQuerySchema } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const workflowMonitorQuerySchema = paginationQuerySchema.extend({
  module: z.string().trim().max(40).optional(),
  entityType: z.string().trim().max(60).optional(),
  status: z.enum(Object.values(WORKFLOW_INSTANCE_STATUS) as [string, ...string[]]).optional(),
  definitionCode: z.string().trim().max(50).optional(),
  from: date.optional(),
  to: date.optional(),
  stalledDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type WorkflowMonitorQuery = z.infer<typeof workflowMonitorQuerySchema>;

/** One waiting or completed step, as metadata. The words an approver wrote belong to the source module. */
export interface WorkflowMonitorStepDto {
  stepOrder: number;
  name: string;
  approverType: string;
  approverName: string | null;
  status: string;
  actedByName: string | null;
  actedAt: string | null;
  skipReason: string | null;
  /** The decision text is shown only to a caller who may open the source module; otherwise its presence and length. */
  comment: string | null;
  commentRedacted: boolean;
  commentLength: number;
}
export interface WorkflowMonitorRowDto {
  id: string;
  definition: { code: string; version: number; name: string };
  module: string;
  moduleLabel: string;
  entityType: string;
  /** The identifier only. The monitor never reads a business record to describe it. */
  entityId: string;
  requesterName: string;
  requesterEmployeeCode: string;
  status: string;
  currentStepName: string | null;
  currentApproverName: string | null;
  submittedAt: string;
  completedAt: string | null;
  /** Calendar days a pending instance has been waiting; null once it is decided. */
  waitingDays: number | null;
  /** True when this caller holds a permission that already opens the source module. */
  canOpenSource: boolean;
  sourcePath: string | null;
}
export interface WorkflowMonitorDetailDto extends WorkflowMonitorRowDto {
  steps: WorkflowMonitorStepDto[];
  history: { at: string; action: string; stepOrder: number | null; actorName: string | null; comment: string | null; commentRedacted: boolean }[];
}
export interface WorkflowMonitorSummaryDto {
  byStatus: { status: string; count: number }[];
  byModule: { module: string; moduleLabel: string; pending: number; total: number; oldestPendingDays: number | null }[];
  generatedAt: string;
}

/**
 * Operational facts an administrator may see. Everything here is either a boolean, an enum or a short label: no
 * connection string, no path, no key, no host, no token. Values set by the deployment are reported, never edited.
 */
export interface AdminDiagnosticsDto {
  environment: 'development' | 'test' | 'production';
  version: string | null;
  database: 'ok' | 'unavailable';
  secureCookies: boolean;
  sessionTtlHours: number;
  documents: { enabled: boolean; storage: 'ok' | 'unavailable' | 'disabled' };
  copilot: { enabled: boolean; provider: string; model: string; configured: boolean };
  notifications: { inApp: boolean; externalDelivery: false };
  generatedAt: string;
}

export interface AdminSettingsAreaDto {
  key: string;
  name: string;
  description: string;
  capability: AdminCapability;
  /** Where the area is administered, when it is administered in the app at all. */
  path: string | null;
  /** Any one of these permissions opens the area; an empty list means nobody administers it here. */
  permissions: string[];
  note: string | null;
}
export const adminCapabilitySchema = z.enum(ADMIN_CAPABILITIES);
