-- CreateTable
CREATE TABLE "competency_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_scales" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_scale_levels" (
    "id" TEXT NOT NULL,
    "scale_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "competency_scale_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competencies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" TEXT NOT NULL,
    "scale_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "competencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_level_indicators" (
    "id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "competency_level_indicators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_competency_requirements" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "required_level" INTEGER NOT NULL,
    "weight" DECIMAL(6,2),
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_competency_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_assessment_cycles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "self_assessment_required" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMP(3),
    "review_opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "competency_assessment_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_assessments" (
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_assessment_items" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "competency_id" TEXT,
    "competency_code_snapshot" TEXT NOT NULL,
    "competency_name_snapshot" TEXT NOT NULL,
    "category_snapshot" TEXT NOT NULL,
    "scale_id_snapshot" TEXT,
    "scale_name_snapshot" TEXT,
    "level_labels_snapshot" JSONB,
    "indicators_snapshot" JSONB,
    "required_level_snapshot" INTEGER NOT NULL,
    "weight_snapshot" DECIMAL(6,2),
    "is_mandatory_snapshot" BOOLEAN NOT NULL DEFAULT true,
    "self_level" INTEGER,
    "manager_level" INTEGER,
    "final_level" INTEGER,
    "self_comment" TEXT,
    "manager_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_assessment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "competency_categories_code_key" ON "competency_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "competency_scales_code_key" ON "competency_scales"("code");

-- CreateIndex
CREATE INDEX "competency_scale_levels_scale_id_idx" ON "competency_scale_levels"("scale_id");

-- CreateIndex
CREATE UNIQUE INDEX "competency_scale_levels_scale_id_level_key" ON "competency_scale_levels"("scale_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "competencies_code_key" ON "competencies"("code");

-- CreateIndex
CREATE INDEX "competencies_category_id_idx" ON "competencies"("category_id");

-- CreateIndex
CREATE INDEX "competencies_is_active_idx" ON "competencies"("is_active");

-- CreateIndex
CREATE INDEX "competency_level_indicators_competency_id_idx" ON "competency_level_indicators"("competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "competency_level_indicators_competency_id_level_key" ON "competency_level_indicators"("competency_id", "level");

-- CreateIndex
CREATE INDEX "job_competency_requirements_job_id_idx" ON "job_competency_requirements"("job_id");

-- CreateIndex
CREATE INDEX "job_competency_requirements_competency_id_idx" ON "job_competency_requirements"("competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_competency_requirements_job_id_competency_id_key" ON "job_competency_requirements"("job_id", "competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "competency_assessment_cycles_code_key" ON "competency_assessment_cycles"("code");

-- CreateIndex
CREATE INDEX "competency_assessment_cycles_status_idx" ON "competency_assessment_cycles"("status");

-- CreateIndex
CREATE INDEX "competency_assessments_employee_id_idx" ON "competency_assessments"("employee_id");

-- CreateIndex
CREATE INDEX "competency_assessments_reviewer_user_id_idx" ON "competency_assessments"("reviewer_user_id");

-- CreateIndex
CREATE INDEX "competency_assessments_cycle_id_status_idx" ON "competency_assessments"("cycle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "competency_assessments_cycle_id_employee_id_key" ON "competency_assessments"("cycle_id", "employee_id");

-- CreateIndex
CREATE INDEX "competency_assessment_items_assessment_id_idx" ON "competency_assessment_items"("assessment_id");

-- CreateIndex
CREATE INDEX "competency_assessment_items_competency_id_idx" ON "competency_assessment_items"("competency_id");

-- AddForeignKey
ALTER TABLE "competency_scale_levels" ADD CONSTRAINT "competency_scale_levels_scale_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "competency_scales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "competency_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_scale_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "competency_scales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_level_indicators" ADD CONSTRAINT "competency_level_indicators_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_competency_requirements" ADD CONSTRAINT "job_competency_requirements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_competency_requirements" ADD CONSTRAINT "job_competency_requirements_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "competency_assessment_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_reviewer_employee_id_fkey" FOREIGN KEY ("reviewer_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessments" ADD CONSTRAINT "competency_assessments_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessment_items" ADD CONSTRAINT "competency_assessment_items_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "competency_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competency_assessment_items" ADD CONSTRAINT "competency_assessment_items_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
