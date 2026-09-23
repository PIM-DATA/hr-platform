import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, createPrivacyRequestSchema, privacyRequestListQuerySchema, updatePrivacyRequestSchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { privacyService } from './privacy.service';

/**
 * Privacy operations. Two permissions, deliberately separate: recording and tracking requests
 * (`privacy.manage_requests`) is a different job from reading out somebody's whole file (`privacy.export_data`).
 *
 * There is no delete endpoint: privacy requests are an operational record, and erasing personal data is a policy
 * decision that this system does not make (see docs/privacy-operations.md).
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const manage = requirePermission(PERMISSIONS.PRIVACY_MANAGE_REQUESTS);
const exportData = requirePermission(PERMISSIONS.PRIVACY_EXPORT_DATA);

export const privacyRouter = Router();
privacyRouter.use(requireAuth);

privacyRouter.get('/requests', manage, validate(privacyRequestListQuerySchema, 'query'), async (_req, res: Response) => res.json(await privacyService.listRequests(res.locals.query)));
privacyRouter.post('/requests', manage, validate(createPrivacyRequestSchema), async (req, res) => res.status(201).json({ data: await privacyService.createRequest(req.body, actor(req)) }));
privacyRouter.get('/requests/:id', manage, async (req, res) => res.json({ data: await privacyService.getRequest(req.params.id as string) }));
privacyRouter.patch('/requests/:id', manage, validate(updatePrivacyRequestSchema), async (req, res) => res.json({ data: await privacyService.updateRequest(req.params.id as string, req.body, actor(req)) }));

/** Employee lookup for privacy work — needs no employees.view, and includes former employees. */
privacyRouter.get('/employee-options', exportData, async (req, res) => res.json({ data: await privacyService.employeeOptions(typeof req.query.search === 'string' ? req.query.search : undefined) }));

/**
 * Personal data export. Streams a JSON attachment and is never stored server-side; `no-store` keeps it out of
 * intermediary and browser caches.
 */
privacyRouter.post('/employees/:employeeId/export', exportData, async (req, res) => {
  const result = await privacyService.exportEmployee(req.params.employeeId as string, actor(req));
  const safeName = `personal-data-${result.subject.employeeCode.replace(/[^A-Za-z0-9._-]/g, '_')}-${result.generatedAt.slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(result, null, 2));
});
