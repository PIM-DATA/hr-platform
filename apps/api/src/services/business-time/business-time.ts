import type { Prisma, PrismaClient } from '@prisma/client';
import { businessDateOf, businessDateRangeInstants, businessToday, isValidTimezone } from '@hr/shared';
import { AppError } from '../../lib/errors';

/**
 * Task 53 (T44-P1-23) — the one place the API answers "what is today?" and "which instants does this business date
 * cover?". Never the process timezone, never a hard-coded zone.
 *
 *   Instant        a UTC `Date` (submittedAt, fulfilledAt, createdAt…) — stored and compared as is.
 *   Business date  `YYYY-MM-DD` in the applicable organization's IANA timezone (dueDate, expiryDate, validUntil…);
 *                  compared as strings, never converted through `Date`.
 *   Timezone       `Organization.timezone`, validated IANA (organizations.service). An invalid stored value is a
 *                  controlled 409, not a silent fallback to the server's zone.
 *
 * Which organization applies:
 *   - a record about an employee → that employee's CURRENT organization (records keep no zone snapshot — see
 *     docs/business-dates.md "Historical records");
 *   - an organization-filtered report → that organization;
 *   - an installation-wide default with no organization in scope (e.g. "this year" for an unfiltered multi-organization
 *     report) → the reference organization: the first active organization by code (the rule attendance already used),
 *     and `UTC` only for an installation with no organization at all;
 *   - per-row comparisons across organizations ("overdue now") → each row's own organization (`employeeTodays`).
 */
type Db = PrismaClient | Prisma.TransactionClient;
type OrgZone = { id: string; code: string; timezone: string };

const invalidZone = (code: string) => new AppError(409, 'ORGANIZATION_TIMEZONE_INVALID', `Organization ${code} has no valid IANA timezone; correct it in organization settings`);
const zoneOf = (o: Pick<OrgZone, 'code' | 'timezone'>) => { if (!isValidTimezone(o.timezone)) throw invalidZone(o.code); return o.timezone; };

export async function organizationZone(db: Db, organizationId: string): Promise<string> {
  const o = await db.organization.findUnique({ where: { id: organizationId }, select: { code: true, timezone: true } });
  if (!o) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
  return zoneOf(o);
}
export async function employeeZone(db: Db, employeeId: string): Promise<string> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { organization: { select: { code: true, timezone: true } } } });
  if (!e) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  return zoneOf(e.organization);
}
/** The reference zone for installation-wide defaults (see above). */
export async function referenceZone(db: Db, organizationId?: string | null): Promise<string> {
  if (organizationId) return organizationZone(db, organizationId);
  const o = await db.organization.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' }, select: { code: true, timezone: true } })
    ?? await db.organization.findFirst({ orderBy: { code: 'asc' }, select: { code: true, timezone: true } });
  return o ? zoneOf(o) : 'UTC';
}

export const todayForOrganization = async (db: Db, organizationId: string, now: Date = new Date()) => businessToday(await organizationZone(db, organizationId), now);
export const todayForEmployee = async (db: Db, employeeId: string, now: Date = new Date()) => businessToday(await employeeZone(db, employeeId), now);
export const referenceToday = async (db: Db, organizationId?: string | null, now: Date = new Date()) => businessToday(await referenceZone(db, organizationId), now);

/** Every organization's business today (one small query; organizations are few). */
export async function organizationTodays(db: Db, now: Date = new Date()): Promise<Map<string, string>> {
  const orgs = await db.organization.findMany({ select: { id: true, code: true, timezone: true } });
  return new Map(orgs.map((o) => [o.id, businessToday(zoneOf(o), now)]));
}
/** Business today for each employee, from their organization (one query). Unknown ids are absent. */
export async function employeeTodays(db: Db, employeeIds: Iterable<string>, now: Date = new Date()): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return new Map();
  const [rows, todays] = await Promise.all([db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, organizationId: true } }), organizationTodays(db, now)]);
  return new Map(rows.map((r) => [r.id, todays.get(r.organizationId)!]));
}
/** Employee zone for many employees at once (for turning instants into each employee's business dates). */
export async function employeeZones(db: Db, employeeIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return new Map();
  const rows = await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, organization: { select: { code: true, timezone: true } } } });
  return new Map(rows.map((r) => [r.id, zoneOf(r.organization)]));
}

/**
 * A WHERE fragment comparing a business-date column with "today" when organizations may disagree about the date.
 * When every organization has the same today (the common case) it is a single comparison; otherwise one branch per
 * distinct today, keyed by organization (`organizationId` models) or by employee (`employeeId` models without a
 * relation).
 */
export async function perOrganizationToday<W>(db: Db, key: 'organizationId' | 'employeeId', build: (today: string) => W, now: Date = new Date()): Promise<W | { OR: W[] }> {
  const todays = await organizationTodays(db, now);
  const groups = new Map<string, string[]>();
  for (const [orgId, t] of todays) groups.set(t, [...(groups.get(t) ?? []), orgId]);
  if (groups.size <= 1) return build([...groups.keys()][0] ?? businessToday('UTC', now));
  const branches: W[] = [];
  for (const [t, orgIds] of groups) {
    if (key === 'organizationId') { branches.push({ ...build(t), organizationId: { in: orgIds } }); continue; }
    const ids = (await db.employee.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } })).map((e) => e.id);
    branches.push({ ...build(t), employeeId: { in: ids } });
  }
  return { OR: branches };
}

/** Instants covering a business-date range in a zone: `[from 00:00, day after to 00:00)` local. */
export const businessRange = (from: string, to: string, timezone: string) => businessDateRangeInstants(from, to, timezone);
/** The business date of an instant in a zone. */
export const businessDateIn = (instant: Date, timezone: string) => businessDateOf(instant, timezone);
/** The business year for sequence numbers: the subject employee's or organization's year (else the reference zone's). */
export async function businessYear(db: Db, subject: { employeeId?: string | null; organizationId?: string | null } = {}, now: Date = new Date()): Promise<number> {
  const zone = subject.employeeId ? await employeeZone(db, subject.employeeId) : await referenceZone(db, subject.organizationId);
  return Number(businessToday(zone, now).slice(0, 4));
}
