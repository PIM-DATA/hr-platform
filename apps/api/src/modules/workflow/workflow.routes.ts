import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS, approverOptionsQuerySchema, createWorkflowDefinitionSchema, workflowActionSchema, workflowInboxQuerySchema, workflowInstanceListQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { workflowController as c } from './workflow.controller';

const P = PERMISSIONS;
export const workflowRouter = Router();
workflowRouter.use(requireAuth);

// approver side
workflowRouter.get('/inbox', requirePermission(P.WORKFLOW_APPROVE), validate(workflowInboxQuerySchema, 'query'), c.inbox);
workflowRouter.get('/instances', requirePermission(P.WORKFLOW_VIEW_ALL), validate(workflowInstanceListQuerySchema, 'query'), c.listInstances);
workflowRouter.get('/instances/:id', c.getInstance); // requester / snapshot approver / view_all — checked in service
workflowRouter.post('/instances/:id/actions', requirePermission(P.WORKFLOW_APPROVE), validate(workflowActionSchema), c.act);

// definitions (admin)
const definitionListQuery = z.object({ code: z.string().trim().max(50).optional(), module: z.string().trim().max(40).optional() });
workflowRouter.get('/approver-options', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), validate(approverOptionsQuerySchema, 'query'), c.approverOptions);
workflowRouter.get('/definitions', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), validate(definitionListQuery, 'query'), c.listDefinitions);
workflowRouter.get('/definitions/:id', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), c.getDefinition);
workflowRouter.post('/definitions', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), validate(createWorkflowDefinitionSchema), c.createDefinition);
workflowRouter.post('/definitions/:id/activate', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), c.activateDefinition);
workflowRouter.post('/definitions/:id/deactivate', requirePermission(P.WORKFLOW_MANAGE_DEFINITIONS), c.deactivateDefinition);
