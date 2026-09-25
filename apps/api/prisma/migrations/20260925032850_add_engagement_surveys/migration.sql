-- CreateTable
CREATE TABLE "engagement_questions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "theme" TEXT,
    "text" TEXT NOT NULL,
    "question_type" TEXT NOT NULL,
    "default_required" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_surveys" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT,
    "survey_type" TEXT NOT NULL,
    "response_mode" TEXT NOT NULL,
    "minimum_anonymous_group_size" INTEGER NOT NULL DEFAULT 5,
    "period_start" TEXT,
    "period_end" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "duplicated_from_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_survey_questions" (
    "id" TEXT NOT NULL,
    "survey_id" TEXT NOT NULL,
    "source_question_id" TEXT,
    "question_text_snapshot" TEXT NOT NULL,
    "theme_snapshot" TEXT,
    "question_type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "scale_min" INTEGER,
    "scale_max" INTEGER,
    "is_enps_primary" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_survey_assignments" (
    "id" TEXT NOT NULL,
    "survey_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "organization_id_snapshot" TEXT NOT NULL,
    "department_id_snapshot" TEXT NOT NULL,
    "job_id_snapshot" TEXT,
    "position_id_snapshot" TEXT NOT NULL,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "engagement_survey_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_responses" (
    "id" TEXT NOT NULL,
    "survey_id" TEXT NOT NULL,
    "response_mode" TEXT NOT NULL,
    "employee_id" TEXT,
    "assignment_id" TEXT,
    "organization_id_snapshot" TEXT NOT NULL,
    "department_id_snapshot" TEXT NOT NULL,
    "job_id_snapshot" TEXT,
    "position_id_snapshot" TEXT,
    "submitted_date" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),

    CONSTRAINT "engagement_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_response_answers" (
    "id" TEXT NOT NULL,
    "response_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "numeric_value" INTEGER,
    "boolean_value" BOOLEAN,
    "text_value" TEXT,
    "choice_values" JSONB,

    CONSTRAINT "engagement_response_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engagement_questions_code_key" ON "engagement_questions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_surveys_code_key" ON "engagement_surveys"("code");

-- CreateIndex
CREATE INDEX "engagement_surveys_status_idx" ON "engagement_surveys"("status");

-- CreateIndex
CREATE INDEX "engagement_survey_questions_survey_id_display_order_idx" ON "engagement_survey_questions"("survey_id", "display_order");

-- CreateIndex
CREATE INDEX "engagement_survey_assignments_survey_id_department_id_snaps_idx" ON "engagement_survey_assignments"("survey_id", "department_id_snapshot");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_survey_assignments_survey_id_employee_id_key" ON "engagement_survey_assignments"("survey_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_responses_assignment_id_key" ON "engagement_responses"("assignment_id");

-- CreateIndex
CREATE INDEX "engagement_responses_survey_id_department_id_snapshot_idx" ON "engagement_responses"("survey_id", "department_id_snapshot");

-- CreateIndex
CREATE INDEX "engagement_responses_survey_id_job_id_snapshot_idx" ON "engagement_responses"("survey_id", "job_id_snapshot");

-- CreateIndex
CREATE INDEX "engagement_response_answers_question_id_numeric_value_idx" ON "engagement_response_answers"("question_id", "numeric_value");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_response_answers_response_id_question_id_key" ON "engagement_response_answers"("response_id", "question_id");

-- AddForeignKey
ALTER TABLE "engagement_survey_questions" ADD CONSTRAINT "engagement_survey_questions_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "engagement_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_survey_questions" ADD CONSTRAINT "engagement_survey_questions_source_question_id_fkey" FOREIGN KEY ("source_question_id") REFERENCES "engagement_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_survey_assignments" ADD CONSTRAINT "engagement_survey_assignments_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "engagement_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_responses" ADD CONSTRAINT "engagement_responses_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "engagement_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_response_answers" ADD CONSTRAINT "engagement_response_answers_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "engagement_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_response_answers" ADD CONSTRAINT "engagement_response_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "engagement_survey_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
