-- Task 43 separation of duties: administering RBAC is not salary authority. Remove the compensation-planning
-- permissions the Task 43 seed gave SYSTEM_ADMIN. One-time data change: the seeder only adds role permissions, and a
-- later deliberate grant through the Roles page (audited) is not reverted by this migration.
DELETE FROM "role_permissions"
WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'SYSTEM_ADMIN')
  AND "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" LIKE 'compensation_planning.%');
