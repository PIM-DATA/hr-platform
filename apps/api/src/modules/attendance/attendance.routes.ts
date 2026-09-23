import { Router, type Request, type Response } from 'express';
import {
  PERMISSIONS, assignScheduleSchema, attendanceListQuerySchema, attendanceReportQuerySchema, clockSchema,
  correctionListQuerySchema, createCorrectionSchema, createOvertimePolicySchema, createOvertimeRequestSchema,
  createShiftSchema, myAttendanceQuerySchema, overtimeListQuerySchema, overtimePolicyListQuerySchema,
  overtimePreviewSchema, overtimeReportQuerySchema, scheduleListQuerySchema, shiftListQuerySchema,
  updateOvertimePolicySchema, updateOvertimeRequestSchema, updateShiftSchema,
} from '@hr/shared';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import { requirePermission } from '../../middleware/permission';
import { validate } from '../../middleware/validate';
import { requestMeta } from '../../services/audit/audit.service';
import { shiftsService } from './shifts.service';
import { schedulesService } from './schedules.service';
import { clockService } from './clock.service';
import { attendanceRecordsService } from './attendance-records.service';
import { correctionsService } from './corrections.service';
import { overtimeService } from './overtime.service';
import { overtimePoliciesService } from './overtime-policies.service';
import './correction.handlers'; // registers the workflow callbacks for module 'attendance' (corrections + overtime)

/**
 * Time & Attendance (Task 20).
 *
 * Permissions follow what a person is doing, not who they are: clocking needs `attendance.clock`, reading needs
 * `attendance.view` (narrowed further by the role's data scope), shifts need `attendance.manage`, schedules
 * `attendance.schedule_manage`, and deciding corrections `attendance.correct` — the workflow engine still checks that
 * the caller is the snapshot approver.
 */
const actor = (req: Request) => ({ auth: req.auth!, ...requestMeta(req) });
const id = (req: Request) => req.params.id as string;
const view = requirePermission(PERMISSIONS.ATTENDANCE_VIEW);
const otView = requirePermission(PERMISSIONS.OT_VIEW);
const otRequest = requirePermission(PERMISSIONS.OT_REQUEST);
const otPolicy = requirePermission(PERMISSIONS.OT_MANAGE_POLICY);
const clock = requirePermission(PERMISSIONS.ATTENDANCE_CLOCK);
const manage = requirePermission(PERMISSIONS.ATTENDANCE_MANAGE);
const scheduleManage = requirePermission(PERMISSIONS.ATTENDANCE_SCHEDULE_MANAGE);

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

// ---------- self service ----------
attendanceRouter.get('/clock/status', clock, async (req, res) => res.json({ data: await clockService.status(req.auth!) }));
attendanceRouter.post('/clock-in', clock, validate(clockSchema), async (req, res) => res.status(201).json({ data: await clockService.clockIn(req.auth!, req.body, actor(req)) }));
attendanceRouter.post('/clock-out', clock, validate(clockSchema), async (req, res) => res.status(201).json({ data: await clockService.clockOut(req.auth!, req.body, actor(req)) }));
attendanceRouter.get('/me', view, validate(myAttendanceQuerySchema, 'query'), async (req, res: Response) => res.json(await attendanceRecordsService.mine(req.auth!, res.locals.query)));
attendanceRouter.get('/today', view, async (req, res) => res.json({ data: await attendanceRecordsService.today(req.auth!) }));

// ---------- team / administration ----------
attendanceRouter.get('/records', view, validate(attendanceListQuerySchema, 'query'), async (req, res: Response) => res.json(await attendanceRecordsService.list(req.auth!, res.locals.query)));
attendanceRouter.get('/summary', view, validate(z.object({ date: z.string(), departmentId: z.string().min(1).optional() }), 'query'), async (req, res: Response) =>
  res.json({ data: await attendanceRecordsService.dailySummary(req.auth!, res.locals.query.date, res.locals.query.departmentId) }));
attendanceRouter.get('/reports/overview', view, validate(attendanceReportQuerySchema, 'query'), async (req, res: Response) =>
  res.json({ data: await attendanceRecordsService.report(req.auth!, res.locals.query) }));
attendanceRouter.post('/recalculate', manage, validate(z.object({ from: z.string(), to: z.string(), employeeId: z.string().min(1).optional(), departmentId: z.string().min(1).optional() })), async (req, res) =>
  res.json({ data: await attendanceRecordsService.recalculate(req.auth!, req.body, actor(req)) }));

// ---------- shifts ----------
attendanceRouter.get('/shifts', view, validate(shiftListQuerySchema, 'query'), async (_req, res: Response) => res.json(await shiftsService.list(res.locals.query)));
attendanceRouter.get('/shift-options', view, validate(z.object({ organizationId: z.string().min(1).optional() }), 'query'), async (_req, res: Response) =>
  res.json({ data: await shiftsService.options(res.locals.query.organizationId) }));
attendanceRouter.get('/shifts/:id', view, async (req, res) => res.json({ data: await shiftsService.getById(id(req)) }));
attendanceRouter.post('/shifts', manage, validate(createShiftSchema), async (req, res) => res.status(201).json({ data: await shiftsService.create(req.body, actor(req)) }));
attendanceRouter.patch('/shifts/:id', manage, validate(updateShiftSchema), async (req, res) => res.json({ data: await shiftsService.update(id(req), req.body, actor(req)) }));

// ---------- schedules ----------
attendanceRouter.get('/schedules', view, validate(scheduleListQuerySchema, 'query'), async (req, res: Response) => res.json(await schedulesService.grid(req.auth!, res.locals.query)));
attendanceRouter.post('/schedules/assign', scheduleManage, validate(assignScheduleSchema), async (req, res) => res.status(201).json({ data: await schedulesService.assign(req.body, actor(req)) }));

// ---------- corrections ----------
attendanceRouter.get('/corrections', view, validate(correctionListQuerySchema, 'query'), async (req, res: Response) => res.json(await correctionsService.list(req.auth!, res.locals.query)));
attendanceRouter.post('/corrections', clock, validate(createCorrectionSchema), async (req, res) => res.status(201).json({ data: await correctionsService.submit(req.auth!, req.body, actor(req)) }));
attendanceRouter.get('/corrections/:id', view, async (req, res) => res.json({ data: await correctionsService.getById(req.auth!, id(req)) }));
attendanceRouter.post('/corrections/:id/cancel', clock, async (req, res) => res.json({ data: await correctionsService.cancel(req.auth!, id(req), actor(req)) }));
// Approving and rejecting go through the generic workflow endpoint (POST /workflow/instances/:id/actions), which
// checks the snapshot approver — there is no attendance-specific approval mutation.

// ---------- overtime (Task 21) ----------
// Claims are raised with `ot.request`, read with `ot.view` (narrowed by data scope) and decided through the generic
// workflow endpoint — there is deliberately no `ot.approve` and no overtime-specific approval mutation.
attendanceRouter.get('/overtime/policies', otView, validate(overtimePolicyListQuerySchema, 'query'), async (_req, res: Response) => res.json(await overtimePoliciesService.list(res.locals.query)));
attendanceRouter.post('/overtime/policies', otPolicy, validate(createOvertimePolicySchema), async (req, res) => res.status(201).json({ data: await overtimePoliciesService.create(req.body, actor(req)) }));
attendanceRouter.get('/overtime/policies/:id', otView, async (req, res) => res.json({ data: await overtimePoliciesService.getById(id(req)) }));
attendanceRouter.patch('/overtime/policies/:id', otPolicy, validate(updateOvertimePolicySchema), async (req, res) => res.json({ data: await overtimePoliciesService.update(id(req), req.body, actor(req)) }));

attendanceRouter.post('/overtime/preview', otRequest, validate(overtimePreviewSchema), async (req, res) => res.json({ data: await overtimeService.preview(req.auth!, req.body.attendanceDate) }));
attendanceRouter.get('/overtime/requests', otView, validate(overtimeListQuerySchema, 'query'), async (req, res: Response) => res.json(await overtimeService.list(req.auth!, res.locals.query)));
attendanceRouter.post('/overtime/requests', otRequest, validate(createOvertimeRequestSchema), async (req, res) => res.status(201).json({ data: await overtimeService.create(req.auth!, req.body, actor(req)) }));
attendanceRouter.get('/overtime/requests/:id', otView, async (req, res) => res.json({ data: await overtimeService.getById(req.auth!, id(req)) }));
attendanceRouter.patch('/overtime/requests/:id', otRequest, validate(updateOvertimeRequestSchema), async (req, res) => res.json({ data: await overtimeService.update(req.auth!, id(req), req.body, actor(req)) }));
attendanceRouter.post('/overtime/requests/:id/submit', otRequest, async (req, res) => res.json({ data: await overtimeService.submit(req.auth!, id(req), actor(req)) }));
attendanceRouter.post('/overtime/requests/:id/cancel', otRequest, async (req, res) => res.json({ data: await overtimeService.cancel(req.auth!, id(req), actor(req)) }));
attendanceRouter.get('/overtime/reports/overview', otView, validate(overtimeReportQuerySchema, 'query'), async (req, res: Response) => res.json({ data: await overtimeService.report(req.auth!, res.locals.query) }));
