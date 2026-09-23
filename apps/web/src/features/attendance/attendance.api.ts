import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignScheduleInput, AttendanceDailySummaryDto, AttendanceRecordDto, AttendanceReportDto, ClockEventDto,
  ClockStatusDto, CorrectionDto, CreateCorrectionInput, CreateShiftInput, ScheduleRowDto, ShiftDto, UpdateShiftInput,
} from '@hr/shared';
import { api } from '@/lib/api-client';

const KEY = 'attendance';
export const attendanceKeys = {
  clockStatus: [KEY, 'clock-status'] as const,
  me: (from: string, to: string) => [KEY, 'me', from, to] as const,
  records: (f: Record<string, unknown>) => [KEY, 'records', f] as const,
  summary: (date: string, departmentId?: string) => [KEY, 'summary', date, departmentId ?? ''] as const,
  schedules: (f: Record<string, unknown>) => [KEY, 'schedules', f] as const,
  shifts: (f: Record<string, unknown>) => [KEY, 'shifts', f] as const,
  shiftOptions: (organizationId?: string) => [KEY, 'shift-options', organizationId ?? ''] as const,
  corrections: (f: Record<string, unknown>) => [KEY, 'corrections', f] as const,
  correction: (id: string) => [KEY, 'correction', id] as const,
  today: [KEY, 'today'] as const,
};

const qs = (f: Record<string, unknown>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
  return params.toString();
};

// ---------- self service ----------
export const useClockStatus = () =>
  useQuery({ queryKey: attendanceKeys.clockStatus, queryFn: () => api.get<ClockStatusDto>('/attendance/clock/status').then((r) => r.data), refetchInterval: 60_000 });

export const useToday = () => useQuery({ queryKey: attendanceKeys.today, queryFn: () => api.get<{ date: string; timezone: string }>('/attendance/today').then((r) => r.data) });

export const useMyAttendance = (from: string, to: string) =>
  useQuery({ queryKey: attendanceKeys.me(from, to), queryFn: () => api.get<AttendanceRecordDto[]>(`/attendance/me?from=${from}&to=${to}`).then((r) => r.data), enabled: !!from && !!to });

export function useClockMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    clockIn: useMutation({ mutationFn: (note?: string) => api.post<ClockEventDto>('/attendance/clock-in', { note }).then((r) => r.data), onSuccess: invalidate }),
    clockOut: useMutation({ mutationFn: (note?: string) => api.post<ClockEventDto>('/attendance/clock-out', { note }).then((r) => r.data), onSuccess: invalidate }),
  };
}

// ---------- team / administration ----------
export const useAttendanceRecords = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: attendanceKeys.records(f), queryFn: () => api.get<AttendanceRecordDto[]>(`/attendance/records?${qs(f)}`), enabled, placeholderData: (p) => p });

export const useDailySummary = (date: string, departmentId?: string) =>
  useQuery({ queryKey: attendanceKeys.summary(date, departmentId), queryFn: () => api.get<AttendanceDailySummaryDto>(`/attendance/summary?${qs({ date, departmentId })}`).then((r) => r.data), enabled: !!date });

export const useAttendanceReport = (f: { from: string; to: string; departmentId?: string; employeeId?: string }, enabled = true) =>
  useQuery({ queryKey: [KEY, 'report', f], queryFn: () => api.get<AttendanceReportDto>(`/attendance/reports/overview?${qs(f)}`).then((r) => r.data), enabled });

export const useScheduleGrid = (f: Record<string, unknown>, enabled = true) =>
  useQuery({ queryKey: attendanceKeys.schedules(f), queryFn: () => api.get<ScheduleRowDto[]>(`/attendance/schedules?${qs(f)}`), enabled, placeholderData: (p) => p });

export const useShifts = (f: Record<string, unknown>) =>
  useQuery({ queryKey: attendanceKeys.shifts(f), queryFn: () => api.get<ShiftDto[]>(`/attendance/shifts?${qs(f)}`), placeholderData: (p) => p });

export const useShiftOptions = (organizationId?: string) =>
  useQuery({ queryKey: attendanceKeys.shiftOptions(organizationId), queryFn: () => api.get<ShiftDto[]>(`/attendance/shift-options?${qs({ organizationId })}`).then((r) => r.data) });

export function useAttendanceMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [KEY] });
  return {
    createShift: useMutation({ mutationFn: (input: CreateShiftInput) => api.post<ShiftDto>('/attendance/shifts', input).then((r) => r.data), onSuccess: invalidate }),
    updateShift: useMutation({ mutationFn: ({ id, input }: { id: string; input: UpdateShiftInput }) => api.patch<ShiftDto>(`/attendance/shifts/${id}`, input).then((r) => r.data), onSuccess: invalidate }),
    assignSchedule: useMutation({
      mutationFn: (input: AssignScheduleInput) => api.post<{ created: number; updated: number; skipped: number; days: number; employees: number }>('/attendance/schedules/assign', input).then((r) => r.data),
      onSuccess: invalidate,
    }),
    recalculate: useMutation({
      mutationFn: (input: { from: string; to: string; departmentId?: string; employeeId?: string }) =>
        api.post<{ employees: number; records: number }>('/attendance/recalculate', input).then((r) => r.data),
      onSuccess: invalidate,
    }),
  };
}

// ---------- corrections ----------
export const useCorrections = (f: Record<string, unknown>) =>
  useQuery({ queryKey: attendanceKeys.corrections(f), queryFn: () => api.get<CorrectionDto[]>(`/attendance/corrections?${qs(f)}`), placeholderData: (p) => p });

export const useCorrection = (id: string | null) =>
  useQuery({ queryKey: attendanceKeys.correction(id ?? ''), queryFn: () => api.get<CorrectionDto>(`/attendance/corrections/${id}`).then((r) => r.data), enabled: !!id });

export function useCorrectionMutations() {
  const qc = useQueryClient();
  // A decision changes the day, the inbox and the notification bell.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['workflow'] });
  };
  return {
    submit: useMutation({ mutationFn: (input: CreateCorrectionInput) => api.post<CorrectionDto>('/attendance/corrections', input).then((r) => r.data), onSuccess: invalidate }),
    cancel: useMutation({ mutationFn: (id: string) => api.post<CorrectionDto>(`/attendance/corrections/${id}/cancel`).then((r) => r.data), onSuccess: invalidate }),
    /** Approve and reject go through the shared workflow endpoint — attendance has no approval mutation of its own. */
    decide: useMutation({
      mutationFn: ({ instanceId, action, comment }: { instanceId: string; action: 'APPROVE' | 'REJECT'; comment?: string }) =>
        api.post(`/workflow/instances/${instanceId}/actions`, { action, comment }),
      onSuccess: invalidate,
    }),
  };
}
