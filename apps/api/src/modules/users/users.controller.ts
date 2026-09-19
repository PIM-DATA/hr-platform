import type { Request, Response } from 'express';
import { requestMeta } from '../../services/audit/audit.service';
import { usersService } from './users.service';

const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });

export const usersController = {
  async list(req: Request, res: Response) {
    res.json(await usersService.list(res.locals.query));
  },
  async get(req: Request, res: Response) {
    res.json({ data: await usersService.getById(req.params.id as string) });
  },
  async create(req: Request, res: Response) {
    res.status(201).json({ data: await usersService.create(req.body, actor(req)) });
  },
  async update(req: Request, res: Response) {
    res.json({ data: await usersService.update(req.params.id as string, req.body, actor(req)) });
  },
  async setRoles(req: Request, res: Response) {
    res.json({ data: await usersService.setRoles(req.params.id as string, req.body, actor(req)) });
  },
  async activate(req: Request, res: Response) {
    res.json({ data: await usersService.activate(req.params.id as string, actor(req)) });
  },
  async deactivate(req: Request, res: Response) {
    res.json({ data: await usersService.deactivate(req.params.id as string, actor(req)) });
  },
  async resetPassword(req: Request, res: Response) {
    await usersService.resetPassword(req.params.id as string, req.body, actor(req));
    res.status(204).end();
  },
  async employeeOptions(req: Request, res: Response) {
    const q = res.locals.query as { search?: string; includeUserId?: string };
    res.json({ data: await usersService.employeeOptions(q.search, q.includeUserId) });
  },
};
