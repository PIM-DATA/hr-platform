-- Task 47 (T44-P1-05): organization performance and competency reports become a reporting authority instead of
-- something every holder of performance.view / competency.view (every employee) could open.
-- Existing databases need the permissions and the grants explicitly (the seeder only runs on demand).
-- Granted to the roles that already see organization-wide HR aggregates: HR, HR_ADMIN, EXECUTIVE, SYSTEM_ADMIN.
INSERT INTO "permissions" ("id", "code", "module", "description") VALUES
  ('perm_performance_view_reports', 'performance.view_reports', 'performance', 'Organization performance reports: completion, averages and rating distribution, with small groups suppressed (needs an organization-wide scope)'),
  ('perm_competency_view_reports', 'competency.view_reports', 'competency', 'Organization competency gap reports, with small groups suppressed (needs an organization-wide scope)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."code" IN ('performance.view_reports', 'competency.view_reports')
WHERE r."code" IN ('HR', 'HR_ADMIN', 'EXECUTIVE', 'SYSTEM_ADMIN')
ON CONFLICT DO NOTHING;

-- The descriptions of the self-service permissions no longer promise organization reports.
UPDATE "permissions" SET "description" = 'View your own performance plan' WHERE "code" = 'performance.view';
UPDATE "permissions" SET "description" = 'View your own competency profile' WHERE "code" = 'competency.view';
