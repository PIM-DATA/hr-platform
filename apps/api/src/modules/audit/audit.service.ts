import type { Prisma } from '@prisma/client';
import type { AuditListQuery, AuditLogDetail, AuditLogListItem } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { parseAuditJson } from '../../services/audit/redact';

/**
 * READ-ONLY access to audit_logs. There is intentionally no create/update/delete here:
 * rows are written only by services/audit/audit.service.ts and never modified afterwards.
 */
const listSelect = {
  id: true, createdAt: true, module: true, action: true, recordType: true, recordId: true, ipAddress: true, userAgent: true,
  // old/new are selected to compute hasChanges (and returned parsed only by getById); the list never parses or sends them
  oldValue: true, newValue: true,
  user: { select: { id: true, email: true } },
} satisfies Prisma.AuditLogSelect;
type Row = Prisma.AuditLogGetPayload<{ select: typeof listSelect }>;

function toListItem(r: Row): AuditLogListItem {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actor: r.user ? { userId: r.user.id, email: r.user.email } : null,
    module: r.module,
    action: r.action,
    recordType: r.recordType,
    recordId: r.recordId,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    hasChanges: r.oldValue !== null || r.newValue !== null,
  };
}

export const auditLogService = {
  async list(q: AuditListQuery): Promise<{ data: AuditLogListItem[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.AuditLogWhereInput = {};
    if (q.userId) where.userId = q.userId;
    if (q.module) where.module = q.module;
    if (q.action) where.action = q.action;
    if (q.recordType) where.recordType = q.recordType;
    if (q.recordId) where.recordId = q.recordId;
    if (q.dateFrom || q.dateTo) where.createdAt = { ...(q.dateFrom ? { gte: q.dateFrom } : {}), ...(q.dateTo ? { lt: q.dateTo } : {}) };
    const [total, rows] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        select: listSelect,
        orderBy: [{ createdAt: q.sortDir }, { id: q.sortDir }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { data: rows.map(toListItem), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string): Promise<AuditLogDetail> {
    const row = await prisma.auditLog.findUnique({ where: { id }, select: listSelect });
    if (!row) throw new AppError(404, 'AUDIT_LOG_NOT_FOUND', 'Audit log entry not found');
    // parsed + redacted on the way out; the stored row is never touched
    return { ...toListItem(row), oldValue: parseAuditJson(row.oldValue), newValue: parseAuditJson(row.newValue) };
  },
};
