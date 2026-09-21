import { Router } from 'express';
import type { ZodType } from 'zod';
import {
  PERMISSIONS,
  createDepartmentSchema, createJobSchema, createOrganizationSchema, createPositionSchema,
  departmentListQuerySchema, jobListQuerySchema, organizationListQuerySchema, organizationTreeQuerySchema, positionListQuerySchema,
  updateDepartmentSchema, updateJobSchema, updateOrganizationSchema, updatePositionSchema,
} from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { departmentsController, jobsController, organizationsController, positionsController, treeController } from './organization.controller';

const view = requirePermission(PERMISSIONS.ORGANIZATION_VIEW);
const manage = requirePermission(PERMISSIONS.ORGANIZATION_MANAGE);

/** Standard REST surface: reads need organization.view, writes need organization.manage. */
function crudRouter(controller: typeof departmentsController, schemas: { list: ZodType; create: ZodType; update: ZodType }) {
  const r = Router();
  r.use(requireAuth);
  r.get('/', view, validate(schemas.list, 'query'), controller.list);
  r.get('/:id', view, controller.get);
  r.post('/', manage, validate(schemas.create), controller.create);
  r.patch('/:id', manage, validate(schemas.update), controller.update);
  r.patch('/:id/activate', manage, controller.activate);
  r.patch('/:id/deactivate', manage, controller.deactivate);
  return r;
}

export const organizationsRouter = crudRouter(organizationsController, { list: organizationListQuerySchema, create: createOrganizationSchema, update: updateOrganizationSchema });
organizationsRouter.get('/:id/departments', view, validate(departmentListQuerySchema, 'query'), organizationsController.departments);

export const departmentsRouter = crudRouter(departmentsController, { list: departmentListQuerySchema, create: createDepartmentSchema, update: updateDepartmentSchema });
export const jobsRouter = crudRouter(jobsController, { list: jobListQuerySchema, create: createJobSchema, update: updateJobSchema });
export const positionsRouter = crudRouter(positionsController, { list: positionListQuerySchema, create: createPositionSchema, update: updatePositionSchema });

export const organizationTreeRouter = Router();
organizationTreeRouter.use(requireAuth);
organizationTreeRouter.get('/tree', view, validate(organizationTreeQuerySchema, 'query'), treeController.get);
