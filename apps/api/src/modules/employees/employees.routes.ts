import { Router } from 'express';
import {
  PERMISSIONS, changeEmployeeManagerSchema, changeEmployeePositionSchema, createEmployeeSchema, employeeListQuerySchema, employeeSelectorQuerySchema, updateEmployeeProfileSchema,
} from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { employeesController as c } from './employees.controller';

const P = PERMISSIONS;
export const employeesRouter = Router();
employeesRouter.use(requireAuth);

// reads — employees.view (+ data scope inside the service)
employeesRouter.get('/', requirePermission(P.EMPLOYEES_VIEW), validate(employeeListQuerySchema, 'query'), c.list);
employeesRouter.get('/options', requirePermission(P.EMPLOYEES_VIEW), validate(employeeSelectorQuerySchema, 'query'), c.options);
employeesRouter.get('/:id', requirePermission(P.EMPLOYEES_VIEW), c.get);
employeesRouter.get('/:id/position-history', requirePermission(P.EMPLOYEES_VIEW), c.positionHistory);
employeesRouter.get('/:id/manager-history', requirePermission(P.EMPLOYEES_VIEW), c.managerHistory);
employeesRouter.get('/:id/reports', requirePermission(P.EMPLOYEES_VIEW), c.reports);

// writes
employeesRouter.post('/', requirePermission(P.EMPLOYEES_CREATE), validate(createEmployeeSchema), c.create);
employeesRouter.patch('/:id', requirePermission(P.EMPLOYEES_UPDATE), validate(updateEmployeeProfileSchema), c.updateProfile);
employeesRouter.patch('/:id/position', requirePermission(P.EMPLOYEES_UPDATE), validate(changeEmployeePositionSchema), c.changePosition);
employeesRouter.patch('/:id/manager', requirePermission(P.EMPLOYEES_UPDATE), validate(changeEmployeeManagerSchema), c.changeManager);
employeesRouter.patch('/:id/activate', requirePermission(P.EMPLOYEES_ACTIVATE), c.activate);
employeesRouter.patch('/:id/deactivate', requirePermission(P.EMPLOYEES_ACTIVATE), c.deactivate);
