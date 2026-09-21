import { Router } from 'express';
import { PERMISSIONS, auditListQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { auditController } from './audit.controller';

/** Read-only: no POST/PATCH/DELETE exists for audit logs by design. */
export const auditRouter = Router();
auditRouter.use(requireAuth, requirePermission(PERMISSIONS.AUDIT_VIEW));
auditRouter.get('/', validate(auditListQuerySchema, 'query'), auditController.list);
auditRouter.get('/:id', auditController.get);
