import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { AuditAction } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { redact, redactFreeText } from './redact';

export interface AuditEntry {
  /** Actor user id; null for anonymous / system actions. */
  userId: string | null;
  action: AuditAction;
  module: string;
  recordType: string;
  recordId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Extracts ip / user-agent from a request for audit + session records. */
export function requestMeta(req: Request) {
  return { ipAddress: req.ip ?? null, userAgent: req.get('user-agent')?.slice(0, 255) ?? null };
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(redact(value));
}

export type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Shared audit-log service. Sensitive keys are redacted before persisting.
 *
 * Two write policies:
 *  - `log(entry)`        best-effort: failures are logged, the business operation still succeeds
 *                        (used for auth events such as LOGIN_SUCCESS).
 *  - `log(entry, tx)`    atomic: writes with the caller's transaction client, so if the audit row
 *                        cannot be written the whole mutation rolls back (used for administrative
 *                        security actions: users, roles, employee master changes).
 */
export const auditService = {
  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx) {
      await tx.auditLog.create({ data: toRow(entry) });
      return;
    }
    try {
      await prisma.auditLog.create({ data: toRow(entry) });
    } catch (err) {
      logger.error({ err, action: entry.action, module: entry.module }, 'audit log write failed');
    }
  },
};

function toRow(entry: AuditEntry) {
  return {
    userId: entry.userId,
    action: entry.action,
    module: entry.module,
    recordType: entry.recordType,
    recordId: entry.recordId ?? null,
    oldValue: serialize(redactFreeText(entry.module, entry.oldValue)),
    newValue: serialize(redactFreeText(entry.module, entry.newValue)),
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  };
}

/** Returns { old, new } containing only the keys whose values differ (for UPDATE_* audits). */
export function diffFields<T extends Record<string, unknown>>(before: T, after: T): { old: Partial<T>; new: Partial<T> } {
  const oldValue: Partial<T> = {};
  const newValue: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      oldValue[key] = before[key];
      newValue[key] = after[key];
    }
  }
  return { old: oldValue, new: newValue };
}
