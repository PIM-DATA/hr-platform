import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, createSavedReportSchema, reportFileName, runReportSchema, updateSavedReportSchema } from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { reportsService } from './reports.service';

/**
 * Report center (Task 30). Every request names a dataset and fields from the server-owned registry; the strict
 * schemas reject anything else (`sql`, `where`, `table`, `join`, unknown keys). Datasets and reports the caller
 * cannot use do not exist to them.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.REPORTS_VIEW);
const create = requirePermission(PERMISSIONS.REPORTS_CREATE, PERMISSIONS.REPORTS_MANAGE);

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

reportsRouter.get('/datasets', view, (req, res) => res.json({ data: reportsService.datasets(req.auth!) }));
reportsRouter.get('/templates', view, (req, res) => res.json({ data: reportsService.templates(req.auth!) }));
reportsRouter.post('/run', view, validate(runReportSchema), async (req, res) => res.json({ data: await reportsService.run(req.auth!, req.body.datasetId, req.body.definition, req.body.page) }));
reportsRouter.post('/export', view, validate(runReportSchema.omit({ page: true }).extend({ name: z.string().trim().max(120).optional() })), async (req, res) => {
  const { csv, rows } = await reportsService.exportCsv(actor(req), req.body.datasetId, req.body.definition, null);
  sendCsv(res, reportFileName(req.body.name ?? req.body.datasetId), csv, rows);
});
reportsRouter.get('/saved', view, async (req, res) => res.json({ data: await reportsService.list(req.auth!) }));
reportsRouter.post('/saved', create, validate(createSavedReportSchema), async (req, res) => res.status(201).json({ data: await reportsService.create(req.body, actor(req)) }));
reportsRouter.get('/saved/:id', view, async (req, res) => res.json({ data: await reportsService.get(req.auth!, id(req)) }));
reportsRouter.patch('/saved/:id', create, validate(updateSavedReportSchema), async (req, res) => res.json({ data: await reportsService.update(id(req), req.body, actor(req)) }));
reportsRouter.delete('/saved/:id', create, async (req, res) => { await reportsService.remove(id(req), actor(req)); res.status(204).end(); });
reportsRouter.post('/saved/:id/run', view, validate(z.object({ page: z.number().int().min(1).max(10_000).default(1) }).strict()), async (req, res) => res.json({ data: await reportsService.runSaved(actor(req), id(req), req.body.page) }));
reportsRouter.get('/saved/:id/export', view, async (req, res) => {
  const saved = await reportsService.get(req.auth!, id(req));
  const { csv, rows } = await reportsService.exportCsv(actor(req), saved.datasetId, saved.definition, saved.id);
  sendCsv(res, reportFileName(saved.name), csv, rows);
});

function sendCsv(res: Response, filename: string, csv: string, rows: number) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Row-Count', String(rows));
  res.send(`﻿${csv}`);
}
