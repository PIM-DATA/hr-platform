-- CreateTable
CREATE TABLE "training_needs" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "competency_id" TEXT,
    "competency_code_snapshot" TEXT,
    "competency_name_snapshot" TEXT,
    "current_level_snapshot" INTEGER,
    "required_level_snapshot" INTEGER,
    "gap_snapshot" INTEGER,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "job_id" TEXT,
    "job_title_snapshot" TEXT,
    "department_id" TEXT,
    "department_name_snapshot" TEXT,
    "source_assessment_date" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "fulfilled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_courses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "delivery_method" TEXT NOT NULL,
    "duration_minutes" INTEGER,
    "provider_name" TEXT,
    "provider_type" TEXT NOT NULL DEFAULT 'INTERNAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "training_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_course_competencies" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "target_level" INTEGER,

    CONSTRAINT "training_course_competencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "course_code_snapshot" TEXT NOT NULL,
    "course_title_snapshot" TEXT NOT NULL,
    "organization_id" TEXT,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT,
    "meeting_url" TEXT,
    "capacity" INTEGER,
    "instructor_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_enrollments" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "department_name_snapshot" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "training_need_id" TEXT,
    "idp_item_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completion_at" TIMESTAMP(3),
    "score" DECIMAL(6,2),
    "result_note" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "individual_development_plans" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "department_name_snapshot" TEXT,
    "title" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "manager_employee_id" TEXT,
    "manager_user_id" TEXT,
    "manager_name_snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "activated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "individual_development_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idp_items" (
    "id" TEXT NOT NULL,
    "idp_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "development_type" TEXT NOT NULL,
    "training_need_id" TEXT,
    "competency_id" TEXT,
    "competency_code_snapshot" TEXT,
    "competency_name_snapshot" TEXT,
    "linked_course_id" TEXT,
    "linked_session_id" TEXT,
    "target_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "progress_percent" INTEGER NOT NULL DEFAULT 0,
    "employee_comment" TEXT,
    "manager_comment" TEXT,
    "hr_comment" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idp_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "training_needs_employee_id_status_idx" ON "training_needs"("employee_id", "status");

-- CreateIndex
CREATE INDEX "training_needs_competency_id_idx" ON "training_needs"("competency_id");

-- CreateIndex
CREATE INDEX "training_needs_department_id_idx" ON "training_needs"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_courses_code_key" ON "training_courses"("code");

-- CreateIndex
CREATE INDEX "training_courses_is_active_idx" ON "training_courses"("is_active");

-- CreateIndex
CREATE INDEX "training_course_competencies_competency_id_idx" ON "training_course_competencies"("competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_course_competencies_course_id_competency_id_key" ON "training_course_competencies"("course_id", "competency_id");

-- CreateIndex
CREATE INDEX "training_sessions_course_id_idx" ON "training_sessions"("course_id");

-- CreateIndex
CREATE INDEX "training_sessions_status_start_at_idx" ON "training_sessions"("status", "start_at");

-- CreateIndex
CREATE INDEX "training_enrollments_employee_id_status_idx" ON "training_enrollments"("employee_id", "status");

-- CreateIndex
CREATE INDEX "training_enrollments_training_need_id_idx" ON "training_enrollments"("training_need_id");

-- CreateIndex
CREATE UNIQUE INDEX "training_enrollments_session_id_employee_id_key" ON "training_enrollments"("session_id", "employee_id");

-- CreateIndex
CREATE INDEX "individual_development_plans_employee_id_status_idx" ON "individual_development_plans"("employee_id", "status");

-- CreateIndex
CREATE INDEX "idp_items_idp_id_idx" ON "idp_items"("idp_id");

-- CreateIndex
CREATE INDEX "idp_items_training_need_id_idx" ON "idp_items"("training_need_id");

-- AddForeignKey
ALTER TABLE "training_needs" ADD CONSTRAINT "training_needs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_needs" ADD CONSTRAINT "training_needs_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_course_competencies" ADD CONSTRAINT "training_course_competencies_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "training_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_course_competencies" ADD CONSTRAINT "training_course_competencies_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "training_courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "training_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_training_need_id_fkey" FOREIGN KEY ("training_need_id") REFERENCES "training_needs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_enrollments" ADD CONSTRAINT "training_enrollments_idp_item_id_fkey" FOREIGN KEY ("idp_item_id") REFERENCES "idp_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "individual_development_plans" ADD CONSTRAINT "individual_development_plans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "individual_development_plans" ADD CONSTRAINT "individual_development_plans_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "individual_development_plans" ADD CONSTRAINT "individual_development_plans_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_items" ADD CONSTRAINT "idp_items_idp_id_fkey" FOREIGN KEY ("idp_id") REFERENCES "individual_development_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_items" ADD CONSTRAINT "idp_items_training_need_id_fkey" FOREIGN KEY ("training_need_id") REFERENCES "training_needs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_items" ADD CONSTRAINT "idp_items_competency_id_fkey" FOREIGN KEY ("competency_id") REFERENCES "competencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idp_items" ADD CONSTRAINT "idp_items_linked_course_id_fkey" FOREIGN KEY ("linked_course_id") REFERENCES "training_courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
