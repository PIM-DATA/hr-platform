import {
  AUDIT_ACTIONS,
  type CompetencyCategoryDto, type CompetencyDto, type CompetencyListQuery, type CompetencyScaleDto,
  type CreateCompetencyCategoryInput, type CreateCompetencyInput, type CreateCompetencyScaleInput,
  type UpdateCompetencyCategoryInput, type UpdateCompetencyInput, type UpdateCompetencyScaleInput,
} from '@hr/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import { competencyAudit, type Actor, type Db } from './competency.types';

/**
 * The competency framework: categories, proficiency scales and the competency library itself.
 *
 * One rule governs all three. **A recorded level is a number whose meaning must never move.** "3" is only useful
 * because a scale says what 3 means; so once a scale is referenced its rungs are fixed, once a competency is used it
 * can be deactivated but never deleted, and everything an assessment needs to explain itself is copied onto the
 * assessment rather than looked up later.
 */

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------
export const competencyCategoryService = {
  async list(includeInactive = false): Promise<CompetencyCategoryDto[]> {
    const rows = await prisma.competencyCategory.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: { _count: { select: { competencies: true } } },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id, code: row.code, name: row.name, description: row.description,
      sortOrder: row.sortOrder, isActive: row.isActive, competencyCount: row._count.competencies,
    }));
  },

  async create(input: CreateCompetencyCategoryInput, actor: Actor): Promise<CompetencyCategoryDto> {
    const duplicate = await prisma.competencyCategory.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'COMPETENCY_CATEGORY_CODE_TAKEN', `A category with the code ${input.code} already exists`);
    await prisma.$transaction(async (tx) => {
      const created = await tx.competencyCategory.create({ data: input });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.CREATE_COMPETENCY_CATEGORY, 'CompetencyCategory', created.id, { code: created.code, name: created.name }), tx);
    });
    return (await competencyCategoryService.list(true)).find((c) => c.code === input.code)!;
  },

  async update(id: string, input: UpdateCompetencyCategoryInput, actor: Actor): Promise<CompetencyCategoryDto> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.competencyCategory.findUnique({ where: { id } });
      if (!before) throw new AppError(404, 'COMPETENCY_CATEGORY_NOT_FOUND', 'Category not found');
      const after = await tx.competencyCategory.update({ where: { id }, data: input });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_COMPETENCY_CATEGORY, 'CompetencyCategory', id,
        { name: after.name, isActive: after.isActive }, { name: before.name, isActive: before.isActive }), tx);
    });
    return (await competencyCategoryService.list(true)).find((c) => c.id === id)!;
  },
};

// ---------------------------------------------------------------------------
// proficiency scales
// ---------------------------------------------------------------------------
const scaleInclude = {
  levels: { orderBy: { level: 'asc' as const } },
  _count: { select: { competencies: true } },
} satisfies Prisma.CompetencyScaleInclude;
type ScaleRow = Prisma.CompetencyScaleGetPayload<{ include: typeof scaleInclude }>;

const toScaleDto = (row: ScaleRow): CompetencyScaleDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  levels: row.levels.map((l) => ({ id: l.id, level: l.level, label: l.label, description: l.description })),
  isActive: row.isActive,
  inUse: row._count.competencies > 0,
});

export const competencyScaleService = {
  async list(includeInactive = false): Promise<CompetencyScaleDto[]> {
    const rows = await prisma.competencyScale.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: scaleInclude,
      orderBy: { code: 'asc' },
    });
    return rows.map(toScaleDto);
  },

  async create(input: CreateCompetencyScaleInput, actor: Actor): Promise<CompetencyScaleDto> {
    const duplicate = await prisma.competencyScale.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'COMPETENCY_SCALE_CODE_TAKEN', `A scale with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.competencyScale.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null,
          levels: { create: input.levels.map((l) => ({ level: l.level, label: l.label, description: l.description ?? null })) },
        },
        include: scaleInclude,
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.CREATE_COMPETENCY_SCALE, 'CompetencyScale', created.id, {
        code: created.code, name: created.name, levels: created.levels.map((l) => `${l.level}=${l.label}`).join(', '),
      }), tx);
      return created;
    });
    return toScaleDto(row);
  },

  /**
   * Editing a scale. Wording can always be improved; **the rungs cannot move once anything uses the scale**, because
   * an assessment recorded "3" on the understanding of what 3 meant, and adding or removing a level would silently
   * rewrite every one of those.
   */
  async update(id: string, input: UpdateCompetencyScaleInput, actor: Actor): Promise<CompetencyScaleDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.competencyScale.findUnique({ where: { id }, include: scaleInclude });
      if (!before) throw new AppError(404, 'COMPETENCY_SCALE_NOT_FOUND', 'Scale not found');

      if (input.levels) {
        const existing = new Set(before.levels.map((l) => l.level));
        const incoming = new Set(input.levels.map((l) => l.level));
        const sameRungs = existing.size === incoming.size && [...existing].every((l) => incoming.has(l));
        if (!sameRungs && before._count.competencies > 0) {
          throw new AppError(409, 'COMPETENCY_SCALE_IN_USE', 'Competencies already use this scale, so its levels cannot be added to or removed — create a new scale instead');
        }
        for (const level of input.levels) {
          await tx.competencyScaleLevel.upsert({
            where: { scaleId_level: { scaleId: id, level: level.level } },
            create: { scaleId: id, level: level.level, label: level.label, description: level.description ?? null },
            update: { label: level.label, description: level.description ?? null },
          });
        }
        await tx.competencyScaleLevel.deleteMany({ where: { scaleId: id, level: { notIn: input.levels.map((l) => l.level) } } });
      }

      const after = await tx.competencyScale.update({
        where: { id },
        data: { name: input.name, description: input.description, isActive: input.isActive },
        include: scaleInclude,
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_COMPETENCY_SCALE, 'CompetencyScale', id,
        { name: after.name, isActive: after.isActive, levels: after.levels.length },
        { name: before.name, isActive: before.isActive, levels: before.levels.length }), tx);
      return after;
    });
    return toScaleDto(row);
  },

  /** The scale a level has to sit on, with its labels — used everywhere a level is validated or snapshotted. */
  async require(db: Db, scaleId: string) {
    const scale = await db.competencyScale.findUnique({ where: { id: scaleId }, include: { levels: { orderBy: { level: 'asc' } } } });
    if (!scale) throw new AppError(404, 'COMPETENCY_SCALE_NOT_FOUND', 'Scale not found');
    return scale;
  },
};

// ---------------------------------------------------------------------------
// competency library
// ---------------------------------------------------------------------------
const competencyInclude = {
  category: { select: { id: true, code: true, name: true } },
  scale: { include: { levels: { orderBy: { level: 'asc' as const } } } },
  indicators: { orderBy: { level: 'asc' as const } },
  _count: { select: { requirements: true, assessmentItems: true } },
} satisfies Prisma.CompetencyInclude;
type CompetencyRow = Prisma.CompetencyGetPayload<{ include: typeof competencyInclude }>;

const toCompetencyDto = (row: CompetencyRow): CompetencyDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  category: row.category,
  scale: {
    id: row.scale.id, code: row.scale.code, name: row.scale.name,
    levels: row.scale.levels.map((l) => ({ id: l.id, level: l.level, label: l.label, description: l.description })),
  },
  indicators: row.indicators.map((i) => ({ level: i.level, description: i.description })),
  isActive: row.isActive,
  inUse: row._count.requirements > 0 || row._count.assessmentItems > 0,
});

export const competencyService = {
  async list(q: CompetencyListQuery): Promise<{ data: CompetencyDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const where: Prisma.CompetencyWhereInput = {
      categoryId: q.categoryId,
      scaleId: q.scaleId,
      ...(q.status ? { isActive: q.status === 'active' } : {}),
      ...(q.search ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.competency.count({ where }),
      prisma.competency.findMany({ where, include: competencyInclude, orderBy: [{ category: { sortOrder: 'asc' } }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toCompetencyDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(id: string): Promise<CompetencyDto> {
    const row = await prisma.competency.findUnique({ where: { id }, include: competencyInclude });
    if (!row) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'Competency not found');
    return toCompetencyDto(row);
  },

  async create(input: CreateCompetencyInput, actor: Actor): Promise<CompetencyDto> {
    const duplicate = await prisma.competency.findUnique({ where: { code: input.code }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'COMPETENCY_CODE_TAKEN', `A competency with the code ${input.code} already exists`);
    const row = await prisma.$transaction(async (tx) => {
      const scale = await competencyScaleService.require(tx, input.scaleId);
      const category = await tx.competencyCategory.findUnique({ where: { id: input.categoryId }, select: { id: true } });
      if (!category) throw new AppError(404, 'COMPETENCY_CATEGORY_NOT_FOUND', 'Category not found');
      assertIndicatorsOnScale(input.indicators, scale.levels.map((l) => l.level), scale.name);

      const created = await tx.competency.create({
        data: {
          code: input.code, name: input.name, description: input.description ?? null,
          categoryId: input.categoryId, scaleId: input.scaleId, createdByUserId: actor.auth.userId,
          indicators: { create: input.indicators.map((i) => ({ level: i.level, description: i.description })) },
        },
        include: competencyInclude,
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.CREATE_COMPETENCY, 'Competency', created.id, {
        code: created.code, name: created.name, category: created.category.code, scale: created.scale.code,
      }), tx);
      return created;
    });
    return toCompetencyDto(row);
  },

  /**
   * Editing a competency changes the **library**. Assessments keep the code, name, category and level wording they
   * snapshotted, so renaming one today leaves every finished assessment reading exactly as it did.
   *
   * The scale is not editable at all: a competency measured on one scale cannot be re-based onto another without
   * making every recorded level ambiguous.
   */
  async update(id: string, input: UpdateCompetencyInput, actor: Actor): Promise<CompetencyDto> {
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.competency.findUnique({ where: { id }, include: competencyInclude });
      if (!before) throw new AppError(404, 'COMPETENCY_NOT_FOUND', 'Competency not found');
      if (input.indicators) assertIndicatorsOnScale(input.indicators, before.scale.levels.map((l) => l.level), before.scale.name);

      if (input.indicators) {
        await tx.competencyLevelIndicator.deleteMany({ where: { competencyId: id } });
        await tx.competencyLevelIndicator.createMany({ data: input.indicators.map((i) => ({ competencyId: id, level: i.level, description: i.description })) });
      }
      const after = await tx.competency.update({
        where: { id },
        data: { name: input.name, description: input.description, categoryId: input.categoryId, isActive: input.isActive },
        include: competencyInclude,
      });
      await auditService.log(competencyAudit(actor, AUDIT_ACTIONS.UPDATE_COMPETENCY, 'Competency', id,
        { name: after.name, isActive: after.isActive, category: after.category.code, indicators: after.indicators.length },
        { name: before.name, isActive: before.isActive, category: before.category.code, indicators: before.indicators.length }), tx);
      return after;
    });
    return toCompetencyDto(row);
  },
};

/** An indicator has to describe a level the competency's scale actually has. */
function assertIndicatorsOnScale(indicators: { level: number }[], levels: number[], scaleName: string) {
  for (const indicator of indicators) {
    if (!levels.includes(indicator.level)) {
      throw new AppError(422, 'COMPETENCY_LEVEL_INVALID', `Level ${indicator.level} is not on the ${scaleName} scale`);
    }
  }
}

export { assertIndicatorsOnScale };
