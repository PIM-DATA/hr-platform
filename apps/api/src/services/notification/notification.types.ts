import type { Prisma } from '@prisma/client';
import type { NotificationType } from '@hr/shared';

export type Tx = Prisma.TransactionClient;

/** What a business module hands to the notification service. Title/body are derived from templates, never passed in. */
export interface PublishInput {
  /** Recipient. A missing or inactive user is skipped (see notification.service publish). */
  userId: string | null | undefined;
  type: NotificationType;
  source?: { module: string; entityType: string; entityId: string };
  /** Minimal ids for deep-linking + the values the template renders. Never request content (reason, attachment, comments). */
  data?: Record<string, string>;
  /** Deterministic per event, e.g. `leave:<requestId>:approved` — makes a retried transaction idempotent. */
  dedupeKey: string;
}
