/**
 * Administration (Task 41): the workflow monitor and the settings hub.
 *
 * The monitor is a generic, read-only view of the workflow engine. It shows who has to decide what and when, and
 * nothing a business module holds: no amount, no claim description, no relations narrative, no survey answer.
 * Reading the words an approver wrote, or opening the record itself, needs that module's own permission, which is
 * why every source module appears here with the permissions that already guard it.
 */

/** Which permission already opens a module, and where its screen lives. The monitor grants nothing by itself. */
export const WORKFLOW_SOURCE_MODULES: Record<string, { label: string; permissions: string[]; path: string }> = {
  leave: { label: 'Leave', permissions: ['leave.view', 'leave.manage', 'leave.approve'], path: '/hrm/leave' },
  attendance: { label: 'Attendance', permissions: ['attendance.view', 'attendance.manage'], path: '/hrm/attendance' },
  ot: { label: 'Overtime', permissions: ['ot.view', 'ot.manage'], path: '/hrm/attendance/overtime' },
  payroll: { label: 'Payroll', permissions: ['payroll.manage', 'payroll.run', 'payroll.approve'], path: '/hrm/payroll' },
  benefits: { label: 'Benefits', permissions: ['benefits.view', 'benefits.manage'], path: '/hrm/benefits' },
  expense: { label: 'Expenses and travel', permissions: ['expense.view', 'expense.manage'], path: '/hrm/expenses' },
  employee_services: { label: 'Employee services', permissions: ['service_request.view', 'service_request.fulfill', 'service_request.manage'], path: '/hrm/services' },
  recruitment: { label: 'Recruitment', permissions: ['recruitment.view', 'recruitment.manage'], path: '/hrm/recruitment' },
  employee_relations: { label: 'Employee relations', permissions: ['employee_relations.view', 'employee_relations.manage'], path: '/hrm/employee-relations' },
  performance: { label: 'Performance', permissions: ['performance.view', 'performance.manage'], path: '/hrm/performance' },
  lifecycle: { label: 'Employee lifecycle', permissions: ['lifecycle.view', 'lifecycle.manage'], path: '/hrm/lifecycle' },
};

/**
 * How an administration area is configured. The settings hub states this for every area rather than offering a
 * control that does nothing: a deployment-managed value is set by whoever runs the service, not from a web page.
 */
export const ADMIN_CAPABILITIES = ['CONFIGURABLE', 'READ_ONLY', 'DEPLOYMENT_MANAGED', 'NOT_AVAILABLE'] as const;
export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];
