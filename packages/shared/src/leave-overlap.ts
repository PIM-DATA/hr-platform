import { toUtcDate, type EndPart, type StartPart } from './business-date';

/** A leave span in business dates with half-day parts (startPart PM = starts at noon; endPart AM = ends at noon). */
export interface LeaveSpan {
  startDate: string;
  endDate: string;
  startPart: StartPart;
  endPart: EndPart;
}

/** Half-day slot index: day n → AM slot 2n, PM slot 2n+1. A span occupies [firstSlot, lastSlot] inclusive. */
function slots(s: LeaveSpan): [number, number] {
  const day = (d: string) => Math.round(toUtcDate(d).getTime() / 86_400_000);
  const first = day(s.startDate) * 2 + (s.startPart === 'PM' ? 1 : 0);
  const last = day(s.endDate) * 2 + (s.endPart === 'AM' ? 0 : 1);
  return [first, last];
}

/**
 * Half-day-aware overlap: two spans overlap when they share at least one half-day slot.
 * Full∩Full, Full∩AM, Full∩PM, AM∩AM, PM∩PM → overlap; AM∩PM of the same day → no overlap.
 * Single source of truth for the DB candidate re-check in the leave request service.
 */
export function leaveSpansOverlap(a: LeaveSpan, b: LeaveSpan): boolean {
  const [a1, a2] = slots(a);
  const [b1, b2] = slots(b);
  return a1 <= b2 && b1 <= a2;
}
