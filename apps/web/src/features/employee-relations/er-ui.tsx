import { Outlet } from 'react-router-dom';
import { PERMISSIONS, type DisciplinaryValidityState, type WarningLetterDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

const CASE_LABEL: Record<string, string> = { DRAFT: 'Draft', UNDER_REVIEW: 'Under review', PENDING_APPROVAL: 'Awaiting approval', ACTION_ISSUED: 'Action issued', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
const CASE_TONE: Record<string, Tone> = { DRAFT: 'neutral', UNDER_REVIEW: 'info', PENDING_APPROVAL: 'warning', ACTION_ISSUED: 'success', CLOSED: 'neutral', CANCELLED: 'neutral' };
export const CaseStatusBadge = ({ status }: { status: string }) => <StatusBadge status={CASE_LABEL[status] ?? status} tone={CASE_TONE[status] ?? 'neutral'} />;

const ACTION_LABEL: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Awaiting approval', ISSUED: 'Issued', ACKNOWLEDGED: 'Acknowledged', REJECTED: 'Rejected', CANCELLED: 'Withdrawn' };
const ACTION_TONE: Record<string, Tone> = { DRAFT: 'neutral', PENDING_APPROVAL: 'warning', ISSUED: 'info', ACKNOWLEDGED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };
export const ActionStatusBadge = ({ status }: { status: string }) => <StatusBadge status={ACTION_LABEL[status] ?? status} tone={ACTION_TONE[status] ?? 'neutral'} />;

const VALIDITY_LABEL: Record<DisciplinaryValidityState, string> = { ACTIVE: 'Active', EXPIRED: 'Expired', NOT_APPLICABLE: '—' };
const VALIDITY_TONE: Record<DisciplinaryValidityState, Tone> = { ACTIVE: 'warning', EXPIRED: 'neutral', NOT_APPLICABLE: 'neutral' };
export const ValidityBadge = ({ validity }: { validity: DisciplinaryValidityState }) =>
  validity === 'NOT_APPLICABLE' ? null : <StatusBadge status={VALIDITY_LABEL[validity]} tone={VALIDITY_TONE[validity]} />;

/**
 * The issued letter, print-friendly. Every field is a frozen snapshot from the server; nothing here is editable and
 * nothing is interpreted. The acknowledgement statement is printed with it, because what acknowledging means is part
 * of the document.
 */
export function WarningLetterView({ letter, printId }: { letter: WarningLetterDto; printId?: string }) {
  return (
    <article id={printId} className="space-y-4 rounded-md border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-800">
      <header className="space-y-1 border-b border-slate-200 pb-3">
        <div className="text-xs text-slate-500">{letter.organization ?? ''} · {letter.letterNumber}</div>
        <h3 className="text-base font-semibold text-slate-900">{letter.subject}</h3>
        <div className="text-xs text-slate-500">
          To {letter.employeeName} ({letter.employeeCode}){letter.position && ` · ${letter.position}`}{letter.department && ` · ${letter.department}`}
        </div>
        <div className="text-xs text-slate-500">Issued {letter.issuedAt.slice(0, 10)} · incident {letter.incidentDate} · {letter.actionName}{letter.validUntil && ` · on record until ${letter.validUntil}`}</div>
      </header>
      <div className="whitespace-pre-wrap">{letter.body}</div>
      <footer className="border-t border-slate-200 pt-3 text-xs text-slate-500">{letter.acknowledgementText}</footer>
    </article>
  );
}

/** Tab visibility follows capability, never a role name. The API enforces the same rules. */
export function useErTabs() {
  const { user, hasPermission } = useAuth();
  const canView = hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_VIEW) || hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
  return [
    hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_ACKNOWLEDGE) && !!user?.employee && { label: 'My records', to: '/hrm/employee-relations', end: true },
    hasPermission(PERMISSIONS.WORKFLOW_APPROVE) && { label: 'Approvals', to: '/hrm/employee-relations/approvals' },
    canView && { label: 'Cases', to: '/hrm/employee-relations/cases' },
    canView && { label: 'Actions', to: '/hrm/employee-relations/actions' },
    hasPermission(PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE) && { label: 'Action types', to: '/hrm/employee-relations/action-types' },
    canView && { label: 'Reports', to: '/hrm/employee-relations/reports' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}

export function ErLayout() {
  const tabs = useErTabs();
  return (
    <>
      <PageHeader
        title="Employee relations"
        description="An operational record of what was reported, proposed, approved and received. The system chooses no action and draws no legal conclusion — those are decisions people make under the organization's own policy."
      />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
