import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Alert } from '@/components/ui/Alert';
import { useToast } from '@/components/ui/Toast';
import { ApiClientError } from '@/lib/api-client';
import { useCorrectionMutations } from './attendance.api';
import { formatBusinessDate } from './attendance-ui';

/**
 * "I forgot to clock out." The employee states the times that should have been recorded; an approver decides.
 * Times are wall clock in the organization's timezone — the server converts them, so the browser's timezone never
 * enters into it.
 */
export function CorrectionDialog({ date, timezone, onClose }: { date: string | null; timezone?: string; onClose: () => void }) {
  const { submit } = useCorrectionMutations();
  const toast = useToast();
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (date) {
      setClockIn('');
      setClockOut('');
      setReason('');
      setError(null);
    }
  }, [date]);

  const onSubmit = async () => {
    if (!date) return;
    setError(null);
    if (!clockIn && !clockOut) return setError('Give the clock-in time, the clock-out time, or both.');
    if (reason.trim().length < 5) return setError('Say what happened — the approver needs it.');
    try {
      await submit.mutateAsync({
        attendanceDate: date,
        requestedClockIn: clockIn || null,
        requestedClockOut: clockOut || null,
        reason: reason.trim(),
      });
      toast.success('Correction sent for approval');
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  return (
    <Modal
      open={!!date}
      onClose={onClose}
      title="Request a correction"
      description={date ? formatBusinessDate(date) : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onSubmit} loading={submit.isPending}>Send for approval</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Clock in" type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} hint={timezone} />
          <Input label="Clock out" type="time" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
        </div>
        <Textarea label="What happened" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. I left through the side door and forgot to clock out." />
        <p className="text-xs text-slate-500">
          Your original clock events are kept as they are. If this is approved, the day is recalculated using the times
          above, and both versions stay on the record.
        </p>
      </div>
    </Modal>
  );
}
