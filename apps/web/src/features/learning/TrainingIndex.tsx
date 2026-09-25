import { Navigate } from 'react-router-dom';
import { PERMISSIONS } from '@hr/shared';
import { useAuth } from '@/hooks/useAuth';
import { MyDevelopmentPage } from '@/features/training/MyDevelopmentPage';

/** The training index is "My development" for anyone with a training record; someone who only holds the learning report permission (an executive) lands on the reports. */
export function TrainingIndex() {
  const { user, hasPermission } = useAuth();
  if (user?.employee && hasPermission(PERMISSIONS.TRAINING_VIEW)) return <MyDevelopmentPage />;
  if (hasPermission(PERMISSIONS.LEARNING_VIEW_REPORTS)) return <Navigate to="/hrd/training/learning-reports" replace />;
  if (hasPermission(PERMISSIONS.TRAINING_VIEW)) return <MyDevelopmentPage />;
  return <Navigate to="/hrd/training/ojt" replace />;
}
