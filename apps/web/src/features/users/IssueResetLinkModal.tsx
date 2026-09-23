import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import type { PasswordResetIssuedDto, UserDto } from '@hr/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Alert } from '@/components/ui/Alert';
import { ApiClientError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useRecoveryMutations } from '@/features/account/account.api';

/**
 * Issues a one-time password reset link for another user.
 *
 * An administrator never sees or chooses anybody's password. What they get is a link, shown exactly once: it is held
 * in component state for as long as the dialog is open and is gone when it closes — nothing caches it, and the server
 * keeps only its hash.
 */
export function IssueResetLinkModal({ open, onClose, user }: { open: boolean; onClose: () => void; user: UserDto | null }) {
  const { issueResetLink } = useRecoveryMutations();
  const [issued, setIssued] = useState<PasswordResetIssuedDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setIssued(null); // the link is never kept after the dialog closes
      setError(null);
      setCopied(false);
    }
  }, [open]);

  const onGenerate = async () => {
    if (!user) return;
    setError(null);
    try {
      setIssued(await issueResetLink.mutateAsync(user.id));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.error.message : 'Something went wrong.');
    }
  };

  const onCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.resetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy automatically — select the link and copy it manually.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Password reset link"
      description={user?.email}
      footer={
        issued ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={onGenerate} loading={issueResetLink.isPending}><KeyRound className="h-4 w-4" /> Generate link</Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {issued ? (
          <>
            <div>
              <label htmlFor="reset-link" className="block text-sm font-medium text-slate-700">One-time link</label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="reset-link"
                  readOnly
                  value={issued.resetUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-9 w-full rounded-md border border-slate-300 bg-slate-50 px-3 font-mono text-xs text-slate-800 shadow-sm"
                />
                <Button variant="secondary" onClick={onCopy} aria-label="Copy link">
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
              <li>Valid until <span className="font-medium text-slate-700">{formatDateTime(issued.expiresAt)}</span>, and can be used only once.</li>
              <li>It is shown here once. Close this dialog and it is gone — generate a new link if it is lost.</li>
              <li>Hand it to {issued.user.email} through a channel you trust. Anyone holding the link can set that password.</li>
              <li>Using it signs the account out of every device.</li>
            </ul>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              This creates a single-use link that lets {user?.email} choose a new password themselves. Any link issued earlier stops working.
            </p>
            <p className="text-xs text-slate-500">
              The system does not send email, so you deliver the link yourself. Nobody — including administrators — can read or set another person's password.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
