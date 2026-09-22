import { Router } from 'express';
import { PERMISSIONS } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { getDashboardSummary } from './dashboard.service';

/** Read-only; opening the dashboard is not audited (would only add noise). */
export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requirePermission(PERMISSIONS.DASHBOARD_VIEW));
dashboardRouter.get('/summary', async (req, res) => res.json({ data: await getDashboardSummary(req.auth!) }));
