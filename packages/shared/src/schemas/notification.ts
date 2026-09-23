import { z } from 'zod';
import { NOTIFICATION_TYPES } from '../enums';
import { paginationQuerySchema } from './common';

/** The inbox is the caller's own data: no permission code, no data scope — every query filters by the session user. */
export const notificationListQuerySchema = paginationQuerySchema.omit({ search: true }).extend({
  status: z.enum(['all', 'unread', 'read']).default('all'),
  type: z.enum(Object.values(NOTIFICATION_TYPES) as [string, ...string[]]).optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  /** Minimal ids for deep-linking (never request content). */
  data: Record<string, string> | null;
  source: { module: string | null; entityType: string | null; entityId: string | null };
  readAt: string | null;
  createdAt: string;
}
