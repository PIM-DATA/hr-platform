import { APPLICATION_ACTIVE_STAGES, APPLICATION_STAGE_ORDER, type ApplicationStage } from './enums';

/**
 * Pure recruitment rules (Task 27). No I/O, no dates from the clock, nothing that could differ between the API and
 * the browser.
 */

export const RECRUITMENT_NUMBER_PREFIX = { requisition: 'REQ', opening: 'OPN', candidate: 'CND', application: 'APP', offer: 'OFR' } as const;
export type RecruitmentNumberKind = keyof typeof RECRUITMENT_NUMBER_PREFIX;

/** `REQ-2026-000001`: kind, year, six-digit sequence. */
export function formatRecruitmentNumber(kind: RecruitmentNumberKind, year: number, sequence: number): string {
  return `${RECRUITMENT_NUMBER_PREFIX[kind]}-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Exact-match duplicate detection only: lower-case and trim. Nothing fuzzy, so a false "duplicate" cannot happen. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

/** Digits only, with a leading `+` kept when present. `+66 (0)81-234 5678` and `+66081 234 5678` compare equal. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

export const isActiveStage = (stage: string): stage is (typeof APPLICATION_ACTIVE_STAGES)[number] => (APPLICATION_ACTIVE_STAGES as readonly string[]).includes(stage);
export const isTerminalStage = (stage: string) => !isActiveStage(stage);

/**
 * Whether a recruiter may move an application by hand from one stage to another.
 *
 * HIRED, REJECTED and WITHDRAWN are never reached by a move: each has its own action with its own checks. Moving
 * forward is a routine step; moving back is unusual enough that a reason is required, and it is recorded.
 */
export function stageMoveCheck(from: string, to: string, reason: string | null | undefined): { ok: true; backwards: boolean } | { ok: false; code: string; message: string } {
  if (!isActiveStage(from)) return { ok: false, code: 'APPLICATION_CLOSED', message: `This application is ${from.toLowerCase()} and cannot be moved` };
  if (!isActiveStage(to) || to === 'APPLIED') return { ok: false, code: 'INVALID_STAGE', message: `Applications cannot be moved to ${to}` };
  if (from === to) return { ok: false, code: 'SAME_STAGE', message: `This application is already at ${to}` };
  const backwards = APPLICATION_STAGE_ORDER.indexOf(to as ApplicationStage) < APPLICATION_STAGE_ORDER.indexOf(from as ApplicationStage);
  if (backwards && !reason?.trim()) return { ok: false, code: 'REASON_REQUIRED', message: 'Moving an application back a stage needs a reason' };
  return { ok: true, backwards };
}

/** Whole days between two instants (UTC), never negative. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Average time to hire: `appliedAt` → `hiredAt`, in days, over the hires given, rounded to one decimal. Null when
 * there are no hires — an average of nothing is not zero. Time-to-fill (requisition approval → hire) is deferred.
 */
export function averageTimeToHireDays(hires: { appliedAt: string; hiredAt: Date }[]): number | null {
  if (hires.length === 0) return null;
  const total = hires.reduce((sum, h) => sum + daysBetween(new Date(`${h.appliedAt}T00:00:00Z`), h.hiredAt), 0);
  return Math.round((total / hires.length) * 10) / 10;
}
