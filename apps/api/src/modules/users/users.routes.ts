import { Router } from 'express';
import {
  PERMISSIONS, createUserSchema, employeeOptionsQuerySchema, updateUserRolesSchema, updateUserSchema, userListQuerySchema,
} from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { usersController } from './users.controller';

const P = PERMISSIONS;
export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/', requirePermission(P.USERS_VIEW), validate(userListQuerySchema, 'query'), usersController.list);
usersRouter.get('/employee-options', requirePermission(P.USERS_CREATE, P.USERS_UPDATE), validate(employeeOptionsQuerySchema, 'query'), usersController.employeeOptions);
usersRouter.get('/:id', requirePermission(P.USERS_VIEW), usersController.get);
usersRouter.post('/', requirePermission(P.USERS_CREATE), validate(createUserSchema), usersController.create);
usersRouter.patch('/:id', requirePermission(P.USERS_UPDATE), validate(updateUserSchema), usersController.update);
usersRouter.patch('/:id/roles', requirePermission(P.USERS_UPDATE), validate(updateUserRolesSchema), usersController.setRoles);
usersRouter.patch('/:id/activate', requirePermission(P.USERS_ACTIVATE), usersController.activate);
usersRouter.patch('/:id/deactivate', requirePermission(P.USERS_ACTIVATE), usersController.deactivate);
