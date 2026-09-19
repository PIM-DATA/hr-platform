import { Construction } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

interface ComingSoonPageProps {
  title: string;
  description?: string;
}

/** Placeholder for modules planned in later phases. */
export function ComingSoonPage({ title, description }: ComingSoonPageProps) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          icon={<Construction className="h-6 w-6" />}
          title="Coming soon"
          description={description ?? `${title} is planned for a later phase. The platform architecture already reserves a place for it.`}
        />
      </Card>
    </>
  );
}
