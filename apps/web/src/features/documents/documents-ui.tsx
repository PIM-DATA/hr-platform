import { Outlet } from 'react-router-dom';
import { Download, Eye } from 'lucide-react';
import { PERMISSIONS, type DocumentVersionDto } from '@hr/shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Tabs } from '@/components/ui/Tabs';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/hooks/useAuth';
import { documentDownloadUrl } from './documents.api';

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
export const CLASSIFICATION_LABEL: Record<string, string> = { PUBLIC_INTERNAL: 'Internal', EMPLOYEE_PRIVATE: 'Employee private', HR_CONFIDENTIAL: 'HR confidential', RESTRICTED: 'Restricted' };
const CLASS_TONE: Record<string, Tone> = { PUBLIC_INTERNAL: 'neutral', EMPLOYEE_PRIVATE: 'info', HR_CONFIDENTIAL: 'warning', RESTRICTED: 'danger' };
export const ClassificationBadge = ({ value }: { value: string }) => <StatusBadge status={CLASSIFICATION_LABEL[value] ?? titleCase(value)} tone={CLASS_TONE[value] ?? 'neutral'} />;
const EXPIRY_TONE: Record<string, Tone> = { VALID: 'success', EXPIRING_SOON: 'warning', EXPIRED: 'danger', NONE: 'neutral' };
export const ExpiryBadge = ({ state, date }: { state: string; date: string | null }) => (state === 'NONE' ? <span className="text-slate-400">—</span> : <StatusBadge status={`${titleCase(state)}${date ? ` · ${date}` : ''}`} tone={EXPIRY_TONE[state] ?? 'neutral'} />);
export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104857.6) / 10} MB`);

/** Download (always an attachment) and, for PDF/images/text, an inline preview in a new tab. Both go through the authenticated endpoint. */
export function DownloadLinks({ documentId, version, size = 'text-xs' }: { documentId: string; version: DocumentVersionDto; size?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${size}`}>
      <a className="inline-flex items-center gap-1 text-brand-700 underline" href={documentDownloadUrl(documentId, version.id)} onClick={(e) => e.stopPropagation()}><Download className="h-3.5 w-3.5" /> Download</a>
      {version.inlinePreviewable && <a className="inline-flex items-center gap-1 text-brand-700 underline" href={documentDownloadUrl(documentId, version.id, true)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><Eye className="h-3.5 w-3.5" /> Preview</a>}
    </span>
  );
}

export function useDocumentTabs() {
  const { user, hasPermission } = useAuth();
  const manage = hasPermission(PERMISSIONS.DOCUMENTS_MANAGE);
  return [
    hasPermission(PERMISSIONS.DOCUMENTS_VIEW_OWN) && !!user?.employee && { label: 'My documents', to: '/hrm/documents', end: true },
    (hasPermission(PERMISSIONS.DOCUMENTS_VIEW) || manage) && { label: 'Document center', to: '/hrm/documents/center' },
    manage && { label: 'Categories', to: '/hrm/documents/categories' },
  ].filter(Boolean) as { label: string; to: string; end?: boolean }[];
}
export function DocumentsLayout() {
  const tabs = useDocumentTabs();
  return (
    <>
      <PageHeader title="Documents" description="Files kept against employees and records, with versions and an access rule per document. Files are not scanned for malware by this system." />
      {tabs.length > 1 && <div className="mb-5"><Tabs items={tabs} /></div>}
      <Outlet />
    </>
  );
}
