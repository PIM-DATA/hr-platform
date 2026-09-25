-- CreateTable
CREATE TABLE "expense_sequences" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "expense_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "currency" TEXT NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "workflow_code" TEXT NOT NULL,
    "maximum_report_amount" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_policy_rules" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "requires_receipt" BOOLEAN NOT NULL DEFAULT false,
    "receipt_required_above" DECIMAL(18,2),
    "per_item_maximum" DECIMAL(18,2),
    "maximum_age_days" INTEGER,
    "allowed_for_travel_only" BOOLEAN NOT NULL DEFAULT false,
    "description_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "expense_policy_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_policy_applicability" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "rule_type" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "expense_policy_applicability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_policies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "currency" TEXT NOT NULL,
    "workflow_code" TEXT NOT NULL,
    "expense_policy_id" TEXT,
    "maximum_estimated_amount" DECIMAL(18,2),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_requests" (
    "id" TEXT NOT NULL,
    "request_number" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "travel_policy_id" TEXT NOT NULL,
    "travel_policy_name_snapshot" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "purpose" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "estimated_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_reports" (
    "id" TEXT NOT NULL,
    "report_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "travel_request_id" TEXT,
    "policy_code_snapshot" TEXT NOT NULL,
    "policy_name_snapshot" TEXT NOT NULL,
    "maximum_report_amount_snapshot" DECIMAL(18,2),
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "currency" TEXT NOT NULL,
    "total_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "payment_method" TEXT,
    "payment_reference" TEXT,
    "paid_date" TEXT,
    "paid_at" TIMESTAMP(3),
    "paid_by_user_id" TEXT,
    "payroll_result_item_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_items" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "category_code_snapshot" TEXT NOT NULL,
    "category_name_snapshot" TEXT NOT NULL,
    "expense_date" TEXT NOT NULL,
    "merchant" TEXT,
    "description" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "original_amount" DECIMAL(18,2),
    "original_currency" TEXT,
    "receipt_required_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "per_item_maximum_snapshot" DECIMAL(18,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_status_history" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "reason_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_code_key" ON "expense_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "expense_policies_code_key" ON "expense_policies"("code");

-- CreateIndex
CREATE INDEX "expense_policies_status_effective_from_effective_to_idx" ON "expense_policies"("status", "effective_from", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "expense_policy_rules_policy_id_category_id_key" ON "expense_policy_rules"("policy_id", "category_id");

-- CreateIndex
CREATE INDEX "expense_policy_applicability_policy_id_idx" ON "expense_policy_applicability"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "travel_policies_code_key" ON "travel_policies"("code");

-- CreateIndex
CREATE INDEX "travel_policies_status_effective_from_effective_to_idx" ON "travel_policies"("status", "effective_from", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "travel_requests_request_number_key" ON "travel_requests"("request_number");

-- CreateIndex
CREATE UNIQUE INDEX "travel_requests_workflow_instance_id_key" ON "travel_requests"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "travel_requests_employee_id_status_idx" ON "travel_requests"("employee_id", "status");

-- CreateIndex
CREATE INDEX "travel_requests_status_start_date_idx" ON "travel_requests"("status", "start_date");

-- CreateIndex
CREATE INDEX "travel_requests_start_date_end_date_idx" ON "travel_requests"("start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "expense_reports_report_number_key" ON "expense_reports"("report_number");

-- CreateIndex
CREATE UNIQUE INDEX "expense_reports_workflow_instance_id_key" ON "expense_reports"("workflow_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "expense_reports_payroll_result_item_id_key" ON "expense_reports"("payroll_result_item_id");

-- CreateIndex
CREATE INDEX "expense_reports_employee_id_status_idx" ON "expense_reports"("employee_id", "status");

-- CreateIndex
CREATE INDEX "expense_reports_policy_id_status_idx" ON "expense_reports"("policy_id", "status");

-- CreateIndex
CREATE INDEX "expense_reports_travel_request_id_idx" ON "expense_reports"("travel_request_id");

-- CreateIndex
CREATE INDEX "expense_reports_status_submitted_at_idx" ON "expense_reports"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "expense_reports_paid_date_idx" ON "expense_reports"("paid_date");

-- CreateIndex
CREATE INDEX "expense_items_report_id_expense_date_idx" ON "expense_items"("report_id", "expense_date");

-- CreateIndex
CREATE INDEX "expense_items_category_id_idx" ON "expense_items"("category_id");

-- CreateIndex
CREATE INDEX "expense_status_history_entity_type_entity_id_created_at_idx" ON "expense_status_history"("entity_type", "entity_id", "created_at");

-- AddForeignKey
ALTER TABLE "expense_policy_rules" ADD CONSTRAINT "expense_policy_rules_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "expense_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_policy_rules" ADD CONSTRAINT "expense_policy_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_policy_applicability" ADD CONSTRAINT "expense_policy_applicability_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "expense_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_policies" ADD CONSTRAINT "travel_policies_expense_policy_id_fkey" FOREIGN KEY ("expense_policy_id") REFERENCES "expense_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_travel_policy_id_fkey" FOREIGN KEY ("travel_policy_id") REFERENCES "travel_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "expense_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_travel_request_id_fkey" FOREIGN KEY ("travel_request_id") REFERENCES "travel_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "expense_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
