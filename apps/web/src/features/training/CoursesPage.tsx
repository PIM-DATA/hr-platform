import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { PERMISSIONS, TRAINING_DELIVERY_METHODS, type CourseDto } from '@hr/shared';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Alert } from '@/components/ui/Alert';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/SearchInput';
import { Checkbox } from '@/components/ui/Checkbox';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Pagination } from '@/components/ui/Pagination';
import { useToast } from '@/components/ui/Toast';
import { usePermission } from '@/hooks/usePermission';
import { useDebounce } from '@/hooks/useDebounce';
import { errorMessage } from '@/features/organization/shared';
import { useCompetencies } from '@/features/competency/competency.api';
import { useCourses, useTrainingMutations } from './training.api';
import { deliveryLabel, formatDuration } from './training-ui';

/** The course catalogue. A course says which competencies it is relevant to — a pointer for choosing, not a promise. */
export function CoursesPage() {
  const canManage = usePermission(PERMISSIONS.TRAINING_MANAGE);
  const [search, setSearch] = useState('');
  const [deliveryMethod, setDelivery] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CourseDto | null>(null);
  const courses = useCourses({ search: useDebounce(search), deliveryMethod, status, page, pageSize: 20 });

  const columns: Column<CourseDto>[] = [
    { key: 'title', header: 'Course', render: (c) => <div><div className="font-medium text-slate-900">{c.title}</div><div className="text-xs text-slate-400">{c.code}{c.category && ` · ${c.category}`}</div></div> },
    { key: 'delivery', header: 'Delivery', render: (c) => deliveryLabel(c.deliveryMethod) },
    { key: 'duration', header: 'Duration', hideBelow: 'sm', render: (c) => formatDuration(c.durationMinutes) },
    { key: 'provider', header: 'Provider', hideBelow: 'md', render: (c) => c.providerName ?? (c.providerType === 'INTERNAL' ? 'Internal' : <span className="text-slate-400">—</span>) },
    { key: 'competencies', header: 'Relevant to', hideBelow: 'lg', render: (c) => (c.competencies.length ? c.competencies.map((x) => x.name).join(', ') : <span className="text-slate-400">—</span>) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.isActive ? 'Active' : 'Inactive'} tone={c.isActive ? 'success' : 'neutral'} /> },
  ];

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 border-b border-slate-200 p-4 sm:grid-cols-4">
          <SearchInput placeholder="Search courses…" value={search} onChange={(v) => { setSearch(v); setPage(1); }} />
          <Select options={TRAINING_DELIVERY_METHODS.map((m) => ({ value: m, label: deliveryLabel(m) }))} placeholder="All delivery methods" value={deliveryMethod} onChange={(e) => { setDelivery(e.target.value); setPage(1); }} />
          <Select options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} placeholder="All statuses" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} />
          {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Course</Button></div>}
        </div>
        {courses.isError && <Alert className="m-4">Could not load the course catalogue.</Alert>}
        <DataTable columns={columns} rows={courses.data?.data ?? []} rowKey={(c) => c.id} loading={courses.isLoading} onRowClick={canManage ? (c) => setEditing(c) : undefined} emptyTitle="No courses yet" />
        {courses.data?.meta && <Pagination {...courses.data.meta} onPageChange={setPage} />}
      </Card>
      <CourseModal open={creating} course={null} onClose={() => setCreating(false)} />
      <CourseModal open={!!editing} course={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function CourseModal({ open, course, onClose }: { open: boolean; course: CourseDto | null; onClose: () => void }) {
  const m = useTrainingMutations();
  const toast = useToast();
  const competencies = useCompetencies({ status: 'active', pageSize: 100 });
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [deliveryMethod, setDelivery] = useState<(typeof TRAINING_DELIVERY_METHODS)[number]>('CLASSROOM');
  const [durationMinutes, setDuration] = useState('');
  const [providerName, setProvider] = useState('');
  const [providerType, setProviderType] = useState<'INTERNAL' | 'EXTERNAL'>('INTERNAL');
  const [competencyIds, setCompetencyIds] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setCode(course?.code ?? ''); setTitle(course?.title ?? ''); setDescription(course?.description ?? ''); setCategory(course?.category ?? '');
    setDelivery(course?.deliveryMethod ?? 'CLASSROOM'); setDuration(course?.durationMinutes ? String(course.durationMinutes) : '');
    setProvider(course?.providerName ?? ''); setProviderType(course?.providerType ?? 'INTERNAL');
    setCompetencyIds(course?.competencies.map((c) => c.id) ?? []); setIsActive(course?.isActive ?? true);
  }, [open, course]);

  const toggle = (id: string) => setCompetencyIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const submit = async () => {
    setErr(null);
    try {
      const common = { title, description: description || null, category: category || null, durationMinutes: durationMinutes ? Number(durationMinutes) : null, providerName: providerName || null, providerType, competencyIds };
      if (course) { await m.updateCourse.mutateAsync({ id: course.id, input: { ...common, isActive } }); toast.success('Course updated'); }
      else { await m.createCourse.mutateAsync({ code, deliveryMethod, ...common }); toast.success('Course added'); }
      onClose();
    } catch (e) { setErr(errorMessage(e)); }
  };

  return (
    <Modal open={open} onClose={onClose} title={course ? course.title : 'Add a course'} description="No content is hosted here — this records that a course exists and what it is relevant to." size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={m.createCourse.isPending || m.updateCourse.isPending} disabled={!title || (!course && !code)}>{course ? 'Save' : 'Add course'}</Button></>}>
      <div className="space-y-3">
        {err && <Alert>{err}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!!course} placeholder="SQL_ADV" />
          <Input label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Advanced SQL" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Select label="Delivery" options={TRAINING_DELIVERY_METHODS.map((x) => ({ value: x, label: deliveryLabel(x) }))} value={deliveryMethod} onChange={(e) => setDelivery(e.target.value as typeof deliveryMethod)} disabled={!!course} />
          <Input label="Duration (minutes)" inputMode="numeric" value={durationMinutes} onChange={(e) => setDuration(e.target.value)} hint="Training hours are counted from this." />
          <Input label="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Provider type" options={[{ value: 'INTERNAL', label: 'Internal' }, { value: 'EXTERNAL', label: 'External' }]} value={providerType} onChange={(e) => setProviderType(e.target.value as 'INTERNAL' | 'EXTERNAL')} />
          <Input label="Provider" value={providerName} onChange={(e) => setProvider(e.target.value)} placeholder="Optional" />
        </div>
        <Textarea label="Description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div>
          <div className="mb-1 text-sm font-medium text-slate-700">Relevant to developing</div>
          <p className="mb-2 text-xs text-slate-500">A pointer for whoever chooses a course. Finishing it does not change anybody's level; only an assessment does.</p>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {(competencies.data?.data ?? []).map((c) => <Checkbox key={c.id} label={c.name} checked={competencyIds.includes(c.id)} onChange={() => toggle(c.id)} />)}
          </div>
        </div>
        {course && <Select label="Status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive — no new sessions' }]} value={isActive ? 'active' : 'inactive'} onChange={(e) => setIsActive(e.target.value === 'active')} />}
      </div>
    </Modal>
  );
}
