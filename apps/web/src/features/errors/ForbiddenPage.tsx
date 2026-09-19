import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

export function ForbiddenPage() {
  return (
    <Card className="mt-6">
      <EmptyState
        icon={<ShieldOff className="h-6 w-6" />}
        title="403 — Access denied"
        description="You do not have permission to view this page. Contact your HR administrator if you believe this is a mistake."
        action={
          <Link to="/dashboard">
            <Button variant="secondary">Back to dashboard</Button>
          </Link>
        }
      />
    </Card>
  );
}
