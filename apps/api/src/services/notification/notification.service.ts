import { Prisma } from '@prisma/client';
import { NOTIFICATION_CHANNELS, NOTIFICATION_DELIVERY_STATUS, type NotificationDto, type NotificationListQuery } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { renderTemplate, type TemplateVars } from './notification.templates';
import type { PublishInput, Tx } from './notification.types';

/**
 * Shared in-app notification service. Business modules (Leave first) publish events; the service owns the wording,
 * idempotency and the delivery outbox. Workflow/Leave never write notification rows themselves.
 *
 * Transaction policy: `publish` takes the caller's transaction, so the notification and its IN_APP delivery commit with
 * the business change — if the insert fails, the business transaction rolls back (in-app delivery is durable by
 * definition). No external channel (email/LINE/Lark/push) is ever called inside a transaction; those become PENDING
 * outbox rows plus a worker in a later task.
 *
 * Recipient policy: a missing or inactive user account is skipped silently — an approval must not fail because the
 * requester has no active login. Everything else (a real DB error) propagates and rolls the caller back.
 */
const inboxSelect = { id: true, type: true, title: true, body: true, data: true, sourceModule: true, sourceEntityType: true, sourceEntityId: true, readAt: true, createdAt: true } satisfies Prisma.NotificationSelect;
type Row = Prisma.NotificationGetPayload<{ select: typeof inboxSelect }>;

const toDto = (n: Row): NotificationDto => ({
  id: n.id, type: n.type, title: n.title, body: n.body,
  data: (n.data ?? null) as Record<string, string> | null,
  source: { module: n.sourceModule, entityType: n.sourceEntityType, entityId: n.sourceEntityId },
  readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString(),
});

/** Same key + same event → replay; same key + a different event → conflict (never silently reuse a key). */
function assertSameEvent(existing: Row & { sourceEntityId: string | null }, input: PublishInput) {
  const same = existing.type === input.type
    && (existing.sourceEntityId ?? null) === (input.source?.entityId ?? null)
    && (existing.sourceEntityType ?? null) === (input.source?.entityType ?? null)
    && (existing.sourceModule ?? null) === (input.source?.module ?? null);
  if (!same) throw new AppError(409, 'NOTIFICATION_DEDUPE_CONFLICT', `Notification key ${input.dedupeKey} was already used for a different event`);
}

export const notificationService = {
  /**
   * Publishes one in-app notification on the caller's transaction. Returns the notification id, or null when there is
   * no valid recipient. Idempotent on (userId, dedupeKey).
   */
  async publish(input: PublishInput, vars: TemplateVars, tx: Tx): Promise<string | null> {
    if (!input.userId) return null;
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, isActive: true } });
    if (!user || !user.isActive) return null; // never notify a missing or deactivated account

    const existing = await tx.notification.findUnique({ where: { userId_dedupeKey: { userId: user.id, dedupeKey: input.dedupeKey } }, select: inboxSelect });
    if (existing) { assertSameEvent(existing, input); return existing.id; }

    const { title, body } = renderTemplate(input.type, vars);
    const created = await tx.notification
      .create({
        data: {
          userId: user.id, type: input.type, title, body,
          sourceModule: input.source?.module ?? null, sourceEntityType: input.source?.entityType ?? null, sourceEntityId: input.source?.entityId ?? null,
          data: input.data ?? Prisma.DbNull, dedupeKey: input.dedupeKey,
        },
        select: inboxSelect,
      })
      .catch(async (e: unknown) => {
        // concurrent publish of the same key: the unique index is the backstop, then replay the committed row
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const row = await tx.notification.findUniqueOrThrow({ where: { userId_dedupeKey: { userId: user.id, dedupeKey: input.dedupeKey } }, select: inboxSelect });
          assertSameEvent(row, input);
          return row;
        }
        throw e;
      });
    // in-app delivery is immediate and durable; external channels get PENDING rows + a worker in a later task
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: created.id, channel: NOTIFICATION_CHANNELS.IN_APP } },
      create: { notificationId: created.id, channel: NOTIFICATION_CHANNELS.IN_APP, status: NOTIFICATION_DELIVERY_STATUS.SENT, attempts: 1, sentAt: new Date() },
      update: {},
    });
    return created.id;
  },

  /** The caller's own inbox, newest first. userId always comes from the session, never from the query. */
  async list(userId: string, q: NotificationListQuery): Promise<{ data: NotificationDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.NotificationWhereInput = { userId, type: q.type, ...(q.status === 'unread' ? { readAt: null } : q.status === 'read' ? { NOT: { readAt: null } } : {}) };
    const [total, rows] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.findMany({ where, select: inboxSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  /** Newest few for the bell dropdown. */
  async latest(userId: string, take = 10): Promise<NotificationDto[]> {
    const rows = await prisma.notification.findMany({ where: { userId }, select: inboxSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take });
    return rows.map(toDto);
  },

  /** COUNT only — the badge never loads notification rows. */
  async unreadCount(userId: string): Promise<number> {
    return prisma.notification.count({ where: { userId, readAt: null } });
  },

  /** Idempotent: the first read timestamp is kept. Another user's notification is a 404 (no existence leak). */
  async markRead(userId: string, id: string): Promise<NotificationDto> {
    const row = await prisma.notification.findFirst({ where: { id, userId }, select: inboxSelect });
    if (!row) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
    if (row.readAt) return toDto(row);
    return toDto(await prisma.notification.update({ where: { id }, data: { readAt: new Date() }, select: inboxSelect }));
  },

  /** Marks only this user's unread notifications; already-read timestamps are untouched. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  },
};
