import { z } from 'zod';

/** Shared list-query schema: pagination + free-text search. Modules extend it. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const idParamSchema = z.object({ id: z.string().min(1) });

/** Standard API envelope types (documented in README). */
export interface ApiListMeta {
  page: number;
  pageSize: number;
  total: number;
}
export interface ApiError {
  code: string;
  message: string;
  details?: { field?: string; message: string }[];
}
