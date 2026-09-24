import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useMyDocuments } from './documents.api';
import { DownloadLinks, ExpiryBadge, formatBytes } from './documents-ui';

/** The employee's own documents — only those filed against them and classified so they may see them. Nobody else's. */
export function MyDocumentsPage() {
  const docs = useMyDocuments();
  if (docs.isLoading) return <LoadingBlock />;
  if (docs.isError) return <Alert>Could not load your documents.</Alert>;
  return (
    <Card>
      <CardHeader title="My documents" description="Documents HR has filed against your record. Download opens the current version; earlier versions are kept by HR." />
      {docs.data!.length === 0 ? <EmptyState title="No documents" description="Documents HR issues to you — contracts, letters, certificates — appear here." /> : (
        <ul className="divide-y divide-slate-100">
          {docs.data!.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div><div className="font-medium text-slate-900">{d.title}</div><div className="text-xs text-slate-500">{d.category.name} · {d.documentNumber}{d.issuedDate && ` · issued ${d.issuedDate}`}{d.currentVersion && ` · v${d.currentVersion.versionNumber} · ${formatBytes(d.currentVersion.fileSize)}`}</div></div>
              <div className="flex items-center gap-3"><ExpiryBadge state={d.expiryState} date={d.expiryDate} />{d.currentVersion && d.can.download && <DownloadLinks documentId={d.id} version={d.currentVersion} />}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
