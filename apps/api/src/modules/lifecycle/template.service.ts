import { AUDIT_ACTIONS, type CreateTemplateInput, type LifecycleTemplateDto, type TemplateTaskInput, type UpdateTemplateInput } from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { lifecycleAudit, notFound, textAudit, userNames, type Actor, type Db } from './lifecycle.types';

/**
 * Checklist templates for onboarding and offboarding. A template is a starting point: a plan or case copies its
 * tasks at creation, so editing a template later never changes anything already instantiated.
 */
const include = { tasks: { orderBy: [{ sortOrder: 'asc' as const }, { title: 'asc' as const }] } };
type Row = Prisma.LifecycleTemplateGetPayload<{ include: typeof include }>;
async function dto(db: Db, r: Row): Promise<LifecycleTemplateDto> {
  const [org, names] = await Promise.all([r.organizationId ? db.organization.findUnique({ where: { id: r.organizationId }, select: { name: true } }) : null, userNames(db, r.tasks.map((t) => t.specificUserId))]);
  return { id: r.id, code: r.code, name: r.name, description: r.description, type: r.type as LifecycleTemplateDto['type'], organizationId: r.organizationId, organizationName: org?.name ?? null, isActive: r.isActive, taskCount: r.tasks.length, tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, description: t.description, category: t.category, assigneeType: t.assigneeType as LifecycleTemplateDto['tasks'][number]['assigneeType'], specificUserId: t.specificUserId, specificUserName: t.specificUserId ? (names.get(t.specificUserId) ?? null) : null, dueOffsetDays: t.dueOffsetDays, relativeTo: t.relativeTo as LifecycleTemplateDto['tasks'][number]['relativeTo'], required: t.required, sortOrder: t.sortOrder, documentCategoryId: t.documentCategoryId, requiresDocument: t.requiresDocument })), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}
async function validateTasks(db: Db, type: string, tasks: TemplateTaskInput[]) {
  for (const t of tasks) {
    if (t.specificUserId && !(await db.user.findUnique({ where: { id: t.specificUserId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown user for a task', [{ field: 'tasks', message: `Unknown user on "${t.title}"` }]);
    if (t.documentCategoryId && !(await db.documentCategory.findUnique({ where: { id: t.documentCategoryId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown document category', [{ field: 'tasks', message: `Unknown document category on "${t.title}"` }]);
    if (type === 'ONBOARDING' && t.relativeTo === 'LAST_WORKING_DATE') throw new AppError(422, 'VALIDATION_ERROR', 'Onboarding tasks are relative to the start or hire date', [{ field: 'tasks', message: `"${t.title}" is relative to the last working date` }]);
    if (type === 'OFFBOARDING' && (t.relativeTo === 'HIRE_DATE' || t.relativeTo === 'START_DATE')) throw new AppError(422, 'VALIDATION_ERROR', 'Offboarding tasks are relative to the last working date or the case start', [{ field: 'tasks', message: `"${t.title}" is relative to the start date` }]);
  }
}
const taskData = (t: TemplateTaskInput, i: number) => ({ title: t.title, description: t.description ?? null, category: t.category, assigneeType: t.assigneeType, specificUserId: t.assigneeType === 'SPECIFIC_USER' ? t.specificUserId ?? null : null, dueOffsetDays: t.dueOffsetDays, relativeTo: t.relativeTo, required: t.required ?? true, sortOrder: t.sortOrder ?? i, documentCategoryId: t.documentCategoryId ?? null, requiresDocument: t.requiresDocument ?? false });

export const templateService = {
  async list(q: { type?: string; includeInactive?: boolean }): Promise<LifecycleTemplateDto[]> {
    const rows = await prisma.lifecycleTemplate.findMany({ where: { type: q.type, ...(q.includeInactive ? {} : { isActive: true }) }, include, orderBy: [{ type: 'asc' }, { name: 'asc' }] });
    return Promise.all(rows.map((r) => dto(prisma, r)));
  },
  async get(id: string): Promise<LifecycleTemplateDto> { const r = await prisma.lifecycleTemplate.findUnique({ where: { id }, include }); if (!r) throw notFound('template'); return dto(prisma, r); },
  async create(input: CreateTemplateInput, actor: Actor): Promise<LifecycleTemplateDto> {
    if (await prisma.lifecycleTemplate.findUnique({ where: { code: input.code.toUpperCase() } })) throw new AppError(409, 'LIFECYCLE_TEMPLATE_CODE_EXISTS', 'A template with this code already exists');
    if (input.organizationId && !(await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } }))) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown organization' }]);
    await validateTasks(prisma, input.type, input.tasks ?? []);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.lifecycleTemplate.create({ data: { code: input.code.toUpperCase(), name: input.name, description: input.description ?? null, type: input.type, organizationId: input.organizationId ?? null, tasks: { create: (input.tasks ?? []).map(taskData) } }, include });
      await auditService.log(lifecycleAudit(actor, input.type === 'ONBOARDING' ? AUDIT_ACTIONS.CREATE_ONBOARDING_TEMPLATE : AUDIT_ACTIONS.CREATE_OFFBOARDING_TEMPLATE, 'LifecycleTemplate', created.id, { code: created.code, name: created.name, type: created.type, tasks: created.tasks.length, ...textAudit('description', null, created.description) }), tx);
      return created;
    });
    return dto(prisma, row);
  },
  /** Replaces the task list when one is given. Plans already created keep their own copies. */
  async update(id: string, input: UpdateTemplateInput, actor: Actor): Promise<LifecycleTemplateDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.lifecycleTemplate.findUnique({ where: { id }, include });
      if (!before) throw notFound('template');
      if (input.tasks) { await validateTasks(tx, before.type, input.tasks); await tx.lifecycleTemplateTask.deleteMany({ where: { templateId: id } }); }
      const after = await tx.lifecycleTemplate.update({ where: { id }, data: { name: input.name, description: input.description === undefined ? undefined : input.description, isActive: input.isActive, ...(input.tasks ? { tasks: { create: input.tasks.map(taskData) } } : {}) }, include });
      await auditService.log(lifecycleAudit(actor, before.type === 'ONBOARDING' ? AUDIT_ACTIONS.UPDATE_ONBOARDING_TEMPLATE : AUDIT_ACTIONS.UPDATE_OFFBOARDING_TEMPLATE, 'LifecycleTemplate', id, { fields: Object.keys(input), tasks: after.tasks.length, isActive: after.isActive, ...textAudit('description', before.description, after.description) }, { tasks: before.tasks.length, isActive: before.isActive }), tx);
      return after;
    });
    return dto(prisma, row);
  },
};
