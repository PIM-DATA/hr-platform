import { PERMISSIONS, calculateGap } from '@hr/shared';
import { prisma } from '../../../lib/prisma';
import { AppError } from '../../../lib/errors';
import { hasPermission } from '../../../services/authorization/authorization.service';
import type { AuthContext } from '../../auth/auth.types';
import { employeeScopeWhere } from '../../employees/employees.scope';
import { applicationScopeWhere } from '../../recruitment/recruitment.types';
import { skillGapService } from '../../competency/skill-gap.service';
import { memoryDataset, prismaDataset, type ColumnDef } from '../prisma-runner';
import { registerDataset, type Row } from '../registry';

/**
 * The datasets. Each one names its module's permission, applies that module's row scope per caller, and lists
 * exactly the fields a report may touch. No salary, no comment, no note, no narrative, no storage key.
 */
const f = (d: Omit<ColumnDef, 'selectable' | 'filterable' | 'sortable' | 'groupable' | 'aggregatable' | 'sensitivity'> & Partial<Pick<ColumnDef, 'selectable' | 'filterable' | 'sortable' | 'groupable' | 'aggregatable' | 'sensitivity'>>): ColumnDef => ({ selectable: true, filterable: true, sortable: true, groupable: false, aggregatable: false, sensitivity: 'NORMAL', ...d });
const deptLabels = async (ids: string[]) => new Map((await prisma.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
const orgLabels = async (ids: string[]) => new Map((await prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
const posLabels = async (ids: string[]) => new Map((await prisma.position.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map((d) => [d.id, d.title]));
const ltLabels = async (ids: string[]) => new Map((await prisma.leaveType.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, ' ') }));
const need = (auth: AuthContext, ...perms: string[]) => { if (!perms.some((p) => hasPermission(auth, p))) throw new AppError(403, 'FORBIDDEN', 'This dataset needs a permission you do not hold'); };

// ---------- employee_directory ----------
registerDataset(prismaDataset({
  id: 'employee_directory', name: 'Employee directory', description: 'One row per employee in your data scope: code, name, organization, department, job, position, status, type and hire date. No contact details, no pay, no records.',
  requiredPermissions: [PERMISSIONS.EMPLOYEES_VIEW], aggregateOnly: false, requiredDateRange: null,
  delegate: prisma.employee, scope: (auth) => employeeScopeWhere(auth), defaultOrder: { employeeCode: 'asc' },
  fields: [
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employeeCode' }),
    f({ id: 'firstName', label: 'First name', type: 'STRING', column: 'firstName', sensitivity: 'PERSONAL' }),
    f({ id: 'lastName', label: 'Last name', type: 'STRING', column: 'lastName', sensitivity: 'PERSONAL' }),
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization.name', groupable: true, groupKey: { column: 'organizationId', labels: orgLabels } }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department.name', groupable: true, groupKey: { column: 'departmentId', labels: deptLabels } }),
    f({ id: 'job', label: 'Job', type: 'STRING', column: 'position.job.title', groupable: false, sortable: false }),
    f({ id: 'position', label: 'Position', type: 'STRING', column: 'position.title', groupable: true, groupKey: { column: 'positionId', labels: posLabels } }),
    f({ id: 'employmentStatus', label: 'Employment status', type: 'ENUM', column: 'employmentStatus', groupable: true, options: opts(['ACTIVE', 'INACTIVE', 'TERMINATED']) }),
    f({ id: 'employmentType', label: 'Employment type', type: 'ENUM', column: 'employmentType', groupable: true, options: opts(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']) }),
    f({ id: 'hireDate', label: 'Hire date', type: 'DATETIME', column: 'hireDate' }),
  ],
}));

// ---------- headcount_summary (aggregate-safe) ----------
registerDataset(prismaDataset({
  id: 'headcount_summary', name: 'Headcount summary', description: 'Counts of employees by organization, department, position, status and type. Aggregate only — every row is a count.',
  requiredPermissions: [PERMISSIONS.EMPLOYEES_VIEW], aggregateOnly: true, requiredDateRange: null,
  delegate: prisma.employee, scope: (auth) => employeeScopeWhere(auth), defaultOrder: { employeeCode: 'asc' },
  fields: [
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization.name', selectable: false, sortable: false, groupable: true, groupKey: { column: 'organizationId', labels: orgLabels } }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department.name', selectable: false, sortable: false, groupable: true, groupKey: { column: 'departmentId', labels: deptLabels } }),
    f({ id: 'position', label: 'Position', type: 'STRING', column: 'position.title', selectable: false, sortable: false, groupable: true, groupKey: { column: 'positionId', labels: posLabels } }),
    f({ id: 'employmentStatus', label: 'Employment status', type: 'ENUM', column: 'employmentStatus', selectable: false, sortable: false, groupable: true, options: opts(['ACTIVE', 'INACTIVE', 'TERMINATED']) }),
    f({ id: 'employmentType', label: 'Employment type', type: 'ENUM', column: 'employmentType', selectable: false, sortable: false, groupable: true, options: opts(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']) }),
    f({ id: 'employees', label: 'Employees', type: 'NUMBER', column: 'id', selectable: false, filterable: false, sortable: false, aggregatable: true }),
  ],
}));

// ---------- leave_requests ----------
registerDataset(prismaDataset({
  id: 'leave_requests', name: 'Leave requests', description: 'Leave requests in your leave scope with type, dates, units and status. No reasons or attachments.',
  requiredPermissions: [PERMISSIONS.LEAVE_VIEW], aggregateOnly: false, requiredDateRange: { fieldId: 'startDate', maxMonths: 24 },
  delegate: prisma.leaveRequest, scope: (auth) => ({ employee: employeeScopeWhere(auth) }), defaultOrder: { startDate: 'desc' },
  fields: [
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employee.employeeCode' }),
    f({ id: 'employeeName', label: 'Employee', type: 'STRING', column: 'employee.lastName', filterable: false, sensitivity: 'PERSONAL' }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department.name', groupable: true, groupKey: { column: 'departmentId', labels: deptLabels } }),
    f({ id: 'leaveType', label: 'Leave type', type: 'STRING', column: 'leaveType.name', groupable: true, groupKey: { column: 'leaveTypeId', labels: ltLabels } }),
    f({ id: 'startDate', label: 'Start date', type: 'DATE', column: 'startDate' }),
    f({ id: 'endDate', label: 'End date', type: 'DATE', column: 'endDate' }),
    f({ id: 'units', label: 'Units', type: 'NUMBER', column: 'units', aggregatable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) }),
    f({ id: 'submittedAt', label: 'Submitted', type: 'DATETIME', column: 'submittedAt' }),
  ],
}));

// ---------- attendance_summary (employee/day) ----------
registerDataset(prismaDataset({
  id: 'attendance_summary', name: 'Attendance (employee per day)', description: 'One row per employee and day in your attendance scope: status, worked, late and early-leave minutes. A date range of up to 12 months is required.',
  requiredPermissions: [PERMISSIONS.ATTENDANCE_VIEW], aggregateOnly: false, requiredDateRange: { fieldId: 'attendanceDate', maxMonths: 12 },
  delegate: prisma.attendanceRecord, scope: (auth) => ({ employee: employeeScopeWhere(auth) }), defaultOrder: { attendanceDate: 'desc' },
  fields: [
    f({ id: 'attendanceDate', label: 'Date', type: 'DATE', column: 'attendanceDate', groupable: true }),
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employee.employeeCode' }),
    f({ id: 'employeeName', label: 'Employee', type: 'STRING', column: 'employee.lastName', filterable: false, sensitivity: 'PERSONAL' }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'employee.department.name', sortable: false, groupable: false }),
    f({ id: 'dayType', label: 'Day type', type: 'ENUM', column: 'dayType', groupable: true, options: opts(['WORKDAY', 'OFF_DAY', 'HOLIDAY']) }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['SCHEDULED', 'NORMAL', 'LATE', 'EARLY_LEAVE', 'LATE_AND_EARLY', 'ABSENT', 'INCOMPLETE', 'LEAVE', 'OFF']) }),
    f({ id: 'workMinutes', label: 'Worked minutes', type: 'NUMBER', column: 'workMinutes', aggregatable: true }),
    f({ id: 'lateMinutes', label: 'Late minutes', type: 'NUMBER', column: 'lateMinutes', aggregatable: true }),
    f({ id: 'earlyLeaveMinutes', label: 'Early-leave minutes', type: 'NUMBER', column: 'earlyLeaveMinutes', aggregatable: true }),
  ],
}));

// ---------- overtime_approved ----------
registerDataset(prismaDataset({
  id: 'overtime_approved', name: 'Overtime claims', description: 'Overtime claims in your scope with claimed and approved minutes by day type. Minutes only — never money.',
  requiredPermissions: [PERMISSIONS.OT_VIEW], aggregateOnly: false, requiredDateRange: { fieldId: 'attendanceDate', maxMonths: 24 },
  delegate: prisma.overtimeRequest, scope: (auth) => ({ employee: employeeScopeWhere(auth) }), defaultOrder: { attendanceDate: 'desc' },
  fields: [
    f({ id: 'attendanceDate', label: 'Date', type: 'DATE', column: 'attendanceDate', groupable: true }),
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employee.employeeCode' }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department.name', groupable: true, groupKey: { column: 'departmentId', labels: deptLabels } }),
    f({ id: 'dayType', label: 'Day type', type: 'ENUM', column: 'dayType', groupable: true, options: opts(['WORKDAY', 'OFF_DAY', 'HOLIDAY']) }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']) }),
    f({ id: 'claimedMinutes', label: 'Claimed minutes', type: 'NUMBER', column: 'claimedMinutes', aggregatable: true }),
    f({ id: 'approvedMinutes', label: 'Approved minutes', type: 'NUMBER', column: 'approvedMinutes', aggregatable: true }),
  ],
}));

// ---------- performance_results (finalized only) ----------
registerDataset(prismaDataset({
  id: 'performance_results', name: 'Performance results', description: 'Finalized performance plans: cycle, snapshot department and job, weighted score and rating. Own, reviewed or, for cycle managers, all. No comments.',
  requiredPermissions: [PERMISSIONS.PERFORMANCE_VIEW], aggregateOnly: false, requiredDateRange: null,
  delegate: prisma.performancePlan, defaultOrder: { finalizedAt: 'desc' },
  scope: (auth) => ({ status: 'FINALIZED', ...(hasPermission(auth, PERMISSIONS.PERFORMANCE_MANAGE_CYCLES) ? {} : { OR: [{ employeeId: auth.employeeId ?? '__none__' }, { reviewerUserId: auth.userId }] }) }),
  fields: [
    f({ id: 'cycle', label: 'Cycle', type: 'STRING', column: 'cycle.name', groupable: true, groupKey: { column: 'cycleId', labels: async (ids) => new Map((await prisma.performanceCycle.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) } }),
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employeeCodeSnapshot' }),
    f({ id: 'employeeName', label: 'Employee', type: 'STRING', column: 'employeeNameSnapshot', sensitivity: 'PERSONAL' }),
    f({ id: 'department', label: 'Department (at plan)', type: 'STRING', column: 'departmentName', groupable: true }),
    f({ id: 'job', label: 'Job (at plan)', type: 'STRING', column: 'jobTitle', groupable: true }),
    f({ id: 'weightedScore', label: 'Weighted score', type: 'DECIMAL', column: 'weightedScore', aggregatable: true, sensitivity: 'SENSITIVE' }),
    f({ id: 'rating', label: 'Rating', type: 'STRING', column: 'ratingLabelSnapshot', groupable: true, sensitivity: 'SENSITIVE' }),
    f({ id: 'finalizedAt', label: 'Finalized', type: 'DATETIME', column: 'finalizedAt' }),
  ],
}));

// ---------- competency_gaps (Task 24 service, current job profile) ----------
registerDataset(memoryDataset({
  id: 'competency_gaps', name: 'Competency gaps', description: 'Each active employee against their current job profile, one row per required competency, using the competency module’s own gap rule. Not assessed stays null — never zero.',
  requiredPermissions: [PERMISSIONS.COMPETENCY_MANAGE], aggregateOnly: false, requiredDateRange: null,
  fields: [
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: '' }),
    f({ id: 'employeeName', label: 'Employee', type: 'STRING', column: '', sensitivity: 'PERSONAL' }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: '', groupable: true }),
    f({ id: 'job', label: 'Job', type: 'STRING', column: '', groupable: true }),
    f({ id: 'competency', label: 'Competency', type: 'STRING', column: '', groupable: true }),
    f({ id: 'competencyCode', label: 'Competency code', type: 'STRING', column: '', groupable: true }),
    f({ id: 'currentLevel', label: 'Current level', type: 'NUMBER', column: '', aggregatable: true }),
    f({ id: 'requiredLevel', label: 'Required level', type: 'NUMBER', column: '', aggregatable: true }),
    f({ id: 'gapNeeded', label: 'Gap', type: 'NUMBER', column: '', aggregatable: true }),
    f({ id: 'status', label: 'Gap status', type: 'ENUM', column: '', groupable: true, options: opts(['UNASSESSED', 'GAP', 'NO_GAP', 'EXCEEDS_REQUIREMENT']) }),
  ],
  load: async (auth) => { need(auth, PERMISSIONS.COMPETENCY_MANAGE); const rows = await skillGapService.getSkillGapsForDevelopment({}); return rows.map((r): Row => ({ employeeCode: r.employeeCode, employeeName: r.employeeName, department: r.departmentName, job: r.jobTitle, competency: r.competencyName, competencyCode: r.competencyCode, currentLevel: r.currentLevel, requiredLevel: r.requiredLevel, gapNeeded: calculateGap({ requiredLevel: r.requiredLevel, currentLevel: r.currentLevel }).gapNeeded, status: r.gapStatus })); },
}));

// ---------- training_history ----------
registerDataset(prismaDataset({
  id: 'training_history', name: 'Training history', description: 'Enrolments in your training scope: course, session, department, status, hours and how the need arose. No scores or result notes.',
  requiredPermissions: [PERMISSIONS.TRAINING_VIEW], aggregateOnly: false, requiredDateRange: null,
  delegate: prisma.trainingEnrollment, defaultOrder: { enrolledAt: 'desc' },
  scope: (auth) => (hasPermission(auth, PERMISSIONS.TRAINING_MANAGE) ? {} : { employee: employeeScopeWhere(auth) }),
  fields: [
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employeeCodeSnapshot' }),
    f({ id: 'employeeName', label: 'Employee', type: 'STRING', column: 'employeeNameSnapshot', sensitivity: 'PERSONAL' }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'departmentNameSnapshot', groupable: true }),
    f({ id: 'course', label: 'Course', type: 'STRING', column: 'session.course.title', sortable: false }),
    f({ id: 'sessionStart', label: 'Session start', type: 'DATETIME', column: 'session.startAt', sortable: false }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ENROLLED', 'ATTENDED', 'COMPLETED', 'FAILED', 'NO_SHOW', 'CANCELLED']) }),
    f({ id: 'source', label: 'Source', type: 'ENUM', column: 'source', groupable: true, options: opts(['MANUAL', 'TNA', 'IDP']) }),
    f({ id: 'durationMinutes', label: 'Course minutes', type: 'NUMBER', column: 'session.course.durationMinutes', sortable: false }),
    f({ id: 'enrolledAt', label: 'Enrolled', type: 'DATETIME', column: 'enrolledAt' }),
  ],
}));

// ---------- recruitment_applications (administrative) ----------
registerDataset(prismaDataset({
  id: 'recruitment_applications', name: 'Recruitment applications', description: 'Applications with opening, job, source, stage and dates for recruitment administrators. No feedback, no offer figures, no candidate contact details.',
  requiredPermissions: [PERMISSIONS.RECRUITMENT_MANAGE], aggregateOnly: false, requiredDateRange: { fieldId: 'appliedAt', maxMonths: 36 },
  delegate: prisma.recruitmentApplication, scope: (auth) => applicationScopeWhere(auth), defaultOrder: { appliedAt: 'desc' },
  fields: [
    f({ id: 'applicationNumber', label: 'Application', type: 'STRING', column: 'applicationNumber' }),
    f({ id: 'candidateName', label: 'Candidate', type: 'STRING', column: 'candidate.lastName', filterable: false, sensitivity: 'PERSONAL' }),
    f({ id: 'opening', label: 'Opening', type: 'STRING', column: 'opening.titleSnapshot', groupable: false, sortable: false }),
    f({ id: 'job', label: 'Job (opening)', type: 'STRING', column: 'jobTitleSnapshot', groupable: true }),
    f({ id: 'department', label: 'Department (opening)', type: 'STRING', column: 'departmentNameSnapshot', groupable: true }),
    f({ id: 'source', label: 'Source', type: 'ENUM', column: 'sourceSnapshot', groupable: true, options: opts(['MANUAL', 'REFERRAL', 'JOB_BOARD', 'AGENCY', 'INTERNAL', 'WALK_IN', 'OTHER']) }),
    f({ id: 'stage', label: 'Stage', type: 'ENUM', column: 'stage', groupable: true, options: opts(['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN']) }),
    f({ id: 'appliedAt', label: 'Applied', type: 'DATE', column: 'appliedAt' }),
    f({ id: 'hiredAt', label: 'Hired', type: 'DATETIME', column: 'hiredAt' }),
    f({ id: 'rejectionReason', label: 'Rejection reason', type: 'ENUM', column: 'rejectionReasonCode', groupable: true, options: opts(['NOT_A_FIT', 'EXPERIENCE', 'COMPENSATION', 'POSITION_FILLED', 'NO_RESPONSE', 'OTHER']) }),
  ],
}));

// ---------- talent_review_summary (talent.manage) ----------
registerDataset(prismaDataset({
  id: 'talent_review_summary', name: 'Talent review summary', description: 'Talent reviews with cycle, snapshot department, performance bucket, potential level and 9-box cell. For talent managers. No comments.',
  requiredPermissions: [PERMISSIONS.TALENT_MANAGE], aggregateOnly: false, requiredDateRange: null,
  delegate: prisma.talentReview, scope: () => ({}), defaultOrder: { createdAt: 'desc' },
  fields: [
    f({ id: 'cycle', label: 'Cycle', type: 'STRING', column: 'cycle.name', groupable: true, groupKey: { column: 'cycleId', labels: async (ids) => new Map((await prisma.talentReviewCycle.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) } }),
    f({ id: 'employeeCode', label: 'Employee code', type: 'STRING', column: 'employeeCodeSnapshot', sensitivity: 'SENSITIVE' }),
    f({ id: 'department', label: 'Department (at review)', type: 'STRING', column: 'departmentNameSnapshot', groupable: true }),
    f({ id: 'performanceBucket', label: 'Performance bucket', type: 'ENUM', column: 'performanceBucket', groupable: true, options: opts(['LOW', 'MEDIUM', 'HIGH']), sensitivity: 'SENSITIVE' }),
    f({ id: 'potentialLevel', label: 'Potential', type: 'ENUM', column: 'potentialLevel', groupable: true, options: opts(['LOW', 'MEDIUM', 'HIGH']), sensitivity: 'SENSITIVE' }),
    f({ id: 'nineBoxCell', label: '9-box cell', type: 'STRING', column: 'nineBoxCell', groupable: true, sensitivity: 'SENSITIVE' }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ASSIGNED', 'SUBMITTED', 'FINALIZED']) }),
  ],
}));

// ---------- employee_relations_aggregate (counts only) ----------
registerDataset(memoryDataset({
  id: 'employee_relations_aggregate', name: 'Employee relations (aggregate)', description: 'Counts of disciplinary actions by department, action type, month and status. No employee, no case, no narrative.',
  requiredPermissions: [PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], aggregateOnly: true, requiredDateRange: null,
  fields: [
    f({ id: 'department', label: 'Department', type: 'STRING', column: '', groupable: true }),
    f({ id: 'actionType', label: 'Action type', type: 'STRING', column: '', groupable: true }),
    f({ id: 'month', label: 'Month', type: 'STRING', column: '', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: '', groupable: true, options: opts(['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED']) }),
    f({ id: 'actions', label: 'Actions', type: 'NUMBER', column: '', aggregatable: true }),
  ],
  load: async (auth) => {
    need(auth, PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
    const rows = await prisma.disciplinaryAction.findMany({ select: { status: true, actionTypeNameSnapshot: true, createdAt: true, case: { select: { departmentName: true } } }, take: 50_000 });
    return rows.map((r): Row => ({ department: r.case.departmentName ?? 'Unassigned', actionType: r.actionTypeNameSnapshot, month: r.createdAt.toISOString().slice(0, 7), status: r.status, actions: 1 }));
  },
}));

// ---------- payroll_period_summary (organization-level, closed runs) ----------
registerDataset(prismaDataset({
  id: 'payroll_period_summary', name: 'Payroll period summary', description: 'One row per closed payroll run: organization, period, employees paid and gross / deduction / net totals. Organization-level only — no individual pay anywhere in the report center.',
  requiredPermissions: [PERMISSIONS.PAYROLL_MANAGE], aggregateOnly: true, requiredDateRange: null,
  delegate: prisma.payrollRun, scope: () => ({ status: 'CLOSED' }), defaultOrder: { closedAt: 'desc' },
  fields: [
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'period.organization.name', sortable: false }),
    f({ id: 'year', label: 'Year', type: 'NUMBER', column: 'period.year', sortable: false }),
    f({ id: 'month', label: 'Month', type: 'NUMBER', column: 'period.month', sortable: false }),
    f({ id: 'employeeCount', label: 'Employees paid', type: 'NUMBER', column: 'employeeCount', aggregatable: true }),
    f({ id: 'grossTotal', label: 'Gross total', type: 'DECIMAL', column: 'grossTotal', aggregatable: true, sensitivity: 'RESTRICTED' }),
    f({ id: 'deductionTotal', label: 'Deductions total', type: 'DECIMAL', column: 'deductionTotal', aggregatable: true, sensitivity: 'RESTRICTED' }),
    f({ id: 'netTotal', label: 'Net total', type: 'DECIMAL', column: 'netTotal', aggregatable: true, sensitivity: 'RESTRICTED' }),
    f({ id: 'currencyCode', label: 'Currency', type: 'STRING', column: 'currencyCode', groupable: true }),
    f({ id: 'closedAt', label: 'Closed', type: 'DATETIME', column: 'closedAt' }),
  ],
}));
