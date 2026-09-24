-- CreateTable
CREATE TABLE "recruitment_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "requisition_workflow_code" TEXT NOT NULL,
    "offer_workflow_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_sequences" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "recruitment_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "recruitment_requisitions" (
    "id" TEXT NOT NULL,
    "requisition_number" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "department_id" TEXT,
    "job_id" TEXT NOT NULL,
    "position_id" TEXT,
    "hiring_manager_employee_id" TEXT,
    "hiring_manager_user_id" TEXT,
    "requested_openings" INTEGER NOT NULL,
    "employment_type" TEXT,
    "reason" TEXT NOT NULL,
    "desired_start_date" TEXT,
    "justification" TEXT,
    "organization_name_snapshot" TEXT,
    "department_name_snapshot" TEXT,
    "job_title_snapshot" TEXT,
    "position_title_snapshot" TEXT,
    "hiring_manager_name_snapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_openings" (
    "id" TEXT NOT NULL,
    "opening_number" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "position_id" TEXT,
    "title_snapshot" TEXT NOT NULL,
    "department_name_snapshot" TEXT,
    "organization_name_snapshot" TEXT,
    "hiring_manager_user_id" TEXT,
    "hiring_manager_employee_id" TEXT,
    "hiring_manager_name_snapshot" TEXT,
    "description" TEXT,
    "requirements_text" TEXT,
    "openings_count" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3),
    "target_close_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_candidates" (
    "id" TEXT NOT NULL,
    "candidate_number" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "email_normalized" TEXT,
    "phone" TEXT,
    "phone_normalized" TEXT,
    "current_company" TEXT,
    "current_title" TEXT,
    "location_text" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "source_detail" TEXT,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "hired_employee_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_applications" (
    "id" TEXT NOT NULL,
    "application_number" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "opening_id" TEXT NOT NULL,
    "applied_at" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'APPLIED',
    "recruiter_user_id" TEXT,
    "hiring_manager_user_id" TEXT,
    "source_snapshot" TEXT NOT NULL,
    "department_name_snapshot" TEXT,
    "job_title_snapshot" TEXT NOT NULL,
    "rejection_reason_code" TEXT,
    "rejection_note" TEXT,
    "rejected_at" TIMESTAMP(3),
    "withdrawn_note" TEXT,
    "withdrawn_at" TIMESTAMP(3),
    "hired_employee_id" TEXT,
    "hired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_application_stage_history" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "from_stage" TEXT,
    "to_stage" TEXT NOT NULL,
    "changed_by_user_id" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "recruitment_application_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_interviews" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "round_number" INTEGER,
    "title" TEXT NOT NULL,
    "scheduled_start" TIMESTAMP(3) NOT NULL,
    "scheduled_end" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT,
    "meeting_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_interviewers" (
    "id" TEXT NOT NULL,
    "interview_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "user_id" TEXT NOT NULL,
    "role_label" TEXT,

    CONSTRAINT "recruitment_interviewers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_interview_feedback" (
    "id" TEXT NOT NULL,
    "interview_id" TEXT NOT NULL,
    "interviewer_user_id" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "overall_score" INTEGER,
    "strengths" TEXT,
    "concerns" TEXT,
    "comments" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recruitment_interview_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_offers" (
    "id" TEXT NOT NULL,
    "offer_number" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "proposed_start_date" TEXT NOT NULL,
    "employment_type_snapshot" TEXT,
    "position_id" TEXT,
    "position_title_snapshot" TEXT,
    "base_salary_proposal" DECIMAL(18,2),
    "currency_code" TEXT NOT NULL DEFAULT 'THB',
    "other_terms_text" TEXT,
    "workflow_instance_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "outcome_recorded_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recruitment_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_policies_organization_id_key" ON "recruitment_policies"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_requisitions_requisition_number_key" ON "recruitment_requisitions"("requisition_number");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_requisitions_workflow_instance_id_key" ON "recruitment_requisitions"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "recruitment_requisitions_status_idx" ON "recruitment_requisitions"("status");

-- CreateIndex
CREATE INDEX "recruitment_requisitions_hiring_manager_user_id_idx" ON "recruitment_requisitions"("hiring_manager_user_id");

-- CreateIndex
CREATE INDEX "recruitment_requisitions_organization_id_idx" ON "recruitment_requisitions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_openings_opening_number_key" ON "recruitment_openings"("opening_number");

-- CreateIndex
CREATE INDEX "recruitment_openings_status_idx" ON "recruitment_openings"("status");

-- CreateIndex
CREATE INDEX "recruitment_openings_requisition_id_idx" ON "recruitment_openings"("requisition_id");

-- CreateIndex
CREATE INDEX "recruitment_openings_hiring_manager_user_id_idx" ON "recruitment_openings"("hiring_manager_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_candidates_candidate_number_key" ON "recruitment_candidates"("candidate_number");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_candidates_hired_employee_id_key" ON "recruitment_candidates"("hired_employee_id");

-- CreateIndex
CREATE INDEX "recruitment_candidates_email_normalized_idx" ON "recruitment_candidates"("email_normalized");

-- CreateIndex
CREATE INDEX "recruitment_candidates_phone_normalized_idx" ON "recruitment_candidates"("phone_normalized");

-- CreateIndex
CREATE INDEX "recruitment_candidates_status_idx" ON "recruitment_candidates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_applications_application_number_key" ON "recruitment_applications"("application_number");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_applications_hired_employee_id_key" ON "recruitment_applications"("hired_employee_id");

-- CreateIndex
CREATE INDEX "recruitment_applications_opening_id_stage_idx" ON "recruitment_applications"("opening_id", "stage");

-- CreateIndex
CREATE INDEX "recruitment_applications_candidate_id_idx" ON "recruitment_applications"("candidate_id");

-- CreateIndex
CREATE INDEX "recruitment_applications_hiring_manager_user_id_idx" ON "recruitment_applications"("hiring_manager_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_applications_candidate_id_opening_id_key" ON "recruitment_applications"("candidate_id", "opening_id");

-- CreateIndex
CREATE INDEX "recruitment_application_stage_history_application_id_change_idx" ON "recruitment_application_stage_history"("application_id", "changed_at");

-- CreateIndex
CREATE INDEX "recruitment_interviews_application_id_idx" ON "recruitment_interviews"("application_id");

-- CreateIndex
CREATE INDEX "recruitment_interviews_scheduled_start_idx" ON "recruitment_interviews"("scheduled_start");

-- CreateIndex
CREATE INDEX "recruitment_interviewers_user_id_idx" ON "recruitment_interviewers"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_interviewers_interview_id_user_id_key" ON "recruitment_interviewers"("interview_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_interview_feedback_interview_id_interviewer_use_key" ON "recruitment_interview_feedback"("interview_id", "interviewer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_offers_offer_number_key" ON "recruitment_offers"("offer_number");

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_offers_workflow_instance_id_key" ON "recruitment_offers"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "recruitment_offers_application_id_idx" ON "recruitment_offers"("application_id");

-- CreateIndex
CREATE INDEX "recruitment_offers_status_idx" ON "recruitment_offers"("status");

-- AddForeignKey
ALTER TABLE "recruitment_policies" ADD CONSTRAINT "recruitment_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_requisitions" ADD CONSTRAINT "recruitment_requisitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_requisitions" ADD CONSTRAINT "recruitment_requisitions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_requisitions" ADD CONSTRAINT "recruitment_requisitions_hiring_manager_employee_id_fkey" FOREIGN KEY ("hiring_manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_openings" ADD CONSTRAINT "recruitment_openings_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "recruitment_requisitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_openings" ADD CONSTRAINT "recruitment_openings_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "recruitment_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_opening_id_fkey" FOREIGN KEY ("opening_id") REFERENCES "recruitment_openings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_application_stage_history" ADD CONSTRAINT "recruitment_application_stage_history_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interviews" ADD CONSTRAINT "recruitment_interviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interviewers" ADD CONSTRAINT "recruitment_interviewers_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "recruitment_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interviewers" ADD CONSTRAINT "recruitment_interviewers_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interviewers" ADD CONSTRAINT "recruitment_interviewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interview_feedback" ADD CONSTRAINT "recruitment_interview_feedback_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "recruitment_interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_interview_feedback" ADD CONSTRAINT "recruitment_interview_feedback_interviewer_user_id_fkey" FOREIGN KEY ("interviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recruitment_offers" ADD CONSTRAINT "recruitment_offers_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "recruitment_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
