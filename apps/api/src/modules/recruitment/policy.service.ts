import { AUDIT_ACTIONS, type RecruitmentPolicyDto, type UpsertRecruitmentPolicyInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { recruitmentAudit, type Actor, type Db } from './recruitment.types';

const toDto = (row: { id: string; organization: { id: string; code: string; name: string }; requisitionWorkflowCode: string; offerWorkflowCode: string }): RecruitmentPolicyDto => ({
  id: row.id, organization: row.organization, requisitionWorkflowCode: row.requisitionWorkflowCode, offerWorkflowCode: row.offerWorkflowCode,
});
const include = { organization: { select: { id: true, code: true, name: true } } } as const;

/** Per organization: which workflow approves a requisition and which approves an offer. Nothing is hardcoded. */
export const recruitmentPolicyService = {
  async list(): Promise<RecruitmentPolicyDto[]> {
    return (await prisma.recruitmentPolicy.findMany({ include, orderBy: { organization: { name: 'asc' } } })).map(toDto);
  },

  async upsert(input: UpsertRecruitmentPolicyInput, actor: Actor): Promise<RecruitmentPolicyDto> {
    for (const code of [input.requisitionWorkflowCode, input.offerWorkflowCode]) {
      const def = await prisma.workflowDefinition.findFirst({ where: { code, module: 'recruitment' }, select: { id: true } });
      if (!def) throw new AppError(422, 'WORKFLOW_DEFINITION_NOT_FOUND', `Workflow "${code}" is not a recruitment workflow definition`);
    }
    const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
    if (!org) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found');
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.recruitmentPolicy.findUnique({ where: { organizationId: input.organizationId } });
      const saved = await tx.recruitmentPolicy.upsert({
        where: { organizationId: input.organizationId },
        create: { organizationId: input.organizationId, requisitionWorkflowCode: input.requisitionWorkflowCode, offerWorkflowCode: input.offerWorkflowCode },
        update: { requisitionWorkflowCode: input.requisitionWorkflowCode, offerWorkflowCode: input.offerWorkflowCode },
        include,
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_RECRUITMENT_POLICY, 'RecruitmentPolicy', saved.id,
        { organizationId: input.organizationId, requisitionWorkflowCode: saved.requisitionWorkflowCode, offerWorkflowCode: saved.offerWorkflowCode },
        before ? { requisitionWorkflowCode: before.requisitionWorkflowCode, offerWorkflowCode: before.offerWorkflowCode } : undefined), tx);
      return saved;
    });
    return toDto(row);
  },

  async resolve(db: Db, organizationId: string) {
    const policy = await db.recruitmentPolicy.findUnique({ where: { organizationId } });
    if (!policy) throw new AppError(409, 'RECRUITMENT_POLICY_NOT_FOUND', 'This organization has no recruitment policy; set the approval workflows first');
    return policy;
  },
};
