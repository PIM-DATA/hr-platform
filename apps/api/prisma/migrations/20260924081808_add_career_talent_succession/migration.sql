-- CreateTable
CREATE TABLE "career_paths" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization_id" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "career_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "career_path_steps" (
    "id" TEXT NOT NULL,
    "path_id" TEXT NOT NULL,
    "from_job_id" TEXT NOT NULL,
    "to_job_id" TEXT NOT NULL,
    "step_order" INTEGER,
    "description" TEXT,

    CONSTRAINT "career_path_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_review_cycles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "organization_id" TEXT,
    "performance_cycle_id" TEXT,
    "potential_levels" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_review_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_performance_bucket_rules" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "rating_code" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,

    CONSTRAINT "talent_performance_bucket_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_reviews" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_id_snapshot" TEXT,
    "organization_name_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "department_name_snapshot" TEXT,
    "job_id_snapshot" TEXT,
    "job_title_snapshot" TEXT,
    "position_id_snapshot" TEXT,
    "position_title_snapshot" TEXT,
    "performance_plan_id" TEXT,
    "performance_cycle_name_snapshot" TEXT,
    "performance_score_snapshot" DECIMAL(6,2),
    "performance_rating_code_snapshot" TEXT,
    "performance_rating_label_snapshot" TEXT,
    "performance_bucket" TEXT,
    "reviewer_employee_id" TEXT,
    "reviewer_user_id" TEXT,
    "reviewer_name_snapshot" TEXT,
    "potential_level" TEXT,
    "potential_comment" TEXT,
    "potential_bucket" TEXT,
    "nine_box_cell" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "submitted_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_pools" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "talent_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_pool_members" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "source_talent_review_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" TEXT,
    "removal_reason" TEXT,

    CONSTRAINT "talent_pool_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "succession_plans" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "organization_id_snapshot" TEXT,
    "organization_name_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "department_name_snapshot" TEXT,
    "job_id_snapshot" TEXT,
    "job_title_snapshot" TEXT,
    "position_title_snapshot" TEXT NOT NULL,
    "criticality" TEXT NOT NULL DEFAULT 'NORMAL',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,

    CONSTRAINT "succession_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "succession_candidates" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "job_title_snapshot" TEXT,
    "department_name_snapshot" TEXT,
    "position_title_snapshot" TEXT,
    "readiness" TEXT NOT NULL,
    "target_readiness_date" TEXT,
    "notes" TEXT,
    "nominated_by_user_id" TEXT NOT NULL,
    "nominated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "removed_at" TIMESTAMP(3),
    "removed_by_user_id" TEXT,
    "removal_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "succession_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "career_paths_code_key" ON "career_paths"("code");

-- CreateIndex
CREATE INDEX "career_path_steps_from_job_id_idx" ON "career_path_steps"("from_job_id");

-- CreateIndex
CREATE INDEX "career_path_steps_to_job_id_idx" ON "career_path_steps"("to_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "career_path_steps_path_id_from_job_id_to_job_id_key" ON "career_path_steps"("path_id", "from_job_id", "to_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "talent_review_cycles_code_key" ON "talent_review_cycles"("code");

-- CreateIndex
CREATE INDEX "talent_review_cycles_status_idx" ON "talent_review_cycles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "talent_performance_bucket_rules_cycle_id_rating_code_key" ON "talent_performance_bucket_rules"("cycle_id", "rating_code");

-- CreateIndex
CREATE INDEX "talent_reviews_employee_id_idx" ON "talent_reviews"("employee_id");

-- CreateIndex
CREATE INDEX "talent_reviews_reviewer_user_id_idx" ON "talent_reviews"("reviewer_user_id");

-- CreateIndex
CREATE INDEX "talent_reviews_cycle_id_nine_box_cell_idx" ON "talent_reviews"("cycle_id", "nine_box_cell");

-- CreateIndex
CREATE UNIQUE INDEX "talent_reviews_cycle_id_employee_id_key" ON "talent_reviews"("cycle_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "talent_pools_code_key" ON "talent_pools"("code");

-- CreateIndex
CREATE INDEX "talent_pool_members_pool_id_status_idx" ON "talent_pool_members"("pool_id", "status");

-- CreateIndex
CREATE INDEX "talent_pool_members_employee_id_idx" ON "talent_pool_members"("employee_id");

-- CreateIndex
CREATE INDEX "succession_plans_position_id_status_idx" ON "succession_plans"("position_id", "status");

-- CreateIndex
CREATE INDEX "succession_plans_department_id_snapshot_idx" ON "succession_plans"("department_id_snapshot");

-- CreateIndex
CREATE INDEX "succession_candidates_plan_id_status_idx" ON "succession_candidates"("plan_id", "status");

-- CreateIndex
CREATE INDEX "succession_candidates_employee_id_status_idx" ON "succession_candidates"("employee_id", "status");

-- AddForeignKey
ALTER TABLE "career_paths" ADD CONSTRAINT "career_paths_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_path_steps" ADD CONSTRAINT "career_path_steps_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "career_paths"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_path_steps" ADD CONSTRAINT "career_path_steps_from_job_id_fkey" FOREIGN KEY ("from_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "career_path_steps" ADD CONSTRAINT "career_path_steps_to_job_id_fkey" FOREIGN KEY ("to_job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_review_cycles" ADD CONSTRAINT "talent_review_cycles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_review_cycles" ADD CONSTRAINT "talent_review_cycles_performance_cycle_id_fkey" FOREIGN KEY ("performance_cycle_id") REFERENCES "performance_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_performance_bucket_rules" ADD CONSTRAINT "talent_performance_bucket_rules_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "talent_review_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_reviews" ADD CONSTRAINT "talent_reviews_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "talent_review_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_reviews" ADD CONSTRAINT "talent_reviews_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_reviews" ADD CONSTRAINT "talent_reviews_reviewer_employee_id_fkey" FOREIGN KEY ("reviewer_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pools" ADD CONSTRAINT "talent_pools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "talent_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_source_talent_review_id_fkey" FOREIGN KEY ("source_talent_review_id") REFERENCES "talent_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_plans" ADD CONSTRAINT "succession_plans_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_plans" ADD CONSTRAINT "succession_plans_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_candidates" ADD CONSTRAINT "succession_candidates_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "succession_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "succession_candidates" ADD CONSTRAINT "succession_candidates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
