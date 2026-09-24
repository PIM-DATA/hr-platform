import type { DisciplinaryValidityState } from './enums';
import { compareBusinessDate } from './business-date';

/**
 * Employee relations: the pure parts.
 *
 * This module is an operational record of what was reported, proposed, approved, issued and received. It is not a
 * legal engine, and nothing here concludes anything about anybody: which action is appropriate, how long it stands,
 * and what any of it means under employment law are the customer's decisions, taken under the customer's policy.
 */

/**
 * Whether an issued warning still stands. Derived on read, never by a scheduler: a warning "expires" because today is
 * past `validUntil`, not because a job ran. A warning with no end date stands until something says otherwise.
 */
export function validityState(status: string, validUntil: string | null, today: string): DisciplinaryValidityState {
  if (status !== 'ISSUED' && status !== 'ACKNOWLEDGED') return 'NOT_APPLICABLE';
  if (!validUntil) return 'ACTIVE';
  return compareBusinessDate(validUntil, today) >= 0 ? 'ACTIVE' : 'EXPIRED';
}

/** `ER-2026-000123`. A display convention; nothing else keys off its shape. */
export const formatCaseNumber = (year: number, sequence: number) => `ER-${year}-${String(sequence).padStart(6, '0')}`;

/**
 * The only placeholders a letter template may use. Anything else is left exactly as typed — there is no expression
 * language, no evaluation, and nothing a template author writes can run.
 */
export const LETTER_PLACEHOLDERS = [
  'employeeName', 'employeeCode', 'incidentDate', 'actionName', 'department', 'position', 'organization', 'issuedDate', 'validUntil',
] as const;
export type LetterPlaceholder = (typeof LETTER_PLACEHOLDERS)[number];
export type LetterValues = Partial<Record<LetterPlaceholder, string | null | undefined>>;

/**
 * Fills `{{placeholder}}` slots from the allow-list. Unknown slots stay literal, and so does an allow-listed slot the
 * caller has not supplied yet — a draft can be rendered before the issue date is known and filled in at issue. A
 * value that is supplied as null or empty becomes an em dash: "no end date" is an answer, not a gap.
 * The output is plain text — how it is displayed is the renderer's job, and the renderer escapes it.
 */
export function renderLetterTemplate(template: string, values: LetterValues): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, key: string) => {
    if (!(LETTER_PLACEHOLDERS as readonly string[]).includes(key)) return match;
    if (!(key in values)) return match;
    const value = values[key as LetterPlaceholder];
    return value === null || value === undefined || value === '' ? '—' : String(value);
  });
}

/** Strips anything that is not plain text. Letters are text; a `<script>` in one is an attack, not formatting. */
export function toPlainText(input: string): string {
  return input.replace(/<[^>]*>/g, '').replace(/\r\n?/g, '\n').trim();
}
