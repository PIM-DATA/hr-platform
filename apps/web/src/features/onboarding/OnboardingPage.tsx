import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import type { OnboardingImportRunDto, OnboardingIssue, OnboardingPreviewDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/Toast';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ApiUploadError, downloadTemplate, useImportHistory, useOnboardingMutations } from './onboarding.api';

const errorMessage = (err: unknown, fallback = 'Something went wrong. Please try again.') =>
  err instanceof ApiUploadError ? (err.status >= 500 ? fallback : err.error.message) : fallback;

/** A cell that starts with =, +, - or @ is treated as a formula by spreadsheet apps — prefix it so it stays text. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const escaped = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${escaped.replace(/"/g, '""')}"`;
}
function downloadErrorCsv(issues: OnboardingIssue[], fileName: string) {
  const rows = [['Sheet', 'Row', 'Field', 'Error code', 'Message'], ...issues.map((i) => [i.sheet, String(i.row), i.field ?? '', i.code, i.message])];
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/\.xlsx$/i, '') + '-errors.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Customer onboarding: download a template, fill it in, preview it, then import.
 *
 * The workbook is never stored anywhere — the browser keeps the selected File only for this visit, and commit
 * re-uploads it so the server can prove (by hash) that it is importing exactly what was previewed. Reloading the page
 * therefore means previewing again, which is the price of not keeping a copy of everyone's personal data around.
 */
export function OnboardingPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OnboardingPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetFilter, setSheetFilter] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [lastRun, setLastRun] = useState<OnboardingImportRunDto | null>(null);
  const [page, setPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const m = useOnboardingMutations();
  const history = useImportHistory({ page, pageSize: 10 });

  const choose = (next: File | null) => {
    // A new file invalidates the previous preview immediately — commit must never use a stale hash.
    setFile(next);
    setPreview(null);
    setError(null);
    setSheetFilter('');
  };
  const runPreview = async () => {
    if (!file) return;
    setError(null);
    try { setPreview(await m.preview.mutateAsync(file)); }
    catch (e) { setPreview(null); setError(errorMessage(e, 'The workbook could not be read.')); }
  };
  const runCommit = async () => {
    if (!file || !preview) return;
    setError(null);
    try {
      const run = await m.commit.mutateAsync({ file, expectedSha256: preview.file.sha256 });
      setLastRun(run);
      toast.success(run.replayed ? 'This workbook was already imported' : 'Import complete', `${run.counts.employees} employees · ${run.counts.positions} positions · ${run.counts.departments} departments`);
      setConfirming(false);
      choose(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      setConfirming(false);
      setError(errorMessage(e, 'The import could not be completed and nothing was created.'));
      setPreview(null); // force a fresh preview: the database may have changed
    }
  };

  const issues = preview ? [...preview.errors, ...preview.warnings] : [];
  const visibleIssues = sheetFilter ? issues.filter((i) => i.sheet === sheetFilter) : issues;
  const sheets = [...new Set(issues.map((i) => i.sheet))];
  const busy = m.preview.isPending || m.commit.isPending;

  const issueColumns: Column<OnboardingIssue & { kind: 'error' | 'warning' }>[] = [
    { key: 'sheet', header: 'Sheet', render: (i) => i.sheet },
    { key: 'row', header: 'Row', className: 'text-right', render: (i) => <span className="tabular-nums">{i.row || '—'}</span> },
    { key: 'field', header: 'Field', hideBelow: 'sm', render: (i) => <span className="font-mono text-xs">{i.field ?? '—'}</span> },
    { key: 'message', header: 'Problem', render: (i) => (
      <div>
        <div className={cn('text-sm', i.kind === 'error' ? 'text-slate-900' : 'text-amber-700')}>{i.message}</div>
        <div className="font-mono text-[11px] text-slate-400">{i.code}</div>
      </div>
    ) },
  ];

  const historyColumns: Column<OnboardingImportRunDto>[] = [
    { key: 'when', header: 'Imported', render: (r) => formatDateTime(r.createdAt) },
    { key: 'file', header: 'File', render: (r) => <span className="font-mono text-xs">{r.fileName}</span> },
    { key: 'employees', header: 'Employees', className: 'text-right', render: (r) => <span className="tabular-nums">{r.counts.employees}</span> },
    { key: 'structure', header: 'Structure', hideBelow: 'md', render: (r) => <span className="text-slate-600">{r.counts.organizations} org · {r.counts.departments} dept · {r.counts.jobs} jobs · {r.counts.positions} pos</span> },
    { key: 'by', header: 'By', hideBelow: 'lg', render: (r) => <span className="text-slate-500">{r.createdBy?.email ?? '—'}</span> },
  ];

  return (
    <>
      <PageHeader title="Data import" description="Customer onboarding: create a new customer's organization structure and employees from one Excel workbook. Onboarding checklists for individual new joiners live under Employee lifecycle." />

      <div className="space-y-5">
        <Card className="p-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">1. Start from the template</h2>
              <p className="mt-1 max-w-xl text-sm text-slate-500">
                The workbook has one sheet per record type: organizations, departments, jobs, positions and employees.
                Codes may reference rows further down the same workbook. Importing employees does not create login accounts.
              </p>
            </div>
            <Button variant="secondary" onClick={() => downloadTemplate().catch(() => setError('Could not download the template.'))}>
              <Download className="h-4 w-4" /> Download template
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-slate-900">2. Upload and preview</h2>
          <p className="mt-1 text-sm text-slate-500">Preview validates the whole workbook and saves nothing.</p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex-1">
              <span className="sr-only">Workbook file</span>
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
            </label>
            <Button onClick={runPreview} loading={m.preview.isPending} disabled={!file || busy}>
              <Upload className="h-4 w-4" /> Preview
            </Button>
          </div>
          {file && !preview && !m.preview.isPending && <p className="mt-2 text-xs text-slate-500">Selected: {file.name} — preview it before importing.</p>}
          {error && <Alert className="mt-3">{error}</Alert>}
        </Card>

        {preview && (
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">3. Review</h2>
              <span className="font-mono text-[11px] text-slate-400">{preview.file.name} · template v{preview.file.templateVersion}</span>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {([['Organizations', preview.summary.organizations], ['Departments', preview.summary.departments], ['Jobs', preview.summary.jobs], ['Positions', preview.summary.positions], ['Employees', preview.summary.employees]] as const).map(([label, value]) => (
                <div key={label} className="rounded-md border border-slate-200 p-3 text-center">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
                </div>
              ))}
            </dl>

            <div className={cn('mt-4 flex flex-wrap items-center gap-3 rounded-md p-3', preview.valid ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800')}>
              {preview.valid ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
              <span className="text-sm font-medium">
                {preview.valid ? 'Ready to import' : `${preview.errors.length} error${preview.errors.length === 1 ? '' : 's'} found — nothing will be imported until they are fixed`}
              </span>
              {preview.warnings.length > 0 && <span className="text-xs">{preview.warnings.length} warning(s)</span>}
              <span className="ml-auto flex gap-2">
                {issues.length > 0 && <Button size="sm" variant="secondary" onClick={() => downloadErrorCsv(issues, preview.file.name)}>Download error CSV</Button>}
                <Button size="sm" disabled={!preview.valid || busy} onClick={() => setConfirming(true)}>Import</Button>
              </span>
            </div>

            {issues.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 flex items-center gap-3">
                  <Select aria-label="Filter by sheet" className="w-52" placeholder="All sheets" value={sheetFilter} onChange={(e) => setSheetFilter(e.target.value)}
                    options={sheets.map((s) => ({ value: s, label: s }))} />
                  <span className="text-xs text-slate-500">{visibleIssues.length} of {issues.length} shown</span>
                </div>
                <DataTable
                  columns={issueColumns}
                  rows={visibleIssues.map((i) => ({ ...i, kind: preview.errors.includes(i) ? ('error' as const) : ('warning' as const) }))}
                  rowKey={(i) => `${i.sheet}-${i.row}-${i.field ?? ''}-${i.code}`}
                  emptyTitle="No issues on this sheet"
                />
              </div>
            )}
          </Card>
        )}

        {lastRun && (
          <Alert>
            Imported {lastRun.counts.organizations} organization(s), {lastRun.counts.departments} department(s), {lastRun.counts.jobs} job(s), {lastRun.counts.positions} position(s) and {lastRun.counts.employees} employee(s)
            {lastRun.replayed ? ' — this workbook had already been imported, so nothing was created again.' : '.'} Import {lastRun.id} · {formatDateTime(lastRun.createdAt)}
          </Alert>
        )}

        <Card>
          <div className="border-b border-slate-200 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Recent imports</h2>
            <p className="mt-1 text-xs text-slate-500">Metadata only — the uploaded workbook itself is never stored. Imports cannot be undone.</p>
          </div>
          {history.isError && <Alert className="m-4">Could not load the import history.</Alert>}
          {(history.data?.data.length ?? 0) === 0 && !history.isLoading ? (
            <EmptyState icon={<FileSpreadsheet className="h-6 w-6" />} title="No imports yet" description="Imported workbooks will be listed here." />
          ) : (
            <>
              <DataTable columns={historyColumns} rows={history.data?.data ?? []} rowKey={(r) => r.id} loading={history.isLoading} emptyTitle="No imports yet" />
              {history.data?.meta && <Pagination {...history.data.meta} onPageChange={setPage} />}
            </>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Import this workbook?"
        message={preview
          ? `This creates ${preview.summary.organizations} organization(s), ${preview.summary.departments} department(s), ${preview.summary.jobs} job(s), ${preview.summary.positions} position(s) and ${preview.summary.employees} employee(s). The import is all-or-nothing and cannot be undone. No login accounts are created.`
          : ''}
        confirmLabel="Import"
        loading={m.commit.isPending}
        onConfirm={runCommit}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
