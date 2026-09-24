import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/Card';
import { Alert } from '@/components/ui/Alert';
import { LoadingBlock } from '@/components/ui/Spinner';
import { useRecruitmentDashboard } from './recruitment.api';
import { Funnel, Stat } from './recruitment-ui';

/** Where hiring stands, for the people involved in it. Scoped by the server: a hiring manager sees their own openings. */
export function RecruitmentDashboardPage() {
  const dash = useRecruitmentDashboard();
  const d = dash.data;
  return (
    <div className="space-y-4">
      {dash.isLoading && <LoadingBlock />}
      {dash.isError && <Alert>Could not load the recruitment dashboard.</Alert>}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Link to="/hrm/recruitment/requisitions"><Stat label="Requisitions in flight" value={d.openRequisitions} /></Link>
            <Link to="/hrm/recruitment/openings?status=OPEN"><Stat label="Open openings" value={d.openOpenings} /></Link>
            <Link to="/hrm/recruitment/applications?active=true"><Stat label="Active applications" value={d.activeApplications} /></Link>
            <Link to="/hrm/recruitment/interviews"><Stat label="Upcoming interviews" value={d.interviewsScheduled} /></Link>
            <Link to="/hrm/recruitment/offers"><Stat label="Offers in progress" value={d.offersPending} /></Link>
            <Stat label="Hires" value={d.hires} />
          </div>
          <Card>
            <CardHeader title="Pipeline" description="Applications by stage. A count of where people are — not a ranking of who is ahead." />
            <div className="p-4"><Funnel funnel={d.funnel} /></div>
          </Card>
        </>
      )}
    </div>
  );
}
