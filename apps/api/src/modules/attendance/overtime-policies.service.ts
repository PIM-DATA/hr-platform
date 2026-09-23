import {
  AUDIT_ACTIONS, compareBusinessDate,
  type CreateOvertimePolicyInput, type OvertimePolicyDto, type OvertimePolicyListQuery, type UpdateOvertimePolicyInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { workflowDefinitionsService } from '../../services/workflow';
import { attendanceAudit, type Actor, type Db } from './attendance.types';

/**
 * Overtime policy: what a day type is worth, and the limits on a claim.
 *
 * Multipliers are **ratios**, never money, and never assumed. A customer whose law or contract says a workday hour is
 * worth 1.5 configures 1.5; another configures something else. Nothing in the code has an opinion beyond "positive,
 * and below a sanity ceiling so a typed 15 is caught before it reaches payroll".
 *
 * Two rules make the history trustworthy:
 *  - **One policy per organization per date.** Active policies may not overlap, so resolving a day can never return
 *    two answers.
 *  - **Rates freeze once claimed.** As soon as a request has snapshotted a policy, its rate fields stop changing:
 *    editing them would silently re-price approved overtime. Close the policy with `effectiveTo` and write a new one.
 */
const policyInclude = { organization: { select: { id: true, code: true, name: true } } } as const;
type Row = Prisma.OvertimePolicyGetPayload<{ include: typeof policyInclude }>;

/** Rate-bearing fields: frozen once any request references the policy. */
const FROZEN_FIELDS = ['workdayMultiplier', 'offDayMultiplier', 'holidayMultiplier', 'minimumEligibleMinutes', 'maximumApprovedMinutesPerDay', 'workflowDefinitionCode'] as const;

const toDto = (row: Row, inUse: boolean): OvertimePolicyDto => ({
  id: row.id,
  organization: row.organization,
  name: row.name,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  workdayMultiplier: row.workdayMultiplier,
  offDayMultiplier: row.offDayMultiplier,
  holidayMultiplier: row.holidayMultiplier,
  minimumEligibleMinutes: row.minimumEligibleMinutes,
  maximumApprovedMinutesPerDay: row.maximumApprovedMinutesPerDay,
  workflowDefinitionCode: row.workflowDefinitionCode,
  isActive: row.isActive,
  inUse,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const rangesOverlap = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) =>
  compareBusinessDate(aFrom, bTo ?? '9999-12-31') <= 0 && compareBusinessDate(bFrom, aTo ?? '9999-12-31') <= 0;

async function assertNoOverlap(db: Db, organizationId: string, effectiveFrom: string, effectiveTo: string | null, exceptId = '__none__') {
  const others = await db.overtimePolicy.findMany({
    where: { id: { not: exceptId }, organizationId, isActive: true },
    select: { id: true, name: true, effectiveFrom: true, effectiveTo: true },
  });
  const clash = others.find((o) => rangesOverlap(effectiveFrom, effectiveTo, o.effectiveFrom, o.effectiveTo));
  if (clash) {
    throw new AppError(409, 'OT_POLICY_OVERLAP', `Overlaps the active policy "${clash.name}" (${clash.effectiveFrom} → ${clash.effectiveTo ?? 'open'}) for this organization`);
  }
}

const usageCount = (db: Db, policyId: string) => db.overtimeRequest.count({ where: { policyId } });

export const overtimePoliciesService = {
  async list(q: OvertimePolicyListQuery): Promise<{ data: OvertimePolicyDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.OvertimePolicyWhereInput = {
      organizationId: q.organizationId,
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.overtimePolicy.count({ where }),
      prisma.overtimePolicy.findMany({ where, include: policyInclude, orderBy: [{ organizationId: 'asc' }, { effectiveFrom: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const used = await prisma.overtimeRequest.groupBy({ by: ['policyId'], where: { policyId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
    const inUse = new Set(used.map((u) => u.policyId));
    return { data: rows.map((r) => toDto(r, inUse.has(r.id))), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async getById(id: string): Promise<OvertimePolicyDto> {
    const row = await prisma.overtimePolicy.findUnique({ where: { id }, include: policyInclude });
    if (!row) throw new AppError(404, 'OT_POLICY_NOT_FOUND', 'Overtime policy not found');
    return toDto(row, (await usageCount(prisma, id)) > 0);
  },

  async create(input: CreateOvertimePolicyInput, actor: Actor): Promise<OvertimePolicyDto> {
    const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
    if (!organization) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    // The workflow must exist and be for overtime, or nobody could ever approve a claim under this policy.
    await workflowDefinitionsService.getActive(prisma, input.workflowDefinitionCode);

    const row = await prisma.$transaction(async (tx) => {
      await assertNoOverlap(tx, input.organizationId, input.effectiveFrom, input.effectiveTo ?? null);
      const created = await tx.overtimePolicy.create({
        data: {
          organizationId: input.organizationId, name: input.name,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
          workdayMultiplier: input.workdayMultiplier, offDayMultiplier: input.offDayMultiplier, holidayMultiplier: input.holidayMultiplier,
          minimumEligibleMinutes: input.minimumEligibleMinutes ?? null,
          maximumApprovedMinutesPerDay: input.maximumApprovedMinutesPerDay ?? null,
          workflowDefinitionCode: input.workflowDefinitionCode,
        },
        include: policyInclude,
      });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.CREATE_OT_POLICY, 'OvertimePolicy', created.id, {
        name: created.name, effectiveFrom: created.effectiveFrom, effectiveTo: created.effectiveTo,
        workdayMultiplier: created.workdayMultiplier, offDayMultiplier: created.offDayMultiplier, holidayMultiplier: created.holidayMultiplier,
        minimumEligibleMinutes: created.minimumEligibleMinutes, maximumApprovedMinutesPerDay: created.maximumApprovedMinutesPerDay,
        workflowDefinitionCode: created.workflowDefinitionCode,
      }), tx);
      return created;
    });
    return toDto(row, false);
  },

  async update(id: string, input: UpdateOvertimePolicyInput, actor: Actor): Promise<OvertimePolicyDto> {
    if (input.workflowDefinitionCode) await workflowDefinitionsService.getActive(prisma, input.workflowDefinitionCode);

    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.overtimePolicy.findUnique({ where: { id }, include: policyInclude });
      if (!before) throw new AppError(404, 'OT_POLICY_NOT_FOUND', 'Overtime policy not found');
      const used = await usageCount(tx, id);

      if (used > 0) {
        const changing = FROZEN_FIELDS.filter((f) => input[f] !== undefined && input[f] !== before[f]);
        if (changing.length) {
          throw new AppError(409, 'OT_POLICY_IN_USE', `${used} overtime request(s) already snapshotted this policy; ${changing.join(', ')} cannot change. Close it with an end date and create a new policy instead.`);
        }
        // Closing a policy is allowed, but never before a day somebody has already claimed under it.
        if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
          const latest = await tx.overtimeRequest.findFirst({ where: { policyId: id }, orderBy: { attendanceDate: 'desc' }, select: { attendanceDate: true } });
          if (latest && compareBusinessDate(input.effectiveTo, latest.attendanceDate) < 0) {
            throw new AppError(409, 'OT_POLICY_IN_USE', `effectiveTo cannot be before ${latest.attendanceDate}, the latest day claimed under this policy`);
          }
        }
      }

      const effectiveTo = input.effectiveTo === undefined ? before.effectiveTo : input.effectiveTo;
      if (effectiveTo && compareBusinessDate(effectiveTo, before.effectiveFrom) < 0) {
        throw new AppError(400, 'OT_POLICY_EFFECTIVE_DATE_INVALID', 'effectiveTo must be on or after effectiveFrom');
      }
      if ((input.isActive ?? before.isActive) === true) await assertNoOverlap(tx, before.organizationId, before.effectiveFrom, effectiveTo, id);

      const after = await tx.overtimePolicy.update({ where: { id }, data: { ...input, effectiveTo }, include: policyInclude });
      await auditService.log(attendanceAudit(actor, AUDIT_ACTIONS.UPDATE_OT_POLICY, 'OvertimePolicy', id,
        { name: after.name, effectiveTo: after.effectiveTo, workdayMultiplier: after.workdayMultiplier, offDayMultiplier: after.offDayMultiplier, holidayMultiplier: after.holidayMultiplier, minimumEligibleMinutes: after.minimumEligibleMinutes, maximumApprovedMinutesPerDay: after.maximumApprovedMinutesPerDay, workflowDefinitionCode: after.workflowDefinitionCode, isActive: after.isActive },
        { name: before.name, effectiveTo: before.effectiveTo, workdayMultiplier: before.workdayMultiplier, offDayMultiplier: before.offDayMultiplier, holidayMultiplier: before.holidayMultiplier, minimumEligibleMinutes: before.minimumEligibleMinutes, maximumApprovedMinutesPerDay: before.maximumApprovedMinutesPerDay, workflowDefinitionCode: before.workflowDefinitionCode, isActive: before.isActive }), tx);
      return after;
    });
    return toDto(row, (await usageCount(prisma, id)) > 0);
  },

  /**
   * The single policy in force for an organization on a date. Overlap is prevented at write time, so this can only
   * ever return one — and when it returns none, a claim cannot be made, which is the honest answer.
   */
  async resolve(db: Db, organizationId: string, attendanceDate: string) {
    const rows = await db.overtimePolicy.findMany({
      where: {
        organizationId,
        isActive: true,
        effectiveFrom: { lte: attendanceDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: attendanceDate } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
      take: 1,
    });
    const policy = rows[0];
    if (!policy) throw new AppError(409, 'OT_POLICY_NOT_FOUND', 'No overtime policy is in force for this organization on that date');
    return policy;
  },
};
