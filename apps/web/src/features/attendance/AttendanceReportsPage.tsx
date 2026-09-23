import { useState } from 'react';
import { addDays } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useDepartments } from '@/features/organization/organization.api';
import { useAttendanceReport, useToday } from './attendance.api';
import { formatMinutes } from './attendance-ui';

type Row = NonNullable<ReturnType<typeof useAttendanceReport>['data']>['rows'][number];

/** A range, one row per employee: the counts HR asks for, aggregated by the database. */
export function AttendanceReportsPage() {
  const today = useToday();
  const defaultTo = today.data?.date ?? '';
  const defaultFrom = defaultTo ? addDays(defaultTo, -29) : '';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const departments = useDepartments({ page: 1, pageSize: 100 });

  const range = { from: from || defaultFrom, to: to || defaultTo, departmentId: departmentId || undefined };
  const report = useAttendanceReport(range, !!range.from && !!range.to);

  const columns: Column<Row>[] = [
    {
      key: 'employee',
      header: 'Employee',
      render: (r) => (
        <div>
          <div className="font-medium text-slate-900">{r.employee.firstName} {r.employee.lastName}</div>
          <div className="text-xs text-slate-500">{r.employee.employeeCode}{r.employee.department ? ` · ${r.employee.department.name}` : ''}</div>
        </div>
      ),
    },
    { key: 'scheduled', header: 'Scheduled', render: (r) => r.scheduledDays },
    { key: 'present', header: 'Present', render: (r) => r.presentDays },
    { key: 'late', header: 'Late', render: (r) => r.lateDays },
    { key: 'absent', header: 'Absent', render: (r) => r.absentDays },
    { key: 'leave', header: 'Leave', hideBelow: 'sm', render: (r) => r.leaveDays },
    { key: 'incomplete', header: 'Incomplete', hideBelow: 'lg', render: (r) => r.incompleteDays },
    { key: 'worked', header: 'Worked', render: (r) => formatMinutes(r.workMinutes) },
    { key: 'lateMinutes', header: 'Late time', hideBelow: 'lg', render: (r) => formatMinutes(r.lateMinutes) },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <input type="date" value={range.from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm" aria-label="From" />
          <span className="text-slate-400">→</span>
          <input type="date" value={range.to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm" aria-label="To" />
        </div>
        <Select
          options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          placeholder="All departments"
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="w-48"
        />
        {report.data && (
          <div className="text-sm text-slate-500 sm:ml-auto">
            Total worked <span className="font-medium text-slate-900">{formatMinutes(report.data.totals.workMinutes)}</span> ·
            absent <span className="font-medium text-slate-900">{report.data.totals.absentDays}</span> day(s)
          </div>
        )}
      </div>
      {report.isError && <Alert className="m-4">Could not load the report.</Alert>}
      <DataTable
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(r) => r.employee.id}
        loading={report.isLoading}
        emptyTitle="Nothing in this range"
        emptyDescription="Attendance appears once days are scheduled and calculated."
      />
    </Card>
  );
}
