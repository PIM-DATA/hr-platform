import type { Request, Response } from 'express';
import { requestMeta } from '../../services/audit/audit.service';
import { employeesService } from './employees.service';

const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;

export const employeesController = {
  list: async (req: Request, res: Response) => res.json(await employeesService.list(req.auth!, res.locals.query)),
  options: async (req: Request, res: Response) => res.json({ data: await employeesService.options(req.auth!, res.locals.query) }),
  get: async (req: Request, res: Response) => res.json({ data: await employeesService.getById(req.auth!, id(req)) }),
  positionHistory: async (req: Request, res: Response) => res.json({ data: await employeesService.positionHistory(req.auth!, id(req)) }),
  managerHistory: async (req: Request, res: Response) => res.json({ data: await employeesService.managerHistory(req.auth!, id(req)) }),
  reports: async (req: Request, res: Response) => res.json({ data: await employeesService.directReports(req.auth!, id(req)) }),
  create: async (req: Request, res: Response) => res.status(201).json({ data: await employeesService.create(req.body, actor(req)) }),
  updateProfile: async (req: Request, res: Response) => res.json({ data: await employeesService.updateProfile(id(req), req.body, actor(req)) }),
  changePosition: async (req: Request, res: Response) => res.json({ data: await employeesService.changePosition(id(req), req.body, actor(req)) }),
  changeManager: async (req: Request, res: Response) => res.json({ data: await employeesService.changeManager(id(req), req.body, actor(req)) }),
  activate: async (req: Request, res: Response) => res.json({ data: await employeesService.activate(id(req), actor(req)) }),
  deactivate: async (req: Request, res: Response) => res.json({ data: await employeesService.deactivate(id(req), actor(req)) }),
};
