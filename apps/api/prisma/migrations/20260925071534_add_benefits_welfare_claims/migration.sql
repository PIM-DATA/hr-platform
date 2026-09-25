-- CreateTable
CREATE TABLE "benefit_sequences" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "benefit_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "benefit_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "plan_type" TEXT NOT NULL,
    "currency" TEXT,
    "default_entitlement_amount" DECIMAL(18,2),
    "per_claim_maximum" DECIMAL(18,2),
    "requires_document" BOOLEAN NOT NULL DEFAULT false,
    "employee_selectable" BOOLEAN NOT NULL DEFAULT false,
    "allow_post_employment_claims" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity" TEXT NOT NULL DEFAULT 'NORMAL',
    "workflow_definition_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_eligibility_rules" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "rule_type" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "benefit_eligibility_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_eligibility_overrides" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_eligibility_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_periods" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "entitlement_amount_snapshot" DECIMAL(18,2),
    "per_claim_maximum_snapshot" DECIMAL(18,2),
    "currency_snapshot" TEXT,
    "requires_document_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_enrollments" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ELIGIBLE',
    "source" TEXT,
    "enrolled_at" TIMESTAMP(3),
    "waived_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "coverage_start" TEXT,
    "coverage_end" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_entitlements" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "granted_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "adjustment_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reserved_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "consumed_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "benefit_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_entitlement_ledger" (
    "id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "claim_id" TEXT,
    "operation_key" TEXT,
    "reason_code" TEXT,
    "note" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_entitlement_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_claims" (
    "id" TEXT NOT NULL,
    "claim_number" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "entitlement_id" TEXT,
    "plan_code_snapshot" TEXT NOT NULL,
    "plan_name_snapshot" TEXT NOT NULL,
    "category_snapshot" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "currency" TEXT NOT NULL,
    "claimed_amount" DECIMAL(18,2) NOT NULL,
    "approved_amount" DECIMAL(18,2),
    "per_claim_maximum_snapshot" DECIMAL(18,2),
    "requires_document_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "sensitivity_snapshot" TEXT NOT NULL DEFAULT 'NORMAL',
    "service_date" TEXT NOT NULL,
    "submitted_date" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
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

    CONSTRAINT "benefit_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "benefit_claim_status_history" (
    "id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "reason_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "benefit_claim_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "benefit_categories_code_key" ON "benefit_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_plans_code_key" ON "benefit_plans"("code");

-- CreateIndex
CREATE INDEX "benefit_plans_status_effective_from_effective_to_idx" ON "benefit_plans"("status", "effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "benefit_plans_category_id_idx" ON "benefit_plans"("category_id");

-- CreateIndex
CREATE INDEX "benefit_eligibility_rules_plan_id_idx" ON "benefit_eligibility_rules"("plan_id");

-- CreateIndex
CREATE INDEX "benefit_eligibility_overrides_plan_id_employee_id_supersede_idx" ON "benefit_eligibility_overrides"("plan_id", "employee_id", "superseded_at");

-- CreateIndex
CREATE INDEX "benefit_periods_plan_id_status_idx" ON "benefit_periods"("plan_id", "status");

-- CreateIndex
CREATE INDEX "benefit_enrollments_plan_id_status_idx" ON "benefit_enrollments"("plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_enrollments_employee_id_plan_id_key" ON "benefit_enrollments"("employee_id", "plan_id");

-- CreateIndex
CREATE INDEX "benefit_entitlements_plan_id_period_id_idx" ON "benefit_entitlements"("plan_id", "period_id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_entitlements_employee_id_plan_id_period_id_key" ON "benefit_entitlements"("employee_id", "plan_id", "period_id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_entitlement_ledger_operation_key_key" ON "benefit_entitlement_ledger"("operation_key");

-- CreateIndex
CREATE INDEX "benefit_entitlement_ledger_entitlement_id_created_at_idx" ON "benefit_entitlement_ledger"("entitlement_id", "created_at");

-- CreateIndex
CREATE INDEX "benefit_entitlement_ledger_claim_id_idx" ON "benefit_entitlement_ledger"("claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_claims_claim_number_key" ON "benefit_claims"("claim_number");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_claims_workflow_instance_id_key" ON "benefit_claims"("workflow_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "benefit_claims_payroll_result_item_id_key" ON "benefit_claims"("payroll_result_item_id");

-- CreateIndex
CREATE INDEX "benefit_claims_employee_id_status_idx" ON "benefit_claims"("employee_id", "status");

-- CreateIndex
CREATE INDEX "benefit_claims_plan_id_status_idx" ON "benefit_claims"("plan_id", "status");

-- CreateIndex
CREATE INDEX "benefit_claims_period_id_status_idx" ON "benefit_claims"("period_id", "status");

-- CreateIndex
CREATE INDEX "benefit_claims_status_submitted_date_idx" ON "benefit_claims"("status", "submitted_date");

-- CreateIndex
CREATE INDEX "benefit_claim_status_history_claim_id_created_at_idx" ON "benefit_claim_status_history"("claim_id", "created_at");

-- AddForeignKey
ALTER TABLE "benefit_plans" ADD CONSTRAINT "benefit_plans_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "benefit_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_eligibility_rules" ADD CONSTRAINT "benefit_eligibility_rules_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_eligibility_overrides" ADD CONSTRAINT "benefit_eligibility_overrides_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_periods" ADD CONSTRAINT "benefit_periods_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_enrollments" ADD CONSTRAINT "benefit_enrollments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_entitlements" ADD CONSTRAINT "benefit_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_entitlements" ADD CONSTRAINT "benefit_entitlements_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "benefit_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_entitlement_ledger" ADD CONSTRAINT "benefit_entitlement_ledger_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "benefit_entitlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "benefit_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "benefit_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "benefit_entitlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "benefit_claim_status_history" ADD CONSTRAINT "benefit_claim_status_history_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "benefit_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
