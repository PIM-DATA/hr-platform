import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, PERMISSIONS, REPORT_LIMITS, csvLine, reportDefinitionSchema, type AuditAction, type AuditModule, type CreateSavedReportInput, type ReportDatasetDto, type ReportDefinition, type ReportRunResultDto, type ReportTemplateDto, type SavedReportDto, type UpdateSavedReportInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { hasPermission, scopeFor } from '../../services/authorization/authorization.service';
import type { AuthContext } from '../auth/auth.types';
import { getDataset, listDatasets, validateDefinition, type FieldDef, type ReportDataset } from './registry';
import './datasets';
import { REPORT_TEMPLATES } from './templates';

type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
const audit = (actor: Actor, action: AuditAction, recordId: string, newValue: unknown, oldValue?: unknown) => ({ userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent, action, module: 'reports' as AuditModule, recordType: 'SavedReport', recordId, oldValue, newValue });

/**
 * Report center: which datasets a caller may use, the fields they may see, and running validated definitions
 * through the registry. A saved report is metadata — sharing one shares the definition, never the data: running it
 * still needs the dataset's permission and returns the caller's own scope.
 */
export function datasetAccess(auth: AuthContext, d: ReportDataset): boolean {
  if (!hasPermission(auth, PERMISSIONS.REPORTS_VIEW)) return false;
  if (!d.aggregateOnly && !hasPermission(auth, PERMISSIONS.REPORTS_VIEW_INDIVIDUAL)) return false;
  return d.requiredPermissions.some((p) => hasPermission(auth, p));
}
/**
 * Task 50 (T44-P1-21): the scope a dataset runs with. It is the scope of the dataset's SOURCE permission, and never wider
 * than the caller's scope for `reports.view` — or, for an individual-row dataset, for `reports.view_individual`. The
 * Report Center opens a door; it never widens what the source permission allows (MANAGER/TEAM + EXECUTIVE/ALL running
 * the employee directory sees the team only). Saved/shared reports run with the RUNNER's scope — sharing confers none.
 */
const RANK = { SELF: 0, TEAM: 1, ALL: 2 } as const;
export function datasetAuth(auth: AuthContext, d: ReportDataset): AuthContext {
  const parts = [scopeFor(auth, ...d.requiredPermissions), scopeFor(auth, PERMISSIONS.REPORTS_VIEW), ...(d.aggregateOnly ? [] : [scopeFor(auth, PERMISSIONS.REPORTS_VIEW_INDIVIDUAL)])];
  const narrowest = parts.reduce<'SELF' | 'TEAM' | 'ALL'>((acc, s) => (s === null ? 'SELF' : RANK[s] < RANK[acc] ? s : acc), 'ALL');
  return { ...auth, dataScope: narrowest };
}
export const visibleFields = (auth: AuthContext, d: ReportDataset): FieldDef[] => d.fields.filter((f) => !f.requiredPermission || hasPermission(auth, f.requiredPermission));
const datasetDto = (auth: AuthContext, d: ReportDataset): ReportDatasetDto => ({
  id: d.id, name: d.name, description: d.description, aggregateOnly: d.aggregateOnly, requiredDateRange: d.requiredDateRange,
  fields: visibleFields(auth, d).map(({ requiredPermission: _p, ...rest }) => { const r = rest as FieldDef & { column?: unknown; groupKey?: unknown }; delete r.column; delete r.groupKey; return r; }),
});
function requireDataset(auth: AuthContext, id: string): ReportDataset {
  const d = getDataset(id);
  if (!d || !datasetAccess(auth, d)) throw new AppError(404, 'REPORT_DATASET_NOT_FOUND', 'Dataset not found');
  return d;
}

export const reportsService = {
  datasets(auth: AuthContext): ReportDatasetDto[] { return listDatasets().filter((d) => datasetAccess(auth, d)).map((d) => datasetDto(auth, d)); },
  templates(auth: AuthContext): ReportTemplateDto[] { return REPORT_TEMPLATES.filter((t) => { const d = getDataset(t.datasetId); return d && datasetAccess(auth, d); }); },

  async run(auth: AuthContext, datasetId: string, definition: ReportDefinition, page: number): Promise<ReportRunResultDto> {
    const d = requireDataset(auth, datasetId);
    const fields = visibleFields(auth, d);
    validateDefinition(d, definition, fields);
    const result = await d.run({ auth: datasetAuth(auth, d), definition, page, pageSize: definition.pageSize });
    return { datasetId, columns: columnsOf(d, definition, fields), rows: result.rows, meta: { page, pageSize: definition.pageSize, total: result.total, grouped: definition.groupBy.length > 0 || definition.aggregations.length > 0 }, suppression: result.suppression ?? null };
  },

  /** Every row up to the cap, as CSV. Refused deterministically when the result would exceed it. */
  async exportCsv(actor: Actor, datasetId: string, definition: ReportDefinition, savedReportId: string | null): Promise<{ csv: string; rows: number }> {
    const d = requireDataset(actor.auth, datasetId);
    const fields = visibleFields(actor.auth, d);
    validateDefinition(d, definition, fields);
    const probe = await d.run({ auth: datasetAuth(actor.auth, d), definition, page: 1, pageSize: 1 });
    if (probe.total > REPORT_LIMITS.exportRows) throw new AppError(413, 'REPORT_EXPORT_TOO_LARGE', `This report has ${probe.total} rows; exports are limited to ${REPORT_LIMITS.exportRows}. Narrow the filters.`);
    const result = await d.runAll({ auth: datasetAuth(actor.auth, d), definition }, REPORT_LIMITS.exportRows);
    const columns = columnsOf(d, definition, fields);
    const lines = [csvLine(columns.map((c) => c.label)), ...result.rows.map((r) => csvLine(columns.map((c) => r[c.id] ?? null)))];
    // Withheld small groups are stated in the file too — never silently missing, never exported with their values.
    if (result.suppression) lines.push('', csvLine(['SUPPRESSED', `${result.suppression.suppressedGroups} group(s) withheld: fewer than ${result.suppression.minimumGroupSize} people`]));
    await auditService.log(audit(actor, AUDIT_ACTIONS.EXPORT_REPORT, savedReportId ?? datasetId, { datasetId, savedReportId, rowCount: result.rows.length, suppressedGroups: result.suppression?.suppressedGroups ?? 0, columns: columns.map((c) => c.id), filters: definition.filters.map((f) => `${f.fieldId}:${f.operator}`) }));
    return { csv: lines.join('\r\n'), rows: result.rows.length };
  },

  async list(auth: AuthContext): Promise<SavedReportDto[]> {
    const rows = await prisma.savedReport.findMany({ where: { OR: [{ ownerUserId: auth.userId }, { visibility: 'SHARED' }] }, orderBy: { updatedAt: 'desc' } });
    // A shared report on a dataset the caller cannot use is omitted, not shown as an inaccessible stub.
    const accessible = rows.filter((r) => { const d = getDataset(r.datasetId); return !!d && datasetAccess(auth, d); });
    const names = await userNames(accessible.map((r) => r.ownerUserId));
    return accessible.map((r) => toDto(auth, r, names));
  },
  async get(auth: AuthContext, id: string): Promise<SavedReportDto> {
    const row = await prisma.savedReport.findUnique({ where: { id } });
    if (!row || (row.ownerUserId !== auth.userId && row.visibility !== 'SHARED' && !hasPermission(auth, PERMISSIONS.REPORTS_MANAGE))) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
    const d = getDataset(row.datasetId);
    if (!d || !datasetAccess(auth, d)) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
    return toDto(auth, row, await userNames([row.ownerUserId]));
  },
  async create(input: CreateSavedReportInput, actor: Actor): Promise<SavedReportDto> {
    const d = requireDataset(actor.auth, input.datasetId);
    validateDefinition(d, input.definition, visibleFields(actor.auth, d));
    if (input.visibility === 'SHARED' && !hasPermission(actor.auth, PERMISSIONS.REPORTS_SHARE)) throw new AppError(403, 'FORBIDDEN', 'Sharing reports needs reports.share');
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.savedReport.create({ data: { name: input.name, description: input.description ?? null, datasetId: input.datasetId, ownerUserId: actor.auth.userId, visibility: input.visibility, definition: input.definition as object, updatedByUserId: actor.auth.userId } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.CREATE_REPORT, created.id, { datasetId: input.datasetId, visibility: input.visibility, columns: input.definition.columns, filters: input.definition.filters.length, groupBy: input.definition.groupBy }), tx);
      return created;
    });
    return toDto(actor.auth, row, await userNames([row.ownerUserId]));
  },
  async update(id: string, input: UpdateSavedReportInput, actor: Actor): Promise<SavedReportDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.savedReport.findUnique({ where: { id } });
      if (!before || (before.ownerUserId !== actor.auth.userId && !hasPermission(actor.auth, PERMISSIONS.REPORTS_MANAGE))) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
      const d = requireDataset(actor.auth, before.datasetId);
      if (input.definition) validateDefinition(d, input.definition, visibleFields(actor.auth, d));
      if (input.visibility && input.visibility !== before.visibility && !hasPermission(actor.auth, PERMISSIONS.REPORTS_SHARE) && !hasPermission(actor.auth, PERMISSIONS.REPORTS_MANAGE)) throw new AppError(403, 'FORBIDDEN', 'Sharing reports needs reports.share');
      const updated = await tx.savedReport.update({ where: { id }, data: { name: input.name, description: input.description, visibility: input.visibility, definition: input.definition as object | undefined, updatedByUserId: actor.auth.userId } });
      await auditService.log(audit(actor, input.visibility && input.visibility !== before.visibility ? AUDIT_ACTIONS.SHARE_REPORT : AUDIT_ACTIONS.UPDATE_REPORT, id, { fields: Object.keys(input), visibility: updated.visibility, columns: input.definition?.columns }, { visibility: before.visibility }), tx);
      return updated;
    });
    return toDto(actor.auth, row, await userNames([row.ownerUserId]));
  },
  async remove(id: string, actor: Actor): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.savedReport.findUnique({ where: { id } });
      if (!before || (before.ownerUserId !== actor.auth.userId && !hasPermission(actor.auth, PERMISSIONS.REPORTS_MANAGE))) throw new AppError(404, 'REPORT_NOT_FOUND', 'Report not found');
      await tx.savedReport.delete({ where: { id } });
      await auditService.log(audit(actor, AUDIT_ACTIONS.DELETE_REPORT, id, { datasetId: before.datasetId, name: before.name }), tx);
    });
  },
  /** Running a saved report: the caller's own scope, always; audited as RUN_REPORT. */
  async runSaved(actor: Actor, id: string, page: number): Promise<ReportRunResultDto> {
    const saved = await this.get(actor.auth, id);
    const result = await this.run(actor.auth, saved.datasetId, saved.definition, page);
    await auditService.log(audit(actor, AUDIT_ACTIONS.RUN_REPORT, id, { datasetId: saved.datasetId, rowCount: result.meta.total, page }));
    return result;
  },
};

function columnsOf(d: ReportDataset, def: ReportDefinition, fields: FieldDef[]) {
  const label = (id: string) => fields.find((f) => f.id === id)?.label ?? id;
  const grouped = def.groupBy.length > 0 || def.aggregations.length > 0;
  if (!grouped) return def.columns.map((c) => ({ id: c, label: label(c), type: fields.find((f) => f.id === c)?.type ?? 'STRING' }));
  return [
    ...def.groupBy.map((g) => ({ id: g, label: label(g), type: fields.find((f) => f.id === g)?.type ?? 'STRING' })),
    ...def.aggregations.map((a) => ({ id: a.alias ?? `${a.fieldId}_${a.function.toLowerCase()}`, label: a.alias ?? `${a.function} of ${label(a.fieldId)}`, type: a.function.startsWith('COUNT') ? 'NUMBER' : fields.find((f) => f.id === a.fieldId)?.type ?? 'NUMBER' })),
  ];
}
async function userNames(ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.employee ? `${u.employee.firstName} ${u.employee.lastName}` : u.email]));
}
function toDto(auth: AuthContext, r: Prisma.SavedReportGetPayload<object>, names: Map<string, string>): SavedReportDto {
  const isOwner = r.ownerUserId === auth.userId;
  const manage = hasPermission(auth, PERMISSIONS.REPORTS_MANAGE);
  return {
    id: r.id, name: r.name, description: r.description, datasetId: r.datasetId, datasetName: getDataset(r.datasetId)?.name ?? r.datasetId,
    owner: { userId: r.ownerUserId, name: names.get(r.ownerUserId) ?? null }, isOwner, visibility: r.visibility as SavedReportDto['visibility'],
    definition: reportDefinitionSchema.parse(r.definition),
    can: { edit: isOwner || manage, share: (isOwner && hasPermission(auth, PERMISSIONS.REPORTS_SHARE)) || manage, delete: isOwner || manage },
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}
