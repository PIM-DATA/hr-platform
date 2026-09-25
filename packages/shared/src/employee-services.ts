/**
 * Employee services (Task 40): service requests and HR letters.
 *
 * Two rules drive everything here. A service request is a ticket: it records what an employee asked for and what HR
 * did, and it never writes to the Employee Master, payroll, leave, benefits or any other source domain. An HR letter
 * is a frozen snapshot: its text is rendered on the server from an allow-listed token registry at the moment of
 * issue and never changes afterwards.
 */

export const SERVICE_REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE', 'FULFILLED', 'REJECTED', 'CANCELLED'] as const;
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];
/** Terminal: nothing about the request changes afterwards. */
export const SERVICE_REQUEST_CLOSED: readonly ServiceRequestStatus[] = ['FULFILLED', 'REJECTED', 'CANCELLED'];
/** HR is working on it; the employee can still read and answer. */
export const SERVICE_REQUEST_OPEN: readonly ServiceRequestStatus[] = ['SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE'];

/** Descriptive labels for the catalogue. A category never triggers a cross-domain write. */
export const SERVICE_CATEGORIES = ['EMPLOYMENT_DOCUMENT', 'PERSONAL_INFORMATION', 'PAYROLL_QUERY', 'LEAVE_QUERY', 'BENEFITS_QUERY', 'EXPENSE_QUERY', 'GENERAL_HR', 'OTHER'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** GENERAL records a fulfilment result; HR_LETTER must issue a letter before the request can be fulfilled. */
export const SERVICE_FULFILLMENT_TYPES = ['GENERAL', 'HR_LETTER'] as const;
export type ServiceFulfillmentType = (typeof SERVICE_FULFILLMENT_TYPES)[number];

/** Allow-listed form field types. No code, HTML, SQL, expression or customer-supplied regex. */
export const SERVICE_FIELD_TYPES = ['TEXT', 'TEXTAREA', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'NUMBER'] as const;
export type ServiceFieldType = (typeof SERVICE_FIELD_TYPES)[number];
export const SERVICE_FIELD_TYPES_WITH_OPTIONS: readonly ServiceFieldType[] = ['SELECT', 'MULTI_SELECT'];

export const SERVICE_MESSAGE_VISIBILITY = ['REQUESTER_VISIBLE', 'INTERNAL'] as const;
export type ServiceMessageVisibility = (typeof SERVICE_MESSAGE_VISIBILITY)[number];

export const SERVICE_REJECT_REASONS = ['NOT_ELIGIBLE', 'INSUFFICIENT_INFORMATION', 'DUPLICATE', 'WITHDRAWN_BY_EMPLOYEE', 'OTHER'] as const;
export type ServiceRejectReason = (typeof SERVICE_REJECT_REASONS)[number];

export const HR_LETTER_TYPES = ['EMPLOYMENT_CERTIFICATE', 'SALARY_CERTIFICATE', 'GENERAL'] as const;
export type HrLetterType = (typeof HR_LETTER_TYPES)[number];
export const HR_LETTER_STATUSES = ['ISSUED', 'VOID'] as const;
export type HrLetterStatus = (typeof HR_LETTER_STATUSES)[number];
export const HR_LETTER_VOID_REASONS = ['ISSUED_IN_ERROR', 'INCORRECT_DATA', 'SUPERSEDED', 'EMPLOYEE_REQUEST', 'OTHER'] as const;
export type HrLetterVoidReason = (typeof HR_LETTER_VOID_REASONS)[number];

/** The generic workflow engine, when a request type opts into approval. No second approval engine exists. */
export const SERVICE_WORKFLOW = { module: 'employee_services', entityType: 'SERVICE_REQUEST' } as const;

export const SERVICE_TEXT_MAX = 2000;
export const SERVICE_FIELD_VALUE_MAX = 2000;
export const HR_LETTER_BODY_MAX = 8000;
export const HR_LETTER_SUBJECT_MAX = 300;

/** Target days are counted in calendar days from the submission date; no business-day calendar is applied. */
export const SERVICE_TARGET_DAYS_MAX = 365;

/**
 * The complete set of values an HR letter template may contain. It is owned by the server: a template can never
 * reach any other field, and there is no expression language, function call, loop, conditional or dynamic property
 * traversal. `sensitive` tokens read authoritative compensation and additionally require the payroll authority to
 * issue, both when the template is saved (`requiresSalaryAccess`) and when a letter is issued.
 */
export const HR_LETTER_TOKENS = {
  'employee.fullName': { label: 'Employee full name', sensitive: false },
  'employee.firstName': { label: 'Employee first name', sensitive: false },
  'employee.lastName': { label: 'Employee last name', sensitive: false },
  'employee.employeeCode': { label: 'Employee code', sensitive: false },
  'employment.hireDate': { label: 'Hire date', sensitive: false },
  'employment.status': { label: 'Employment status', sensitive: false },
  'employment.type': { label: 'Employment type', sensitive: false },
  'organization.name': { label: 'Organization name', sensitive: false },
  'department.name': { label: 'Department name', sensitive: false },
  'job.title': { label: 'Job title', sensitive: false },
  'position.title': { label: 'Position title', sensitive: false },
  'letter.number': { label: 'Letter number', sensitive: false },
  'letter.issueDate': { label: 'Issue date', sensitive: false },
  'compensation.baseSalary': { label: 'Current base salary (exact decimal)', sensitive: true },
  'compensation.currency': { label: 'Salary currency', sensitive: true },
  'compensation.salaryType': { label: 'Salary type (monthly, daily …)', sensitive: true },
} as const;
export type HrLetterToken = keyof typeof HR_LETTER_TOKENS;
export const HR_LETTER_TOKEN_LIST = Object.keys(HR_LETTER_TOKENS) as HrLetterToken[];
export const isHrLetterToken = (t: string): t is HrLetterToken => Object.prototype.hasOwnProperty.call(HR_LETTER_TOKENS, t) && HR_LETTER_TOKEN_LIST.includes(t as HrLetterToken);
export const isSensitiveToken = (t: HrLetterToken) => HR_LETTER_TOKENS[t].sensitive;

/** Anything between double braces is a token candidate, so an unknown or hostile one is caught rather than ignored. */
const TOKEN_PATTERN = /\{\{([^{}]*)\}\}/g;

export interface TemplateScan { tokens: HrLetterToken[]; unknown: string[]; malformed: boolean; sensitive: boolean }

/**
 * Reads a template without executing anything. Every `{{…}}` must name a registry token; anything else is reported
 * as unknown, and a stray brace pair is reported as malformed. Used when a template is saved and again at issue.
 */
export function scanLetterTemplate(template: string): TemplateScan {
  const tokens: HrLetterToken[] = [];
  const unknown: string[] = [];
  let rest = template;
  for (const m of template.matchAll(TOKEN_PATTERN)) {
    const raw = m[1].trim();
    if (isHrLetterToken(raw)) { if (!tokens.includes(raw)) tokens.push(raw); } else unknown.push(raw.slice(0, 60));
    rest = rest.replace(m[0], '');
  }
  return { tokens, unknown, malformed: rest.includes('{{') || rest.includes('}}'), sensitive: tokens.some(isSensitiveToken) };
}

/**
 * Substitutes resolved values into a scanned template. Values arrive in a Map, so a hostile key such as
 * `__proto__` or `constructor` can never reach an object prototype, and a token the server could not resolve
 * throws instead of rendering a blank.
 */
export function renderHrLetter(template: string, values: Map<string, string>): string {
  return template.replace(TOKEN_PATTERN, (_whole, raw: string) => {
    const name = raw.trim();
    if (!isHrLetterToken(name)) throw new Error(`Unknown letter token: ${name.slice(0, 60)}`);
    const v = values.get(name);
    if (v === undefined) throw new Error(`Unresolved letter token: ${name}`);
    return v;
  });
}

/** Calendar days: `dueDate = submitted + targetDays`. Documented as calendar, not working, days. */
export function serviceDueDate(submittedDate: string, targetDays: number | null | undefined): string | null {
  if (!targetDays) return null;
  const d = new Date(`${submittedDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + targetDays);
  return d.toISOString().slice(0, 10);
}
