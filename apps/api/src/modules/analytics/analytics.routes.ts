import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, analyticsFilterSchema, ANALYTICS_METRICS } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { logger } from '../../lib/logger';
import { employee360Service } from './employee360.service';
import { executiveAnalyticsService } from './executive-analytics.service';
import { executiveOverviewCsv } from './analytics.csv';

/**
 * Employee 360 and executive analytics (Task 29). Read-only: nothing here mutates a business record.
 *
 * `employee360.view` opens the page; every section is then decided by the source module's own permission and
 * scope, and an unauthorized section is absent. `analytics.view_executive` returns organization-level aggregates
 * only; payroll totals need `analytics.view_payroll_aggregate` on top.
 */
const log = logger.child({ module: 'analytics' });
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get('/employee-360/:employeeId', requirePermission(PERMISSIONS.EMPLOYEE360_VIEW), async (req, res) => {
  const started = Date.now();
  const result = await employee360Service.getOverview({ employeeId: req.params.employeeId as string, actor: actor(req) });
  // Route, actor, sections and duration — never the payload.
  log.info({ event: 'employee_360', actorUserId: req.auth!.userId, employeeId: req.params.employeeId, sections: result.visibleSections, durationMs: Date.now() - started }, 'employee 360');
  res.json({ data: result });
});

analyticsRouter.get('/metrics', requirePermission(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE), (_req, res) => res.json({ data: ANALYTICS_METRICS }));

analyticsRouter.get('/executive/overview', requirePermission(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE), validate(analyticsFilterSchema, 'query'), async (req, res: Response) => {
  const result = await executiveAnalyticsService.overview(req.auth!, res.locals.query);
  log.info({ event: 'executive_overview', actorUserId: req.auth!.userId, filters: { from: result.filters.from, to: result.filters.to, organizationId: result.filters.organizationId ?? null, departmentId: result.filters.departmentId ?? null, jobId: result.filters.jobId ?? null }, durationMs: result.durationMs }, 'executive overview');
  res.json({ data: result });
});

/** CSV of the aggregate tables. Formula-escaped; no employee-level rows exist in the source, so none can be exported. */
analyticsRouter.get('/executive/export', requirePermission(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE), validate(analyticsFilterSchema, 'query'), async (req, res: Response) => {
  const result = await executiveAnalyticsService.overview(req.auth!, res.locals.query);
  const csv = executiveOverviewCsv(result);
  log.info({ event: 'executive_export', actorUserId: req.auth!.userId, filters: { from: result.filters.from, to: result.filters.to, organizationId: result.filters.organizationId ?? null, departmentId: result.filters.departmentId ?? null }, bytes: csv.length }, 'executive export');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hr-analytics-${result.filters.from}-to-${result.filters.to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`﻿${csv}`);
});

analyticsRouter.get('/executive/options', requirePermission(PERMISSIONS.ANALYTICS_VIEW_EXECUTIVE), validate(z.object({}).passthrough(), 'query'), async (_req, res) => res.json({ data: await executiveAnalyticsService.options() }));
