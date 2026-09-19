import { z } from 'zod';
import { paginationQuerySchema } from './common';

const emailField = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const passwordField = z.string().min(8, 'Password must be at least 8 characters').max(128);
const roleCodesField = z.array(z.string().trim().min(1)).min(1, 'Select at least one role').max(20);

export const createUserSchema = z.object({
  email: emailField,
  password: passwordField,
  roleCodes: roleCodesField,
  employeeId: z.string().min(1).nullable().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Generic profile update. Password and roles have their own endpoints. */
export const updateUserSchema = z
  .object({
    email: emailField.optional(),
    employeeId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const updateUserRolesSchema = z.object({ roleCodes: roleCodesField });
export type UpdateUserRolesInput = z.infer<typeof updateUserRolesSchema>;

export const resetPasswordSchema = z.object({ password: passwordField });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const USER_SORT_FIELDS = ['email', 'createdAt', 'lastLoginAt'] as const;
export const userListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(['active', 'inactive']).optional(),
  role: z.string().trim().min(1).optional(),
  sortBy: z.enum(USER_SORT_FIELDS).default('email'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const employeeOptionsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  /** Include the employee currently linked to this user (so the edit form can show it). */
  includeUserId: z.string().min(1).optional(),
});

/** Public user shape. Never contains passwordHash, sessions or tokens. */
export interface UserDto {
  id: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  employee: { id: string; employeeCode: string; firstName: string; lastName: string } | null;
  roles: { id: string; code: string; name: string }[];
}

export interface EmployeeOption {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  linkedUserId: string | null;
}
