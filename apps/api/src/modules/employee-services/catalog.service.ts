import type { Prisma } from '@prisma/client';
import {
  AUDIT_ACTIONS, SERVICE_FIELD_TYPES_WITH_OPTIONS, SERVICE_WORKFLOW, type CreateServiceRequestTypeInput, type ServiceAnswerInput, type ServiceFieldDto, type ServiceFieldType,
  type ServiceRequestTypeDto, type UpdateServiceRequestTypeInput,
} from '@hr/shared';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { auditService } from '../../services/audit/audit.service';
import { workflowDefinitionsService } from '../../services/workflow';
import { type Actor, type Db, type Tx, notFound, servicesAudit, textAudit } from './services.types';

const typeInclude = { fields: { orderBy: [{ displayOrder: 'asc' }, { key: 'asc' }] }, letterTemplate: { select: { id: true, name: true, letterType: true, isActive: true, requiresSalaryAccess: true } }, _count: { select: { requests: true } } } satisfies Prisma.ServiceRequestTypeInclude;
export type TypeRow = Prisma.ServiceRequestTypeGetPayload<{ include: typeof typeInclude }>;

const parseOptions = (json: string | null): string[] => { if (!json) return []; try { const v: unknown = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
export const fieldDto = (f: TypeRow['fields'][number]): ServiceFieldDto => ({
  id: f.id, key: f.key, label: f.label, fieldType: f.fieldType as ServiceFieldType, required: f.required, displayOrder: f.displayOrder,
  options: parseOptions(f.optionsJson), maxLength: f.maxLength, employeeVisible: f.employeeVisible, helpText: f.helpText,
});
export async function typeDto(db: Db, t: TypeRow): Promise<ServiceRequestTypeDto> {
  const org = t.organizationId ? await db.organization.findUnique({ where: { id: t.organizationId }, select: { name: true } }) : null;
  return {
    id: t.id, code: t.code, name: t.name, description: t.description, category: t.category as ServiceRequestTypeDto['category'], organizationId: t.organizationId, organizationName: org?.name ?? null,
    workflowCode: t.workflowCode, targetDays: t.targetDays, requiresAttachment: t.requiresAttachment, employeeSelectable: t.employeeSelectable,
    fulfillmentType: t.fulfillmentType as ServiceRequestTypeDto['fulfillmentType'], letterTemplateId: t.letterTemplateId, letterTemplateName: t.letterTemplate?.name ?? null,
    isActive: t.isActive, fields: t.fields.map(fieldDto), requestCount: t._count.requests, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(),
  };
}

/** A field definition is data, never behaviour: only allow-listed types, and options only where a choice list makes sense. */
function fieldData(f: CreateServiceRequestTypeInput['fields'] extends (infer T)[] | undefined ? T : never, index: number) {
  const wantsOptions = SERVICE_FIELD_TYPES_WITH_OPTIONS.includes(f.fieldType);
  if (wantsOptions && (!f.options || f.options.length === 0)) throw new AppError(422, 'VALIDATION_ERROR', `Field ${f.key} needs at least one option`, [{ field: 'fields', message: `${f.key} needs options` }]);
  if (!wantsOptions && f.options?.length) throw new AppError(422, 'VALIDATION_ERROR', `Field ${f.key} does not take options`, [{ field: 'fields', message: `${f.key} takes no options` }]);
  return {
    key: f.key, label: f.label, fieldType: f.fieldType, required: f.required ?? false, displayOrder: f.displayOrder ?? index,
    optionsJson: wantsOptions ? JSON.stringify(f.options) : null, maxLength: f.maxLength ?? null, employeeVisible: f.employeeVisible ?? true, helpText: f.helpText ?? null,
  };
}

async function validateRefs(tx: Tx, input: Partial<CreateServiceRequestTypeInput>) {
  if (input.organizationId) { const o = await tx.organization.findFirst({ where: { id: input.organizationId, isActive: true } }); if (!o) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown organization', [{ field: 'organizationId', message: 'Unknown' }]); }
  if (input.workflowCode) {
    const def = await workflowDefinitionsService.getActive(tx, input.workflowCode).catch(() => null);
    if (!def || def.module !== SERVICE_WORKFLOW.module || def.entityType !== SERVICE_WORKFLOW.entityType) {
      throw new AppError(422, 'VALIDATION_ERROR', `The workflow must be an active definition for ${SERVICE_WORKFLOW.module} / ${SERVICE_WORKFLOW.entityType}`, [{ field: 'workflowCode', message: 'Unknown or wrong workflow definition' }]);
    }
  }
  if (input.letterTemplateId) {
    const t = await tx.hrLetterTemplate.findFirst({ where: { id: input.letterTemplateId, isActive: true } });
    if (!t) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown or inactive letter template', [{ field: 'letterTemplateId', message: 'Unknown' }]);
  }
  if (input.fulfillmentType === 'HR_LETTER' && input.letterTemplateId === null) throw new AppError(422, 'VALIDATION_ERROR', 'A letter request type needs a letter template', [{ field: 'letterTemplateId', message: 'Required' }]);
  if (input.fields) { const keys = input.fields.map((f) => f.key.toLowerCase()); if (new Set(keys).size !== keys.length) throw new AppError(422, 'VALIDATION_ERROR', 'Duplicate field key', [{ field: 'fields', message: 'Duplicate key' }]); }
}

export const serviceCatalogService = {
  async list(db: Db, includeInactive: boolean): Promise<ServiceRequestTypeDto[]> {
    const rows = await db.serviceRequestType.findMany({ where: includeInactive ? {} : { isActive: true }, include: typeInclude, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    return Promise.all(rows.map((t) => typeDto(db, t)));
  },
  async get(id: string): Promise<ServiceRequestTypeDto> {
    const t = await prisma.serviceRequestType.findUnique({ where: { id }, include: typeInclude });
    if (!t) throw notFound('service request type');
    return typeDto(prisma, t);
  },
  async create(input: CreateServiceRequestTypeInput, actor: Actor): Promise<ServiceRequestTypeDto> {
    const row = await prisma.$transaction(async (tx) => {
      if (await tx.serviceRequestType.findUnique({ where: { code: input.code } })) throw new AppError(409, 'SERVICE_REQUEST_TYPE_CODE_EXISTS', 'That code is already used');
      await validateRefs(tx, input);
      if (input.fulfillmentType === 'HR_LETTER' && !input.letterTemplateId) throw new AppError(422, 'VALIDATION_ERROR', 'A letter request type needs a letter template', [{ field: 'letterTemplateId', message: 'Required' }]);
      const t = await tx.serviceRequestType.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null, category: input.category, organizationId: input.organizationId ?? null, workflowCode: input.workflowCode ?? null,
          targetDays: input.targetDays ?? null, requiresAttachment: input.requiresAttachment ?? false, employeeSelectable: input.employeeSelectable ?? true, fulfillmentType: input.fulfillmentType ?? 'GENERAL',
          letterTemplateId: input.letterTemplateId ?? null, createdByUserId: actor.auth.userId, fields: { create: (input.fields ?? []).map(fieldData) },
        },
        include: typeInclude,
      });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.CREATE_SERVICE_REQUEST_TYPE, 'ServiceRequestType', t.id, { code: t.code, category: t.category, fulfillmentType: t.fulfillmentType, workflowCode: t.workflowCode, targetDays: t.targetDays, fields: t.fields.length }), tx);
      return t;
    });
    return typeDto(prisma, row);
  },
  async update(id: string, input: UpdateServiceRequestTypeInput, actor: Actor): Promise<ServiceRequestTypeDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.serviceRequestType.findUnique({ where: { id }, include: typeInclude });
      if (!before) throw notFound('service request type');
      await validateRefs(tx, input);
      const fulfillment = input.fulfillmentType ?? before.fulfillmentType;
      const template = input.letterTemplateId === undefined ? before.letterTemplateId : input.letterTemplateId;
      if (fulfillment === 'HR_LETTER' && !template) throw new AppError(422, 'VALIDATION_ERROR', 'A letter request type needs a letter template', [{ field: 'letterTemplateId', message: 'Required' }]);
      if (input.fields) await tx.serviceRequestTypeField.deleteMany({ where: { requestTypeId: id } });
      const after = await tx.serviceRequestType.update({
        where: { id },
        data: {
          name: input.name, description: input.description === undefined ? undefined : input.description, category: input.category, organizationId: input.organizationId === undefined ? undefined : input.organizationId,
          workflowCode: input.workflowCode === undefined ? undefined : input.workflowCode, targetDays: input.targetDays === undefined ? undefined : input.targetDays, requiresAttachment: input.requiresAttachment,
          employeeSelectable: input.employeeSelectable, fulfillmentType: input.fulfillmentType, letterTemplateId: input.letterTemplateId === undefined ? undefined : input.letterTemplateId, isActive: input.isActive,
          ...(input.fields ? { fields: { create: input.fields.map(fieldData) } } : {}),
        },
        include: typeInclude,
      });
      await auditService.log(servicesAudit(actor, AUDIT_ACTIONS.UPDATE_SERVICE_REQUEST_TYPE, 'ServiceRequestType', id, {
        fields: Object.keys(input), isActive: after.isActive, fulfillmentType: after.fulfillmentType, workflowCode: after.workflowCode, targetDays: after.targetDays, fieldCount: after.fields.length, ...textAudit('description', before.description, after.description),
      }), tx);
      return after;
    });
    return typeDto(prisma, row);
  },
};

/**
 * Validates submitted answers against the type's configured fields and returns the rows to freeze. Unknown keys are
 * refused, required fields must be answered, a choice must come from the configured options, and a value is always
 * stored as plain text: nothing here is ever evaluated.
 */
export function buildAnswerRows(fields: TypeRow['fields'], answers: ServiceAnswerInput[] | undefined): { fieldKey: string; labelSnapshot: string; fieldTypeSnapshot: string; employeeVisibleSnapshot: boolean; displayOrderSnapshot: number; value: string }[] {
  const given = new Map<string, ServiceAnswerInput['value']>();
  for (const a of answers ?? []) {
    const f = fields.find((x) => x.key === a.key);
    if (!f) throw new AppError(422, 'VALIDATION_ERROR', `Unknown field ${a.key}`, [{ field: 'answers', message: `Unknown field ${a.key}` }]);
    given.set(a.key, a.value);
  }
  const rows: ReturnType<typeof buildAnswerRows> = [];
  for (const f of fields) {
    const raw = given.get(f.key);
    const value = normaliseAnswer(f, raw);
    if (value === null) continue;
    rows.push({ fieldKey: f.key, labelSnapshot: f.label, fieldTypeSnapshot: f.fieldType, employeeVisibleSnapshot: f.employeeVisible, displayOrderSnapshot: f.displayOrder, value });
  }
  return rows;
}

function normaliseAnswer(f: TypeRow['fields'][number], raw: ServiceAnswerInput['value'] | undefined): string | null {
  const fail = (message: string) => { throw new AppError(422, 'VALIDATION_ERROR', `${f.label}: ${message}`, [{ field: `answers.${f.key}`, message }]); };
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) return null;
  const options = parseOptions(f.optionsJson);
  switch (f.fieldType as ServiceFieldType) {
    case 'BOOLEAN': {
      if (typeof raw !== 'boolean') return fail('expected yes or no');
      return raw ? 'true' : 'false';
    }
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (typeof raw === 'boolean' || Array.isArray(raw) || !Number.isFinite(n)) return fail('expected a number');
      return String(n);
    }
    case 'DATE': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail('expected a date as YYYY-MM-DD');
      return raw;
    }
    case 'SELECT': {
      if (typeof raw !== 'string' || !options.includes(raw)) return fail('choose one of the configured options');
      return raw;
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(raw) || raw.some((v) => !options.includes(v))) return fail('choose from the configured options');
      return [...new Set(raw)].join('; ');
    }
    default: {
      if (typeof raw !== 'string') return fail('expected text');
      if (f.maxLength && raw.length > f.maxLength) return fail(`at most ${f.maxLength} characters`);
      return raw;
    }
  }
}

/** Required-field check, run at submission so a draft can be saved half-finished. */
export function missingRequired(fields: TypeRow['fields'], rows: { fieldKey: string }[]): string[] {
  return fields.filter((f) => f.required && !rows.some((r) => r.fieldKey === f.key)).map((f) => `${f.label} is required`);
}
