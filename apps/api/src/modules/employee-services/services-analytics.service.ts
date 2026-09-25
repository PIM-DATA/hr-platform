import type { HrLetterType, ServiceCategory, ServiceDashboardDto, ServiceReportsDto } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { today } from './services.types';

/**
 * Aggregates only. Counts, months and averages by request type, category and letter type; never an employee, a
 * request number, a subject, a field answer, a message, a letter body or a salary amount.
 */
const DEFINITIONS = {
  overdue: 'An open request (submitted, in progress or waiting employee) whose derived due date is before today. Due dates are calendar days from submission; nothing escalates automatically.',
  averageFulfillmentDays: 'Mean calendar days from submission to fulfilment, over requests fulfilled in the range. Requests still open are not counted.',
  workflowApproved: 'A request type may require approval. Approval authorises the request; HR still performs the fulfilment, so an approved request is not yet fulfilled.',
  letters: 'Letters are counted where they were issued. A voided letter keeps its row and is counted as voided, never deleted.',
};

const group = <T, K extends string>(rows: T[], key: (r: T) => K) => { const m = new Map<K, T[]>(); for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m; };
const days = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
const average = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export const serviceAnalyticsService = {
  async dashboard(): Promise<ServiceDashboardDto> {
    const t = today();
    const [requests, letters] = await Promise.all([
      prisma.serviceRequest.findMany({ select: { status: true, dueDate: true, submittedAt: true, fulfilledAt: true } }),
      prisma.hrLetter.findMany({ select: { status: true, letterTypeSnapshot: true } }),
    ]);
    const count = (s: string) => requests.filter((r) => r.status === s).length;
    const open = requests.filter((r) => ['SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE'].includes(r.status));
    const fulfilled = requests.filter((r) => r.fulfilledAt && r.submittedAt);
    return {
      requests: {
        draft: count('DRAFT'), submitted: count('SUBMITTED'), inProgress: count('IN_PROGRESS'), waitingEmployee: count('WAITING_EMPLOYEE'),
        overdue: open.filter((r) => r.dueDate && r.dueDate < t).length, fulfilled: count('FULFILLED'), rejected: count('REJECTED'), cancelled: count('CANCELLED'),
      },
      letters: {
        issued: letters.filter((l) => l.status === 'ISSUED').length, voided: letters.filter((l) => l.status === 'VOID').length,
        byType: [...group(letters, (l) => l.letterTypeSnapshot as HrLetterType)].map(([letterType, rows]) => ({ letterType, count: rows.length })).sort((a, b) => a.letterType.localeCompare(b.letterType)),
      },
      averageFulfillmentDays: average(fulfilled.map((r) => days(r.submittedAt!, r.fulfilledAt!))),
      definitions: DEFINITIONS, generatedAt: new Date().toISOString(),
    };
  },

  async report(q: { from?: string; to?: string; organizationId?: string }): Promise<ServiceReportsDto> {
    const t = today();
    const from = q.from ?? `${t.slice(0, 4)}-01-01`;
    const to = q.to ?? t;
    const orgName = q.organizationId ? ((await prisma.organization.findUnique({ where: { id: q.organizationId }, select: { name: true } }))?.name ?? '?') : null;
    const orgWhere = orgName ? { organizationSnapshot: orgName } : {};
    const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59Z`) };
    const [requests, letters] = await Promise.all([
      prisma.serviceRequest.findMany({ where: { ...orgWhere, status: { not: 'DRAFT' }, submittedAt: range }, select: { status: true, requestTypeNameSnapshot: true, categorySnapshot: true, submittedAt: true, fulfilledAt: true } }),
      prisma.hrLetter.findMany({ where: { ...orgWhere, issuedDate: { gte: from, lte: to } }, select: { status: true, letterTypeSnapshot: true, issuedDate: true } }),
    ]);
    const fulfilledDays = (rows: typeof requests) => average(rows.filter((r) => r.fulfilledAt && r.submittedAt).map((r) => days(r.submittedAt!, r.fulfilledAt!)));
    const byType = [...group(requests, (r) => `${r.requestTypeNameSnapshot}|${r.categorySnapshot}`)].map(([k, rows]) => ({
      requestType: k.split('|')[0], category: k.split('|')[1] as ServiceCategory, submitted: rows.length, fulfilled: rows.filter((r) => r.status === 'FULFILLED').length,
      rejected: rows.filter((r) => r.status === 'REJECTED').length, open: rows.filter((r) => ['SUBMITTED', 'IN_PROGRESS', 'WAITING_EMPLOYEE'].includes(r.status)).length, averageFulfillmentDays: fulfilledDays(rows),
    })).sort((a, b) => a.requestType.localeCompare(b.requestType));
    const byCategory = [...group(requests, (r) => r.categorySnapshot as ServiceCategory)].map(([category, rows]) => ({ category, submitted: rows.length, fulfilled: rows.filter((r) => r.status === 'FULFILLED').length })).sort((a, b) => a.category.localeCompare(b.category));
    const byMonth = [...group(requests, (r) => r.submittedAt!.toISOString().slice(0, 7))].map(([month, rows]) => ({ month, submitted: rows.length, fulfilled: rows.filter((r) => r.status === 'FULFILLED').length })).sort((a, b) => a.month.localeCompare(b.month));
    return {
      range: { from, to }, byType, byCategory, byMonth,
      letters: {
        byType: [...group(letters, (l) => l.letterTypeSnapshot as HrLetterType)].map(([letterType, rows]) => ({ letterType, issued: rows.filter((l) => l.status === 'ISSUED').length, voided: rows.filter((l) => l.status === 'VOID').length })).sort((a, b) => a.letterType.localeCompare(b.letterType)),
        byMonth: [...group(letters, (l) => l.issuedDate.slice(0, 7))].map(([month, rows]) => ({ month, issued: rows.length })).sort((a, b) => a.month.localeCompare(b.month)),
      },
    };
  },
};
