import { useState } from 'react';
import { Download } from 'lucide-react';
import type { PersonalDataExportDto, PrivacyEmployeeOptionDto } from '@hr/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { ApiClientError } from '@/lib/api-client';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PrivacyEmployeePicker } from './PrivacyEmployeePicker';
import { exportEmployeeData } from './privacy.api';

/**
 * Assembles one employee's data as a JSON file. The file goes straight to the operator's machine: the server keeps
 * no copy, and the browser is told not to cache it.
 */
export function DataExportPage() {
  const toast = useToast();
  const [employee, setEmployee] = useState<PrivacyEmployeeOptionDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<PersonalDataExportDto | null>(null);

  const onExport = async () => {
    if (!employee) return;
    setBusy(true);
    setError(null);
    try {
      const result = await exportEmployeeData(employee.id);
      setLast(result);
      toast.success('Export downloaded', `${result.subject.employeeCode} · generated ${formatDateTime(result.generatedAt)}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'The export could not be generated.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Export personal data" description="Everything this system holds about one person, as a JSON file." />
        <div className="space-y-4 p-5">
          {error && <Alert>{error}</Alert>}
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-slate-700">Employee</span>
            <PrivacyEmployeePicker value={employee} onChange={setEmployee} />
          </div>
          <Button onClick={onExport} disabled={!employee} loading={busy}><Download className="h-4 w-4" /> Generate export</Button>
          <p className="text-xs text-slate-500">
            The file contains personal data. Hand it over the way your policy requires, and delete your local copy when you are done.
            Every export is recorded in the audit trail — as an event with counts, never the data itself.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="What an export contains" description="A point-in-time snapshot, honest about its limits." />
        <div className="space-y-4 p-5 text-sm">
          {last ? (
            <>
              <p className="text-slate-700">
                Last export: <span className="font-medium">{last.subject.firstName} {last.subject.lastName} ({last.subject.employeeCode})</span> · {formatDateTime(last.generatedAt)}
              </p>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                {Object.entries(last.data)
                  .filter(([, value]) => Array.isArray(value))
                  .map(([key, value]) => (
                    <li key={key} className="flex justify-between gap-2">
                      <span className="capitalize">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                      <span className="font-medium text-slate-800">{formatNumber((value as unknown[]).length)}</span>
                    </li>
                  ))}
              </ul>
              <div>
                <div className="text-slate-500">Not included</div>
                <ul className="mt-1 space-y-1.5 text-xs text-slate-600">
                  {last.notIncluded.map((n) => (
                    <li key={n.category}><span className="font-medium text-slate-800 capitalize">{n.category}:</span> {n.reason}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="text-slate-600">
              Profile and account details, position and manager history, leave requests, entitlements and ledger entries, approval history and the person's own notifications.
              Credentials are never exported, and neither is another person's data — the generated file lists exactly what it leaves out and why.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
