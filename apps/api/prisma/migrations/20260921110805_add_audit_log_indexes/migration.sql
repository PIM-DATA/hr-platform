-- DropIndex
DROP INDEX "audit_logs_module_record_id_idx";

-- DropIndex
DROP INDEX "audit_logs_user_id_idx";

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_module_created_at_idx" ON "audit_logs"("module", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_record_type_record_id_idx" ON "audit_logs"("record_type", "record_id");
