import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { listFiles, sha256File } from './backup-set';

/**
 * Task 49 — operational integrity checks (report only: nothing is repaired, moved or deleted).
 *
 * Documents (T44-P1-10): every DocumentVersion must have its stored object, with the recorded size (and, with `deep`,
 * the recorded sha256). Objects in the store that no version references are listed as orphans — after a restore these
 * are expected (objects uploaded after the database snapshot) and are a warning, not a failure.
 *
 * Financial handoff (T44-P1-15, Task 48 follow-up): a benefit claim or expense report in SENT_TO_PAYROLL must point at
 * an existing payroll line that points back at it; a handoff line must point at an existing source in a payroll state.
 *
 * Output carries record ids and opaque storage keys only — never an original file name, an amount or a person.
 */
const OBJECT_KEY = /^documents\/[0-9a-f]{2}\/[0-9a-f-]{36}$/;
const SAMPLE = 20;

export interface IntegrityReport {
  ok: boolean;
  documents: { enabled: boolean; versions: number; objects: number; missing: number; sizeMismatch: number; checksumMismatch: number; orphans: number; deep: boolean; samples: { missing: string[]; mismatch: string[]; orphans: string[] } } | null;
  financial: { sentWithoutLine: number; lineWithoutSource: number; lineSourceNotInPayroll: number; samples: string[] };
  failures: string[];
  warnings: string[];
}

export async function runIntegrity(prisma: PrismaClient, documentsRoot: string | null, opts: { deep?: boolean } = {}): Promise<IntegrityReport> {
  const failures: string[] = [];
  const warnings: string[] = [];
  let documents: IntegrityReport['documents'] = null;

  if (documentsRoot) {
    const versions = await prisma.documentVersion.findMany({ select: { id: true, storageKey: true, fileSize: true, sha256: true } });
    const rootOk = (await stat(documentsRoot).catch(() => null))?.isDirectory() ?? false;
    const objects = rootOk ? (await listFiles(documentsRoot)).filter((k) => OBJECT_KEY.test(k)) : [];
    const present = new Set(objects);
    const missing: string[] = [];
    const mismatch: string[] = [];
    let sizeMismatch = 0;
    let checksumMismatch = 0;
    for (const v of versions) {
      if (!present.has(v.storageKey)) { missing.push(v.id); continue; }
      const full = path.join(documentsRoot, v.storageKey);
      const s = await stat(full);
      if (s.size !== v.fileSize) { sizeMismatch += 1; mismatch.push(v.id); continue; }
      if (opts.deep && (await sha256File(full)) !== v.sha256) { checksumMismatch += 1; mismatch.push(v.id); }
    }
    const referenced = new Set(versions.map((v) => v.storageKey));
    const orphans = objects.filter((k) => !referenced.has(k));
    documents = {
      enabled: true, versions: versions.length, objects: objects.length, missing: missing.length, sizeMismatch, checksumMismatch, orphans: orphans.length, deep: !!opts.deep,
      samples: { missing: missing.slice(0, SAMPLE), mismatch: mismatch.slice(0, SAMPLE), orphans: orphans.slice(0, SAMPLE) },
    };
    if (!rootOk && versions.length > 0) failures.push('DOCUMENT_ROOT_UNAVAILABLE');
    if (missing.length) failures.push(`DOCUMENT_OBJECTS_MISSING: ${missing.length} version(s) without their stored object`);
    if (sizeMismatch || checksumMismatch) failures.push(`DOCUMENT_OBJECTS_MISMATCH: ${sizeMismatch} size and ${checksumMismatch} checksum mismatch(es)`);
    if (orphans.length) warnings.push(`DOCUMENT_ORPHANS: ${orphans.length} stored object(s) with no version (expected after a restore; not deleted)`);
  }

  // Financial handoff (FK RESTRICT prevents new dangling pointers since Task 48; history and direct writes may still exist)
  const samples: string[] = [];
  const sentClaims = await prisma.benefitClaim.findMany({ where: { status: 'SENT_TO_PAYROLL' }, select: { id: true, payrollResultItemId: true } });
  const sentReports = await prisma.expenseReport.findMany({ where: { status: 'SENT_TO_PAYROLL' }, select: { id: true, payrollResultItemId: true } });
  const lineIds = [...sentClaims, ...sentReports].map((r) => r.payrollResultItemId).filter((x): x is string => !!x);
  const lines = await prisma.payrollResultItem.findMany({ where: { id: { in: lineIds } }, select: { id: true, referenceType: true, referenceId: true } });
  const lineById = new Map(lines.map((l) => [l.id, l]));
  let sentWithoutLine = 0;
  for (const [kind, rows] of [['BENEFIT_CLAIM', sentClaims], ['EXPENSE_REPORT', sentReports]] as const) {
    for (const r of rows) {
      const line = r.payrollResultItemId ? lineById.get(r.payrollResultItemId) : undefined;
      if (!line || line.referenceType !== kind || line.referenceId !== r.id) { sentWithoutLine += 1; if (samples.length < SAMPLE) samples.push(`${kind}:${r.id}`); }
    }
  }
  const handoffLines = await prisma.payrollResultItem.findMany({ where: { referenceType: { in: ['BENEFIT_CLAIM', 'EXPENSE_REPORT'] } }, select: { id: true, referenceType: true, referenceId: true } });
  const claimIds = handoffLines.filter((l) => l.referenceType === 'BENEFIT_CLAIM').map((l) => l.referenceId!);
  const reportIds = handoffLines.filter((l) => l.referenceType === 'EXPENSE_REPORT').map((l) => l.referenceId!);
  const claims = new Map((await prisma.benefitClaim.findMany({ where: { id: { in: claimIds } }, select: { id: true, status: true } })).map((c) => [c.id, c.status]));
  const reports = new Map((await prisma.expenseReport.findMany({ where: { id: { in: reportIds } }, select: { id: true, status: true } })).map((r) => [r.id, r.status]));
  let lineWithoutSource = 0;
  let lineSourceNotInPayroll = 0;
  for (const l of handoffLines) {
    const status = (l.referenceType === 'BENEFIT_CLAIM' ? claims : reports).get(l.referenceId ?? '');
    if (!status) { lineWithoutSource += 1; if (samples.length < SAMPLE) samples.push(`LINE:${l.id}`); }
    else if (!['SENT_TO_PAYROLL', 'PAID'].includes(status)) { lineSourceNotInPayroll += 1; if (samples.length < SAMPLE) samples.push(`LINE:${l.id}`); }
  }
  if (sentWithoutLine) failures.push(`FINANCIAL_SENT_WITHOUT_PAYROLL_LINE: ${sentWithoutLine} claim(s)/report(s) are SENT_TO_PAYROLL without a matching payroll line — reconcile by hand`);
  if (lineWithoutSource) failures.push(`FINANCIAL_LINE_WITHOUT_SOURCE: ${lineWithoutSource} handoff line(s) point at no claim/report`);
  if (lineSourceNotInPayroll) failures.push(`FINANCIAL_LINE_SOURCE_NOT_IN_PAYROLL: ${lineSourceNotInPayroll} handoff line(s) whose source is not SENT_TO_PAYROLL/PAID`);

  return { ok: failures.length === 0, documents, financial: { sentWithoutLine, lineWithoutSource, lineSourceNotInPayroll, samples }, failures, warnings };
}
