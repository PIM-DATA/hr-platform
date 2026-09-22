import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type CreateJobInput, type JobDto, type JobListQuery, type UpdateJobInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService, diffFields } from '../../services/audit/audit.service';
import { MODULE, actorMeta, inUse, notFound, paging, type Actor, type Db } from './organization.shared';

const include = { _count: { select: { positions: true } } } satisfies Prisma.JobInclude;
type Row = Prisma.JobGetPayload<{ include: typeof include }>;

const toDto = (j: Row): JobDto => ({
  id: j.id, code: j.code, title: j.title, level: j.level, description: j.description, isActive: j.isActive,
  positionCount: j._count.positions, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString(),
});

async function findOrThrow(db: Db | typeof prisma, id: string) {
  const row = await db.job.findUnique({ where: { id }, include });
  if (!row) throw notFound.job();
  return row;
}

async function assertCodeFree(db: Db, code: string, exceptId?: string) {
  const existing = await db.job.findUnique({ where: { code } });
  if (existing && existing.id !== exceptId) throw new AppError(409, 'JOB_CODE_EXISTS', `Job code ${code} already exists`);
}

const audit = (actor: Actor, action: keyof typeof AUDIT_ACTIONS, recordId: string, oldValue?: unknown, newValue?: unknown) => ({
  ...actorMeta(actor), action: AUDIT_ACTIONS[action], module: MODULE, recordType: 'Job', recordId, oldValue, newValue,
});

export const jobsService = {
  async list(q: JobListQuery) {
    const where: Prisma.JobWhereInput = {};
    if (q.status) where.isActive = q.status === 'active';
    if (q.search) where.OR = [{ code: { contains: q.search, mode: 'insensitive' } }, { title: { contains: q.search, mode: 'insensitive' } }];
    const [total, rows] = await prisma.$transaction([
      prisma.job.count({ where }),
      prisma.job.findMany({ where, include, orderBy: { [q.sortBy]: q.sortDir }, ...paging(q) }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string) {
    return toDto(await findOrThrow(prisma, id));
  },

  async create(input: CreateJobInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      await assertCodeFree(tx, input.code);
      const created = await tx.job.create({ data: { code: input.code, title: input.title, level: input.level, description: input.description ?? null }, include });
      await auditService.log(audit(actor, 'CREATE_JOB', created.id, undefined, { code: created.code, title: created.title, level: created.level }), tx);
      return created;
    });
    return toDto(row);
  },

  async update(id: string, input: UpdateJobInput, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (input.code) await assertCodeFree(tx, input.code, id);
      const after = await tx.job.update({
        where: { id },
        data: { code: input.code, title: input.title, level: input.level, description: input.description === undefined ? undefined : input.description },
        include,
      });
      const pick = (j: Row) => ({ code: j.code, title: j.title, level: j.level, description: j.description });
      const diff = diffFields(pick(before), pick(after));
      if (Object.keys(diff.new).length) await auditService.log(audit(actor, 'UPDATE_JOB', id, diff.old, diff.new), tx);
      return after;
    });
    return toDto(row);
  },

  /** Guard: no active positions may use the job. */
  async deactivate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (!before.isActive) return before;
      const positions = await tx.position.count({ where: { jobId: id, isActive: true } });
      if (positions) throw inUse('JOB_IN_USE', 'Job', [`${positions} active position(s)`]);
      const after = await tx.job.update({ where: { id }, data: { isActive: false }, include });
      await auditService.log(audit(actor, 'DEACTIVATE_JOB', id, { isActive: true }, { isActive: false }), tx);
      return after;
    });
    return toDto(row);
  },

  async activate(id: string, actor: Actor) {
    const row = await prisma.$transaction(async (tx) => {
      const before = await findOrThrow(tx, id);
      if (before.isActive) return before;
      const after = await tx.job.update({ where: { id }, data: { isActive: true }, include });
      await auditService.log(audit(actor, 'ACTIVATE_JOB', id, { isActive: false }, { isActive: true }), tx);
      return after;
    });
    return toDto(row);
  },
};
