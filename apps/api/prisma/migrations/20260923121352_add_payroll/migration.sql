-- CreateTable
CREATE TABLE "employee_compensations" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "salary_type" TEXT NOT NULL DEFAULT 'MONTHLY',
    "base_salary" DECIMAL(18,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,

    CONSTRAINT "employee_compensations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_components" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "calculation_type" TEXT NOT NULL DEFAULT 'FIXED',
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "recurring_allowed" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pay_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_pay_items" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,

    CONSTRAINT "employee_pay_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthly_divisor_days" DECIMAL(8,4) NOT NULL,
    "daily_work_hours" DECIMAL(8,4) NOT NULL,
    "new_hire_proration" TEXT NOT NULL DEFAULT 'CALENDAR_DAYS',
    "termination_proration" TEXT NOT NULL DEFAULT 'CALENDAR_DAYS',
    "absence_deduction_enabled" BOOLEAN NOT NULL DEFAULT true,
    "late_deduction_enabled" BOOLEAN NOT NULL DEFAULT false,
    "workflow_definition_code" TEXT NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "attendance_from" TEXT NOT NULL,
    "attendance_to" TEXT NOT NULL,
    "payment_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "policy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'REVIEW',
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "gross_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "deduction_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "net_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "input_fingerprint" TEXT,
    "workflow_instance_id" TEXT,
    "started_by_user_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculated_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code" TEXT NOT NULL,
    "employee_name" TEXT NOT NULL,
    "organization_id" TEXT,
    "department_id" TEXT,
    "department_name" TEXT,
    "position_id" TEXT,
    "position_title" TEXT,
    "compensation_id" TEXT,
    "base_salary" DECIMAL(18,2) NOT NULL,
    "daily_rate" DECIMAL(18,6) NOT NULL,
    "minute_rate" DECIMAL(18,6) NOT NULL,
    "gross_pay" DECIMAL(18,2) NOT NULL,
    "total_deductions" DECIMAL(18,2) NOT NULL,
    "net_pay" DECIMAL(18,2) NOT NULL,
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "absent_days" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "unpaid_leave_units" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "approved_ot_minutes" INTEGER NOT NULL DEFAULT 0,
    "prorated_days" DECIMAL(8,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_result_items" (
    "id" TEXT NOT NULL,
    "payroll_result_id" TEXT NOT NULL,
    "component_id" TEXT,
    "component_code_snapshot" TEXT NOT NULL,
    "component_name_snapshot" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "rate" DECIMAL(18,6),
    "multiplier" DECIMAL(8,4),
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,

    CONSTRAINT "payroll_result_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_compensations_employee_id_effective_from_idx" ON "employee_compensations"("employee_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "pay_components_code_key" ON "pay_components"("code");

-- CreateIndex
CREATE INDEX "pay_components_type_is_active_idx" ON "pay_components"("type", "is_active");

-- CreateIndex
CREATE INDEX "employee_pay_items_employee_id_component_id_effective_from_idx" ON "employee_pay_items"("employee_id", "component_id", "effective_from");

-- CreateIndex
CREATE INDEX "payroll_policies_organization_id_is_active_effective_from_idx" ON "payroll_policies"("organization_id", "is_active", "effective_from");

-- CreateIndex
CREATE INDEX "payroll_periods_organization_id_status_idx" ON "payroll_periods"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_organization_id_year_month_key" ON "payroll_periods"("organization_id", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_period_id_key" ON "payroll_runs"("period_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_workflow_instance_id_key" ON "payroll_runs"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "payroll_runs_status_idx" ON "payroll_runs"("status");

-- CreateIndex
CREATE INDEX "payroll_results_employee_id_idx" ON "payroll_results"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_results_run_id_employee_id_key" ON "payroll_results"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_result_items_payroll_result_id_idx" ON "payroll_result_items"("payroll_result_id");

-- CreateIndex
CREATE INDEX "payroll_result_items_reference_type_reference_id_idx" ON "payroll_result_items"("reference_type", "reference_id");

-- AddForeignKey
ALTER TABLE "employee_compensations" ADD CONSTRAINT "employee_compensations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_compensations" ADD CONSTRAINT "employee_compensations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_items" ADD CONSTRAINT "employee_pay_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_items" ADD CONSTRAINT "employee_pay_items_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "pay_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_pay_items" ADD CONSTRAINT "employee_pay_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "payroll_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_results" ADD CONSTRAINT "payroll_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_results" ADD CONSTRAINT "payroll_results_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_results" ADD CONSTRAINT "payroll_results_compensation_id_fkey" FOREIGN KEY ("compensation_id") REFERENCES "employee_compensations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_result_items" ADD CONSTRAINT "payroll_result_items_payroll_result_id_fkey" FOREIGN KEY ("payroll_result_id") REFERENCES "payroll_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_result_items" ADD CONSTRAINT "payroll_result_items_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "pay_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;
