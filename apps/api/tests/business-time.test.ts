/**
 * Task 53 (T44-P1-23) — business dates follow the ORGANIZATION's IANA timezone, never a hard-coded zone or the
 * server's UTC date.
 *
 * Audit evidence (docs/final-enterprise-readiness-audit.md §10): "Hard-coded Asia/Bangkok in expense, services SLA,
 * certification expiry, probation, compensation baseline and benefits; hard-coded UTC in ER; server UTC date in copilot
 * tools, document expiry, several Report Center datasets (services SLA disagrees with the module for 7 h a day),
 * Employee 360 certification status and the dashboard new-hire window." Plus §10: "sequence year is UTC".
 *
 * Every case pins the clock (Date only) to an instant whose local date differs from its UTC date or from Bangkok's:
 *   BKK_0130 = 2026-09-30T18:30Z → Bangkok 2026-10-01 01:30, UTC 2026-09-30
 *   NYC_2200 = 2026-10-01T02:00Z → New York 2026-09-30 22:00, Bangkok 2026-10-01 09:00, UTC 2026-10-01
 * Results must be identical whatever the process TZ is (the file is also run under TZ=UTC / Asia/Bangkok /
 * America/New_York — see the Task 53 report).
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { serviceAnalyticsService } from '../src/modules/employee-services/services-analytics.service';
import { certificationService } from '../src/modules/learning/certification.service';
import { erReportService } from '../src/modules/employee-relations/er-report.service';
import { getDashboardSummary } from '../src/modules/dashboard/dashboard.service';
import { probationService } from '../src/modules/lifecycle/probation.service';
import { domainRollups } from '../src/modules/analytics/domain-rollups';
import { buildWhere, type ColumnDef } from '../src/modules/reports/prisma-runner';
import { businessDateRangeInstants, businessDayStart, businessToday, toUtcDate } from '@hr/shared';
import { businessYear, employeeTodays, organizationTodays, referenceZone, todayForEmployee, todayForOrganization } from '../src/services/business-time/business-time';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthContext } from '../src/modules/auth/auth.types';
import { createTestServer, createUser, loginAs, resetDatabase } from './helpers';

const app: Server = createTestServer();
const PW = 'Correct-Horse-1';
type Session = { cookie: string; csrf: string; user: { id: string } };
const as = (s: Session, m: 'get' | 'post', url: string) => request(app)[m](url).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

const BKK_0130 = new Date('2026-09-30T18:30:00Z');
const NYC_2200 = new Date('2026-10-01T02:00:00Z');
const at = (now: Date) => vi.useFakeTimers({ toFake: ['Date'], now });

let hrAdmin: Session;
const org: Record<string, { id: string; name: string }> = {};
const emp: Record<string, string> = {};
let hrAuth: AuthContext;

beforeAll(async () => {
  await resetDatabase();
  for (const [key, tz] of [['BKK', 'Asia/Bangkok'], ['NYC', 'America/New_York'], ['UTC', 'UTC']] as const) {
    const o = await prisma.organization.create({ data: { code: `T53${key}`, name: `T53 ${key}`, timezone: tz } });
    org[key] = { id: o.id, name: o.name };
    const dept = await prisma.department.create({ data: { organizationId: o.id, code: `D${key}`, name: `Dept ${key}` } });
    const job = await prisma.job.create({ data: { code: `J${key}`, title: `Job ${key}`, level: 1 } });
    const pos = await prisma.position.create({ data: { departmentId: dept.id, code: `P${key}`, title: `Pos ${key}`, jobId: job.id } });
    for (let i = 1; i <= 6; i += 1) {
      const code = `${key}${i}`;
      emp[code] = (await prisma.employee.create({ data: { employeeCode: code, firstName: code, lastName: 'T', email: `${code.toLowerCase()}@t53.local`, hireDate: new Date('2020-01-01T00:00:00Z'), organizationId: o.id, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE', positionHistory: { create: { positionId: pos.id, departmentId: dept.id, startDate: new Date('2020-01-01T00:00:00Z') } } } })).id;
    }
  }
  await createUser({ email: 'hradmin@t53.local', password: PW, role: 'HR_ADMIN', employeeId: emp.UTC6 });
  hrAdmin = await loginAs(app, 'hradmin@t53.local', PW);
  const perms = ['employees.view', 'probation.view', 'probation.manage'];
  hrAuth = { userId: hrAdmin.user.id, employeeId: emp.UTC6!, roles: ['HR_ADMIN'], permissions: perms, dataScope: 'ALL', permissionScopes: Object.fromEntries(perms.map((p) => [p, 'ALL'])) } as unknown as AuthContext;
}, 180000);
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

async function serviceRequest(employeeKey: string, orgKey: string, dueDate: string, n: number) {
  const type = await prisma.serviceRequestType.findFirst() ?? await prisma.serviceRequestType.create({ data: { code: 'T53', name: 'T53 request', category: 'GENERAL', fulfillmentType: 'GENERAL', targetDays: 1, createdByUserId: hrAdmin.user.id } });
  return prisma.serviceRequest.create({ data: { requestNumber: `SR-T53-${n}`, requestTypeId: type.id, employeeId: emp[employeeKey]!, requestTypeCodeSnapshot: 'T53', requestTypeNameSnapshot: 'T53 request', categorySnapshot: 'GENERAL', fulfillmentTypeSnapshot: 'GENERAL', employeeCodeSnapshot: employeeKey, employeeNameSnapshot: employeeKey, organizationSnapshot: org[orgKey]!.name, subject: 's', status: 'SUBMITTED', submittedDate: '2026-09-29', dueDate, submittedAt: new Date('2026-09-29T03:00:00Z'), createdByUserId: hrAdmin.user.id } });
}

describe('A. reproduction of T44-P1-23 (exact audit paths)', () => {
  it('services SLA: the module and the Report Center dataset agree (Bangkok org at 01:30 local, due yesterday)', async () => {
    for (let i = 1; i <= 5; i += 1) await serviceRequest(`BKK${i}`, 'BKK', '2026-09-30', i);
    at(BKK_0130);
    const module = await serviceAnalyticsService.dashboard({ organizationId: org.BKK!.id });
    const rc = await as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'service_request_summary', definition: { columns: ['organization', 'overdue'], groupBy: ['organization', 'overdue'], aggregations: [{ fieldId: 'daysToFulfil', function: 'COUNT' }], filters: [{ fieldId: 'organization', operator: 'EQ', value: org.BKK!.name }] }, page: 1 });
    expect(rc.status).toBe(200);
    const overdueCell = rc.body.data.rows.find((r: Record<string, unknown>) => Object.values(r).includes(true));
    console.log(`[T53 evidence] services SLA BKK now=${BKK_0130.toISOString()} module.overdue=${module.requests.overdue} reportCenterRows=${JSON.stringify(rc.body.data.rows)}`);
    expect(module.requests.overdue).toBe(5);
    expect(overdueCell, 'Report Center must say "past target" like the module').toBeTruthy();
  });
  it('services SLA: a New York organization is judged on New York\'s date, not Bangkok\'s', async () => {
    await serviceRequest('NYC1', 'NYC', '2026-09-30', 11);
    at(NYC_2200);
    const module = await serviceAnalyticsService.dashboard({ organizationId: org.NYC!.id });
    console.log(`[T53 evidence] services SLA NYC now=${NYC_2200.toISOString()} (NY 2026-09-30 22:00) due=2026-09-30 module.overdue=${module.requests.overdue} expected=0`);
    expect(module.requests.overdue).toBe(0);
  });
  it('certification expiry: valid through its last day in the employee\'s own zone (module and Employee 360)', async () => {
    const def = await prisma.certificationDefinition.create({ data: { code: 'T53C', name: 'T53 cert', issuerType: 'INTERNAL', validityDays: 365 } });
    await prisma.employeeCertification.create({ data: { employeeId: emp.NYC2!, definitionId: def.id, definitionNameSnapshot: 'T53 cert', issuedDate: '2025-10-01', expiryDate: '2026-09-30', createdByUserId: hrAdmin.user.id } });
    at(NYC_2200);
    const [cert] = await certificationService.forEmployee(emp.NYC2!);
    console.log(`[T53 evidence] certification NYC now=${NYC_2200.toISOString()} expiry=2026-09-30 status=${cert!.status} expected=EXPIRING_SOON`);
    expect(cert!.status).toBe('EXPIRING_SOON');
  });
  it('ER warning validity: a Bangkok warning valid until yesterday is no longer active at 01:30 local (ER used UTC)', async () => {
    const at0 = await prisma.disciplinaryActionType.create({ data: { code: 'T53W', name: 'T53 warning', severityOrder: 1, requiresWarningLetter: false, requiresAcknowledgement: false } });
    const c = await prisma.employeeRelationCase.create({ data: { caseNumber: 'ER-T53-1', employeeId: emp.BKK3!, employeeCodeSnapshot: 'BKK3', employeeNameSnapshot: 'BKK3', incidentDate: '2026-01-05', title: 't', description: 'd', status: 'ACTION_ISSUED', createdByUserId: hrAdmin.user.id } });
    await prisma.disciplinaryAction.create({ data: { caseId: c.id, actionTypeId: at0.id, actionTypeCodeSnapshot: 'T53W', actionTypeNameSnapshot: 'T53 warning', employeeId: emp.BKK3!, reason: 'r', status: 'ISSUED', issuedDate: '2026-01-10', issuedAt: new Date('2026-01-10T00:00:00Z'), validUntil: '2026-09-30', requiresWarningLetter: false, requiresAcknowledgement: false, createdByUserId: hrAdmin.user.id } });
    at(BKK_0130);
    const r = await erReportService.report({});
    console.log(`[T53 evidence] ER BKK now=${BKK_0130.toISOString()} validUntil=2026-09-30 active=${r.actions?.active} expected=0`);
    expect(r.actions?.active).toBe(0);
    expect(r.actions?.expired).toBe(1);
  });
  it('document expiry: a Bangkok employee\'s document expiring yesterday is EXPIRED at 01:30 local (documents used UTC)', async () => {
    const cat = await prisma.documentCategory.create({ data: { code: 'T53D', name: 'T53 docs', defaultClassification: 'PUBLIC_INTERNAL' } });
    await prisma.document.create({ data: { documentNumber: 'DOC-T53-1', title: 'T53 passport', categoryId: cat.id, classification: 'PUBLIC_INTERNAL', ownerEmployeeId: emp.BKK4!, expiryDate: '2026-09-30', status: 'ACTIVE', createdByUserId: hrAdmin.user.id } });
    at(BKK_0130);
    const r = await as(hrAdmin, 'get', '/api/v1/documents?page=1&pageSize=20&search=T53');
    const doc = r.body.data.find((d: { documentNumber: string }) => d.documentNumber === 'DOC-T53-1');
    console.log(`[T53 evidence] document BKK now=${BKK_0130.toISOString()} expiry=2026-09-30 expiryState=${doc?.expiryState} expected=EXPIRED`);
    expect(doc.expiryState).toBe('EXPIRED');
  });
  it('dashboard new-hire window: "last 30 days including today" counts from the organization\'s today', async () => {
    await prisma.employee.update({ where: { id: emp.BKK5! }, data: { hireDate: new Date('2026-09-01T00:00:00Z') } }); // outside: today is 10-01 in Bangkok
    await prisma.employee.update({ where: { id: emp.BKK6! }, data: { hireDate: new Date('2026-09-02T00:00:00Z') } }); // inside
    at(BKK_0130);
    const s = await getDashboardSummary(hrAuth);
    console.log(`[T53 evidence] dashboard BKK now=${BKK_0130.toISOString()} hires 2026-09-01 / 2026-09-02 newLast30Days=${s.employees.newLast30Days} expected=1`);
    expect(s.employees.newLast30Days).toBe(1);
  });
  it('probation: days remaining are counted from the employee\'s own today (New York 22:00, ends tomorrow)', async () => {
    const policy = await prisma.probationPolicy.create({ data: { name: 'T53 probation', durationDays: 90, maxExtensionDays: 30 } });
    const pc = await prisma.probationCase.create({ data: { employeeId: emp.NYC3!, policyId: policy.id, policyNameSnapshot: 'T53 probation', employeeCodeSnapshot: 'NYC3', employeeNameSnapshot: 'NYC3', startDate: '2026-07-03', originalEndDate: '2026-10-01', currentEndDate: '2026-10-01', status: 'ACTIVE', createdByUserId: hrAdmin.user.id } });
    at(NYC_2200);
    const d = await probationService.get(hrAuth, pc.id);
    console.log(`[T53 evidence] probation NYC now=${NYC_2200.toISOString()} end=2026-10-01 daysRemaining=${d.daysRemaining} expected=1`);
    expect(d.daysRemaining).toBe(1);
  });
});

describe('B–D. organization zones: Bangkok across UTC midnight, a UTC organization, a DST organization', () => {
  it('the same instant is a different business date per organization — and never the process zone', async () => {
    expect(await todayForOrganization(prisma, org.BKK!.id, BKK_0130)).toBe('2026-10-01');
    expect(await todayForOrganization(prisma, org.UTC!.id, BKK_0130)).toBe('2026-09-30');
    expect(await todayForOrganization(prisma, org.NYC!.id, BKK_0130)).toBe('2026-09-30');
    expect(await todayForOrganization(prisma, org.NYC!.id, NYC_2200)).toBe('2026-09-30');
    expect(await todayForOrganization(prisma, org.UTC!.id, NYC_2200)).toBe('2026-10-01');
    expect(await todayForEmployee(prisma, emp.BKK1!, BKK_0130)).toBe('2026-10-01');
    const many = await employeeTodays(prisma, [emp.BKK1!, emp.NYC1!, emp.UTC1!], NYC_2200);
    expect([many.get(emp.BKK1!), many.get(emp.NYC1!), many.get(emp.UTC1!)]).toEqual(['2026-10-01', '2026-09-30', '2026-10-01']);
    expect((await organizationTodays(prisma, BKK_0130)).get(org.BKK!.id)).toBe('2026-10-01');
  });
  it('New Year: the business year (sequence numbers) follows the organization, not UTC', async () => {
    const bkkNewYear = new Date('2026-12-31T20:00:00Z'); // 2027-01-01 03:00 Bangkok
    expect(await businessYear(prisma, { employeeId: emp.BKK1! }, bkkNewYear)).toBe(2027);
    expect(await businessYear(prisma, { employeeId: emp.UTC1! }, bkkNewYear)).toBe(2026);
    expect(await businessYear(prisma, { employeeId: emp.NYC1! }, new Date('2027-01-01T03:00:00Z'))).toBe(2026); // 22:00 on 31 Dec in New York
  });
  it('DST (America/New_York, Europe/London): a business day is 23 h at spring-forward and 25 h at fall-back', () => {
    const hours = (d: string, tz: string) => { const r = businessDateRangeInstants(d, d, tz); return (r.lt.getTime() - r.gte.getTime()) / 3_600_000; };
    expect(hours('2026-03-08', 'America/New_York')).toBe(23);
    expect(hours('2026-11-01', 'America/New_York')).toBe(25);
    expect(hours('2026-03-29', 'Europe/London')).toBe(23);
    expect(hours('2026-10-25', 'Europe/London')).toBe(25);
    expect(hours('2026-10-01', 'Asia/Bangkok')).toBe(24);
    expect(businessDayStart('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(businessDayStart('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(businessDayStart('2026-11-02', 'America/New_York').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    // "today" on both sides of a transition, from the instants themselves
    expect(businessToday('America/New_York', new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08'); // 01:59 EST
    expect(businessToday('America/New_York', new Date('2026-11-01T04:30:00Z'))).toBe('2026-11-01'); // 00:30 EDT
    expect(businessToday('America/New_York', new Date('2026-11-02T04:30:00Z'))).toBe('2026-11-01'); // 23:30 EST, 25-hour day
    expect(businessToday('Europe/London', new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
  });
});

describe('E. date-only values stay calendar dates', () => {
  it('a business date round-trips unchanged through the API (no Date constructor, no UTC shift)', async () => {
    const people = [emp.NYC4!, emp.NYC5!, emp.NYC6!, emp.UTC2!];
    for (const [i, d] of ['2026-03-08', '2026-11-01', '2026-12-31', '2027-01-01'].entries()) {
      const r = await as(hrAdmin, 'post', '/api/v1/lifecycle/probation').send({ employeeId: people[i], startDate: d, durationDays: 90 });
      expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(201);
      expect(r.body.data.startDate).toBe(d);
      const stored = await prisma.probationCase.findUniqueOrThrow({ where: { id: r.body.data.id }, select: { startDate: true, currentEndDate: true } });
      expect(stored).toEqual({ startDate: d, currentEndDate: r.body.data.currentEndDate });
    }
  });
  it('hireDate (a calendar date stored as UTC midnight) is not shifted by the zone rules', () => {
    expect(toUtcDate('2026-09-02').toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });
});

describe('F. business-date range boundaries', () => {
  it('Report Center: an instant field filtered by business dates uses [local 00:00, next local 00:00) — calendar-date fields stay UTC', () => {
    const fields = [{ id: 'finalizedAt', label: 'Finalized', type: 'DATETIME', column: 'finalizedAt' }, { id: 'hireDate', label: 'Hire', type: 'DATETIME', column: 'hireDate', calendarDate: true }] as unknown as ColumnDef[];
    const w = (fieldId: string, operator: string, value: unknown, tz: string) => JSON.parse(JSON.stringify(buildWhere(fields, { columns: [fieldId], filters: [{ fieldId, operator, value }], sort: [], groupBy: [], aggregations: [], pageSize: 50 } as never, {}, tz))).AND[1];
    expect(w('finalizedAt', 'BETWEEN', ['2026-10-01', '2026-10-01'], 'Asia/Bangkok')).toEqual({ finalizedAt: { gte: '2026-09-30T17:00:00.000Z', lt: '2026-10-01T17:00:00.000Z' } });
    expect(w('finalizedAt', 'EQ', '2026-11-01', 'America/New_York')).toEqual({ finalizedAt: { gte: '2026-11-01T04:00:00.000Z', lt: '2026-11-02T05:00:00.000Z' } });
    expect(w('finalizedAt', 'AFTER', '2026-10-01', 'Asia/Bangkok')).toEqual({ finalizedAt: { gte: '2026-10-01T17:00:00.000Z' } });
    expect(w('finalizedAt', 'LTE', '2026-10-01', 'UTC')).toEqual({ finalizedAt: { lt: '2026-10-02T00:00:00.000Z' } });
    expect(w('hireDate', 'BETWEEN', ['2026-10-01', '2026-10-01'], 'Asia/Bangkok')).toEqual({ hireDate: { gte: '2026-10-01T00:00:00.000Z', lt: '2026-10-02T00:00:00.000Z' } });
  });
  it('the reference zone is the first active organization by code (here Bangkok), never the process zone', async () => {
    expect(await referenceZone(prisma)).toBe('Asia/Bangkok');
    expect(await referenceZone(prisma, org.NYC!.id)).toBe('America/New_York');
  });
});

describe('H. historical records and controlled errors', () => {
  it('a change of organization timezone re-evaluates "today" but never rewrites a stored business date', async () => {
    const before = await prisma.serviceRequest.findMany({ where: { requestNumber: { startsWith: 'SR-T53-' } }, select: { submittedDate: true, dueDate: true }, orderBy: { requestNumber: 'asc' } });
    await prisma.organization.update({ where: { id: org.BKK!.id }, data: { timezone: 'America/New_York' } });
    try {
      at(BKK_0130); // 14:30 on 30 Sep in New York: the Bangkok requests due 30 Sep are not yet past due there
      expect((await serviceAnalyticsService.dashboard({ organizationId: org.BKK!.id })).requests.overdue).toBe(0);
    } finally { vi.useRealTimers(); await prisma.organization.update({ where: { id: org.BKK!.id }, data: { timezone: 'Asia/Bangkok' } }); }
    expect(await prisma.serviceRequest.findMany({ where: { requestNumber: { startsWith: 'SR-T53-' } }, select: { submittedDate: true, dueDate: true }, orderBy: { requestNumber: 'asc' } })).toEqual(before);
  });
  it('an invalid stored timezone is a controlled 409, never a silent fallback to the server zone', async () => {
    await prisma.$executeRaw`UPDATE "organizations" SET "timezone" = 'Mars/Olympus' WHERE "id" = ${org.UTC!.id}`;
    try {
      await expect(todayForEmployee(prisma, emp.UTC1!)).rejects.toMatchObject({ statusCode: 409, code: 'ORGANIZATION_TIMEZONE_INVALID' });
    } finally { await prisma.organization.update({ where: { id: org.UTC!.id }, data: { timezone: 'UTC' } }); }
    const bad = await request(app).patch(`/api/v1/organizations/${org.UTC!.id}`).set('Cookie', hrAdmin.cookie).set('x-csrf-token', hrAdmin.csrf).send({ timezone: '+07:00' });
    expect(bad.status).toBe(400); expect(bad.body.error.code).toMatch(/TIMEZONE|VALIDATION/);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.UTC!.id } })).timezone).toBe('UTC');
    expect(JSON.stringify(bad.body)).not.toMatch(/stack|prisma|SELECT/i);
  });
});

describe('I–J. one source, every consumer agrees (module, executive roll-up, Report Center)', () => {
  it('services overdue: module, executive roll-up and Report Center give the same answer at 01:30 Bangkok', async () => {
    for (let i = 2; i <= 6; i += 1) await serviceRequest(`NYC${i}`, 'NYC', '2026-09-30', 20 + i); // New York: 14:30 on 30 Sep — not past due
    at(BKK_0130);
    const module = await serviceAnalyticsService.dashboard({ organizationId: org.BKK!.id });
    const exec = await domainRollups.employeeServices({ from: '2026-01-01', to: '2026-10-01', organizationId: org.BKK!.id });
    vi.useRealTimers(); at(BKK_0130);
    const rc = await as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'service_request_summary', definition: { columns: ['organization', 'overdue'], groupBy: ['organization', 'overdue'], aggregations: [{ fieldId: 'daysToFulfil', function: 'COUNT' }], filters: [] }, page: 1 });
    // No organization filter (an "everyone but Bangkok" difference would be withheld by the Task 47 rule). One report,
    // two zones: Bangkok's 5 are past target, New York's 6 are not.
    expect(rc.body.data.rows).toEqual(expect.arrayContaining([{ organization: org.NYC!.name, overdue: false, daysToFulfil_count: 6 }]));
    const rcOverdue = rc.body.data.rows.filter((r: { organization: string; overdue: boolean }) => r.organization === org.BKK!.name && r.overdue).reduce((n: number, r: { daysToFulfil_count: number }) => n + r.daysToFulfil_count, 0);
    expect([module.requests.overdue, exec.current.overdue, rcOverdue]).toEqual([5, 5, 5]);
  });
});

describe('Task 54. the user\'s business calendar for date-picker defaults', () => {
  it('/auth/me names the zone of the user\'s organization (the browser zone may differ)', async () => {
    expect((await as(hrAdmin, 'get', '/api/v1/auth/me')).body.data.businessCalendar).toEqual({ timezone: 'UTC' }); // HR admin's employee is in the UTC organization
    await createUser({ email: 'nyc@t53.local', password: PW, role: 'EMPLOYEE', employeeId: emp.NYC1 });
    const nyc = await loginAs(app, 'nyc@t53.local', PW);
    expect((await as(nyc, 'get', '/api/v1/auth/me')).body.data.businessCalendar).toEqual({ timezone: 'America/New_York' });
    await createUser({ email: 'unlinked@t53.local', password: PW, role: 'EXECUTIVE' });
    const unlinked = await loginAs(app, 'unlinked@t53.local', PW);
    expect((await as(unlinked, 'get', '/api/v1/auth/me')).body.data.businessCalendar).toEqual({ timezone: await referenceZone(prisma) });
  });
});

describe('G. no production path asks the server for "today"', () => {
  it('no hard-coded business zone and no server-UTC business date in apps/api/src (allow-list documented)', () => {
    const root = join(__dirname, '../src');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(root);
    const banned = [/businessToday\('Asia\/Bangkok'\)/, /businessToday\('UTC'\)\s*;?\s*$/m, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, /new Date\(\)\.getUTCFullYear\(\)/, /Date\.now\(\)[^;\n]*toISOString\(\)\.slice\(0, 10\)/];
    const offenders = files.flatMap((f) => { const text = readFileSync(f, 'utf8'); return banned.filter((re) => re.test(text)).map((re) => `${f.replace(root, 'src')} ${re}`); });
    expect(offenders).toEqual([]);
  });
});

describe('performance (indicative, no SLA): 1,000 employees across two zones on different dates', () => {
  it('module overdue list, dashboard and Report Center stay single-query-per-organization (no per-employee zone lookups)', async () => {
    const pos = await prisma.position.findFirstOrThrow({ where: { code: 'PBKK' } });
    const posN = await prisma.position.findFirstOrThrow({ where: { code: 'PNYC' } });
    const rows = Array.from({ length: 1000 }, (_, i) => { const ny = i % 2 === 1; const p = ny ? posN : pos; return { employeeCode: `PERF${i}`, firstName: 'P', lastName: String(i), email: `perf${i}@t53.local`, hireDate: new Date('2021-01-01T00:00:00Z'), organizationId: ny ? org.NYC!.id : org.BKK!.id, departmentId: p.departmentId, positionId: p.id, employmentType: 'FULL_TIME' as const, employmentStatus: 'ACTIVE' as const }; });
    await prisma.employee.createMany({ data: rows });
    const ids = await prisma.employee.findMany({ where: { employeeCode: { startsWith: 'PERF' } }, select: { id: true, organizationId: true } });
    const type = await prisma.serviceRequestType.findFirstOrThrow();
    await prisma.serviceRequest.createMany({ data: ids.map((e, i) => ({ requestNumber: `SR-PERF-${i}`, requestTypeId: type.id, employeeId: e.id, requestTypeCodeSnapshot: 'T53', requestTypeNameSnapshot: 'T53 request', categorySnapshot: 'GENERAL', fulfillmentTypeSnapshot: 'GENERAL', employeeCodeSnapshot: 'PERF', employeeNameSnapshot: 'PERF', organizationSnapshot: e.organizationId === org.BKK!.id ? org.BKK!.name : org.NYC!.name, subject: 's', status: 'SUBMITTED', submittedDate: '2026-09-29', dueDate: '2026-09-30', submittedAt: new Date('2026-09-29T03:00:00Z'), createdByUserId: hrAdmin.user.id })) });
    at(BKK_0130); // Bangkok 1 Oct, New York 30 Sep: the per-organization branch is exercised
    const time = async (label: string, f: () => Promise<unknown>) => { const t0 = performance.now(); const r = await f(); const ms = performance.now() - t0; return { label, ms: Math.round(ms), r }; };
    const a = await time('services dashboard (all orgs)', () => serviceAnalyticsService.dashboard({}));
    const b = await time('request list ?overdue', () => as(hrAdmin, 'get', '/api/v1/employee-services/requests?page=1&pageSize=50&overdue=true'));
    const c = await time('Report Center service_request_summary', () => as(hrAdmin, 'post', '/api/v1/reports/run').send({ datasetId: 'service_request_summary', definition: { columns: ['organization', 'overdue'], groupBy: ['organization', 'overdue'], aggregations: [{ fieldId: 'daysToFulfil', function: 'COUNT' }], filters: [] }, page: 1 }));
    const d = await time('dashboard summary', () => getDashboardSummary(hrAuth));
    console.log(`[T53 perf] ${[a, b, c, d].map((x) => `${x.label}=${x.ms}ms`).join(' ')}`);
    expect((a.r as { requests: { overdue: number } }).requests.overdue).toBe(500 + 5); // 500 Bangkok PERF + the 5 BKK from A; New York's are not yet due
    expect((b.r as request.Response).body.meta.total).toBe(505);
  }, 120000);
});
