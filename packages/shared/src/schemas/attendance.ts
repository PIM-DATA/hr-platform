import { z } from 'zod';
import {
  ATTENDANCE_CORRECTION_STATUSES, ATTENDANCE_DAY_TYPES, ATTENDANCE_STATUSES, CLOCK_SOURCES,
} from '../enums';
import { isBusinessDate, WEEKDAYS } from '../business-date';
import { isClockTime } from '../attendance';
import { paginationQuerySchema } from './common';

/**
 * Attendance contracts (Task 20). Shared by the API and the UI so a rule exists once: shift times are `HH:mm` wall
 * clock in the organization's timezone, business dates are `YYYY-MM-DD`, and every instant on the wire is an ISO
 * UTC timestamp.
 */
const businessDate = z.string().refine(isBusinessDate, 'Use a real date in YYYY-MM-DD format');
const clockTime = z.string().refine(isClockTime, 'Use a 24-hour time in HH:mm format');
const codeField = z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore').transform((v) => v.toUpperCase());

// ---------- shifts ----------
export const createShiftSchema = z.object({
  organizationId: z.string().min(1),
  code: codeField,
  name: z.string().trim().min(1).max(100),
  startTime: clockTime,
  endTime: clockTime,
  /** Unpaid break inside the shift. Subtracted from worked time; halved for a half-day. */
  breakMinutes: z.number().int().min(0).max(480).default(0),
  lateGraceMinutes: z.number().int().min(0).max(240).default(0),
  earlyLeaveGraceMinutes: z.number().int().min(0).max(240).default(0),
})
  .refine((v) => v.startTime !== v.endTime, { message: 'A shift cannot start and end at the same time', path: ['endTime'] });
export type CreateShiftInput = z.infer<typeof createShiftSchema>;

export const updateShiftSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  startTime: clockTime.optional(),
  endTime: clockTime.optional(),
  breakMinutes: z.number().int().min(0).max(480).optional(),
  lateGraceMinutes: z.number().int().min(0).max(240).optional(),
  earlyLeaveGraceMinutes: z.number().int().min(0).max(240).optional(),
  isActive: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;

export const shiftListQuerySchema = paginationQuerySchema.extend({
  organizationId: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;

export interface ShiftDto {
  id: string;
  organization: { id: string; code: string; name: string } | null;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  /** Derived from the times, never supplied: an end at or before the start means the shift runs into the next day. */
  isOvernight: boolean;
  /** Paid time the shift asks for (span minus break), in minutes. */
  requiredMinutes: number;
  isActive: boolean;
}

// ---------- schedules ----------
export const assignScheduleSchema = z.object({
  employeeIds: z.array(z.string().min(1)).min(1, 'Choose at least one employee').max(200),
  from: businessDate,
  to: businessDate,
  /** null = the day is off (or a holiday, which the calendar decides). */
  shiftId: z.string().min(1).nullable(),
  /** Which weekdays inside the range the assignment applies to. Defaults to the calendar's working days. */
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
  /** Holidays stay holidays unless the operator deliberately schedules work on them. */
  includeHolidays: z.boolean().default(false),
  /** Replace rows that already exist in the range (otherwise existing rows are left alone). */
  overwriteExisting: z.boolean().default(true),
}).refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] });
export type AssignScheduleInput = z.infer<typeof assignScheduleSchema>;

export const scheduleListQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
  departmentId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(25),
}).refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] });
export type ScheduleListQuery = z.infer<typeof scheduleListQuerySchema>;

export interface ScheduleCellDto {
  date: string;
  dayType: (typeof ATTENDANCE_DAY_TYPES)[number];
  shift: { id: string; code: string; startTime: string; endTime: string } | null;
  source: string;
}
export interface ScheduleRowDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  days: ScheduleCellDto[];
}

// ---------- clocking ----------
export const clockSchema = z.object({
  /** Optional free-text note kept with the event (e.g. "worked from the client site"). Never a location. */
  note: z.string().trim().max(200).optional(),
});
export type ClockInput = z.infer<typeof clockSchema>;

export interface ClockEventDto {
  id: string;
  eventType: string;
  occurredAt: string;
  attendanceDate: string;
  source: (typeof CLOCK_SOURCES)[number];
  note: string | null;
}

/** What the clock screen needs to render itself: today's schedule, what has been clocked, and what is allowed next. */
export interface ClockStatusDto {
  attendanceDate: string;
  timezone: string;
  serverTime: string;
  shift: { id: string; code: string; name: string; startTime: string; endTime: string; isOvernight: boolean } | null;
  dayType: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstClockIn: string | null;
  lastClockOut: string | null;
  canClockIn: boolean;
  canClockOut: boolean;
  status: (typeof ATTENDANCE_STATUSES)[number];
  workMinutes: number;
  events: ClockEventDto[];
}

// ---------- records ----------
export const attendanceListQuerySchema = paginationQuerySchema.extend({
  from: businessDate.optional(),
  to: businessDate.optional(),
  date: businessDate.optional(),
  employeeId: z.string().min(1).optional(),
  departmentId: z.string().min(1).optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
});
export type AttendanceListQuery = z.infer<typeof attendanceListQuerySchema>;

export const myAttendanceQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
}).refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] });
export type MyAttendanceQuery = z.infer<typeof myAttendanceQuerySchema>;

export interface AttendanceRecordDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  attendanceDate: string;
  dayType: string;
  shift: { id: string; code: string; name: string; startTime: string; endTime: string; isOvernight: boolean } | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  firstClockIn: string | null;
  lastClockOut: string | null;
  workMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  /** Worked beyond the shift. Informational only — there is no overtime calculation in this release. */
  extraMinutes: number;
  leaveUnits: number;
  status: (typeof ATTENDANCE_STATUSES)[number];
  /** Set when an approved correction supplied one or both times. */
  correctionId: string | null;
  calculatedAt: string;
}

export interface AttendanceDailySummaryDto {
  date: string;
  scheduled: number;
  normal: number;
  late: number;
  earlyLeave: number;
  absent: number;
  onLeave: number;
  incomplete: number;
  notClockedYet: number;
  notScheduled: number;
}

// ---------- corrections ----------
export const createCorrectionSchema = z.object({
  attendanceDate: businessDate,
  /** Wall-clock times on the attendance date, in the organization's timezone. At least one is required. */
  requestedClockIn: clockTime.nullable().optional(),
  requestedClockOut: clockTime.nullable().optional(),
  reason: z.string().trim().min(5, 'Say what happened — the approver needs it').max(500),
}).refine((v) => !!v.requestedClockIn || !!v.requestedClockOut, {
  message: 'Give the clock-in time, the clock-out time, or both',
  path: ['requestedClockIn'],
});
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>;

export const correctionListQuerySchema = paginationQuerySchema.omit({ search: true }).extend({
  status: z.enum(ATTENDANCE_CORRECTION_STATUSES).optional(),
  employeeId: z.string().min(1).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  /** `mine` = requests I raised; `inbox` = requests waiting for me to decide. */
  view: z.enum(['mine', 'inbox', 'all']).default('mine'),
});
export type CorrectionListQuery = z.infer<typeof correctionListQuerySchema>;

export interface CorrectionDto {
  id: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string };
  attendanceDate: string;
  requestedClockIn: string | null;
  requestedClockOut: string | null;
  reason: string;
  status: (typeof ATTENDANCE_CORRECTION_STATUSES)[number];
  workflowInstanceId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  createdBy: { id: string; email: string } | null;
  /** The attendance as it stands now, so an approver can see what they are changing. */
  current: { firstClockIn: string | null; lastClockOut: string | null; status: string } | null;
}

// ---------- reporting ----------
export const attendanceReportQuerySchema = z.object({
  from: businessDate,
  to: businessDate,
  departmentId: z.string().min(1).optional(),
  employeeId: z.string().min(1).optional(),
}).refine((v) => v.from <= v.to, { message: 'The end date cannot be before the start date', path: ['to'] });
export type AttendanceReportQuery = z.infer<typeof attendanceReportQuerySchema>;

export interface AttendanceReportRowDto {
  employee: { id: string; employeeCode: string; firstName: string; lastName: string; department: { id: string; name: string } | null };
  scheduledDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  leaveDays: number;
  incompleteDays: number;
  workMinutes: number;
  lateMinutes: number;
}

export interface AttendanceReportDto {
  from: string;
  to: string;
  rows: AttendanceReportRowDto[];
  totals: Omit<AttendanceReportRowDto, 'employee'>;
}
