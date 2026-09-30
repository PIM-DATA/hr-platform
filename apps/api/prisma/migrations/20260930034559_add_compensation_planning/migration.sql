-- CreateTable
CREATE TABLE "compensation_review_cycles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "organization_name_snapshot" TEXT NOT NULL,
    "effective_date" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "show_performance_context" BOOLEAN NOT NULL DEFAULT true,
    "baseline_date" TEXT,
    "activated_at" TIMESTAMP(3),
    "review_started_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "finalized_by_user_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "applied_by_user_id" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensation_review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_cycle_exclusions" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_cycle_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_cycle_employees" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_id_snapshot" TEXT NOT NULL,
    "department_id_snapshot" TEXT NOT NULL,
    "department_name_snapshot" TEXT NOT NULL,
    "job_id_snapshot" TEXT,
    "job_title_snapshot" TEXT,
    "position_id_snapshot" TEXT,
    "manager_employee_id_snapshot" TEXT,
    "manager_name_snapshot" TEXT,
    "employment_type_snapshot" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "source_compensation_id" TEXT,
    "current_base_salary_snapshot" DECIMAL(18,2),
    "currency_snapshot" TEXT,
    "compensation_effective_from_snapshot" TEXT,
    "planner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_cycle_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_planner_assignments" (
    "id" TEXT NOT NULL,
    "cycle_employee_id" TEXT NOT NULL,
    "from_user_id" TEXT,
    "to_user_id" TEXT,
    "reason_code" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_planner_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_budget_pools" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "budget_amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensation_budget_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_proposals" (
    "id" TEXT NOT NULL,
    "cycle_employee_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "current_base_salary" DECIMAL(18,2) NOT NULL,
    "proposed_base_salary" DECIMAL(18,2),
    "increase_amount" DECIMAL(18,2),
    "increase_percent" DECIMAL(9,4),
    "manager_comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "submitted_at" TIMESTAMP(3),
    "submitted_by_user_id" TEXT,
    "returned_at" TIMESTAMP(3),
    "return_reason_code" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "applied_by_user_id" TEXT,
    "applied_compensation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compensation_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_proposal_history" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "old_proposed_base_salary" DECIMAL(18,2),
    "new_proposed_base_salary" DECIMAL(18,2),
    "actor_user_id" TEXT NOT NULL,
    "reason_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compensation_proposal_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compensation_review_cycles_code_key" ON "compensation_review_cycles"("code");

-- CreateIndex
CREATE INDEX "compensation_review_cycles_organization_id_status_effective_idx" ON "compensation_review_cycles"("organization_id", "status", "effective_date");

-- CreateIndex
CREATE INDEX "compensation_review_cycles_status_idx" ON "compensation_review_cycles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_cycle_exclusions_cycle_id_employee_id_key" ON "compensation_cycle_exclusions"("cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "compensation_cycle_employees_cycle_id_planner_user_id_idx" ON "compensation_cycle_employees"("cycle_id", "planner_user_id");

-- CreateIndex
CREATE INDEX "compensation_cycle_employees_cycle_id_department_id_snapsho_idx" ON "compensation_cycle_employees"("cycle_id", "department_id_snapshot");

-- CreateIndex
CREATE INDEX "compensation_cycle_employees_employee_id_idx" ON "compensation_cycle_employees"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_cycle_employees_cycle_id_employee_id_key" ON "compensation_cycle_employees"("cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "compensation_planner_assignments_cycle_employee_id_created__idx" ON "compensation_planner_assignments"("cycle_employee_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_budget_pools_cycle_id_key" ON "compensation_budget_pools"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_proposals_cycle_employee_id_key" ON "compensation_proposals"("cycle_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "compensation_proposals_applied_compensation_id_key" ON "compensation_proposals"("applied_compensation_id");

-- CreateIndex
CREATE INDEX "compensation_proposals_cycle_id_status_idx" ON "compensation_proposals"("cycle_id", "status");

-- CreateIndex
CREATE INDEX "compensation_proposal_history_proposal_id_created_at_idx" ON "compensation_proposal_history"("proposal_id", "created_at");

-- AddForeignKey
ALTER TABLE "compensation_cycle_exclusions" ADD CONSTRAINT "compensation_cycle_exclusions_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "compensation_review_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_cycle_employees" ADD CONSTRAINT "compensation_cycle_employees_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "compensation_review_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_planner_assignments" ADD CONSTRAINT "compensation_planner_assignments_cycle_employee_id_fkey" FOREIGN KEY ("cycle_employee_id") REFERENCES "compensation_cycle_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_budget_pools" ADD CONSTRAINT "compensation_budget_pools_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "compensation_review_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_proposals" ADD CONSTRAINT "compensation_proposals_cycle_employee_id_fkey" FOREIGN KEY ("cycle_employee_id") REFERENCES "compensation_cycle_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_proposal_history" ADD CONSTRAINT "compensation_proposal_history_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "compensation_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
