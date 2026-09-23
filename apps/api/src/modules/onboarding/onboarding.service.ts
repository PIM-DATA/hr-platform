import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, EMPLOYMENT_TYPES, ONBOARDING_COLUMNS, ONBOARDING_SHEETS as S, ONBOARDING_SHEET_ORDER, ONBOARDING_TEMPLATE_VERSION,
  createDepartmentSchema, createEmployeeSchema, createJobSchema, createOrganizationSchema, createPositionSchema, isValidTimezone,
  type OnboardingCounts, type OnboardingImportListQuery, type OnboardingImportRunDto, type OnboardingIssue, type OnboardingPreviewDto,
} from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { logger } from '../../lib/logger';
import { createOrganizationWithTx } from '../organization/organizations.service';
import { createDepartmentWithTx, setDepartmentHeadWithTx } from '../organization/departments.service';
import { createJobWithTx } from '../organization/jobs.service';
import { createPositionWithTx } from '../organization/positions.service';
import { createEmployeeWithTx } from '../employees/employees.service';
import type { Actor } from '../leave/leave-types.service';
import { parseWorkbook, type ParsedRow, type ParsedWorkbook } from './workbook';

/**
 * Customer onboarding import.
 *
 * Create-oriented by design: every row declares an intent to CREATE. A code that already exists is an error, never a
 * silent update — this is an onboarding tool, not a bulk-edit tool.
 *
 * Preview and commit run the *same* validation; commit simply re-parses the uploaded file, re-validates inside the
 * transaction (the database may have changed since the preview) and then creates everything through the ordinary
 * domain helpers, so uniqueness, assignment, manager-cycle and history rules are the ones the UI uses — not a copy.
 *
 * All-or-nothing: one transaction, one advisory lock, and any failure rolls the whole import back.
 */
type Tx = Prisma.TransactionClient;

/** Fixed key for the transaction-scoped advisory lock that serialises onboarding commits (nothing else takes it). */
const ONBOARDING_LOCK_KEY = 4917_2301;

const zeroCounts = (): OnboardingCounts => ({ organizations: 0, departments: 0, jobs: 0, positions: 0, employees: 0 });
const sheetRank = new Map(ONBOARDING_SHEET_ORDER.map((s, i) => [s as string, i]));
/** Deterministic ordering so the UI and the tests always see the same list. */
function sortIssues(issues: OnboardingIssue[]): OnboardingIssue[] {
  return [...issues].sort((a, b) =>
    (sheetRank.get(a.sheet) ?? 99) - (sheetRank.get(b.sheet) ?? 99) || a.row - b.row || (a.field ?? '').localeCompare(b.field ?? '') || a.code.localeCompare(b.code));
}

export const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** Keeps a basename with safe characters only: the name is displayed and stored, never used to build a path. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'workbook.xlsx';
  const cleaned = base.replace(/[^A-Za-z0-9._ ()\[\]&+,'-]/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'workbook.xlsx').slice(0, 120);
}

// ---------- validated, normalized rows ----------
interface OrgRow { excelRow: number; code: string; name: string; timezone?: string }
interface DeptRow { excelRow: number; organizationCode: string; code: string; name: string; parentCode?: string; headEmployeeCode?: string }
interface JobRow { excelRow: number; code: string; title: string; level: number; description?: string }
interface PosRow { excelRow: number; code: string; title: string; organizationCode: string; departmentCode: string; jobCode: string }
interface EmpRow { excelRow: number; code: string; firstName: string; lastName: string; nickname?: string; email: string; phone?: string; hireDate: string; employmentType: string; positionCode: string; managerCode?: string }

interface Validated {
  organizations: OrgRow[];
  departments: DeptRow[];
  jobs: JobRow[];
  positions: PosRow[];
  employees: EmpRow[];
  errors: OnboardingIssue[];
  warnings: OnboardingIssue[];
}

const err = (sheet: string, row: number, code: string, message: string, field?: string): OnboardingIssue => ({ sheet, row, field, code, message });

/** Reports zod problems in the vocabulary the user sees (the column header), not the internal field name. */
type SafeParse<T> = { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
function zodIssues(sheet: string, row: number, result: SafeParse<unknown>, map: Record<string, string>): OnboardingIssue[] {
  if (result.success) return [];
  return result.error.issues.map((i) => {
    const key = String(i.path[0] ?? '');
    return err(sheet, row, 'ONBOARDING_INVALID_VALUE', i.message, map[key] ?? key);
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates every sheet: field shapes through the same zod schemas the HTTP API uses, then duplicates inside the
 * workbook, then references (which may point forward inside the workbook or at existing rows), then conflicts with
 * what is already in the database. Reads the database in a handful of batched queries — never per row.
 */
async function validate(parsed: ParsedWorkbook): Promise<Validated> {
  const errors: OnboardingIssue[] = [...parsed.issues.filter((i) => i.code !== 'ONBOARDING_UNKNOWN_COLUMN')];
  const warnings: OnboardingIssue[] = [...parsed.issues.filter((i) => i.code === 'ONBOARDING_UNKNOWN_COLUMN')];
  const out: Validated = { organizations: [], departments: [], jobs: [], positions: [], employees: [], errors, warnings };

  // ---------- Organizations ----------
  const orgByCode = new Map<string, OrgRow>();
  for (const row of parsed.sheets[S.organizations]) {
    const v = row.values;
    const parsedOrg = createOrganizationSchema.safeParse({ code: v.organizationCode ?? '', name: v.name ?? '' });
    const issues = zodIssues(S.organizations, row.excelRow, parsedOrg, { code: 'organizationCode', name: 'name' });
    if (v.timezone && !isValidTimezone(v.timezone)) issues.push(err(S.organizations, row.excelRow, 'ONBOARDING_INVALID_VALUE', 'Timezone must be an IANA name such as Asia/Bangkok', 'timezone'));
    if (issues.length) { errors.push(...issues); continue; }
    const org: OrgRow = { excelRow: row.excelRow, code: parsedOrg.data!.code, name: parsedOrg.data!.name, timezone: v.timezone };
    const clash = orgByCode.get(org.code);
    if (clash) { errors.push(err(S.organizations, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `organizationCode ${org.code} is already used on row ${clash.excelRow}`, 'organizationCode')); continue; }
    orgByCode.set(org.code, org);
    out.organizations.push(org);
  }

  // ---------- Jobs ----------
  const jobByCode = new Map<string, JobRow>();
  for (const row of parsed.sheets[S.jobs]) {
    const v = row.values;
    const parsedJob = createJobSchema.safeParse({ code: v.jobCode ?? '', title: v.title ?? '', level: v.level ?? 1, description: v.description });
    const issues = zodIssues(S.jobs, row.excelRow, parsedJob, { code: 'jobCode', title: 'title', level: 'level', description: 'description' });
    if (issues.length) { errors.push(...issues); continue; }
    const job: JobRow = { excelRow: row.excelRow, code: parsedJob.data!.code, title: parsedJob.data!.title, level: parsedJob.data!.level, description: parsedJob.data!.description ?? undefined };
    const clash = jobByCode.get(job.code);
    if (clash) { errors.push(err(S.jobs, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `jobCode ${job.code} is already used on row ${clash.excelRow}`, 'jobCode')); continue; }
    jobByCode.set(job.code, job);
    out.jobs.push(job);
  }

  // ---------- Departments ----------
  const deptKey = (orgCode: string, code: string) => `${orgCode}::${code}`;
  const deptByKey = new Map<string, DeptRow>();
  for (const row of parsed.sheets[S.departments]) {
    const v = row.values;
    const code = (v.departmentCode ?? '').trim().toUpperCase();
    const orgCode = (v.organizationCode ?? '').trim().toUpperCase();
    const parsedDept = createDepartmentSchema.safeParse({ organizationId: orgCode || 'missing', code, name: v.name ?? '' });
    const issues = zodIssues(S.departments, row.excelRow, parsedDept, { organizationId: 'organizationCode', code: 'departmentCode', name: 'name' });
    if (!orgCode) issues.push(err(S.departments, row.excelRow, 'ONBOARDING_REQUIRED', 'organizationCode is required', 'organizationCode'));
    if (issues.length) { errors.push(...issues); continue; }
    const dept: DeptRow = {
      excelRow: row.excelRow, organizationCode: orgCode, code: parsedDept.data!.code, name: parsedDept.data!.name,
      parentCode: v.parentDepartmentCode?.trim().toUpperCase() || undefined,
      headEmployeeCode: v.headEmployeeCode?.trim().toUpperCase() || undefined,
    };
    const clash = deptByKey.get(deptKey(dept.organizationCode, dept.code));
    if (clash) { errors.push(err(S.departments, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `departmentCode ${dept.code} is already used for this organization on row ${clash.excelRow}`, 'departmentCode')); continue; }
    deptByKey.set(deptKey(dept.organizationCode, dept.code), dept);
    out.departments.push(dept);
  }

  // ---------- Positions ----------
  const posByCode = new Map<string, PosRow>();
  for (const row of parsed.sheets[S.positions]) {
    const v = row.values;
    const parsedPos = createPositionSchema.safeParse({ departmentId: (v.departmentCode ?? '') || 'missing', jobId: (v.jobCode ?? '') || 'missing', code: v.positionCode ?? '', title: v.title ?? '' });
    const issues = zodIssues(S.positions, row.excelRow, parsedPos, { departmentId: 'departmentCode', jobId: 'jobCode', code: 'positionCode', title: 'title' });
    for (const [field, value] of [['organizationCode', v.organizationCode], ['departmentCode', v.departmentCode], ['jobCode', v.jobCode]] as const) {
      if (!value?.trim()) issues.push(err(S.positions, row.excelRow, 'ONBOARDING_REQUIRED', `${field} is required`, field));
    }
    if (issues.length) { errors.push(...issues); continue; }
    const pos: PosRow = {
      excelRow: row.excelRow, code: parsedPos.data!.code, title: parsedPos.data!.title,
      organizationCode: v.organizationCode!.trim().toUpperCase(), departmentCode: v.departmentCode!.trim().toUpperCase(), jobCode: v.jobCode!.trim().toUpperCase(),
    };
    const clash = posByCode.get(pos.code);
    if (clash) { errors.push(err(S.positions, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `positionCode ${pos.code} is already used on row ${clash.excelRow}`, 'positionCode')); continue; }
    posByCode.set(pos.code, pos);
    out.positions.push(pos);
  }

  // ---------- Employees ----------
  const empByCode = new Map<string, EmpRow>();
  const emailSeen = new Map<string, EmpRow>();
  for (const row of parsed.sheets[S.employees]) {
    const v = row.values;
    const issues: OnboardingIssue[] = [];
    const hireDate = v.hireDate?.trim() ?? '';
    if (hireDate && !DATE_RE.test(hireDate)) {
      issues.push(err(S.employees, row.excelRow, 'ONBOARDING_INVALID_DATE', 'hireDate must be written as YYYY-MM-DD (for example 2026-01-31)', 'hireDate'));
    }
    const employmentType = v.employmentType?.trim().toUpperCase() || 'FULL_TIME';
    if (!EMPLOYMENT_TYPES.includes(employmentType as (typeof EMPLOYMENT_TYPES)[number])) {
      issues.push(err(S.employees, row.excelRow, 'ONBOARDING_INVALID_VALUE', `employmentType must be one of ${EMPLOYMENT_TYPES.join(', ')}`, 'employmentType'));
    }
    const parsedEmp = createEmployeeSchema.safeParse({
      employeeCode: v.employeeCode ?? '', firstName: v.firstName ?? '', lastName: v.lastName ?? '', nickname: v.nickname, email: v.email ?? '', phone: v.phone,
      hireDate: DATE_RE.test(hireDate) ? hireDate : '2000-01-01', employmentType: EMPLOYMENT_TYPES.includes(employmentType as (typeof EMPLOYMENT_TYPES)[number]) ? employmentType : 'FULL_TIME',
      positionId: (v.positionCode ?? '') || 'missing',
    });
    issues.push(...zodIssues(S.employees, row.excelRow, parsedEmp, {
      employeeCode: 'employeeCode', firstName: 'firstName', lastName: 'lastName', nickname: 'nickname', email: 'email', phone: 'phone', hireDate: 'hireDate', positionId: 'positionCode',
    }));
    if (!v.positionCode?.trim()) issues.push(err(S.employees, row.excelRow, 'ONBOARDING_REQUIRED', 'positionCode is required', 'positionCode'));
    if (issues.length) { errors.push(...issues); continue; }
    const emp: EmpRow = {
      excelRow: row.excelRow, code: parsedEmp.data!.employeeCode, firstName: parsedEmp.data!.firstName, lastName: parsedEmp.data!.lastName,
      nickname: parsedEmp.data!.nickname ?? undefined, email: parsedEmp.data!.email, phone: parsedEmp.data!.phone ?? undefined,
      hireDate: hireDate, employmentType, positionCode: v.positionCode!.trim().toUpperCase(), managerCode: v.managerEmployeeCode?.trim().toUpperCase() || undefined,
    };
    const clash = empByCode.get(emp.code);
    if (clash) { errors.push(err(S.employees, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `employeeCode ${emp.code} is already used on row ${clash.excelRow}`, 'employeeCode')); continue; }
    const emailClash = emailSeen.get(emp.email.toLowerCase());
    if (emailClash) { errors.push(err(S.employees, row.excelRow, 'ONBOARDING_DUPLICATE_IN_FILE', `email is already used on row ${emailClash.excelRow}`, 'email')); continue; }
    empByCode.set(emp.code, emp);
    emailSeen.set(emp.email.toLowerCase(), emp);
    out.employees.push(emp);
  }

  // ---------- existing database entities (batched; never per row) ----------
  const [existingOrgs, existingDepts, existingJobs, existingPositions, existingEmployees] = await Promise.all([
    prisma.organization.findMany({ where: { code: { in: [...orgByCode.keys()] } }, select: { id: true, code: true, isActive: true } }),
    prisma.department.findMany({ where: { code: { in: out.departments.map((d) => d.code) } }, select: { id: true, code: true, organizationId: true, organization: { select: { code: true } } } }),
    prisma.job.findMany({ where: { code: { in: [...jobByCode.keys()] } }, select: { id: true, code: true, isActive: true } }),
    prisma.position.findMany({ where: { code: { in: [...posByCode.keys()] } }, select: { id: true, code: true } }),
    prisma.employee.findMany({
      where: { OR: [{ employeeCode: { in: [...empByCode.keys(), ...out.employees.map((e) => e.managerCode ?? '')].filter(Boolean) } }, { email: { in: out.employees.map((e) => e.email) } }] },
      select: { id: true, employeeCode: true, email: true, employmentStatus: true, managerId: true },
    }),
  ]);
  const existingOrgByCode = new Map(existingOrgs.map((o) => [o.code, o]));
  const existingDeptByKey = new Map(existingDepts.map((d) => [deptKey(d.organization.code, d.code), d]));
  const existingJobByCode = new Map(existingJobs.map((j) => [j.code, j]));
  const existingPositionByCode = new Map(existingPositions.map((p) => [p.code, p]));
  const existingEmployeeByCode = new Map(existingEmployees.map((e) => [e.employeeCode, e]));
  const existingEmails = new Set(existingEmployees.map((e) => e.email.toLowerCase()));

  // conflicts: a row declares CREATE, so an existing code is an error (never an implicit update)
  for (const o of out.organizations) if (existingOrgByCode.has(o.code)) errors.push(err(S.organizations, o.excelRow, 'ORGANIZATION_CODE_EXISTS', `Organization ${o.code} already exists in the system`, 'organizationCode'));
  for (const j of out.jobs) if (existingJobByCode.has(j.code)) errors.push(err(S.jobs, j.excelRow, 'JOB_CODE_EXISTS', `Job ${j.code} already exists in the system`, 'jobCode'));
  for (const p of out.positions) if (existingPositionByCode.has(p.code)) errors.push(err(S.positions, p.excelRow, 'POSITION_CODE_EXISTS', `Position ${p.code} already exists in the system`, 'positionCode'));
  for (const d of out.departments) if (existingDeptByKey.has(deptKey(d.organizationCode, d.code))) errors.push(err(S.departments, d.excelRow, 'DEPARTMENT_CODE_EXISTS', `Department ${d.code} already exists in organization ${d.organizationCode}`, 'departmentCode'));
  for (const e of out.employees) {
    if (existingEmployeeByCode.has(e.code)) errors.push(err(S.employees, e.excelRow, 'EMPLOYEE_CODE_EXISTS', `Employee ${e.code} already exists in the system`, 'employeeCode'));
    if (existingEmails.has(e.email.toLowerCase())) errors.push(err(S.employees, e.excelRow, 'EMPLOYEE_EMAIL_EXISTS', 'An employee with this email already exists', 'email'));
  }

  // ---------- references ----------
  const orgExists = (code: string) => orgByCode.has(code) || existingOrgByCode.has(code);
  const deptExists = (orgCode: string, code: string) => deptByKey.has(deptKey(orgCode, code)) || existingDeptByKey.has(deptKey(orgCode, code));

  for (const d of out.departments) {
    if (!orgExists(d.organizationCode)) errors.push(err(S.departments, d.excelRow, 'ORGANIZATION_NOT_FOUND', `Organization ${d.organizationCode} is not in this workbook or in the system`, 'organizationCode'));
    if (d.parentCode) {
      if (d.parentCode === d.code) errors.push(err(S.departments, d.excelRow, 'DEPARTMENT_SELF_PARENT', 'A department cannot be its own parent', 'parentDepartmentCode'));
      else if (!deptExists(d.organizationCode, d.parentCode)) errors.push(err(S.departments, d.excelRow, 'DEPARTMENT_PARENT_NOT_FOUND', `Parent department ${d.parentCode} is not in this workbook or in organization ${d.organizationCode}`, 'parentDepartmentCode'));
    }
  }
  // cycle detection across the workbook rows (existing departments already form a valid tree)
  for (const d of out.departments) {
    const seen = new Set<string>([deptKey(d.organizationCode, d.code)]);
    let cursor = d.parentCode ? deptByKey.get(deptKey(d.organizationCode, d.parentCode)) : undefined;
    while (cursor) {
      const key = deptKey(cursor.organizationCode, cursor.code);
      if (seen.has(key)) { errors.push(err(S.departments, d.excelRow, 'DEPARTMENT_CYCLE', 'These departments form a parent loop', 'parentDepartmentCode')); break; }
      seen.add(key);
      cursor = cursor.parentCode ? deptByKey.get(deptKey(cursor.organizationCode, cursor.parentCode)) : undefined;
    }
  }

  for (const p of out.positions) {
    if (!orgExists(p.organizationCode)) errors.push(err(S.positions, p.excelRow, 'ORGANIZATION_NOT_FOUND', `Organization ${p.organizationCode} is not in this workbook or in the system`, 'organizationCode'));
    if (!deptExists(p.organizationCode, p.departmentCode)) errors.push(err(S.positions, p.excelRow, 'DEPARTMENT_NOT_FOUND', `Department ${p.departmentCode} is not in organization ${p.organizationCode}`, 'departmentCode'));
    if (!jobByCode.has(p.jobCode) && !existingJobByCode.has(p.jobCode)) errors.push(err(S.positions, p.excelRow, 'JOB_NOT_FOUND', `Job ${p.jobCode} is not in this workbook or in the system`, 'jobCode'));
  }

  for (const e of out.employees) {
    if (!posByCode.has(e.positionCode) && !existingPositionByCode.has(e.positionCode)) {
      errors.push(err(S.employees, e.excelRow, 'POSITION_NOT_FOUND', `Position ${e.positionCode} is not in this workbook or in the system`, 'positionCode'));
    }
    if (e.managerCode) {
      if (e.managerCode === e.code) errors.push(err(S.employees, e.excelRow, 'EMPLOYEE_SELF_MANAGER', 'An employee cannot be their own manager', 'managerEmployeeCode'));
      else {
        const inFile = empByCode.get(e.managerCode);
        const existing = existingEmployeeByCode.get(e.managerCode);
        if (!inFile && !existing) errors.push(err(S.employees, e.excelRow, 'MANAGER_NOT_FOUND', `Manager ${e.managerCode} is not in this workbook or in the system`, 'managerEmployeeCode'));
        else if (!inFile && existing && existing.employmentStatus !== 'ACTIVE') errors.push(err(S.employees, e.excelRow, 'MANAGER_INACTIVE', `Manager ${e.managerCode} is not an active employee`, 'managerEmployeeCode'));
      }
    }
  }
  // manager cycles among the new employees (existing employees are never modified, so only new edges can create one)
  for (const e of out.employees) {
    const seen = new Set<string>([e.code]);
    let cursor = e.managerCode ? empByCode.get(e.managerCode) : undefined;
    while (cursor) {
      if (seen.has(cursor.code)) { errors.push(err(S.employees, e.excelRow, 'MANAGER_CYCLE', 'These employees manage each other in a loop', 'managerEmployeeCode')); break; }
      seen.add(cursor.code);
      cursor = cursor.managerCode ? empByCode.get(cursor.managerCode) : undefined;
    }
  }

  // department head: the employee must exist (workbook or system) and belong to that department's organization
  for (const d of out.departments) {
    if (!d.headEmployeeCode) continue;
    const inFile = empByCode.get(d.headEmployeeCode);
    const existing = existingEmployeeByCode.get(d.headEmployeeCode);
    if (!inFile && !existing) { errors.push(err(S.departments, d.excelRow, 'EMPLOYEE_NOT_FOUND', `Employee ${d.headEmployeeCode} is not in this workbook or in the system`, 'headEmployeeCode')); continue; }
    if (existing && existing.employmentStatus !== 'ACTIVE') errors.push(err(S.departments, d.excelRow, 'EMPLOYEE_INACTIVE', `Employee ${d.headEmployeeCode} is not active`, 'headEmployeeCode'));
    if (inFile) {
      const position = posByCode.get(inFile.positionCode);
      const departmentOfHead = position ? { org: position.organizationCode, dept: position.departmentCode } : undefined;
      if (departmentOfHead && departmentOfHead.dept !== d.code) {
        errors.push(err(S.departments, d.excelRow, 'DEPARTMENT_HEAD_NOT_IN_DEPARTMENT', `Employee ${d.headEmployeeCode} is not assigned to department ${d.code}`, 'headEmployeeCode'));
      }
    }
  }

  return out;
}

const countsOf = (v: Validated): OnboardingCounts => ({
  organizations: v.organizations.length, departments: v.departments.length, jobs: v.jobs.length, positions: v.positions.length, employees: v.employees.length,
});

const toRunDto = (run: { id: string; fileName: string; fileHash: string; templateVersion: number; organizationCount: number; departmentCount: number; jobCount: number; positionCount: number; employeeCount: number; createdAt: Date; createdBy?: { id: string; email: string } | null }, replayed = false): OnboardingImportRunDto => ({
  id: run.id, fileName: run.fileName, fileHash: run.fileHash, templateVersion: run.templateVersion,
  counts: { organizations: run.organizationCount, departments: run.departmentCount, jobs: run.jobCount, positions: run.positionCount, employees: run.employeeCount },
  createdBy: run.createdBy ?? null, createdAt: run.createdAt.toISOString(), ...(replayed ? { replayed: true } : {}),
});

export const onboardingService = {
  /** Validation only. Reads the database, writes nothing — no entities, no audit, no stored workbook. */
  async preview(buffer: Buffer, fileName: string, actor: Actor): Promise<OnboardingPreviewDto> {
    const started = Date.now();
    const hash = sha256(buffer);
    const parsed = await parseWorkbook(buffer);
    const validated = await validate(parsed);
    const summary = countsOf(validated);
    // Logs carry counts and identifiers only — never names, emails or any row content.
    logger.info({ event: 'onboarding_preview', actorUserId: actor.auth.userId, fileHash: hash.slice(0, 12), sizeBytes: buffer.length, summary, errors: validated.errors.length, warnings: validated.warnings.length, durationMs: Date.now() - started }, 'onboarding preview');
    return {
      file: { name: sanitizeFileName(fileName), sha256: hash, sizeBytes: buffer.length, templateVersion: parsed.templateVersion },
      summary, valid: validated.errors.length === 0, errors: sortIssues(validated.errors), warnings: sortIssues(validated.warnings),
    };
  },

  /**
   * Creates everything in one transaction. The uploaded file is re-hashed (it must be the previewed one), re-parsed and
   * re-validated *inside* the transaction, because the database may have changed since the preview.
   */
  async commit(buffer: Buffer, fileName: string, expectedSha256: string, actor: Actor): Promise<OnboardingImportRunDto> {
    const started = Date.now();
    const hash = sha256(buffer);
    if (hash !== expectedSha256) throw new AppError(409, 'ONBOARDING_FILE_CHANGED', 'The selected file is not the one that was previewed. Preview it again before importing.');

    // Re-importing an already committed workbook is a no-op replay, not a duplicate import.
    const already = await prisma.onboardingImportRun.findUnique({ where: { fileHash: hash }, include: { createdBy: { select: { id: true, email: true } } } });
    if (already) {
      logger.info({ event: 'onboarding_import_replayed', actorUserId: actor.auth.userId, importRunId: already.id, fileHash: hash.slice(0, 12) }, 'onboarding import replayed');
      return toRunDto(already, true);
    }

    const parsed = await parseWorkbook(buffer);
    const preflight = await validate(parsed);
    if (preflight.errors.length) throw new AppError(400, 'ONBOARDING_VALIDATION_FAILED', `The workbook has ${preflight.errors.length} error(s) and was not imported`);

    const name = sanitizeFileName(fileName);
    try {
      const run = await prisma.$transaction(async (tx) => {
        // Serialise onboarding imports against each other (transaction-scoped; released on commit or rollback).
        // Business requests never take this lock, so normal traffic is unaffected.
        // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns void, which has no Prisma column type.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ONBOARDING_LOCK_KEY}::bigint)`;

        // Another import may have committed this exact file while we waited for the lock.
        const raced = await tx.onboardingImportRun.findUnique({ where: { fileHash: hash }, include: { createdBy: { select: { id: true, email: true } } } });
        if (raced) return { run: raced, replayed: true as const };

        // Re-validate inside the transaction: the database may have changed since the preview.
        const validated = await validate(parsed);
        if (validated.errors.length) throw new AppError(409, 'ONBOARDING_VALIDATION_FAILED', `The workbook no longer matches the system (${validated.errors.length} error(s)) — preview it again`);

        const orgIdByCode = new Map<string, string>();
        const deptIdByKey = new Map<string, string>();
        const jobIdByCode = new Map<string, string>();
        const posIdByCode = new Map<string, string>();
        const empIdByCode = new Map<string, string>();
        const key = (org: string, dept: string) => `${org}::${dept}`;

        // 1. organizations
        for (const o of validated.organizations) {
          const created = await createOrganizationWithTx(tx, { code: o.code, name: o.name, timezone: o.timezone }, actor);
          orgIdByCode.set(o.code, created.id);
        }
        const resolveOrgId = async (code: string) => {
          const known = orgIdByCode.get(code);
          if (known) return known;
          const row = await tx.organization.findUnique({ where: { code }, select: { id: true } });
          if (!row) throw new AppError(409, 'ORGANIZATION_NOT_FOUND', `Organization ${code} could not be resolved`);
          orgIdByCode.set(code, row.id);
          return row.id;
        };

        // 2. departments, parents before children (the workbook may list them in any order)
        const pending = [...validated.departments];
        let guard = pending.length + 1;
        while (pending.length && guard-- > 0) {
          const remaining: typeof pending = [];
          for (const d of pending) {
            const organizationId = await resolveOrgId(d.organizationCode);
            let parentId: string | null = null;
            if (d.parentCode) {
              parentId = deptIdByKey.get(key(d.organizationCode, d.parentCode))
                ?? (await tx.department.findFirst({ where: { organizationId, code: d.parentCode }, select: { id: true } }))?.id
                ?? null;
              if (!parentId) { remaining.push(d); continue; } // parent is created later in this workbook
            }
            const created = await createDepartmentWithTx(tx, { organizationId, parentId, code: d.code, name: d.name }, actor);
            deptIdByKey.set(key(d.organizationCode, d.code), created.id);
          }
          if (remaining.length === pending.length) throw new AppError(409, 'DEPARTMENT_PARENT_NOT_FOUND', 'Department parents could not be resolved');
          pending.length = 0;
          pending.push(...remaining);
        }

        // 3. jobs
        for (const j of validated.jobs) {
          const created = await createJobWithTx(tx, { code: j.code, title: j.title, level: j.level, description: j.description ?? null }, actor);
          jobIdByCode.set(j.code, created.id);
        }

        // 4. positions
        for (const p of validated.positions) {
          const organizationId = await resolveOrgId(p.organizationCode);
          const departmentId = deptIdByKey.get(key(p.organizationCode, p.departmentCode))
            ?? (await tx.department.findFirst({ where: { organizationId, code: p.departmentCode }, select: { id: true } }))?.id;
          const jobId = jobIdByCode.get(p.jobCode) ?? (await tx.job.findUnique({ where: { code: p.jobCode }, select: { id: true } }))?.id;
          if (!departmentId) throw new AppError(409, 'DEPARTMENT_NOT_FOUND', `Department ${p.departmentCode} could not be resolved`);
          if (!jobId) throw new AppError(409, 'JOB_NOT_FOUND', `Job ${p.jobCode} could not be resolved`);
          const created = await createPositionWithTx(tx, { departmentId, jobId, code: p.code, title: p.title }, actor);
          posIdByCode.set(p.code, created.id);
        }

        // 5. employees without managers first, so a manager may appear anywhere in the sheet
        for (const e of validated.employees) {
          const positionId = posIdByCode.get(e.positionCode) ?? (await tx.position.findUnique({ where: { code: e.positionCode }, select: { id: true } }))?.id;
          if (!positionId) throw new AppError(409, 'POSITION_NOT_FOUND', `Position ${e.positionCode} could not be resolved`);
          const created = await createEmployeeWithTx(tx, {
            employeeCode: e.code, firstName: e.firstName, lastName: e.lastName, nickname: e.nickname ?? null, email: e.email, phone: e.phone ?? null,
            hireDate: new Date(`${e.hireDate}T00:00:00.000Z`), employmentType: e.employmentType as (typeof EMPLOYMENT_TYPES)[number], positionId, managerId: null,
          }, actor);
          empIdByCode.set(e.code, created.id);
        }

        // 6. manager assignments (second pass → forward references work), through the normal service so history + audit match
        for (const e of validated.employees) {
          if (!e.managerCode) continue;
          const managerId = empIdByCode.get(e.managerCode) ?? (await tx.employee.findUnique({ where: { employeeCode: e.managerCode }, select: { id: true } }))?.id;
          if (!managerId) throw new AppError(409, 'MANAGER_NOT_FOUND', `Manager ${e.managerCode} could not be resolved`);
          await assignManagerWithTx(tx, empIdByCode.get(e.code)!, managerId, new Date(`${e.hireDate}T00:00:00.000Z`), actor);
        }

        // 7. department heads, once every employee exists
        for (const d of validated.departments) {
          if (!d.headEmployeeCode) continue;
          const departmentId = deptIdByKey.get(key(d.organizationCode, d.code))!;
          const headId = empIdByCode.get(d.headEmployeeCode) ?? (await tx.employee.findUnique({ where: { employeeCode: d.headEmployeeCode }, select: { id: true } }))?.id;
          if (!headId) throw new AppError(409, 'EMPLOYEE_NOT_FOUND', `Employee ${d.headEmployeeCode} could not be resolved`);
          await setDepartmentHeadWithTx(tx, departmentId, headId, actor);
        }

        // 8. import run + batch audit (counts and file identity only — never row content)
        const counts = countsOf(validated);
        const created = await tx.onboardingImportRun.create({
          data: {
            fileName: name, fileHash: hash, templateVersion: parsed.templateVersion,
            organizationCount: counts.organizations, departmentCount: counts.departments, jobCount: counts.jobs, positionCount: counts.positions, employeeCount: counts.employees,
            createdByUserId: actor.auth.userId,
          },
          include: { createdBy: { select: { id: true, email: true } } },
        });
        await auditService.log({
          userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
          action: AUDIT_ACTIONS.IMPORT_CUSTOMER_ONBOARDING, module: 'onboarding', recordType: 'OnboardingImportRun', recordId: created.id,
          newValue: { fileName: name, fileHash: hash, templateVersion: parsed.templateVersion, counts },
        }, tx);
        return { run: created, replayed: false as const };
      }, { timeout: 120_000 });

      logger.info({ event: 'onboarding_import_committed', actorUserId: actor.auth.userId, importRunId: run.run.id, fileHash: hash.slice(0, 12), replayed: run.replayed, durationMs: Date.now() - started }, 'onboarding import committed');
      return toRunDto(run.run, run.replayed);
    } catch (e) {
      if (e instanceof AppError) throw e;
      // Unique/FK violations are the database backstop behind validation: report them as a business failure.
      logger.error({ event: 'onboarding_import_failed', actorUserId: actor.auth.userId, fileHash: hash.slice(0, 12), err: e }, 'onboarding import failed');
      throw new AppError(409, 'ONBOARDING_IMPORT_FAILED', 'The import could not be completed and nothing was created. Preview the workbook again.');
    }
  },

  /** Metadata only: counts, file identity, who and when. Never row content. */
  async listImports(q: OnboardingImportListQuery): Promise<{ data: OnboardingImportRunDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const [total, rows] = await prisma.$transaction([
      prisma.onboardingImportRun.count(),
      prisma.onboardingImportRun.findMany({ include: { createdBy: { select: { id: true, email: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map((r) => toRunDto(r)), meta: { page: q.page, pageSize: q.pageSize, total } };
  },
};

/** Manager assignment on the caller's transaction: same pointer + history + audit as the employee service's own path. */
async function assignManagerWithTx(tx: Tx, employeeId: string, managerId: string, startDate: Date, actor: Actor) {
  const { assertValidManager } = await import('../employees/assignment.service');
  await assertValidManager(tx, employeeId, managerId);
  await tx.employee.update({ where: { id: employeeId }, data: { managerId, updatedBy: actor.auth.userId } });
  await tx.employeeManager.create({ data: { employeeId, managerId, startDate } });
  await auditService.log({
    userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent,
    action: AUDIT_ACTIONS.CHANGE_EMPLOYEE_MANAGER, module: 'employees', recordType: 'Employee', recordId: employeeId,
    oldValue: { managerId: null }, newValue: { managerId, effectiveDate: startDate.toISOString() },
  }, tx);
}

export const ONBOARDING_ADVISORY_LOCK_KEY = ONBOARDING_LOCK_KEY;
