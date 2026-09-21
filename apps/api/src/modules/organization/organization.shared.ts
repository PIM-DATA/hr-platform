import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import type { AuthContext } from '../auth/auth.types';

export type Actor = { auth: AuthContext; ipAddress: string | null; userAgent: string | null };
export type Db = Prisma.TransactionClient;

export const MODULE = 'organization';

export function actorMeta(actor: Actor) {
  return { userId: actor.auth.userId, ipAddress: actor.ipAddress, userAgent: actor.userAgent };
}

export function inUse(code: string, entity: string, reasons: string[]) {
  return new AppError(409, code, `${entity} is still in use: ${reasons.join(', ')}`);
}

export const notFound = {
  organization: () => new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found'),
  department: () => new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found'),
  job: () => new AppError(404, 'JOB_NOT_FOUND', 'Job not found'),
  position: () => new AppError(404, 'POSITION_NOT_FOUND', 'Position not found'),
};

export function paging<T extends { page: number; pageSize: number }>(q: T) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}
