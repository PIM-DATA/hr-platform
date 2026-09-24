import {
  AUDIT_ACTIONS,
  type ActionTypeDto, type CaseCategoryDto, type CreateActionTypeInput, type CreateCaseCategoryInput,
  type DisciplinaryPolicyDto, type LetterTemplateDto, type UpdateActionTypeInput, type UpsertLetterTemplateInput,
  type UpsertPolicyInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { erAudit, type Actor, type Db } from './er.types';

/**
 * Employee relations configuration: what actions exist, how cases are categorised, which approval workflow applies
 * and what a letter template says.
 *
 * None of it is a rule engine. An action type has a default validity and a display order, and that is all: the
 * system never picks an action, never escalates one into another, and never concludes what any of this means under
 * employment law. Those are the customer's decisions, under the customer's policy.
 */
const actionTypeInclude = { _count: { select: { actions: true } } } satisfies Prisma.DisciplinaryActionTypeInclude;
type ActionTypeRow = Prisma.DisciplinaryActionTypeGetPayload<{ include: typeof actionTypeInclude }>;

const toActionTypeDto = (row: ActionTypeRow): ActionTypeDto => ({
  id: row.id, code: row.code, name: row.name, description: row.description, severityOrder: row.severityOrder,
  requiresWarningLetter: row.requiresWarningLetter, requiresAcknowledgement: row.requiresAcknowledgement,
  defaultValidityDays: row.defaultValidityDays, isActive: row.isActive, inUse: row._count.actions > 0,
});

export const actionTypeService = {
  async list(includeInactive = false): Promise<ActionTypeDto[]> {
    const rows = await prisma.disciplinaryActionType.findMany({ where: includeInactive ? {} : { isActive: true }, include: actionTypeInclude, orderBy: [{ severityOrder: 'asc' }, { code: 'asc' }] });
    return rows.map(toActionTypeDto);
  },

  async create(input: CreateActionTypeInput, actor: Actor): Promise<ActionTypeDto> {
    const duplicate = await prisma.disciplinaryActionType.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'ACTION_TYPE_CODE_TAKEN', `An action type with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.disciplinaryActionType.create({ data: { ...input, description: input.description ?? null, defaultValidityDays: input.defaultValidityDays ?? null }, include: actionTypeInclude });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.CREATE_DISCIPLINARY_ACTION_TYPE, 'DisciplinaryActionType', created.id, {
        code: created.code, name: created.name, requiresWarningLetter: created.requiresWarningLetter, requiresAcknowledgement: created.requiresAcknowledgement, defaultValidityDays: created.defaultValidityDays,
      }), tx);
      return created;
    });
    return toActionTypeDto(row);
  },

  /** Editing a type changes the catalogue. Actions already issued keep the name and validity they were issued with. */
  async update(id: string, input: UpdateActionTypeInput, actor: Actor): Promise<ActionTypeDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.disciplinaryActionType.findUnique({ where: { id }, include: actionTypeInclude });
      if (!before) throw new AppError(404, 'ACTION_TYPE_NOT_FOUND', 'Action type not found');
      const after = await tx.disciplinaryActionType.update({ where: { id }, data: input, include: actionTypeInclude });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_DISCIPLINARY_ACTION_TYPE, 'DisciplinaryActionType', id,
        { name: after.name, isActive: after.isActive, defaultValidityDays: after.defaultValidityDays },
        { name: before.name, isActive: before.isActive, defaultValidityDays: before.defaultValidityDays }), tx);
      return after;
    });
    return toActionTypeDto(row);
  },

  async require(db: Db, id: string) {
    const row = await db.disciplinaryActionType.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'ACTION_TYPE_NOT_FOUND', 'Action type not found');
    if (!row.isActive) throw new AppError(409, 'ACTION_TYPE_INACTIVE', `${row.code} is inactive`);
    return row;
  },
};

export const caseCategoryService = {
  async list(): Promise<CaseCategoryDto[]> {
    const rows = await prisma.disciplinaryCaseCategory.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, sortOrder: r.sortOrder, isActive: r.isActive }));
  },
  async create(input: CreateCaseCategoryInput): Promise<CaseCategoryDto> {
    const duplicate = await prisma.disciplinaryCaseCategory.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'CASE_CATEGORY_CODE_TAKEN', `A category with the code ${input.code} already exists`);
    const r = await prisma.disciplinaryCaseCategory.create({ data: input });
    return { id: r.id, code: r.code, name: r.name, sortOrder: r.sortOrder, isActive: r.isActive };
  },
};

const policyInclude = { organization: { select: { id: true, code: true, name: true } } } satisfies Prisma.DisciplinaryPolicyInclude;
const toPolicyDto = (row: Prisma.DisciplinaryPolicyGetPayload<{ include: typeof policyInclude }>): DisciplinaryPolicyDto => ({
  id: row.id, organization: row.organization, name: row.name, workflowDefinitionCode: row.workflowDefinitionCode,
  defaultAcknowledgementDueDays: row.defaultAcknowledgementDueDays, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, isActive: row.isActive,
});

export const disciplinaryPolicyService = {
  async list(): Promise<DisciplinaryPolicyDto[]> {
    const rows = await prisma.disciplinaryPolicy.findMany({ include: policyInclude, orderBy: [{ organization: { code: 'asc' } }, { effectiveFrom: 'desc' }] });
    return rows.map(toPolicyDto);
  },

  /** One policy in force per organization: setting it again replaces the one that covers the same start date. */
  async upsert(input: UpsertPolicyInput, actor: Actor): Promise<DisciplinaryPolicyDto> {
    const row = await prisma.$transaction(async (tx) => {
      const definition = await tx.workflowDefinition.findFirst({ where: { code: input.workflowDefinitionCode, isActive: true, module: 'employee_relations' }, select: { id: true } });
      if (!definition) throw new AppError(422, 'WORKFLOW_DEFINITION_INVALID', `No active employee-relations workflow is called ${input.workflowDefinitionCode}`);
      const existing = await tx.disciplinaryPolicy.findFirst({ where: { organizationId: input.organizationId, effectiveFrom: input.effectiveFrom } });
      const data = { ...input, effectiveTo: input.effectiveTo ?? null, defaultAcknowledgementDueDays: input.defaultAcknowledgementDueDays ?? null };
      const saved = existing
        ? await tx.disciplinaryPolicy.update({ where: { id: existing.id }, data, include: policyInclude })
        : await tx.disciplinaryPolicy.create({ data, include: policyInclude });
      await auditService.log(erAudit(actor, AUDIT_ACTIONS.UPDATE_DISCIPLINARY_POLICY, 'DisciplinaryPolicy', saved.id, {
        organization: saved.organization.code, name: saved.name, workflowDefinitionCode: saved.workflowDefinitionCode, defaultAcknowledgementDueDays: saved.defaultAcknowledgementDueDays,
      }), tx);
      return saved;
    });
    return toPolicyDto(row);
  },

  async resolve(db: Db, organizationId: string, onDate: string) {
    const rows = await db.disciplinaryPolicy.findMany({
      where: { organizationId, isActive: true, effectiveFrom: { lte: onDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }] },
      orderBy: [{ effectiveFrom: 'desc' }],
      take: 1,
    });
    if (!rows[0]) throw new AppError(409, 'DISCIPLINARY_POLICY_NOT_FOUND', 'No employee-relations policy is in force for this organization, so no approval workflow applies');
    return rows[0];
  },
};

export const letterTemplateService = {
  async list(): Promise<LetterTemplateDto[]> {
    const rows = await prisma.warningLetterTemplate.findMany({ orderBy: { code: 'asc' } });
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, subjectTemplate: r.subjectTemplate, bodyTemplate: r.bodyTemplate, isActive: r.isActive }));
  },
  async upsert(input: UpsertLetterTemplateInput): Promise<LetterTemplateDto> {
    const r = await prisma.warningLetterTemplate.upsert({
      where: { code: input.code },
      create: input,
      update: { name: input.name, subjectTemplate: input.subjectTemplate, bodyTemplate: input.bodyTemplate, isActive: input.isActive },
    });
    return { id: r.id, code: r.code, name: r.name, subjectTemplate: r.subjectTemplate, bodyTemplate: r.bodyTemplate, isActive: r.isActive };
  },
};
