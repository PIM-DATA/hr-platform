import type { Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

export interface ResolvedAssignment {
  positionId: string;
  departmentId: string;
  organizationId: string;
}

/**
 * Single place that turns a positionId into the (position, department, organization) triple the
 * employee record must carry. The client never supplies department/organization for an employee.
 * Validates the whole chain is active: position → department → organization, and the job.
 */
export async function resolvePositionAssignment(db: Db, positionId: string): Promise<ResolvedAssignment> {
  const position = await db.position.findUnique({
    where: { id: positionId },
    include: { department: { include: { organization: true } }, job: true },
  });
  if (!position) throw new AppError(404, 'POSITION_NOT_FOUND', 'Position not found');
  if (!position.isActive) throw new AppError(409, 'POSITION_INACTIVE', `Position ${position.code} is inactive`);
  if (!position.department.isActive) throw new AppError(409, 'DEPARTMENT_INACTIVE', `Department ${position.department.code} is inactive`);
  if (!position.department.organization.isActive) throw new AppError(409, 'ORGANIZATION_INACTIVE', `Organization ${position.department.organization.code} is inactive`);
  if (position.job && !position.job.isActive) throw new AppError(409, 'JOB_INACTIVE', `Job ${position.job.code} is inactive`);
  return { positionId: position.id, departmentId: position.departmentId, organizationId: position.department.organizationId };
}

/**
 * Validates a manager for `employeeId` (null when the employee is being created):
 *   exists · ACTIVE · not the employee itself · no cycle in the manager chain.
 * The cycle check loads (id, managerId) for all employees once and walks upward in memory (no N+1).
 */
export async function assertValidManager(db: Db, employeeId: string | null, managerId: string): Promise<void> {
  if (employeeId && managerId === employeeId) throw new AppError(400, 'SELF_MANAGER_NOT_ALLOWED', 'An employee cannot be their own manager');
  const manager = await db.employee.findUnique({ where: { id: managerId }, select: { id: true, employmentStatus: true, employeeCode: true } });
  if (!manager) throw new AppError(404, 'MANAGER_NOT_FOUND', 'Manager not found');
  if (manager.employmentStatus !== 'ACTIVE') throw new AppError(409, 'MANAGER_INACTIVE', `Manager ${manager.employeeCode} is not an active employee`);
  if (!employeeId) return; // a new employee cannot be in anyone's chain yet

  const pairs = await db.employee.findMany({ select: { id: true, managerId: true } });
  const managerOf = new Map(pairs.map((e) => [e.id, e.managerId]));
  let cursor: string | null = managerId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === employeeId) throw new AppError(400, 'MANAGER_CYCLE_NOT_ALLOWED', 'This assignment would create a cycle in the manager hierarchy');
    if (seen.has(cursor)) break; // defensive: pre-existing cycle in data
    seen.add(cursor);
    cursor = managerOf.get(cursor) ?? null;
  }
}
