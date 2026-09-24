import type { Prisma } from '@prisma/client';
import { AUDIT_ACTIONS, normalizeEmail, normalizePhone, type CandidateDto, type CandidateListQuery, type CreateCandidateInput, type DuplicateCandidateDto, type UpdateCandidateInput } from '@hr/shared';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { auditService } from '../../services/audit/audit.service';
import type { AuthContext } from '../auth/auth.types';
import { applicationScopeWhere, isRecruitmentAdmin, lockRow, nextNumber, notFound, recruitmentAudit, textAudit, type Actor, type Db } from './recruitment.types';

/**
 * Candidates — people outside the company.
 *
 * The profile is the minimum a recruiter needs: name, contact, current role, source, a summary. Nothing protected is
 * modelled, so nothing protected can be stored. A candidate is never deleted — the applications, interviews and
 * offers that reference them are a record of decisions — but can be archived. A likely duplicate (same normalized
 * email or phone) is reported, not merged; the recruiter decides.
 */
const include = { _count: { select: { applications: true } } } satisfies Prisma.RecruitmentCandidateInclude;
type Row = Prisma.RecruitmentCandidateGetPayload<{ include: typeof include }>;

const toDto = (row: Row): CandidateDto => ({
  id: row.id, candidateNumber: row.candidateNumber, firstName: row.firstName, lastName: row.lastName, email: row.email, phone: row.phone,
  currentCompany: row.currentCompany, currentTitle: row.currentTitle, locationText: row.locationText, source: row.source as CandidateDto['source'],
  sourceDetail: row.sourceDetail, summary: row.summary, status: row.status as CandidateDto['status'], hiredEmployeeId: row.hiredEmployeeId,
  applicationCount: row._count.applications, createdAt: row.createdAt.toISOString(),
});

export async function loadCandidate(db: Db, id: string) {
  const row = await db.recruitmentCandidate.findUnique({ where: { id }, include });
  if (!row) throw notFound('candidate');
  return row;
}

/** Non-admins see only candidates with an application they may see. */
const scopeWhere = (auth: AuthContext): Prisma.RecruitmentCandidateWhereInput => (isRecruitmentAdmin(auth) ? {} : { applications: { some: applicationScopeWhere(auth) } });

async function findDuplicates(db: Db, emailNormalized: string | null, phoneNormalized: string | null, excludeId: string | null): Promise<DuplicateCandidateDto[]> {
  if (!emailNormalized && !phoneNormalized) return [];
  const rows = await db.recruitmentCandidate.findMany({
    where: { ...(excludeId ? { id: { not: excludeId } } : {}), OR: [...(emailNormalized ? [{ emailNormalized }] : []), ...(phoneNormalized ? [{ phoneNormalized }] : [])] },
    select: { id: true, candidateNumber: true, firstName: true, lastName: true, emailNormalized: true },
    take: 10,
  });
  return rows.map((r) => ({ id: r.id, candidateNumber: r.candidateNumber, firstName: r.firstName, lastName: r.lastName, matchedOn: emailNormalized && r.emailNormalized === emailNormalized ? 'email' : 'phone' }));
}

export const candidateService = {
  async list(auth: AuthContext, q: CandidateListQuery) {
    const where: Prisma.RecruitmentCandidateWhereInput = {
      ...scopeWhere(auth), status: q.status, source: q.source,
      ...(q.search ? { OR: [{ candidateNumber: { contains: q.search, mode: 'insensitive' } }, { firstName: { contains: q.search, mode: 'insensitive' } }, { lastName: { contains: q.search, mode: 'insensitive' } }, { emailNormalized: { contains: q.search.toLowerCase() } }] } : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.recruitmentCandidate.count({ where }),
      prisma.recruitmentCandidate.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { data: rows.map(toDto), meta: { page: q.page, pageSize: q.pageSize, total } };
  },

  async get(auth: AuthContext, id: string): Promise<CandidateDto> {
    const row = await prisma.recruitmentCandidate.findFirst({ where: { id, ...scopeWhere(auth) }, include });
    if (!row) throw notFound('candidate');
    return toDto(row);
  },

  /** Exact-match duplicate check, so the UI can warn before the recruiter saves. */
  async duplicates(email: string | null | undefined, phone: string | null | undefined, excludeId: string | null): Promise<DuplicateCandidateDto[]> {
    return findDuplicates(prisma, normalizeEmail(email), normalizePhone(phone), excludeId);
  },

  async create(input: CreateCandidateInput, actor: Actor): Promise<{ candidate: CandidateDto; duplicates: DuplicateCandidateDto[] }> {
    const emailNormalized = normalizeEmail(input.email);
    const phoneNormalized = normalizePhone(input.phone);
    const { row, duplicates } = await prisma.$transaction(async (tx) => {
      const duplicates = await findDuplicates(tx, emailNormalized, phoneNormalized, null);
      if (duplicates.length && !input.allowDuplicate) throw new AppError(409, 'CANDIDATE_POSSIBLE_DUPLICATE', 'A candidate with the same email or phone already exists', duplicates.map((d) => ({ field: d.matchedOn, message: d.candidateNumber })));
      const candidateNumber = await nextNumber(tx, 'candidate');
      const created = await tx.recruitmentCandidate.create({
        data: {
          candidateNumber, firstName: input.firstName, lastName: input.lastName, email: input.email ?? null, emailNormalized, phone: input.phone ?? null, phoneNormalized,
          currentCompany: input.currentCompany ?? null, currentTitle: input.currentTitle ?? null, locationText: input.locationText ?? null,
          source: input.source, sourceDetail: input.sourceDetail ?? null, summary: input.summary ?? null, createdByUserId: actor.auth.userId,
        },
        include,
      });
      // Names and contact details stay out of the log: the candidate number is enough to find the record.
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.CREATE_CANDIDATE, 'RecruitmentCandidate', created.id, { candidateNumber, source: input.source, duplicatesAcknowledged: duplicates.length }), tx);
      return { row: created, duplicates };
    });
    return { candidate: toDto(row), duplicates };
  },

  async update(id: string, input: UpdateCandidateInput, actor: Actor): Promise<CandidateDto> {
    const row = await prisma.$transaction(async (tx) => {
      await lockRow(tx, 'recruitment_candidates', id);
      const before = await loadCandidate(tx, id);
      if (before.status === 'HIRED' && input.status) throw new AppError(409, 'CANDIDATE_HIRED', 'A hired candidate keeps their status; the employee record is the live one now');
      const email = input.email === undefined ? before.email : input.email;
      const phone = input.phone === undefined ? before.phone : input.phone;
      const updated = await tx.recruitmentCandidate.update({
        where: { id },
        data: {
          firstName: input.firstName, lastName: input.lastName, email, emailNormalized: normalizeEmail(email), phone, phoneNormalized: normalizePhone(phone),
          currentCompany: input.currentCompany, currentTitle: input.currentTitle, locationText: input.locationText, source: input.source, sourceDetail: input.sourceDetail,
          summary: input.summary, status: input.status,
        },
        include,
      });
      await auditService.log(recruitmentAudit(actor, AUDIT_ACTIONS.UPDATE_CANDIDATE, 'RecruitmentCandidate', id,
        { candidateNumber: before.candidateNumber, fields: Object.keys(input).filter((k) => k !== 'summary'), status: updated.status, ...textAudit('summary', before.summary, updated.summary) },
        { status: before.status }), tx);
      return updated;
    });
    return toDto(row);
  },
};
