import { z } from 'zod';
import { WEEKDAYS, isBusinessDate, isValidTimezone, normalizeWorkingDays } from '../business-date';
import { paginationQuerySchema } from './common';

/** Canonical business date: real calendar date in YYYY-MM-DD. */
export const businessDateSchema = z.string().refine(isBusinessDate, { message: 'Must be a real date in YYYY-MM-DD form' });
export const timezoneSchema = z.string().trim().refine(isValidTimezone, { message: 'Must be an IANA timezone such as Asia/Bangkok' });
export const workingDaysSchema = z
  .array(z.enum(WEEKDAYS))
  .min(1, 'At least one working day')
  .refine((v) => normalizeWorkingDays(v) !== null, { message: 'Working days must be unique weekday codes' })
  .transform((v) => normalizeWorkingDays(v)!);

const codeField = z.string().trim().toUpperCase().min(1, 'Code is required').max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Use letters, numbers, dot, dash or underscore');
const nameField = z.string().trim().min(1, 'Name is required').max(120);
const nonEmpty = <T extends z.ZodRawShape>(shape: T) => z.object(shape).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const createCalendarSchema = z.object({ organizationId: z.string().min(1, 'Organization is required'), code: codeField, name: nameField, workingDays: workingDaysSchema });
export const updateCalendarSchema = nonEmpty({ code: codeField.optional(), name: nameField.optional(), workingDays: workingDaysSchema.optional() });
export const calendarListQuerySchema = paginationQuerySchema.extend({ organizationId: z.string().min(1).optional(), status: z.enum(['active', 'inactive']).optional() });
export const setDefaultCalendarSchema = z.object({ calendarId: z.string().min(1).nullable() });

export const createHolidaySchema = z.object({ date: businessDateSchema, name: nameField });
export const updateHolidaySchema = nonEmpty({ date: businessDateSchema.optional(), name: nameField.optional() });
export const holidayListQuerySchema = z.object({ year: z.coerce.number().int().min(1970).max(2200).optional(), status: z.enum(['active', 'inactive']).optional() });

export type CreateCalendarInput = z.infer<typeof createCalendarSchema>;
export type UpdateCalendarInput = z.infer<typeof updateCalendarSchema>;
export type CalendarListQuery = z.infer<typeof calendarListQuerySchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;

export interface HolidayDto { id: string; calendarId: string; date: string; name: string; isActive: boolean; createdAt: string; updatedAt: string }
export interface WorkCalendarDto {
  id: string;
  organization: { id: string; code: string; name: string };
  code: string;
  name: string;
  workingDays: string[];
  isActive: boolean;
  isDefault: boolean;
  holidayCount: number;
  createdAt: string;
  updatedAt: string;
}
