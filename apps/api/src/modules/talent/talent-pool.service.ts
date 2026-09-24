import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, type AddPoolMemberInput, type CreateTalentPoolInput, type RemovePoolMemberInput, type TalentPoolDto, type TalentPoolMemberDto, type UpdateTalentPoolInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { lockRow, notFound, talentAudit, textAudit, userNames, type Actor, type Db } from './talent.types';

/**
 * Talent pools. Named by the organization, filled by hand: no cell of the 9-box adds anybody, and a removal keeps
 * the row with who removed it and when. One active membership per person per pool.
 */
const include = { organization: { select: { id: true, name: true } }, _count: { select: { members: { where: { status: 'ACTIVE' } } } } } satisfies Prisma.TalentPoolInclude;
type Row = Prisma.TalentPoolGetPayload<{ include: typeof include }>;
const toDto = (r: Row): TalentPoolDto => ({ id: r.id, code: r.code, name: r.name, description: r.description, organization: r.organization, isActive: r.isActive, activeMembers: r._count.members, createdAt: r.createdAt.toISOString() });
const memberInclude = { employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, department: { select: { name: true } }, position: { select: { job: { select: { title: true } } } } } }, sourceTalentReview: { select: { id: true, cycle: { select: { name: true } } } } } satisfies Prisma.TalentPoolMemberInclude;
type MemberRow = Prisma.TalentPoolMemberGetPayload<{ include: typeof memberInclude }>;

async function memberDtos(db: Db, rows: MemberRow[]): Promise<TalentPoolMemberDto[]> {
  const names = await userNames(db, rows.flatMap((r) => [r.addedByUserId, r.removedByUserId]));
  return rows.map((r) => ({
    id: r.id, employee: { id: r.employee.id, employeeCode: r.employee.employeeCode, firstName: r.employee.firstName, lastName: r.employee.lastName, jobTitle: r.employee.position?.job?.title ?? null, departmentName: r.employee.department?.name ?? null },
    addedAt: r.addedAt.toISOString(), addedBy: names.get(r.addedByUserId) ?? null, reason: r.reason, sourceTalentReview: r.sourceTalentReview ? { id: r.sourceTalentReview.id, cycleName: r.sourceTalentReview.cycle.name } : null,
    status: r.status as 'ACTIVE' | 'REMOVED', removedAt: r.removedAt?.toISOString() ?? null, removedBy: r.removedByUserId ? names.get(r.removedByUserId) ?? null : null, removalReason: r.removalReason,
  }));
}
async function load(db: Db, id: string) {
  const row = await db.talentPool.findUnique({ where: { id }, include });
  if (!row) throw notFound('talent pool');
  return row;
}

export const talentPoolService = {
  async list(includeInactive: boolean): Promise<TalentPoolDto[]> { return (await prisma.talentPool.findMany({ where: includeInactive ? {} : { isActive: true }, include, orderBy: { name: 'asc' } })).map(toDto); },
  async get(id: string): Promise<TalentPoolDto> { return toDto(await load(prisma, id)); },
  async members(id: string, includeRemoved: boolean): Promise<TalentPoolMemberDto[]> {
    await load(prisma, id);
    return memberDtos(prisma, await prisma.talentPoolMember.findMany({ where: { poolId: id, ...(includeRemoved ? {} : { status: 'ACTIVE' }) }, include: memberInclude, orderBy: [{ status: 'asc' }, { addedAt: 'desc' }] }));
  },

  async create(input: CreateTalentPoolInput, actor: Actor): Promise<TalentPoolDto> {
    if (await prisma.talentPool.findUnique({ where: { code: input.code }, select: { id: true } })) throw new AppError(409, 'TALENT_POOL_CODE_EXISTS', `Pool ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.talentPool.create({ data: { code: input.code, name: input.name, description: input.description ?? null, organizationId: input.organizationId ?? null, isActive: input.isActive }, include });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.CREATE_TALENT_POOL, 'TalentPool', created.id, { code: created.code, name: created.name }), tx);
      return created;
    });
    return toDto(row);
  },

  async update(id: string, input: UpdateTalentPoolInput, actor: Actor): Promise<TalentPoolDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await load(tx, id);
      const updated = await tx.talentPool.update({ where: { id }, data: { name: input.name, description: input.description, organizationId: input.organizationId, isActive: input.isActive }, include });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.UPDATE_TALENT_POOL, 'TalentPool', id, { fields: Object.keys(input), name: updated.name, isActive: updated.isActive, ...textAudit('description', before.description, updated.description) }, { name: before.name, isActive: before.isActive }), tx);
      return updated;
    });
    return toDto(row);
  },

  /** Idempotent: adding somebody who is already an active member returns that membership unchanged. */
  async addMember(id: string, input: AddPoolMemberInput, actor: Actor): Promise<TalentPoolMemberDto> {
    const memberId = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_pools', id);
      const pool = await load(tx, id);
      if (!pool.isActive) throw new AppError(409, 'TALENT_POOL_INACTIVE', 'This pool is inactive');
      const employee = await tx.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, employmentStatus: true } });
      if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      if (employee.employmentStatus !== 'ACTIVE') throw new AppError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees join a pool');
      const active = await tx.talentPoolMember.findFirst({ where: { poolId: id, employeeId: input.employeeId, status: 'ACTIVE' }, select: { id: true } });
      if (active) return active.id;
      if (input.sourceTalentReviewId) {
        const review = await tx.talentReview.findFirst({ where: { id: input.sourceTalentReviewId, employeeId: input.employeeId }, select: { id: true } });
        if (!review) throw new AppError(422, 'TALENT_REVIEW_MISMATCH', 'That talent review is not this employee\'s');
      }
      const created = await tx.talentPoolMember.create({ data: { poolId: id, employeeId: input.employeeId, addedByUserId: actor.auth.userId, reason: input.reason ?? null, sourceTalentReviewId: input.sourceTalentReviewId ?? null } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.ADD_TALENT_POOL_MEMBER, 'TalentPoolMember', created.id, { poolId: id, poolCode: pool.code, employeeCode: employee.employeeCode, sourceTalentReviewId: input.sourceTalentReviewId ?? null, ...textAudit('reason', null, input.reason) }), tx);
      return created.id;
    });
    const row = await prisma.talentPoolMember.findUniqueOrThrow({ where: { id: memberId }, include: memberInclude });
    return (await memberDtos(prisma, [row]))[0]!;
  },

  async removeMember(id: string, memberId: string, input: RemovePoolMemberInput, actor: Actor): Promise<TalentPoolMemberDto> {
    await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'talent_pools', id);
      const member = await tx.talentPoolMember.findFirst({ where: { id: memberId, poolId: id }, select: { id: true, status: true, employee: { select: { employeeCode: true } } } });
      if (!member) throw notFound('pool member');
      if (member.status !== 'ACTIVE') throw new AppError(409, 'TALENT_POOL_MEMBER_REMOVED', 'This membership was already removed');
      await tx.talentPoolMember.update({ where: { id: memberId }, data: { status: 'REMOVED', removedAt: new Date(), removedByUserId: actor.auth.userId, removalReason: input.reason ?? null } });
      await auditService.log(talentAudit(actor, AUDIT_ACTIONS.REMOVE_TALENT_POOL_MEMBER, 'TalentPoolMember', memberId, { poolId: id, employeeCode: member.employee.employeeCode, ...textAudit('reason', null, input.reason) }), tx);
    });
    const row = await prisma.talentPoolMember.findUniqueOrThrow({ where: { id: memberId }, include: memberInclude });
    return (await memberDtos(prisma, [row]))[0]!;
  },
};
