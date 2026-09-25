import { useSearchParams } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { useAuth } from '@/hooks/useAuth';
import { TrainingReportsPage } from './TrainingReportsPage';
import { LearningReportsPage } from '@/features/learning/LearningReportsPage';

/**
 * One Reports tab for the whole Training & development module. Training reports (needs, sessions, completion —
 * Task 25) need `training.manage`; learning reports (OJT, paths, certifications — Task 35) need
 * `learning.view_reports` or a learning manage permission. Whoever holds only one sees only that view.
 */
export function TrainingReportsHubPage() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const training = hasPermission(PERMISSIONS.TRAINING_MANAGE);
  const learning = [PERMISSIONS.LEARNING_VIEW_REPORTS, PERMISSIONS.OJT_MANAGE, PERMISSIONS.LEARNING_PATH_MANAGE, PERMISSIONS.CERTIFICATION_MANAGE].some(hasPermission);
  const view = params.get('view') === 'learning' || !training ? 'learning' : 'training';
  return (
    <div className="space-y-4">
      {training && learning && (
        <div className="flex gap-2">{(['training', 'learning'] as const).map((v) => <button key={v} type="button" onClick={() => { const n = new URLSearchParams(params); n.set('view', v); setParams(n, { replace: true }); }} className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700'}`}>{v === 'training' ? 'Training' : 'OJT, paths & certifications'}</button>)}</div>
      )}
      {view === 'training' && training ? <TrainingReportsPage /> : learning ? <LearningReportsPage /> : null}
    </div>
  );
}
