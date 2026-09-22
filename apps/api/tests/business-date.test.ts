import { describe, expect, it } from 'vitest';
import { businessToday, calculateLeaveUnits, compareBusinessDate, enumerateDates, enumerateWorkingDays, isBusinessDate, isHalfDayUnit, isValidTimezone, isWorkingDay, normalizeWorkingDays, weekdayOf } from '@hr/shared';

const MON_FRI = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const;
// 2026-09-21 = Monday, 2026-09-26 = Saturday, 2026-09-27 = Sunday
const cal = (holidays: string[] = []) => ({ workingDays: MON_FRI, holidays });

describe('business dates', () => {
  it('53. valid real dates incl. leap day; 54. invalid dates / formats', () => {
    for (const ok of ['2026-09-22', '2028-02-29', '2026-12-31']) expect(isBusinessDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '22-09-2026', '2026-9-2', '2026-13-01', '2026-00-10', '2026-09-22T00:00:00Z', 20260922, null, '']) expect(isBusinessDate(bad), String(bad)).toBe(false);
  });
  it('55. comparison and enumeration', () => {
    expect(compareBusinessDate('2026-01-31', '2026-02-01')).toBeLessThan(0);
    expect(compareBusinessDate('2026-02-01', '2026-02-01')).toBe(0);
    expect(enumerateDates('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(enumerateDates('2026-03-02', '2026-03-01')).toEqual([]);
    expect(weekdayOf('2026-09-21')).toBe('MON');
    expect(weekdayOf('2026-09-27')).toBe('SUN');
  });
  it('working days normalization: known codes only, unique, ordered, non-empty', () => {
    expect(normalizeWorkingDays(['FRI', 'MON', 'WED'])).toEqual(['MON', 'WED', 'FRI']);
    expect(normalizeWorkingDays(['MON', 'MON'])).toBeNull();
    expect(normalizeWorkingDays(['MON', 'FUNDAY'])).toBeNull();
    expect(normalizeWorkingDays([])).toBeNull();
    expect(normalizeWorkingDays('MON')).toBeNull();
    expect(isWorkingDay('2026-09-26', MON_FRI)).toBe(false);
    expect(isWorkingDay('2026-09-26', ['SAT'])).toBe(true);
  });
  it('unit precision: multiples of 0.5, non-negative', () => {
    for (const ok of [0, 0.5, 1, 10, 10.5]) expect(isHalfDayUnit(ok)).toBe(true);
    for (const bad of [10.25, -0.5, 0.1, NaN, Infinity, '1']) expect(isHalfDayUnit(bad)).toBe(false);
  });
});

describe('timezone', () => {
  it('67. same instant → different business dates per timezone (injected now); UTC accepted', () => {
    const instant = new Date('2026-09-22T20:30:00Z'); // 03:30 next day in Bangkok, 16:30 same day in New York
    expect(businessToday('Asia/Bangkok', instant)).toBe('2026-09-23');
    expect(businessToday('America/New_York', instant)).toBe('2026-09-22');
    expect(businessToday('UTC', instant)).toBe('2026-09-22');
    expect(businessToday('Asia/Tokyo', new Date('2026-12-31T15:30:00Z'))).toBe('2027-01-01');
  });
  it('68. invalid timezones rejected; valid IANA accepted', () => {
    for (const ok of ['Asia/Bangkok', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'UTC']) expect(isValidTimezone(ok), ok).toBe(true);
    for (const bad of ['GMT+7-custom', 'abc', '+07:00', 'Asia', 'Bangkok', '', 7, null, 'EST5EDT']) expect(isValidTimezone(bad), String(bad)).toBe(false);
    expect(() => businessToday('+07:00')).toThrow(RangeError);
  });
});

describe('leave units (half-day precision)', () => {
  const units = (startDate: string, endDate: string, startPart: 'FULL' | 'PM' = 'FULL', endPart: 'FULL' | 'AM' = 'FULL', holidays: string[] = []) =>
    calculateLeaveUnits({ calendar: cal(holidays), startDate, endDate, startPart, endPart });
  it('56. one working day full = 1; 57/58. same-day AM or PM = 0.5', () => {
    expect(units('2026-09-22', '2026-09-22')).toMatchObject({ ok: true, units: 1 });
    expect(units('2026-09-22', '2026-09-22', 'FULL', 'AM')).toMatchObject({ ok: true, units: 0.5 }); // morning off
    expect(units('2026-09-22', '2026-09-22', 'PM', 'FULL')).toMatchObject({ ok: true, units: 0.5 }); // afternoon off
  });
  it('two working days = 2; 59. weekend excluded; 66. no working day = 0', () => {
    expect(units('2026-09-22', '2026-09-23')).toMatchObject({ ok: true, units: 2 });
    expect(units('2026-09-25', '2026-09-28')).toMatchObject({ ok: true, units: 2, workingDays: ['2026-09-25', '2026-09-28'] }); // Fri, Sat, Sun, Mon
    expect(units('2026-09-26', '2026-09-27')).toMatchObject({ ok: true, units: 0 });
  });
  it('60. holiday on a working day excluded; 61. holiday on weekend not double-counted', () => {
    expect(units('2026-09-21', '2026-09-25', 'FULL', 'FULL', ['2026-09-23'])).toMatchObject({ ok: true, units: 4 });
    expect(units('2026-09-25', '2026-09-28', 'FULL', 'FULL', ['2026-09-26'])).toMatchObject({ ok: true, units: 2 });
    expect(enumerateWorkingDays(cal(['2026-09-26', '2026-09-28']), '2026-09-25', '2026-09-29')).toEqual(['2026-09-25', '2026-09-29']);
  });
  it('62. multi-day start PM −0.5; 63. end AM −0.5; 64. start PM + end AM −1.0', () => {
    expect(units('2026-09-22', '2026-09-24', 'PM', 'FULL')).toMatchObject({ ok: true, units: 2.5 });
    expect(units('2026-09-22', '2026-09-24', 'FULL', 'AM')).toMatchObject({ ok: true, units: 2.5 });
    expect(units('2026-09-22', '2026-09-24', 'PM', 'AM')).toMatchObject({ ok: true, units: 2 });
  });
  it('65. invalid boundaries: same-day PM→AM, start after end, half-day on non-working day / holiday', () => {
    expect(units('2026-09-22', '2026-09-22', 'PM', 'AM')).toEqual({ ok: false, code: 'INVALID_HALF_DAY_BOUNDARY' });
    expect(units('2026-09-23', '2026-09-22')).toEqual({ ok: false, code: 'INVALID_DATE_RANGE' });
    expect(units('2026-09-26', '2026-09-28', 'PM', 'FULL')).toEqual({ ok: false, code: 'HALF_DAY_ON_NON_WORKING_DAY' }); // Saturday PM
    expect(units('2026-09-22', '2026-09-23', 'FULL', 'AM', ['2026-09-23'])).toEqual({ ok: false, code: 'HALF_DAY_ON_NON_WORKING_DAY' }); // AM on a holiday
  });
});
