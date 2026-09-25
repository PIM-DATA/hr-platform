import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, workflowMonitorQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { adminDiagnosticsService } from './diagnostics.service';
import { workflowMonitorService } from './workflow-monitor.service';

/**
 * Administration (Task 41). Two read-only surfaces: the workflow monitor, behind the workflow permission that
 * already exists, and the settings hub's operational facts. There is no `admin.manage_everything`: each area is
 * administered under the permission that already guards it, and the hub simply reports which ones this caller has.
 */
const P = PERMISSIONS;
export const adminRouter = Router();
adminRouter.use(requireAuth);

/** Any administrative permission opens the hub; the areas list itself says what this caller may do. */
const anyAdmin = requirePermission(P.USERS_VIEW, P.ROLES_VIEW, P.AUDIT_VIEW, P.WORKFLOW_MANAGE_DEFINITIONS, P.WORKFLOW_VIEW_ALL, P.SETTINGS_MANAGE, P.PAYROLL_MANAGE, P.ONBOARDING_MANAGE, P.PRIVACY_MANAGE_REQUESTS, P.PRIVACY_EXPORT_DATA, P.LEAVE_MANAGE_TYPES, P.LEAVE_MANAGE_POLICIES, P.LEAVE_MANAGE_ENTITLEMENTS);
const monitor = requirePermission(P.WORKFLOW_VIEW_ALL);

adminRouter.get('/settings/areas', anyAdmin, (_req, res: Response) => res.json({ data: adminDiagnosticsService.areas() }));
adminRouter.get('/diagnostics', anyAdmin, async (_req, res: Response) => res.json({ data: await adminDiagnosticsService.get() }));

adminRouter.get('/workflow-monitor', monitor, validate(workflowMonitorQuerySchema, 'query'), async (req: Request, res: Response) => res.json(await workflowMonitorService.list(req.auth!, res.locals.query)));
adminRouter.get('/workflow-monitor/summary', monitor, async (_req, res: Response) => res.json({ data: await workflowMonitorService.summary() }));
adminRouter.get('/workflow-monitor/:id', monitor, async (req: Request, res: Response) => res.json({ data: await workflowMonitorService.get(req.auth!, req.params.id as string) }));
