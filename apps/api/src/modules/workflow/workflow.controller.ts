import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requestMeta } from '../../services/audit/audit.service';
import { workflowDefinitionsService, workflowEngine } from '../../services/workflow';

const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;

export const workflowController = {
  inbox: async (req: Request, res: Response) => res.json(await workflowEngine.inbox(req.auth!, res.locals.query)),
  listInstances: async (_req: Request, res: Response) => res.json(await workflowEngine.list(res.locals.query)),
  getInstance: async (req: Request, res: Response) => res.json({ data: await workflowEngine.getInstance(req.auth!, id(req)) }),
  /** APPROVE / REJECT only — CANCEL is a business-module concern (e.g. POST /leave/requests/:id/cancel). */
  act: async (req: Request, res: Response) => {
    const a = actor(req);
    const result = await prisma.$transaction((tx) => workflowEngine.act(id(req), req.body, a, tx));
    res.json({ data: result });
  },

  listDefinitions: async (_req: Request, res: Response) => res.json({ data: await workflowDefinitionsService.list(res.locals.query ?? {}) }),
  getDefinition: async (req: Request, res: Response) => res.json({ data: await workflowDefinitionsService.getById(id(req)) }),
  createDefinition: async (req: Request, res: Response) => res.status(201).json({ data: await workflowDefinitionsService.createVersion(req.body, actor(req)) }),
  activateDefinition: async (req: Request, res: Response) => res.json({ data: await workflowDefinitionsService.activate(id(req), actor(req)) }),
  deactivateDefinition: async (req: Request, res: Response) => res.json({ data: await workflowDefinitionsService.deactivate(id(req), actor(req)) }),
};
