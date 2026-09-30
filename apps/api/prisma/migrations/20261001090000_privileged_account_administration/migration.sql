-- Task 45: privileged-account administration authority.
-- `users.manage_privileged` is required to reset, sign out, edit, (de)activate or re-role an account that holds RBAC
-- administration (roles.manage) or this permission. Existing databases need it explicitly: the seeder only runs on
-- demand, and without this row no administrator could administer a peer administrator after the upgrade.
-- Granted to SYSTEM_ADMIN only (least privilege). Idempotent; forward-only.
INSERT INTO "permissions" ("id", "code", "module", "description")
VALUES (
  'perm_users_manage_privileged',
  'users.manage_privileged',
  'users',
  'Administer privileged accounts (those holding roles.manage or this permission): reset links, sign-out, edit, activate/deactivate, role changes. Grants no business access'
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" = 'users.manage_privileged'
WHERE r."code" = 'SYSTEM_ADMIN'
ON CONFLICT DO NOTHING;
