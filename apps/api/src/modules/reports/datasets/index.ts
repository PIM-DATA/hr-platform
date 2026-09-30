import { PERMISSIONS, calculateGap, SERVICE_CATEGORIES, HR_LETTER_TYPES, HR_LETTER_STATUSES } from '@hr/shared';
import { prisma } from '../../../lib/prisma';
import { AppError } from '../../../lib/errors';
import { hasPermission } from '../../../services/authorization/authorization.service';
import type { AuthContext } from '../../auth/auth.types';
import { employeeScopeWhere } from '../../employees/employees.scope';
import { applicationScopeWhere } from '../../recruitment/recruitment.types';
import { skillGapService } from '../../competency/skill-gap.service';
import { headcountDelta } from '@hr/shared';
import { visibleDepartmentIds } from '../../workforce/workforce.types';
import { responseRate } from '@hr/shared';
import { aggregateEngagement, loadSurveyQuestions } from '../../engagement/results.service';
import { visibleDepartmentIds as engagementVisibleDepartments } from '../../engagement/engagement.types';
import { checklistProgress } from '@hr/shared';
import { lifecycleEmployeeWhere } from '../../lifecycle/lifecycle.types';
import { CERTIFICATION_EXPIRY_WINDOW_DAYS, certificationStatus } from '@hr/shared';
import { scopedEmployeeIds } from '../../learning/learning.types';
import { availableOf, sumsOf } from '../../benefits/benefit-ledger';
import { toMoneyString } from '../../payroll/money';
import { cycleReport } from '../../compensation-planning/report.service';
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
  requiredPermissions: [PERMISSIONS.EMPLOYEES_VIEW], aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'NON_PERSONAL', note: 'Headcounts per unit; the employee directory itself is visible to employees.view' },
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
  requiredPermissions: [PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE], aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'department', label: 'Department', type: 'STRING', column: '', groupable: true }),
    f({ id: 'actionType', label: 'Action type', type: 'STRING', column: '', groupable: true }),
    f({ id: 'month', label: 'Month', type: 'STRING', column: '', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: '', groupable: true, options: opts(['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED']) }),
    f({ id: 'actions', label: 'Actions', type: 'NUMBER', column: '', aggregatable: true }),
  ],
  load: async (auth) => {
    need(auth, PERMISSIONS.EMPLOYEE_RELATIONS_VIEW, PERMISSIONS.EMPLOYEE_RELATIONS_MANAGE);
    const rows = await prisma.disciplinaryAction.findMany({ select: { status: true, actionTypeNameSnapshot: true, createdAt: true, case: { select: { departmentName: true, employeeId: true } } }, take: 50_000 });
    return rows.map((r): Row => ({ __subject: r.case.employeeId, department: r.case.departmentName ?? 'Unassigned', actionType: r.actionTypeNameSnapshot, month: r.createdAt.toISOString().slice(0, 7), status: r.status, actions: 1 }));
  },
}));

// ---------- payroll_period_summary (organization-level, closed runs) ----------
registerDataset(prismaDataset({
  id: 'payroll_period_summary', name: 'Payroll period summary', description: 'One row per closed payroll run: organization, period, employees paid and gross / deduction / net totals. Organization-level only — no individual pay anywhere in the report center.',
  requiredPermissions: [PERMISSIONS.PAYROLL_MANAGE], aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PRE_AGGREGATED', populationField: 'employeeCount' },
  delegate: prisma.payrollRun, scope: () => ({ status: 'CLOSED' }), defaultOrder: { closedAt: 'desc' },
  fields: [
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'period.organization.name', sortable: false }),
    f({ id: 'year', label: 'Year', type: 'NUMBER', column: 'period.year', sortable: false }),
    f({ id: 'month', label: 'Month', type: 'NUMBER', column: 'period.month', sortable: false }),
    f({ id: 'employeeCount', label: 'Employees paid', type: 'NUMBER', column: 'employeeCount', aggregatable: true }),
    f({ id: 'grossTotal', label: 'Gross total', type: 'DECIMAL', column: 'grossTotal', aggregatable: true, sensitivity: 'RESTRICTED', currencyField: 'currencyCode' }),
    f({ id: 'deductionTotal', label: 'Deductions total', type: 'DECIMAL', column: 'deductionTotal', aggregatable: true, sensitivity: 'RESTRICTED', currencyField: 'currencyCode' }),
    f({ id: 'netTotal', label: 'Net total', type: 'DECIMAL', column: 'netTotal', aggregatable: true, sensitivity: 'RESTRICTED', currencyField: 'currencyCode' }),
    f({ id: 'currencyCode', label: 'Currency', type: 'STRING', column: 'currencyCode', groupable: true }),
    f({ id: 'closedAt', label: 'Closed', type: 'DATETIME', column: 'closedAt' }),
  ],
}));

// ---------- workforce_plan_summary (aggregate-safe, Task 32) ----------
registerDataset(memoryDataset({
  id: 'workforce_plan_summary', name: 'Workforce plan summary', description: 'One row per planning cycle, department and job: current headcount snapshot, planned headcount and the delta. Counts only — no notes, no person.',
  requiredPermissions: [PERMISSIONS.WORKFORCE_VIEW], aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'NON_PERSONAL', note: 'Planned headcount per department and job; no outcome about a person' },
  fields: [
    f({ id: 'cycle', label: 'Planning cycle', type: 'STRING', column: 'cycle', groupable: true }),
    f({ id: 'cycleStatus', label: 'Cycle status', type: 'ENUM', column: 'cycleStatus', groupable: true, options: opts(['DRAFT', 'ACTIVE', 'FINALIZED', 'ARCHIVED']) }),
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }),
    f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }),
    f({ id: 'current', label: 'Current (snapshot)', type: 'NUMBER', column: 'current', aggregatable: true }),
    f({ id: 'planned', label: 'Planned', type: 'NUMBER', column: 'planned', aggregatable: true }),
    f({ id: 'delta', label: 'Delta', type: 'NUMBER', column: 'delta', aggregatable: true }),
    f({ id: 'classification', label: 'Classification', type: 'ENUM', column: 'classification', groupable: true, options: opts(['EXPANSION', 'NO_CHANGE', 'REDUCTION_PLANNED']) }),
    f({ id: 'reason', label: 'Reason', type: 'ENUM', column: 'reason', groupable: true, options: opts(['GROWTH', 'REPLACEMENT', 'RESTRUCTURE', 'NEW_FUNCTION', 'SEASONAL', 'OTHER']) }),
    f({ id: 'priority', label: 'Priority', type: 'ENUM', column: 'priority', groupable: true, options: opts(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']) }),
    f({ id: 'targetDate', label: 'Target date', type: 'DATE', column: 'targetDate' }),
  ],
  async load(auth) {
    need(auth, PERMISSIONS.WORKFORCE_VIEW, PERMISSIONS.WORKFORCE_PLAN, PERMISSIONS.WORKFORCE_MANAGE);
    const visible = await visibleDepartmentIds(prisma, auth);
    const rows = await prisma.workforcePlanItem.findMany({ where: visible ? { departmentId: { in: visible } } : {}, select: { departmentNameSnapshot: true, jobTitleSnapshot: true, currentHeadcountSnapshot: true, plannedHeadcount: true, reason: true, priority: true, targetDate: true, cycle: { select: { name: true, status: true } } }, orderBy: [{ cycle: { periodStart: 'desc' } }, { departmentNameSnapshot: 'asc' }], take: 50000 });
    return rows.map((r): Row => { const d = headcountDelta(r.plannedHeadcount, r.currentHeadcountSnapshot); return { cycle: r.cycle.name, cycleStatus: r.cycle.status, department: r.departmentNameSnapshot, job: r.jobTitleSnapshot ?? 'No job assigned', current: r.currentHeadcountSnapshot, planned: r.plannedHeadcount, delta: d.delta, classification: d.classification, reason: r.reason, priority: r.priority, targetDate: r.targetDate }; });
  },
}));

// ---------- organization_design_summary (aggregate-safe, Task 32) ----------
registerDataset(memoryDataset({
  id: 'organization_design_summary', name: 'Organization design summary', description: 'One row per scenario and planned unit: planned headcount and whether the unit exists today. No notes.',
  requiredPermissions: [PERMISSIONS.ORG_DESIGN_VIEW, PERMISSIONS.ORG_DESIGN_MANAGE], aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'NON_PERSONAL', note: 'Design scenarios and planned units' },
  fields: [
    f({ id: 'scenario', label: 'Scenario', type: 'STRING', column: 'scenario', groupable: true }),
    f({ id: 'scenarioStatus', label: 'Scenario status', type: 'ENUM', column: 'scenarioStatus', groupable: true, options: opts(['DRAFT', 'FINALIZED', 'ARCHIVED']) }),
    f({ id: 'unit', label: 'Planned unit', type: 'STRING', column: 'unit', groupable: true }),
    f({ id: 'unitType', label: 'Unit type', type: 'ENUM', column: 'unitType', groupable: true, options: opts(['ORGANIZATION', 'DEPARTMENT', 'TEAM']) }),
    f({ id: 'plannedOnly', label: 'Planned only', type: 'BOOLEAN', column: 'plannedOnly', groupable: true }),
    f({ id: 'plannedHeadcount', label: 'Planned headcount', type: 'NUMBER', column: 'plannedHeadcount', aggregatable: true }),
  ],
  async load(auth) {
    need(auth, PERMISSIONS.ORG_DESIGN_VIEW, PERMISSIONS.ORG_DESIGN_MANAGE);
    const nodes = await prisma.organizationDesignNode.findMany({ select: { name: true, nodeType: true, plannedOnly: true, scenario: { select: { name: true, status: true } }, positions: { select: { plannedHeadcount: true } } }, orderBy: [{ scenario: { createdAt: 'desc' } }, { sortOrder: 'asc' }], take: 50000 });
    return nodes.map((n): Row => ({ scenario: n.scenario.name, scenarioStatus: n.scenario.status, unit: n.name, unitType: n.nodeType, plannedOnly: n.plannedOnly, plannedHeadcount: n.positions.reduce((s, p) => s + p.plannedHeadcount, 0) }));
  },
}));

// ---------- engagement (aggregate-safe, Task 33): the same threshold suppression as the results screens ----------
const ENGAGEMENT_PERMS = [PERMISSIONS.ENGAGEMENT_VIEW_RESULTS, PERMISSIONS.ENGAGEMENT_MANAGE];
async function engagementRows(auth: AuthContext, grain: 'survey' | 'question' | 'department'): Promise<Row[]> {
  need(auth, ...ENGAGEMENT_PERMS);
  const visible = await engagementVisibleDepartments(prisma, auth);
  const scope = visible ? { departmentIdSnapshot: { in: visible } } : {};
  const surveys = await prisma.engagementSurvey.findMany({ where: { status: { in: ['OPEN', 'CLOSED', 'ARCHIVED'] } }, include: { _count: { select: { questions: true, assignments: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const out: Row[] = [];
  for (const s of surveys) {
    const questions = await loadSurveyQuestions(prisma, s.id);
    if (grain === 'department') {
      const groups = await prisma.engagementSurveyAssignment.groupBy({ by: ['deptCohortId'], where: { surveyId: s.id, ...scope }, _count: { _all: true } });
      const names = new Map((await prisma.engagementSurveyCohort.findMany({ where: { surveyId: s.id, dimensionType: 'DEPARTMENT' }, select: { id: true, label: true } })).map((c) => [c.id, c.label]));
      for (const g of groups) {
        const r = await aggregateEngagement(prisma, s, questions, { deptCohortId: g.deptCohortId }, false);
        const completed = r.suppressed ? null : await prisma.engagementSurveyAssignment.count({ where: { surveyId: s.id, deptCohortId: g.deptCohortId, completedAt: { not: null } } });
        out.push({ survey: s.name, surveyStatus: s.status, responseMode: s.responseMode, department: g.deptCohortId ? (names.get(g.deptCohortId) ?? '?') : 'Not set', suppressed: r.suppressed, assigned: r.suppressed ? null : g._count._all, completed, responseRate: r.suppressed || completed === null ? null : responseRate(completed, g._count._all), enps: r.suppressed ? null : (r.enps?.score ?? null) });
      }
      continue;
    }
    const responseScope = visible ? { deptCohortId: { in: (await prisma.engagementSurveyCohort.findMany({ where: { surveyId: s.id, dimensionType: 'DEPARTMENT', sourceId: { in: visible } }, select: { id: true } })).map((c) => c.id) } } : {};
    const r = await aggregateEngagement(prisma, s, questions, responseScope, false);
    const [assigned, completed] = await Promise.all([prisma.engagementSurveyAssignment.count({ where: { surveyId: s.id, ...scope } }), prisma.engagementSurveyAssignment.count({ where: { surveyId: s.id, ...scope, completedAt: { not: null } } })]);
    if (grain === 'survey') { out.push({ survey: s.name, code: s.code, surveyType: s.surveyType, surveyStatus: s.status, responseMode: s.responseMode, questions: s._count.questions, assigned: r.suppressed ? null : assigned, completed: r.suppressed ? null : completed, responseRate: r.suppressed ? null : responseRate(completed, assigned), suppressed: r.suppressed, enps: r.suppressed ? null : (r.enps?.score ?? null), closedAt: s.closedAt ? s.closedAt.toISOString() : null }); continue; }
    for (const q of questions) { const qr = r.suppressed ? null : r.questions.find((x) => x.questionId === q.id) ?? null; out.push({ survey: s.name, surveyStatus: s.status, question: q.text, theme: q.theme, questionType: q.questionType, suppressed: r.suppressed, responses: qr ? qr.responseCount : null, average: qr ? qr.average : null }); }
  }
  return out;
}
registerDataset(memoryDataset({
  id: 'engagement_survey_summary', name: 'Engagement survey summary', description: 'One row per survey: participation, response rate and eNPS. Groups below the survey\'s anonymity threshold are suppressed, exactly as on the results screens. No answer, no comment.',
  requiredPermissions: ENGAGEMENT_PERMS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'SOURCE_SUPPRESSED', note: 'Survey threshold and differencing rule applied by the engagement module' },
  fields: [
    f({ id: 'survey', label: 'Survey', type: 'STRING', column: 'survey', groupable: true }), f({ id: 'code', label: 'Code', type: 'STRING', column: 'code' }),
    f({ id: 'surveyType', label: 'Type', type: 'ENUM', column: 'surveyType', groupable: true, options: opts(['ENGAGEMENT', 'ENPS', 'PULSE', 'CUSTOM']) }),
    f({ id: 'surveyStatus', label: 'Status', type: 'ENUM', column: 'surveyStatus', groupable: true, options: opts(['OPEN', 'CLOSED', 'ARCHIVED']) }),
    f({ id: 'responseMode', label: 'Mode', type: 'ENUM', column: 'responseMode', groupable: true, options: opts(['ANONYMOUS', 'IDENTIFIED']) }),
    f({ id: 'questions', label: 'Questions', type: 'NUMBER', column: 'questions' }), f({ id: 'assigned', label: 'Assigned', type: 'NUMBER', column: 'assigned', aggregatable: true }), f({ id: 'completed', label: 'Completed', type: 'NUMBER', column: 'completed', aggregatable: true }),
    f({ id: 'responseRate', label: 'Response rate %', type: 'NUMBER', column: 'responseRate' }), f({ id: 'suppressed', label: 'Suppressed', type: 'BOOLEAN', column: 'suppressed', groupable: true }), f({ id: 'enps', label: 'eNPS', type: 'NUMBER', column: 'enps' }), f({ id: 'closedAt', label: 'Closed', type: 'DATETIME', column: 'closedAt' }),
  ],
  load: (auth) => engagementRows(auth, 'survey'),
}));
registerDataset(memoryDataset({
  id: 'engagement_question_summary', name: 'Engagement question summary', description: 'One row per survey and question: response count and average for scaled questions. Suppressed surveys carry no figures. No answer text.',
  requiredPermissions: ENGAGEMENT_PERMS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'SOURCE_SUPPRESSED', note: 'Survey threshold and differencing rule applied by the engagement module' },
  fields: [
    f({ id: 'survey', label: 'Survey', type: 'STRING', column: 'survey', groupable: true }), f({ id: 'surveyStatus', label: 'Status', type: 'ENUM', column: 'surveyStatus', groupable: true, options: opts(['OPEN', 'CLOSED', 'ARCHIVED']) }),
    f({ id: 'question', label: 'Question', type: 'STRING', column: 'question' }), f({ id: 'theme', label: 'Theme', type: 'STRING', column: 'theme', groupable: true }),
    f({ id: 'questionType', label: 'Question type', type: 'ENUM', column: 'questionType', groupable: true, options: opts(['LIKERT', 'SCALE', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'TEXT', 'ENPS']) }),
    f({ id: 'suppressed', label: 'Suppressed', type: 'BOOLEAN', column: 'suppressed', groupable: true }), f({ id: 'responses', label: 'Responses', type: 'NUMBER', column: 'responses', aggregatable: true }), f({ id: 'average', label: 'Average', type: 'NUMBER', column: 'average' }),
  ],
  load: (auth) => engagementRows(auth, 'question'),
}));
registerDataset(memoryDataset({
  id: 'engagement_department_summary', name: 'Engagement department summary', description: 'One row per survey and department (snapshot at opening): participation, response rate and eNPS, suppressed below the anonymity threshold.',
  requiredPermissions: ENGAGEMENT_PERMS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'SOURCE_SUPPRESSED', note: 'Survey threshold and differencing rule applied by the engagement module' },
  fields: [
    f({ id: 'survey', label: 'Survey', type: 'STRING', column: 'survey', groupable: true }), f({ id: 'surveyStatus', label: 'Status', type: 'ENUM', column: 'surveyStatus', groupable: true, options: opts(['OPEN', 'CLOSED', 'ARCHIVED']) }),
    f({ id: 'responseMode', label: 'Mode', type: 'ENUM', column: 'responseMode', groupable: true, options: opts(['ANONYMOUS', 'IDENTIFIED']) }), f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }),
    f({ id: 'suppressed', label: 'Suppressed', type: 'BOOLEAN', column: 'suppressed', groupable: true }), f({ id: 'assigned', label: 'Assigned', type: 'NUMBER', column: 'assigned', aggregatable: true }), f({ id: 'completed', label: 'Completed', type: 'NUMBER', column: 'completed', aggregatable: true }),
    f({ id: 'responseRate', label: 'Response rate %', type: 'NUMBER', column: 'responseRate' }), f({ id: 'enps', label: 'eNPS', type: 'NUMBER', column: 'enps' }),
  ],
  load: (auth) => engagementRows(auth, 'department'),
}));

// ---------- lifecycle (Task 34): departments, statuses, dates and progress — never a name, a note or a comment ----------
const LIFECYCLE_VIEW = [PERMISSIONS.LIFECYCLE_VIEW_REPORTS, PERMISSIONS.ONBOARDING_MANAGE, PERMISSIONS.PROBATION_MANAGE, PERMISSIONS.OFFBOARDING_MANAGE];
const monthOf = (d: Date | string | null) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 7) : null);
registerDataset(memoryDataset({
  id: 'onboarding_summary', name: 'Onboarding summary', description: 'One row per onboarding plan: department and job at creation, start month, status, task counts and progress. No names, no task notes.',
  requiredPermissions: LIFECYCLE_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }), f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'startMonth', label: 'Start month', type: 'STRING', column: 'startMonth', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']) }),
    f({ id: 'tasks', label: 'Tasks', type: 'NUMBER', column: 'tasks', aggregatable: true }), f({ id: 'done', label: 'Done', type: 'NUMBER', column: 'done', aggregatable: true }), f({ id: 'overdue', label: 'Overdue', type: 'NUMBER', column: 'overdue', aggregatable: true }), f({ id: 'progressPct', label: 'Progress %', type: 'NUMBER', column: 'progressPct' }),
  ],
  async load(auth) {
    need(auth, ...LIFECYCLE_VIEW);
    const t = new Date().toISOString().slice(0, 10);
    const rows = await prisma.onboardingPlan.findMany({ where: await lifecycleEmployeeWhere(auth), select: { employeeId: true, departmentSnapshot: true, jobSnapshot: true, organizationSnapshot: true, startDate: true, status: true, tasks: { select: { status: true, required: true, dueDate: true } } }, orderBy: { startDate: 'desc' }, take: 50000 });
    return rows.map((r): Row => { const p = checklistProgress(r.tasks); return { __subject: r.employeeId, department: r.departmentSnapshot, job: r.jobSnapshot, organization: r.organizationSnapshot, startMonth: r.startDate.slice(0, 7), status: r.status, tasks: p.total, done: p.done, overdue: r.status === 'ACTIVE' ? r.tasks.filter((x) => (x.status === 'PENDING' || x.status === 'IN_PROGRESS') && x.dueDate < t).length : 0, progressPct: p.pct }; });
  },
}));
registerDataset(memoryDataset({
  id: 'probation_summary', name: 'Probation summary', description: 'One row per probation case: department and job at creation, start and end months, status, outcome and extension count. No names, no review comments.',
  requiredPermissions: LIFECYCLE_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }), f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'startMonth', label: 'Start month', type: 'STRING', column: 'startMonth', groupable: true }), f({ id: 'endMonth', label: 'Current end month', type: 'STRING', column: 'endMonth', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ACTIVE', 'PENDING_REVIEW', 'PASSED', 'EXTENDED', 'NOT_PASSED', 'CANCELLED']) }),
    f({ id: 'outcome', label: 'Final outcome', type: 'ENUM', column: 'outcome', groupable: true, options: opts(['PASS', 'NOT_PASS']) }), f({ id: 'extensions', label: 'Extensions', type: 'NUMBER', column: 'extensions', aggregatable: true }), f({ id: 'durationDays', label: 'Duration (days)', type: 'NUMBER', column: 'durationDays', aggregatable: true }),
  ],
  async load(auth) {
    need(auth, ...LIFECYCLE_VIEW);
    const rows = await prisma.probationCase.findMany({ where: (await lifecycleEmployeeWhere(auth)) as never, select: { employeeId: true, departmentSnapshot: true, jobSnapshot: true, organizationSnapshot: true, startDate: true, currentEndDate: true, status: true, finalOutcome: true, reviews: { select: { outcome: true } } }, orderBy: { startDate: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, department: r.departmentSnapshot, job: r.jobSnapshot, organization: r.organizationSnapshot, startMonth: r.startDate.slice(0, 7), endMonth: r.currentEndDate.slice(0, 7), status: r.status, outcome: r.finalOutcome, extensions: r.reviews.filter((x) => x.outcome === 'EXTEND').length, durationDays: Math.round((Date.parse(`${r.currentEndDate}T00:00:00Z`) - Date.parse(`${r.startDate}T00:00:00Z`)) / 86_400_000) }));
  },
}));
registerDataset(memoryDataset({
  id: 'offboarding_summary', name: 'Offboarding summary', description: 'One row per offboarding case: department and job at creation, reason category, planned and actual last-day months, status and task counts. No names, no reason notes, no exit-interview notes.',
  requiredPermissions: LIFECYCLE_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }), f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'reason', label: 'Reason', type: 'ENUM', column: 'reason', groupable: true, options: opts(['RESIGNATION', 'END_OF_CONTRACT', 'RETIREMENT', 'TERMINATION', 'REDUNDANCY', 'TRANSFER_OUT', 'OTHER']) }),
    f({ id: 'plannedMonth', label: 'Planned last-day month', type: 'STRING', column: 'plannedMonth', groupable: true }), f({ id: 'completedMonth', label: 'Completed month', type: 'STRING', column: 'completedMonth', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'ACTIVE', 'READY_TO_COMPLETE', 'COMPLETED', 'CANCELLED']) }), f({ id: 'tasks', label: 'Tasks', type: 'NUMBER', column: 'tasks', aggregatable: true }), f({ id: 'done', label: 'Done', type: 'NUMBER', column: 'done', aggregatable: true }),
  ],
  async load(auth) {
    need(auth, ...LIFECYCLE_VIEW);
    const rows = await prisma.offboardingCase.findMany({ where: (await lifecycleEmployeeWhere(auth)) as never, select: { employeeId: true, departmentSnapshot: true, jobSnapshot: true, organizationSnapshot: true, reasonCode: true, plannedLastWorkingDate: true, completedAt: true, status: true, tasks: { select: { status: true, required: true } } }, orderBy: { plannedLastWorkingDate: 'desc' }, take: 50000 });
    return rows.map((r): Row => { const p = checklistProgress(r.tasks); return { __subject: r.employeeId, department: r.departmentSnapshot, job: r.jobSnapshot, organization: r.organizationSnapshot, reason: r.reasonCode, plannedMonth: r.plannedLastWorkingDate.slice(0, 7), completedMonth: monthOf(r.completedAt), status: r.status, tasks: p.total, done: p.done }; });
  },
}));

// ---------- learning (Task 35): departments, programs, paths, certifications, statuses and dates — never a comment, reflection, evidence title or certificate number ----------
const LEARNING_VIEW = [PERMISSIONS.LEARNING_VIEW_REPORTS, PERMISSIONS.OJT_MANAGE, PERMISSIONS.LEARNING_PATH_MANAGE, PERMISSIONS.CERTIFICATION_MANAGE];
const learningScope = async (auth: AuthContext) => { const ids = await scopedEmployeeIds(auth); return ids === null ? {} : { employeeId: { in: ids } }; };
registerDataset(memoryDataset({
  id: 'ojt_summary', name: 'OJT summary', description: 'One row per OJT plan: program, department and job at creation, start month, status, activity counts and completion days. No names, trainer comments or evidence.',
  requiredPermissions: LEARNING_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'program', label: 'Program', type: 'STRING', column: 'program', groupable: true }), f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }), f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }),
    f({ id: 'startMonth', label: 'Start month', type: 'STRING', column: 'startMonth', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']) }),
    f({ id: 'activities', label: 'Activities', type: 'NUMBER', column: 'activities', aggregatable: true }), f({ id: 'activitiesCompleted', label: 'Completed activities', type: 'NUMBER', column: 'activitiesCompleted', aggregatable: true }), f({ id: 'completionDays', label: 'Completion days', type: 'NUMBER', column: 'completionDays', aggregatable: true }),
  ],
  async load(auth) {
    need(auth, ...LEARNING_VIEW);
    const rows = await prisma.ojtPlan.findMany({ where: await learningScope(auth), select: { employeeId: true, programNameSnapshot: true, departmentSnapshot: true, jobSnapshot: true, startDate: true, status: true, completedAt: true, activities: { select: { status: true } } }, orderBy: { startDate: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, program: r.programNameSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, startMonth: r.startDate.slice(0, 7), status: r.status, activities: r.activities.length, activitiesCompleted: r.activities.filter((a) => a.status === 'COMPLETED').length, completionDays: r.completedAt ? Math.round((r.completedAt.getTime() - Date.parse(`${r.startDate}T00:00:00Z`)) / 86_400_000) : null }));
  },
}));
registerDataset(memoryDataset({
  id: 'learning_path_summary', name: 'Learning path summary', description: 'One row per learning path assignment: path, department and job at assignment, status, steps and fulfilled steps. No names.',
  requiredPermissions: LEARNING_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'path', label: 'Learning path', type: 'STRING', column: 'path', groupable: true }), f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }), f({ id: 'job', label: 'Job', type: 'STRING', column: 'job', groupable: true }),
    f({ id: 'assignedMonth', label: 'Assigned month', type: 'STRING', column: 'assignedMonth', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ACTIVE', 'COMPLETED', 'CANCELLED']) }),
    f({ id: 'steps', label: 'Steps', type: 'NUMBER', column: 'steps', aggregatable: true }), f({ id: 'fulfilled', label: 'Fulfilled', type: 'NUMBER', column: 'fulfilled', aggregatable: true }), f({ id: 'progressPct', label: 'Progress %', type: 'NUMBER', column: 'progressPct' }),
  ],
  async load(auth) {
    need(auth, ...LEARNING_VIEW);
    const rows = await prisma.learningPathAssignment.findMany({ where: await learningScope(auth), select: { employeeId: true, pathNameSnapshot: true, departmentSnapshot: true, jobSnapshot: true, assignedAt: true, status: true, steps: { select: { fulfilledAt: true } } }, orderBy: { assignedAt: 'desc' }, take: 50000 });
    return rows.map((r): Row => { const done = r.steps.filter((x) => x.fulfilledAt).length; return { __subject: r.employeeId, path: r.pathNameSnapshot, department: r.departmentSnapshot, job: r.jobSnapshot, assignedMonth: r.assignedAt.toISOString().slice(0, 7), status: r.status, steps: r.steps.length, fulfilled: done, progressPct: r.steps.length ? Math.round((done / r.steps.length) * 1000) / 10 : 0 }; });
  },
}));
registerDataset(memoryDataset({
  id: 'certification_summary', name: 'Certification summary', description: 'One row per certification issuance: certification, issuer type, the employee\'s current organization and department (a certification has no snapshot; same rule as the learning report), issue and expiry months, derived status. No names, no certificate numbers.',
  requiredPermissions: LEARNING_VIEW, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'certification', label: 'Certification', type: 'STRING', column: 'certification', groupable: true }), f({ id: 'issuerType', label: 'Issuer type', type: 'ENUM', column: 'issuerType', groupable: true, options: opts(['INTERNAL', 'EXTERNAL']) }), f({ id: 'organization', label: 'Organization (current)', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'department', label: 'Department', type: 'STRING', column: 'department', groupable: true }),
    f({ id: 'issuedMonth', label: 'Issued month', type: 'STRING', column: 'issuedMonth', groupable: true }), f({ id: 'expiryMonth', label: 'Expiry month', type: 'STRING', column: 'expiryMonth', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'REVOKED']) }), f({ id: 'renewal', label: 'Is renewal', type: 'BOOLEAN', column: 'renewal', groupable: true }),
  ],
  async load(auth) {
    need(auth, ...LEARNING_VIEW);
    const t = new Date().toISOString().slice(0, 10);
    const rows = await prisma.employeeCertification.findMany({ where: await learningScope(auth), select: { employeeId: true, definitionNameSnapshot: true, issuedDate: true, expiryDate: true, revokedAt: true, renewedFromId: true, definition: { select: { issuerType: true, expiryWindowDays: true } } }, orderBy: { issuedDate: 'desc' }, take: 50000 });
    const depts = new Map((await prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, department: { select: { name: true } }, organization: { select: { name: true } } } })).map((e) => [e.id, e]));
    return rows.map((r): Row => ({ __subject: r.employeeId, certification: r.definitionNameSnapshot, issuerType: r.definition.issuerType, organization: depts.get(r.employeeId)?.organization.name ?? null, department: depts.get(r.employeeId)?.department.name ?? null, issuedMonth: r.issuedDate.slice(0, 7), expiryMonth: r.expiryDate ? r.expiryDate.slice(0, 7) : null, status: certificationStatus({ expiryDate: r.expiryDate, revokedAt: r.revokedAt }, t, r.definition.expiryWindowDays ?? CERTIFICATION_EXPIRY_WINDOW_DAYS), renewal: !!r.renewedFromId }));
  },
}));

// ---------- benefits (Task 36): plan, category, period, status, currency and money — organization-wide, never an employee, a department, a description, a document or a payment reference ----------
const BENEFITS_REPORTS = [PERMISSIONS.BENEFITS_VIEW_REPORTS, PERMISSIONS.BENEFITS_MANAGE];
registerDataset(memoryDataset({
  id: 'benefit_enrollment_summary', name: 'Benefit enrolment summary', description: 'One row per enrolment: plan, category, plan type, organization at enrolment and status. No names.',
  requiredPermissions: BENEFITS_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'plan', label: 'Plan', type: 'STRING', column: 'plan', groupable: true }), f({ id: 'category', label: 'Category', type: 'STRING', column: 'category', groupable: true }), f({ id: 'planType', label: 'Plan type', type: 'ENUM', column: 'planType', groupable: true, options: opts(['REIMBURSEMENT', 'ALLOWANCE', 'COVERAGE_ONLY']) }),
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ELIGIBLE', 'ENROLLED', 'WAIVED', 'ENDED']) }), f({ id: 'enrolledMonth', label: 'Enrolled month', type: 'STRING', column: 'enrolledMonth', groupable: true }),
  ],
  async load(auth) {
    need(auth, ...BENEFITS_REPORTS);
    const rows = await prisma.benefitEnrollment.findMany({ select: { employeeId: true, status: true, organizationSnapshot: true, enrolledAt: true, plan: { select: { name: true, planType: true, category: { select: { name: true } } } } }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, plan: r.plan.name, category: r.plan.category.name, planType: r.plan.planType, organization: r.organizationSnapshot, status: r.status, enrolledMonth: r.enrolledAt ? r.enrolledAt.toISOString().slice(0, 7) : null }));
  },
}));
registerDataset(memoryDataset({
  id: 'benefit_entitlement_summary', name: 'Benefit entitlement summary', description: 'One row per entitlement account: plan, category, period, currency, organization, granted / adjustment / reserved / consumed / available as exact decimals. No names.',
  requiredPermissions: BENEFITS_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'plan', label: 'Plan', type: 'STRING', column: 'plan', groupable: true }), f({ id: 'category', label: 'Category', type: 'STRING', column: 'category', groupable: true }), f({ id: 'period', label: 'Period', type: 'STRING', column: 'period', groupable: true }), f({ id: 'periodStatus', label: 'Period status', type: 'ENUM', column: 'periodStatus', groupable: true, options: opts(['DRAFT', 'OPEN', 'CLOSED']) }),
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }),
    f({ id: 'granted', label: 'Granted', type: 'DECIMAL', column: 'granted', aggregatable: true , currencyField: 'currency' }), f({ id: 'adjustment', label: 'Adjustment', type: 'DECIMAL', column: 'adjustment', aggregatable: true , currencyField: 'currency' }), f({ id: 'reserved', label: 'Reserved', type: 'DECIMAL', column: 'reserved', aggregatable: true , currencyField: 'currency' }), f({ id: 'consumed', label: 'Consumed', type: 'DECIMAL', column: 'consumed', aggregatable: true , currencyField: 'currency' }), f({ id: 'available', label: 'Available', type: 'DECIMAL', column: 'available', aggregatable: true , currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...BENEFITS_REPORTS);
    const rows = await prisma.benefitEntitlement.findMany({ select: { employeeId: true, currency: true, organizationSnapshot: true, grantedAmount: true, adjustmentAmount: true, reservedAmount: true, consumedAmount: true, plan: { select: { name: true, category: { select: { name: true } } } }, period: { select: { name: true, status: true } } }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, plan: r.plan.name, category: r.plan.category.name, period: r.period.name, periodStatus: r.period.status, organization: r.organizationSnapshot, currency: r.currency, granted: toMoneyString(r.grantedAmount), adjustment: toMoneyString(r.adjustmentAmount), reserved: toMoneyString(r.reservedAmount), consumed: toMoneyString(r.consumedAmount), available: toMoneyString(availableOf(sumsOf(r))) }));
  },
}));
registerDataset(memoryDataset({
  id: 'benefit_claim_summary', name: 'Benefit claim summary', description: 'One row per claim: plan, category, period, organization, status, currency, submitted / paid month, claimed and approved amounts. No names, claim numbers, descriptions, documents or payment references.',
  requiredPermissions: BENEFITS_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'plan', label: 'Plan', type: 'STRING', column: 'plan', groupable: true }), f({ id: 'category', label: 'Category', type: 'STRING', column: 'category', groupable: true }), f({ id: 'period', label: 'Period', type: 'STRING', column: 'period', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['DRAFT', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID', 'REJECTED', 'CANCELLED']) }), f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }),
    f({ id: 'submittedMonth', label: 'Submitted month', type: 'STRING', column: 'submittedMonth', groupable: true }), f({ id: 'paidMonth', label: 'Paid month', type: 'STRING', column: 'paidMonth', groupable: true }), f({ id: 'paymentMethod', label: 'Payment method', type: 'STRING', column: 'paymentMethod', groupable: true }),
    f({ id: 'claimedAmount', label: 'Claimed', type: 'DECIMAL', column: 'claimedAmount', aggregatable: true , currencyField: 'currency' }), f({ id: 'approvedAmount', label: 'Approved', type: 'DECIMAL', column: 'approvedAmount', aggregatable: true , currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...BENEFITS_REPORTS);
    const rows = await prisma.benefitClaim.findMany({ select: { employeeId: true, status: true, currency: true, organizationSnapshot: true, submittedDate: true, paidDate: true, paymentMethod: true, claimedAmount: true, approvedAmount: true, planNameSnapshot: true, categorySnapshot: true, period: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, plan: r.planNameSnapshot, category: r.categorySnapshot, period: r.period.name, organization: r.organizationSnapshot, status: r.status, currency: r.currency, submittedMonth: r.submittedDate ? r.submittedDate.slice(0, 7) : null, paidMonth: r.paidDate ? r.paidDate.slice(0, 7) : null, paymentMethod: r.paymentMethod, claimedAmount: toMoneyString(r.claimedAmount), approvedAmount: r.approvedAmount ? toMoneyString(r.approvedAmount) : null }));
  },
}));

// ---------- expense and travel (Task 39): policy, category, month, status, currency and exact totals — organization at snapshot, never a person, a number, a merchant, a description, a receipt or a reference ----------
const EXPENSE_REPORTS = [PERMISSIONS.EXPENSE_VIEW_REPORTS, PERMISSIONS.EXPENSE_MANAGE];
registerDataset(memoryDataset({
  id: 'travel_request_summary', name: 'Travel request summary', description: 'One row per submitted travel request: travel policy, organization, submitted month, trip month, status, currency and the requested estimate. No names, purposes or destinations.',
  requiredPermissions: EXPENSE_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'travelPolicy', label: 'Travel policy', type: 'STRING', column: 'travelPolicy', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'submittedMonth', label: 'Submitted month', type: 'STRING', column: 'submittedMonth', groupable: true }), f({ id: 'tripMonth', label: 'Trip month', type: 'STRING', column: 'tripMonth', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED']) }), f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }), f({ id: 'tripDays', label: 'Trip days', type: 'NUMBER', column: 'tripDays', aggregatable: true }), f({ id: 'estimatedAmount', label: 'Estimated', type: 'DECIMAL', column: 'estimatedAmount', aggregatable: true , currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...EXPENSE_REPORTS);
    const rows = await prisma.travelRequest.findMany({ where: { status: { not: 'DRAFT' } }, select: { employeeId: true, travelPolicyNameSnapshot: true, organizationSnapshot: true, submittedAt: true, startDate: true, endDate: true, status: true, currency: true, estimatedAmount: true }, orderBy: { createdAt: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, travelPolicy: r.travelPolicyNameSnapshot, organization: r.organizationSnapshot, submittedMonth: r.submittedAt ? r.submittedAt.toISOString().slice(0, 7) : null, tripMonth: r.startDate.slice(0, 7), status: r.status, currency: r.currency, tripDays: Math.round((Date.parse(`${r.endDate}T00:00:00Z`) - Date.parse(`${r.startDate}T00:00:00Z`)) / 86_400_000) + 1, estimatedAmount: toMoneyString(r.estimatedAmount) }));
  },
}));
registerDataset(memoryDataset({
  id: 'expense_report_summary', name: 'Expense report summary', description: 'One row per submitted expense report: policy, organization, submitted and paid months, status, currency, item count and exact total. No names, report numbers, merchants, descriptions or references.',
  requiredPermissions: EXPENSE_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'policy', label: 'Policy', type: 'STRING', column: 'policy', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'submittedMonth', label: 'Submitted month', type: 'STRING', column: 'submittedMonth', groupable: true }), f({ id: 'paidMonth', label: 'Paid month', type: 'STRING', column: 'paidMonth', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID', 'REJECTED', 'CANCELLED']) }), f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }), f({ id: 'paymentMethod', label: 'Payment method', type: 'STRING', column: 'paymentMethod', groupable: true }), f({ id: 'linkedToTravel', label: 'Linked to travel', type: 'BOOLEAN', column: 'linkedToTravel', groupable: true }),
    f({ id: 'items', label: 'Items', type: 'NUMBER', column: 'items', aggregatable: true }), f({ id: 'total', label: 'Total', type: 'DECIMAL', column: 'total', aggregatable: true , currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...EXPENSE_REPORTS);
    const rows = await prisma.expenseReport.findMany({ where: { status: { not: 'DRAFT' } }, select: { employeeId: true, policyNameSnapshot: true, organizationSnapshot: true, submittedAt: true, paidDate: true, status: true, currency: true, paymentMethod: true, travelRequestId: true, totalAmount: true, _count: { select: { items: true } } }, orderBy: { createdAt: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.employeeId, policy: r.policyNameSnapshot, organization: r.organizationSnapshot, submittedMonth: r.submittedAt ? r.submittedAt.toISOString().slice(0, 7) : null, paidMonth: r.paidDate ? r.paidDate.slice(0, 7) : null, status: r.status, currency: r.currency, paymentMethod: r.paymentMethod, linkedToTravel: !!r.travelRequestId, items: r._count.items, total: toMoneyString(r.totalAmount) }));
  },
}));
registerDataset(memoryDataset({
  id: 'expense_category_summary', name: 'Expense category summary', description: 'One row per item of a submitted expense report: category, policy, organization, expense month, report status, currency and exact amount. No names, merchants, descriptions or receipts.',
  requiredPermissions: EXPENSE_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'category', label: 'Category', type: 'STRING', column: 'category', groupable: true }), f({ id: 'policy', label: 'Policy', type: 'STRING', column: 'policy', groupable: true }), f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }), f({ id: 'expenseMonth', label: 'Expense month', type: 'STRING', column: 'expenseMonth', groupable: true }),
    f({ id: 'reportStatus', label: 'Report status', type: 'ENUM', column: 'reportStatus', groupable: true, options: opts(['PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'SENT_TO_PAYROLL', 'PAID', 'REJECTED', 'CANCELLED']) }), f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }), f({ id: 'receiptRequired', label: 'Receipt required', type: 'BOOLEAN', column: 'receiptRequired', groupable: true }), f({ id: 'amount', label: 'Amount', type: 'DECIMAL', column: 'amount', aggregatable: true , currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...EXPENSE_REPORTS);
    const rows = await prisma.expenseItem.findMany({ where: { report: { status: { not: 'DRAFT' } } }, select: { categoryNameSnapshot: true, expenseDate: true, amount: true, receiptRequiredSnapshot: true, report: { select: { employeeId: true, policyNameSnapshot: true, organizationSnapshot: true, status: true, currency: true } } }, orderBy: { expenseDate: 'desc' }, take: 50000 });
    return rows.map((r): Row => ({ __subject: r.report.employeeId, category: r.categoryNameSnapshot, policy: r.report.policyNameSnapshot, organization: r.report.organizationSnapshot, expenseMonth: r.expenseDate.slice(0, 7), reportStatus: r.report.status, currency: r.report.currency, receiptRequired: r.receiptRequiredSnapshot, amount: toMoneyString(r.amount) }));
  },
}));

// ---------------------------------------------------------------------------
// Employee services (Task 40). Aggregate-safe: request type, category, status, month, duration and letter type.
// No employee, request number, subject, field answer, message, letter number, letter body or salary.
// ---------------------------------------------------------------------------
const SERVICE_REPORTS = [PERMISSIONS.HR_LETTER_VIEW_REPORTS, PERMISSIONS.SERVICE_REQUEST_MANAGE];
registerDataset(memoryDataset({
  id: 'service_request_summary', name: 'Service request summary',
  description: 'One row per submitted service request: type, category, organization, submitted and fulfilled months, status, whether it went past its target, and days to fulfil. No employee, request number, subject, answers or messages.',
  requiredPermissions: SERVICE_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'requestType', label: 'Request type', type: 'STRING', column: 'requestType', groupable: true }),
    f({ id: 'category', label: 'Category', type: 'ENUM', column: 'category', groupable: true, options: opts([...SERVICE_CATEGORIES]) }),
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'submittedMonth', label: 'Submitted month', type: 'STRING', column: 'submittedMonth', groupable: true }),
    f({ id: 'fulfilledMonth', label: 'Fulfilled month', type: 'STRING', column: 'fulfilledMonth', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE', 'FULFILLED', 'REJECTED', 'CANCELLED']) }),
    f({ id: 'fulfillmentType', label: 'Fulfilment type', type: 'ENUM', column: 'fulfillmentType', groupable: true, options: opts(['GENERAL', 'HR_LETTER']) }),
    f({ id: 'overdue', label: 'Past target', type: 'BOOLEAN', column: 'overdue', groupable: true }),
    f({ id: 'daysToFulfil', label: 'Days to fulfil', type: 'NUMBER', column: 'daysToFulfil', aggregatable: true }),
  ],
  async load(auth) {
    need(auth, ...SERVICE_REPORTS);
    const rows = await prisma.serviceRequest.findMany({
      where: { status: { not: 'DRAFT' } },
      select: { employeeId: true, requestTypeNameSnapshot: true, categorySnapshot: true, organizationSnapshot: true, submittedAt: true, fulfilledAt: true, dueDate: true, status: true, fulfillmentTypeSnapshot: true },
    });
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r): Row => ({ __subject: r.employeeId,
      requestType: r.requestTypeNameSnapshot, category: r.categorySnapshot, organization: r.organizationSnapshot,
      submittedMonth: r.submittedAt ? r.submittedAt.toISOString().slice(0, 7) : null, fulfilledMonth: r.fulfilledAt ? r.fulfilledAt.toISOString().slice(0, 7) : null,
      status: r.status, fulfillmentType: r.fulfillmentTypeSnapshot,
      overdue: !!r.dueDate && (r.fulfilledAt ? r.dueDate < r.fulfilledAt.toISOString().slice(0, 10) : r.dueDate < today && ['SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE'].includes(r.status)),
      daysToFulfil: r.submittedAt && r.fulfilledAt ? Math.max(0, Math.round((r.fulfilledAt.getTime() - r.submittedAt.getTime()) / 86_400_000)) : null,
    }));
  },
}));
registerDataset(memoryDataset({
  id: 'hr_letter_summary', name: 'HR letter summary',
  description: 'One row per issued HR letter: letter type, template, organization, issue month and status. No employee, letter number, subject, body or salary.',
  requiredPermissions: SERVICE_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PERSON_ROWS' },
  fields: [
    f({ id: 'letterType', label: 'Letter type', type: 'ENUM', column: 'letterType', groupable: true, options: opts([...HR_LETTER_TYPES]) }),
    f({ id: 'template', label: 'Template', type: 'STRING', column: 'template', groupable: true }),
    f({ id: 'organization', label: 'Organization', type: 'STRING', column: 'organization', groupable: true }),
    f({ id: 'issuedMonth', label: 'Issued month', type: 'STRING', column: 'issuedMonth', groupable: true }),
    f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts([...HR_LETTER_STATUSES]) }),
    f({ id: 'fromRequest', label: 'From a request', type: 'BOOLEAN', column: 'fromRequest', groupable: true }),
  ],
  async load(auth) {
    need(auth, ...SERVICE_REPORTS);
    const rows = await prisma.hrLetter.findMany({ select: { employeeId: true, letterTypeSnapshot: true, templateNameSnapshot: true, organizationSnapshot: true, issuedDate: true, status: true, serviceRequestId: true } });
    return rows.map((r): Row => ({ __subject: r.employeeId, letterType: r.letterTypeSnapshot, template: r.templateNameSnapshot, organization: r.organizationSnapshot, issuedMonth: r.issuedDate.slice(0, 7), status: r.status, fromRequest: !!r.serviceRequestId }));
  },
}));

// ---------- compensation planning (Task 43): one row per salary-review cycle, organization level — never an employee, an individual salary or increase, or a comment ----------
const COMP_REPORTS = [PERMISSIONS.COMP_PLAN_VIEW_REPORTS];
registerDataset(memoryDataset({
  id: 'compensation_planning_summary', name: 'Compensation planning summary', description: 'One row per salary-review cycle (not drafts): status, currency, population, completion, and exact organization-level current base, increase and budget. No person, no individual salary, no comment.',
  requiredPermissions: COMP_REPORTS, aggregateOnly: true, requiredDateRange: null, privacy: { kind: 'PRE_AGGREGATED', populationField: 'population' },
  fields: [
    f({ id: 'cycle', label: 'Cycle', type: 'STRING', column: 'cycle', groupable: true }), f({ id: 'status', label: 'Status', type: 'ENUM', column: 'status', groupable: true, options: opts(['ACTIVE', 'REVIEW', 'FINALIZED', 'ARCHIVED']) }),
    f({ id: 'effectiveDate', label: 'Effective date', type: 'DATE', column: 'effectiveDate' }), f({ id: 'applied', label: 'Applied', type: 'BOOLEAN', column: 'applied', groupable: true }),
    f({ id: 'currency', label: 'Currency', type: 'STRING', column: 'currency', groupable: true }),
    f({ id: 'population', label: 'Population', type: 'NUMBER', column: 'population', aggregatable: true }), f({ id: 'plannable', label: 'Plannable', type: 'NUMBER', column: 'plannable', aggregatable: true }),
    f({ id: 'addressed', label: 'With a proposal', type: 'NUMBER', column: 'addressed', aggregatable: true }), f({ id: 'approved', label: 'Approved', type: 'NUMBER', column: 'approved', aggregatable: true }),
    f({ id: 'currentBase', label: 'Current base total', type: 'DECIMAL', column: 'currentBase', aggregatable: true, currencyField: 'currency' }),
    f({ id: 'increase', label: 'Proposed increase total', type: 'DECIMAL', column: 'increase', aggregatable: true, currencyField: 'currency' }),
    f({ id: 'budget', label: 'Budget', type: 'DECIMAL', column: 'budget', aggregatable: true, currencyField: 'currency' }),
    f({ id: 'budgetRemaining', label: 'Budget remaining', type: 'DECIMAL', column: 'budgetRemaining', aggregatable: true, currencyField: 'currency' }),
  ],
  async load(auth) {
    need(auth, ...COMP_REPORTS);
    const cycles = await prisma.compensationReviewCycle.findMany({ where: { status: { not: 'DRAFT' } }, select: { id: true }, orderBy: { effectiveDate: 'desc' }, take: 500 });
    const reports = await Promise.all(cycles.map((c) => cycleReport(prisma, c.id, false)));
    return reports.map((r): Row => ({
      cycle: r.cycle.name, status: r.cycle.status, effectiveDate: r.cycle.effectiveDate, applied: r.cycle.applied, currency: r.cycle.currency,
      population: r.population.total, plannable: r.population.eligible, addressed: r.population.eligible - r.completion.notStarted, approved: r.completion.approved,
      currentBase: r.totals.currentBase, increase: r.totals.increase, budget: r.budget?.amount ?? null, budgetRemaining: r.budget?.remaining ?? null,
    }));
  },
}));
