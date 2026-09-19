import type { Request, Response } from 'express';
import { requestMeta } from '../../services/audit/audit.service';
import { rolesService } from './roles.service';

export const rolesController = {
  async list(_req: Request, res: Response) {
    res.json({ data: await rolesService.list() });
  },
  async get(req: Request, res: Response) {
    res.json({ data: await rolesService.getById(req.params.id as string) });
  },
  async listPermissions(_req: Request, res: Response) {
    res.json({ data: await rolesService.listPermissions() });
  },
  async setPermissions(req: Request, res: Response) {
    res.json({ data: await rolesService.setPermissions(req.params.id as string, req.body, { auth: req.auth!, ...requestMeta(req) }) });
  },
};
