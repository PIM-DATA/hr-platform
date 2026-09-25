-- CreateTable
CREATE TABLE "lifecycle_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "organization_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lifecycle_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_template_tasks" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "assignee_type" TEXT NOT NULL,
    "specific_user_id" TEXT,
    "due_offset_days" INTEGER NOT NULL,
    "relative_to" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "document_category_id" TEXT,
    "requires_document" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lifecycle_template_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_plans" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "template_id" TEXT,
    "template_name_snapshot" TEXT,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "manager_id_snapshot" TEXT,
    "manager_name_snapshot" TEXT,
    "manager_code_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "hire_date_snapshot" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "hr_owner_user_id" TEXT,
    "application_id" TEXT,
    "probation_case_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_tasks" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT,
    "category_snapshot" TEXT NOT NULL,
    "assignee_type" TEXT NOT NULL,
    "assignee_user_id" TEXT,
    "assignee_employee_id" TEXT,
    "due_date" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "requires_document" BOOLEAN NOT NULL DEFAULT false,
    "document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" TEXT,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "probation_policies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization_id" TEXT,
    "duration_days" INTEGER NOT NULL,
    "review_lead_days" INTEGER,
    "allow_extension" BOOLEAN NOT NULL DEFAULT true,
    "max_extension_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "probation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "probation_cases" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "policy_name_snapshot" TEXT,
    "allow_extension" BOOLEAN NOT NULL DEFAULT true,
    "max_extension_days" INTEGER,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "manager_id_snapshot" TEXT,
    "manager_name_snapshot" TEXT,
    "manager_code_snapshot" TEXT,
    "start_date" TEXT NOT NULL,
    "original_end_date" TEXT NOT NULL,
    "current_end_date" TEXT NOT NULL,
    "reviewer_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "final_outcome" TEXT,
    "finalized_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "probation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "probation_reviews" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "reviewer_user_id" TEXT NOT NULL,
    "review_date" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "comment" TEXT,
    "extension_end_date" TEXT,
    "previous_end_date" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "probation_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offboarding_cases" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "template_id" TEXT,
    "template_name_snapshot" TEXT,
    "reason_code" TEXT NOT NULL,
    "reason_note" TEXT,
    "planned_last_working_date" TEXT NOT NULL,
    "actual_last_working_date" TEXT,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "manager_id_snapshot" TEXT,
    "manager_name_snapshot" TEXT,
    "manager_code_snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "hr_owner_user_id" TEXT,
    "exit_interview_date" TEXT,
    "exit_reason_category" TEXT,
    "exit_would_rejoin" BOOLEAN,
    "exit_interview_note" TEXT,
    "exit_interviewer_user_id" TEXT,
    "separation_account_disabled" BOOLEAN,
    "separation_sessions_revoked" INTEGER,
    "created_by_user_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboarding_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offboarding_tasks" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT,
    "category_snapshot" TEXT NOT NULL,
    "assignee_type" TEXT NOT NULL,
    "assignee_user_id" TEXT,
    "assignee_employee_id" TEXT,
    "due_date" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "requires_document" BOOLEAN NOT NULL DEFAULT false,
    "document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" TEXT,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offboarding_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_templates_code_key" ON "lifecycle_templates"("code");

-- CreateIndex
CREATE INDEX "lifecycle_templates_type_is_active_idx" ON "lifecycle_templates"("type", "is_active");

-- CreateIndex
CREATE INDEX "lifecycle_template_tasks_template_id_sort_order_idx" ON "lifecycle_template_tasks"("template_id", "sort_order");

-- CreateIndex
CREATE INDEX "onboarding_plans_employee_id_status_idx" ON "onboarding_plans"("employee_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_plans_status_idx" ON "onboarding_plans"("status");

-- CreateIndex
CREATE INDEX "onboarding_tasks_plan_id_status_idx" ON "onboarding_tasks"("plan_id", "status");

-- CreateIndex
CREATE INDEX "onboarding_tasks_assignee_user_id_status_idx" ON "onboarding_tasks"("assignee_user_id", "status");

-- CreateIndex
CREATE INDEX "probation_cases_employee_id_status_idx" ON "probation_cases"("employee_id", "status");

-- CreateIndex
CREATE INDEX "probation_cases_status_current_end_date_idx" ON "probation_cases"("status", "current_end_date");

-- CreateIndex
CREATE INDEX "probation_cases_reviewer_user_id_status_idx" ON "probation_cases"("reviewer_user_id", "status");

-- CreateIndex
CREATE INDEX "probation_reviews_case_id_submitted_at_idx" ON "probation_reviews"("case_id", "submitted_at");

-- CreateIndex
CREATE INDEX "offboarding_cases_employee_id_status_idx" ON "offboarding_cases"("employee_id", "status");

-- CreateIndex
CREATE INDEX "offboarding_cases_status_planned_last_working_date_idx" ON "offboarding_cases"("status", "planned_last_working_date");

-- CreateIndex
CREATE INDEX "offboarding_tasks_case_id_status_idx" ON "offboarding_tasks"("case_id", "status");

-- CreateIndex
CREATE INDEX "offboarding_tasks_assignee_user_id_status_idx" ON "offboarding_tasks"("assignee_user_id", "status");

-- AddForeignKey
ALTER TABLE "lifecycle_template_tasks" ADD CONSTRAINT "lifecycle_template_tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "lifecycle_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "onboarding_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probation_cases" ADD CONSTRAINT "probation_cases_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "probation_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probation_reviews" ADD CONSTRAINT "probation_reviews_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "probation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offboarding_tasks" ADD CONSTRAINT "offboarding_tasks_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "offboarding_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
