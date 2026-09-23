import { z } from 'zod';
import { businessDateSchema } from './calendar';

/** Reports attribute a request to its START DATE (see LEAVE_REPORT_ATTRIBUTION), so a range is always required. */
export const MAX_REPORT_MONTHS = 24;
export const LEAVE_REPORT_ATTRIBUTION = 'START_DATE' as const;

export const leaveReportQuerySchema = z
  .object({
    from: businessDateSchema,
    to: businessDateSchema,
    leaveTypeId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    departmentId: z.string().min(1).optional(),
  })
  .refine((v) => v.from <= v.to, { message: 'from must be on or before to', path: ['to'] });
export type LeaveReportQuery = z.infer<typeof leaveReportQuerySchema>;

export interface LeaveReportSummaryDto {
  submittedRequests: number;
  approvedRequests: number;
  pendingRequests: number;
  rejectedRequests: number;
  cancelledRequests: number;
  approvedUnits: number;
  pendingUnits: number;
}
export interface LeaveReportTypeRowDto {
  leaveTypeId: string;
  code: string;
  name: string;
  submittedRequests: number;
  approvedRequests: number;
  pendingRequests: number;
  approvedUnits: number;
  pendingUnits: number;
}
export interface LeaveReportTrendPointDto {
  month: string; // YYYY-MM
  submittedRequests: number;
  approvedRequests: number;
  approvedUnits: number;
  pendingUnits: number;
}
export interface LeaveReportDepartmentRowDto {
  departmentId: string | null;
  departmentName: string;
  submittedRequests: number;
  approvedRequests: number;
  approvedUnits: number;
  pendingUnits: number;
}
export interface LeaveReportAgingBucketDto {
  bucket: '0-2' | '3-7' | '8+';
  label: string;
  count: number;
}
export interface LeaveReportOverviewDto {
  period: { from: string; to: string; attribution: typeof LEAVE_REPORT_ATTRIBUTION };
  summary: LeaveReportSummaryDto;
  byLeaveType: LeaveReportTypeRowDto[];
  trend: LeaveReportTrendPointDto[];
  byDepartment: LeaveReportDepartmentRowDto[];
  pendingAging: LeaveReportAgingBucketDto[];
}

/** Filter options for the reports screen, derived from what the caller can already see (no org-admin permission needed). */
export interface LeaveReportOptionsDto {
  leaveTypes: { id: string; code: string; name: string }[];
  organizations: { id: string; name: string }[];
  departments: { id: string; name: string }[];
}
