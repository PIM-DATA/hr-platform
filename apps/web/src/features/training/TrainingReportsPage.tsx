import { useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { Select } from '@/components/ui/Select';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useDepartmentOptions } from '@/features/organization/organization.api';
import { useCourses, useTrainingReport } from './training.api';
import { deliveryLabel } from './training-ui';

/**
 * Training reporting. Two definitions the numbers rest on are stated on screen: a completion rate excludes cancelled
 * and still-enrolled places, and training hours count attended or completed places only. Nothing here reports that a
 * skill improved — nobody was reassessed, so there is no evidence for it.
 */
export function TrainingReportsPage() {
  const departments = useDepartmentOptions();
  const courses = useCourses({ pageSize: 100 });
  const [departmentId, setDepartmentId] = useState('');
  const [courseId, setCourseId] = useState('');
  const report = useTrainingReport({ departmentId, courseId });
  const r = report.data;

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Select label="Department" options={(departments.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} />
          <Select label="Course" options={(courses.data?.data ?? []).map((c) => ({ value: c.id, label: c.title }))} placeholder="All courses" value={courseId} onChange={(e) => setCourseId(e.target.value)} />
        </div>
      </Card>
      {report.isLoading && <LoadingBlock />}
      {report.isError && <Alert>Could not load the report.</Alert>}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Figure label="Enrolments" value={r.enrollments.total} />
            <Figure label="Completion rate" value={r.completionRate === null ? '—' : `${r.completionRate}%`} hint="completed ÷ (completed + failed + no-show)" />
            <Figure label="No-shows" value={r.enrollments.noShow} />
            <Figure label="Training hours" value={r.trainingHours} hint="attended or completed places only" />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Breakdown title="By department" rows={r.byDepartment.map((d) => ({ label: d.departmentName, cells: [`${d.enrollments} enrolled`, `${d.completed} completed`, `${d.noShow} no-show`, `${d.hours} h`] }))} />
            <Breakdown title="By delivery method" rows={r.byDeliveryMethod.map((d) => ({ label: deliveryLabel(d.deliveryMethod), cells: [`${d.enrollments} enrolled`, `${d.completed} completed`, `${d.hours} h`] }))} />
          </div>
          <Card>
            <CardHeader title="By course" description="Which competencies each course is relevant to. Relevance is not evidence of a change in anybody's level." />
            <ul className="divide-y divide-slate-100 px-5 py-2">
              {r.byCourse.length === 0 && <li className="py-2 text-sm text-slate-400">Nothing to show yet.</li>}
              {r.byCourse.map((c) => (
                <li key={c.courseId} className="flex items-center justify-between py-2 text-sm">
                  <span className="min-w-0"><span className="block text-slate-900">{c.courseTitle}</span><span className="block text-xs text-slate-400">{c.competencies.length ? `relevant to ${c.competencies.join(', ')}` : 'no competency mapped'}</span></span>
                  <span className="flex gap-4 text-slate-600"><span className="tabular-nums">{c.enrollments} enrolled</span><span className="tabular-nums">{c.completed} completed</span></span>
                </li>
              ))}
            </ul>
          </Card>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Development needs" />
              <ul className="divide-y divide-slate-100 px-5 py-2 text-sm">
                {[['Open', r.needs.open], ['Planned', r.needs.planned], ['In progress', r.needs.inProgress], ['Fulfilled', r.needs.fulfilled], ['Cancelled', r.needs.cancelled], ['From a competency gap', r.needs.fromGap], ['Raised by HR', r.needs.manual]].map(([label, value]) => (
                  <li key={label} className="flex justify-between py-2"><span className="text-slate-700">{label}</span><span className="tabular-nums text-slate-900">{value}</span></li>
                ))}
              </ul>
              {r.topNeedCompetencies.length > 0 && <div className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">Most needed: {r.topNeedCompetencies.map((t) => `${t.competencyName} (${t.needs})`).join(', ')}</div>}
            </Card>
            <Card>
              <CardHeader title="Development plans" />
              <ul className="divide-y divide-slate-100 px-5 py-2 text-sm">
                {[['Draft', r.idps.draft], ['Active', r.idps.active], ['Completed', r.idps.completed], ['Cancelled', r.idps.cancelled]].map(([label, value]) => (
                  <li key={label} className="flex justify-between py-2"><span className="text-slate-700">{label}</span><span className="tabular-nums text-slate-900">{value}</span></li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

const Figure = ({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{value}</div>
    {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
  </div>
);

const Breakdown = ({ title, rows }: { title: string; rows: { label: string; cells: string[] }[] }) => (
  <Card>
    <CardHeader title={title} />
    <ul className="divide-y divide-slate-100 px-5 py-2">
      {rows.length === 0 && <li className="py-2 text-sm text-slate-400">Nothing to show yet.</li>}
      {rows.map((row) => (
        <li key={row.label} className="flex items-center justify-between py-2 text-sm"><span className="text-slate-700">{row.label}</span><span className="flex gap-3 text-slate-600">{row.cells.map((c) => <span key={c} className="tabular-nums">{c}</span>)}</span></li>
      ))}
    </ul>
  </Card>
);
