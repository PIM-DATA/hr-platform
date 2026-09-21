import type { Request, Response } from 'express';
import { auditLogService } from './audit.service';

export const auditController = {
  list: async (_req: Request, res: Response) => res.json(await auditLogService.list(res.locals.query)),
  get: async (req: Request, res: Response) => res.json({ data: await auditLogService.getById(req.params.id as string) }),
};
