import type { Request, Response } from 'express';
import { requestMeta } from '../../services/audit/audit.service';
import { organizationsService } from './organizations.service';
import { departmentsService } from './departments.service';
import { jobsService } from './jobs.service';
import { positionsService } from './positions.service';
import { buildOrganizationTree } from './tree.service';
import type { Actor } from './organization.shared';

const actor = (req: Request): Actor => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;

/** Generic CRUD controller for the four master-data services (they share the same surface). */
function crud(service: {
  list: (q: never) => Promise<unknown>;
  getById: (id: string) => Promise<unknown>;
  create: (input: never, actor: Actor) => Promise<unknown>;
  update: (id: string, input: never, actor: Actor) => Promise<unknown>;
  activate: (id: string, actor: Actor) => Promise<unknown>;
  deactivate: (id: string, actor: Actor) => Promise<unknown>;
}) {
  return {
    list: async (_req: Request, res: Response) => res.json(await service.list(res.locals.query as never)),
    get: async (req: Request, res: Response) => res.json({ data: await service.getById(id(req)) }),
    create: async (req: Request, res: Response) => res.status(201).json({ data: await service.create(req.body as never, actor(req)) }),
    update: async (req: Request, res: Response) => res.json({ data: await service.update(id(req), req.body as never, actor(req)) }),
    activate: async (req: Request, res: Response) => res.json({ data: await service.activate(id(req), actor(req)) }),
    deactivate: async (req: Request, res: Response) => res.json({ data: await service.deactivate(id(req), actor(req)) }),
  };
}

export const organizationsController = {
  ...crud(organizationsService),
  /** GET /organizations/:id/departments — departments of one organization (same list semantics). */
  departments: async (req: Request, res: Response) => {
    await organizationsService.getById(id(req)); // 404 if unknown
    res.json(await departmentsService.list({ ...(res.locals.query as object), organizationId: id(req) } as never));
  },
};
export const departmentsController = crud(departmentsService);
export const jobsController = crud(jobsService);
export const positionsController = crud(positionsService);

export const treeController = {
  get: async (_req: Request, res: Response) => {
    const q = res.locals.query as { organizationId?: string; includeInactive: boolean };
    res.json({ data: await buildOrganizationTree(q) });
  },
};
