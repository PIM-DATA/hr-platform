-- CreateTable
CREATE TABLE "performance_cycles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "self_review_start" TEXT,
    "self_review_end" TEXT,
    "manager_review_start" TEXT,
    "manager_review_end" TEXT,
    "self_review_required" BOOLEAN NOT NULL DEFAULT true,
    "min_score" DECIMAL(6,2) NOT NULL DEFAULT 1,
    "max_score" DECIMAL(6,2) NOT NULL DEFAULT 5,
    "score_step" DECIMAL(6,2) NOT NULL DEFAULT 0.1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMP(3),
    "review_opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "performance_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_rating_bands" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "min_score" DECIMAL(6,2) NOT NULL,
    "max_score" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "performance_rating_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_kpis" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "measurement_type" TEXT NOT NULL,
    "unit" TEXT,
    "default_weight" DECIMAL(6,2),
    "organization_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "performance_kpis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_plans" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_id" TEXT,
    "organization_name" TEXT,
    "department_id" TEXT,
    "department_name" TEXT,
    "position_id" TEXT,
    "position_title" TEXT,
    "job_id" TEXT,
    "job_title" TEXT,
    "reviewer_employee_id" TEXT,
    "reviewer_user_id" TEXT,
    "reviewer_name_snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "self_submitted_at" TIMESTAMP(3),
    "manager_submitted_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "weighted_score" DECIMAL(6,2),
    "rating_code" TEXT,
    "rating_label_snapshot" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_plan_items" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "kpi_id" TEXT,
    "kpi_code_snapshot" TEXT NOT NULL,
    "kpi_name_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT,
    "measurement_type" TEXT NOT NULL,
    "weight" DECIMAL(6,2) NOT NULL,
    "target_value" DECIMAL(18,2),
    "target_text" TEXT,
    "actual_value" DECIMAL(18,2),
    "actual_text" TEXT,
    "progress_percent" INTEGER,
    "employee_comment" TEXT,
    "manager_comment" TEXT,
    "self_score" DECIMAL(6,2),
    "manager_score" DECIMAL(6,2),
    "final_score" DECIMAL(6,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performance_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "performance_cycles_code_key" ON "performance_cycles"("code");

-- CreateIndex
CREATE INDEX "performance_cycles_status_idx" ON "performance_cycles"("status");

-- CreateIndex
CREATE INDEX "performance_cycles_organization_id_idx" ON "performance_cycles"("organization_id");

-- CreateIndex
CREATE INDEX "performance_rating_bands_cycle_id_idx" ON "performance_rating_bands"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_rating_bands_cycle_id_code_key" ON "performance_rating_bands"("cycle_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "performance_kpis_code_key" ON "performance_kpis"("code");

-- CreateIndex
CREATE INDEX "performance_kpis_is_active_idx" ON "performance_kpis"("is_active");

-- CreateIndex
CREATE INDEX "performance_kpis_category_idx" ON "performance_kpis"("category");

-- CreateIndex
CREATE INDEX "performance_plans_employee_id_idx" ON "performance_plans"("employee_id");

-- CreateIndex
CREATE INDEX "performance_plans_reviewer_user_id_idx" ON "performance_plans"("reviewer_user_id");

-- CreateIndex
CREATE INDEX "performance_plans_cycle_id_status_idx" ON "performance_plans"("cycle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "performance_plans_cycle_id_employee_id_key" ON "performance_plans"("cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "performance_plan_items_plan_id_idx" ON "performance_plan_items"("plan_id");

-- CreateIndex
CREATE INDEX "performance_plan_items_kpi_id_idx" ON "performance_plan_items"("kpi_id");

-- AddForeignKey
ALTER TABLE "performance_cycles" ADD CONSTRAINT "performance_cycles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_rating_bands" ADD CONSTRAINT "performance_rating_bands_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "performance_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_kpis" ADD CONSTRAINT "performance_kpis_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plans" ADD CONSTRAINT "performance_plans_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "performance_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plans" ADD CONSTRAINT "performance_plans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plans" ADD CONSTRAINT "performance_plans_reviewer_employee_id_fkey" FOREIGN KEY ("reviewer_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plans" ADD CONSTRAINT "performance_plans_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plan_items" ADD CONSTRAINT "performance_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "performance_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_plan_items" ADD CONSTRAINT "performance_plan_items_kpi_id_fkey" FOREIGN KEY ("kpi_id") REFERENCES "performance_kpis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
