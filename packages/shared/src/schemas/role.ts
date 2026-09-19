import { z } from 'zod';

export const updateRolePermissionsSchema = z.object({
  permissionCodes: z.array(z.string().trim().min(1)).max(200),
});
export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsSchema>;

export interface PermissionDto {
  id: string;
  code: string;
  module: string;
  description: string | null;
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  dataScope: string;
  isSystem: boolean;
  permissionCodes: string[];
  userCount: number;
}
