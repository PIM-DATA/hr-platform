import { Router } from 'express';
import { PERMISSIONS, updateRolePermissionsSchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { rolesController } from './roles.controller';

export const rolesRouter = Router();
rolesRouter.use(requireAuth);
rolesRouter.get('/', requirePermission(PERMISSIONS.ROLES_VIEW), rolesController.list);
rolesRouter.get('/:id', requirePermission(PERMISSIONS.ROLES_VIEW), rolesController.get);
rolesRouter.patch('/:id/permissions', requirePermission(PERMISSIONS.ROLES_MANAGE), validate(updateRolePermissionsSchema), rolesController.setPermissions);

export const permissionsRouter = Router();
permissionsRouter.use(requireAuth);
permissionsRouter.get('/', requirePermission(PERMISSIONS.ROLES_VIEW), rolesController.listPermissions);
