import { Router, type Request, type Response } from 'express';
import { PERMISSIONS, adjustEntitlementSchema, carryForwardSchema, createEntitlementSchema, createLeavePolicySchema, createLeaveTypeSchema, entitlementListQuerySchema, entitlementPreviewQuerySchema, leaveEmployeeOptionsQuerySchema, leavePolicyListQuerySchema, leaveTypeListQuerySchema, ledgerListQuerySchema, resolvePolicyQuerySchema, updateLeavePolicySchema, updateLeaveTypeSchema, workflowOptionsQuerySchema } from '@hr/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { leaveTypesService } from './leave-types.service';
import { leavePoliciesService } from './leave-policies.service';
import { entitlementsService } from './entitlements.service';

const types = requirePermission(PERMISSIONS.LEAVE_MANAGE_TYPES);
const policies = requirePermission(PERMISSIONS.LEAVE_MANAGE_POLICIES);
const entitlements = requirePermission(PERMISSIONS.LEAVE_MANAGE_ENTITLEMENTS);
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;

export const leaveRouter = Router();
leaveRouter.use(requireAuth);

// leave types — leave.manage_types (reads too: master admin only in Task 9; employee-facing reads arrive with Task 11)
leaveRouter.get('/types', types, validate(leaveTypeListQuerySchema, 'query'), async (_req, res: Response) => res.json(await leaveTypesService.list(res.locals.query)));
leaveRouter.get('/types/:id', types, async (req, res) => res.json({ data: await leaveTypesService.getById(id(req)) }));
leaveRouter.post('/types', types, validate(createLeaveTypeSchema), async (req, res) => res.status(201).json({ data: await leaveTypesService.create(req.body, actor(req)) }));
leaveRouter.patch('/types/:id', types, validate(updateLeaveTypeSchema), async (req, res) => res.json({ data: await leaveTypesService.update(id(req), req.body, actor(req)) }));
leaveRouter.patch('/types/:id/activate', types, async (req, res) => res.json({ data: await leaveTypesService.activate(id(req), actor(req)) }));
leaveRouter.patch('/types/:id/deactivate', types, async (req, res) => res.json({ data: await leaveTypesService.deactivate(id(req), actor(req)) }));

// leave policies — leave.manage_policies
leaveRouter.get('/policies', policies, validate(leavePolicyListQuerySchema, 'query'), async (_req, res: Response) => res.json(await leavePoliciesService.list(res.locals.query)));
leaveRouter.get('/policies/resolve', policies, validate(resolvePolicyQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await leavePoliciesService.resolveForEmployee(res.locals.query) }));
leaveRouter.get('/policies/:id', policies, async (req, res) => res.json({ data: await leavePoliciesService.getById(id(req)) }));
leaveRouter.post('/policies', policies, validate(createLeavePolicySchema), async (req, res) => res.status(201).json({ data: await leavePoliciesService.create(req.body, actor(req)) }));
leaveRouter.patch('/policies/:id', policies, validate(updateLeavePolicySchema), async (req, res) => res.json({ data: await leavePoliciesService.update(id(req), req.body, actor(req)) }));
leaveRouter.patch('/policies/:id/activate', policies, async (req, res) => res.json({ data: await leavePoliciesService.activate(id(req), actor(req)) }));
leaveRouter.patch('/policies/:id/deactivate', policies, async (req, res) => res.json({ data: await leavePoliciesService.deactivate(id(req), actor(req)) }));
leaveRouter.get('/workflow-options', policies, validate(workflowOptionsQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await leavePoliciesService.workflowOptions(res.locals.query.search) }));

// entitlements + ledger — leave.manage_entitlements (administrative accounting; employee-facing balances arrive with Task 11)
leaveRouter.get('/entitlements', entitlements, validate(entitlementListQuerySchema, 'query'), async (_req, res: Response) => res.json(await entitlementsService.list(res.locals.query)));
leaveRouter.get('/entitlements/preview', entitlements, validate(entitlementPreviewQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await entitlementsService.preview(res.locals.query) }));
leaveRouter.get('/entitlements/:id', entitlements, async (req, res) => res.json({ data: await entitlementsService.getById(id(req)) }));
leaveRouter.get('/entitlements/:id/ledger', entitlements, validate(ledgerListQuerySchema, 'query'), async (req, res: Response) => res.json(await entitlementsService.ledger(id(req), res.locals.query)));
leaveRouter.post('/entitlements', entitlements, validate(createEntitlementSchema), async (req, res) => res.status(201).json({ data: await entitlementsService.generate(req.body, actor(req)) }));
leaveRouter.post('/entitlements/:id/adjust', entitlements, validate(adjustEntitlementSchema), async (req, res) => res.json({ data: await entitlementsService.adjust(id(req), req.body, actor(req)) }));
leaveRouter.post('/entitlements/:id/carry-forward', entitlements, validate(carryForwardSchema), async (req, res) => res.json({ data: await entitlementsService.carryForward(id(req), req.body, actor(req)) }));
leaveRouter.get('/employee-options', entitlements, validate(leaveEmployeeOptionsQuerySchema, 'query'), async (_req, res: Response) => res.json({ data: await entitlementsService.employeeOptions(res.locals.query) }));
leaveRouter.get('/type-options', entitlements, async (_req, res: Response) => res.json({ data: await entitlementsService.typeOptions() }));
