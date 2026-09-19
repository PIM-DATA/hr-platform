import type { Request } from 'express';
import type { AuditAction } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { redact } from './redact';

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

/**
 * Shared audit-log service. Sensitive keys are redacted before persisting.
 * Audit failures are logged but never fail the business operation.
 */
export const auditService = {
  async log(entry: AuditEntry): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          userId: entry.userId,
          action: entry.action,
          module: entry.module,
          recordType: entry.recordType,
          recordId: entry.recordId ?? null,
          oldValue: serialize(entry.oldValue),
          newValue: serialize(entry.newValue),
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (err) {
      logger.error({ err, action: entry.action, module: entry.module }, 'audit log write failed');
    }
  },
};
