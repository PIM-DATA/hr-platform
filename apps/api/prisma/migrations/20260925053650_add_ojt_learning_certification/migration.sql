-- CreateTable
CREATE TABLE "learning_sequences" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "learning_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "ojt_programs" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "job_id" TEXT,
    "duration_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ojt_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_program_competencies" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "target_level" INTEGER,
    "importance" TEXT,
    "description" TEXT,

    CONSTRAINT "ojt_program_competencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_program_activities" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "activity_type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "expected_days" INTEGER,
    "document_evidence_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ojt_program_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_activity_criteria" (
    "id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "criterion" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ojt_activity_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_plans" (
    "id" TEXT NOT NULL,
    "plan_number" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "program_id" TEXT,
    "program_name_snapshot" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "trainer_employee_id" TEXT,
    "trainer_user_id" TEXT,
    "trainer_name_snapshot" TEXT,
    "start_date" TEXT NOT NULL,
    "target_end_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "training_need_id" TEXT,
    "idp_item_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ojt_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_plan_competencies" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "competency_code_snapshot" TEXT NOT NULL,
    "competency_name_snapshot" TEXT NOT NULL,
    "target_level" INTEGER,
    "importance" TEXT,
    "description" TEXT,

    CONSTRAINT "ojt_plan_competencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_plan_activities" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "description_snapshot" TEXT,
    "activity_type" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "expected_days" INTEGER,
    "requires_evidence" BOOLEAN NOT NULL DEFAULT false,
    "document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "trainer_comment" TEXT,
    "employee_reflection" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ojt_plan_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_plan_criteria" (
    "id" TEXT NOT NULL,
    "plan_activity_id" TEXT NOT NULL,
    "criterion_snapshot" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ojt_plan_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_activity_observations" (
    "id" TEXT NOT NULL,
    "plan_activity_id" TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "observer_user_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "comment" TEXT,
    "observed_at" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ojt_activity_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ojt_plan_assessments" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "assessor_user_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "comment" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ojt_plan_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competency_evidence" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "competency_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_label" TEXT NOT NULL,
    "observed_level" INTEGER,
    "note" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competency_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_paths" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "target_job_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_path_steps" (
    "id" TEXT NOT NULL,
    "path_id" TEXT NOT NULL,
    "step_type" TEXT NOT NULL,
    "reference_id" TEXT,
    "title_snapshot" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "prerequisite_step_id" TEXT,

    CONSTRAINT "learning_path_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_path_assignments" (
    "id" TEXT NOT NULL,
    "path_id" TEXT NOT NULL,
    "path_name_snapshot" TEXT NOT NULL,
    "target_job_title_snapshot" TEXT,
    "employee_id" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "department_id_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "assigned_by_user_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_path_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_path_assignment_steps" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "step_type" TEXT NOT NULL,
    "reference_id" TEXT,
    "title_snapshot" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "prerequisite_sequence" INTEGER,
    "fulfilled_at" TIMESTAMP(3),
    "fulfilled_source_id" TEXT,
    "fulfilled_by_user_id" TEXT,
    "note" TEXT,

    CONSTRAINT "learning_path_assignment_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification_definitions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "issuer_type" TEXT NOT NULL,
    "issuer_name" TEXT,
    "organization_id" TEXT,
    "validity_days" INTEGER,
    "expiry_window_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certification_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_certifications" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "definition_name_snapshot" TEXT NOT NULL,
    "certificate_number" TEXT,
    "issued_date" TEXT NOT NULL,
    "expiry_date" TEXT,
    "issuer_name" TEXT,
    "document_id" TEXT,
    "renewed_from_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" TEXT,
    "revoke_reason" TEXT,
    "note" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ojt_programs_code_key" ON "ojt_programs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ojt_program_competencies_program_id_competency_id_key" ON "ojt_program_competencies"("program_id", "competency_id");

-- CreateIndex
CREATE INDEX "ojt_program_activities_program_id_sequence_idx" ON "ojt_program_activities"("program_id", "sequence");

-- CreateIndex
CREATE INDEX "ojt_activity_criteria_activity_id_sequence_idx" ON "ojt_activity_criteria"("activity_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ojt_plans_plan_number_key" ON "ojt_plans"("plan_number");

-- CreateIndex
CREATE INDEX "ojt_plans_employee_id_status_idx" ON "ojt_plans"("employee_id", "status");

-- CreateIndex
CREATE INDEX "ojt_plans_trainer_user_id_status_idx" ON "ojt_plans"("trainer_user_id", "status");

-- CreateIndex
CREATE INDEX "ojt_plans_status_idx" ON "ojt_plans"("status");

-- CreateIndex
CREATE INDEX "ojt_plan_competencies_plan_id_idx" ON "ojt_plan_competencies"("plan_id");

-- CreateIndex
CREATE INDEX "ojt_plan_activities_plan_id_sequence_idx" ON "ojt_plan_activities"("plan_id", "sequence");

-- CreateIndex
CREATE INDEX "ojt_plan_criteria_plan_activity_id_sequence_idx" ON "ojt_plan_criteria"("plan_activity_id", "sequence");

-- CreateIndex
CREATE INDEX "ojt_activity_observations_plan_activity_id_idx" ON "ojt_activity_observations"("plan_activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "ojt_activity_observations_criterion_id_observer_user_id_key" ON "ojt_activity_observations"("criterion_id", "observer_user_id");

-- CreateIndex
CREATE INDEX "ojt_plan_assessments_plan_id_submitted_at_idx" ON "ojt_plan_assessments"("plan_id", "submitted_at");

-- CreateIndex
CREATE INDEX "competency_evidence_employee_id_competency_id_idx" ON "competency_evidence"("employee_id", "competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "competency_evidence_source_type_source_id_competency_id_key" ON "competency_evidence"("source_type", "source_id", "competency_id");

-- CreateIndex
CREATE UNIQUE INDEX "learning_paths_code_key" ON "learning_paths"("code");

-- CreateIndex
CREATE INDEX "learning_path_steps_path_id_sequence_idx" ON "learning_path_steps"("path_id", "sequence");

-- CreateIndex
CREATE INDEX "learning_path_assignments_employee_id_status_idx" ON "learning_path_assignments"("employee_id", "status");

-- CreateIndex
CREATE INDEX "learning_path_assignments_path_id_status_idx" ON "learning_path_assignments"("path_id", "status");

-- CreateIndex
CREATE INDEX "learning_path_assignment_steps_assignment_id_sequence_idx" ON "learning_path_assignment_steps"("assignment_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "certification_definitions_code_key" ON "certification_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_certifications_renewed_from_id_key" ON "employee_certifications"("renewed_from_id");

-- CreateIndex
CREATE INDEX "employee_certifications_employee_id_idx" ON "employee_certifications"("employee_id");

-- CreateIndex
CREATE INDEX "employee_certifications_definition_id_expiry_date_idx" ON "employee_certifications"("definition_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_certifications_employee_id_definition_id_issued_da_key" ON "employee_certifications"("employee_id", "definition_id", "issued_date");

-- AddForeignKey
ALTER TABLE "ojt_program_competencies" ADD CONSTRAINT "ojt_program_competencies_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "ojt_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_program_activities" ADD CONSTRAINT "ojt_program_activities_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "ojt_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_activity_criteria" ADD CONSTRAINT "ojt_activity_criteria_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "ojt_program_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_plans" ADD CONSTRAINT "ojt_plans_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "ojt_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_plan_competencies" ADD CONSTRAINT "ojt_plan_competencies_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ojt_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_plan_activities" ADD CONSTRAINT "ojt_plan_activities_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ojt_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_plan_criteria" ADD CONSTRAINT "ojt_plan_criteria_plan_activity_id_fkey" FOREIGN KEY ("plan_activity_id") REFERENCES "ojt_plan_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_activity_observations" ADD CONSTRAINT "ojt_activity_observations_plan_activity_id_fkey" FOREIGN KEY ("plan_activity_id") REFERENCES "ojt_plan_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_activity_observations" ADD CONSTRAINT "ojt_activity_observations_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "ojt_plan_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ojt_plan_assessments" ADD CONSTRAINT "ojt_plan_assessments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "ojt_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_steps" ADD CONSTRAINT "learning_path_steps_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "learning_paths"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_assignments" ADD CONSTRAINT "learning_path_assignments_path_id_fkey" FOREIGN KEY ("path_id") REFERENCES "learning_paths"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_path_assignment_steps" ADD CONSTRAINT "learning_path_assignment_steps_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "learning_path_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_certifications" ADD CONSTRAINT "employee_certifications_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "certification_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
