-- CreateTable
CREATE TABLE "disciplinary_action_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity_order" INTEGER NOT NULL DEFAULT 0,
    "requires_warning_letter" BOOLEAN NOT NULL DEFAULT true,
    "requires_acknowledgement" BOOLEAN NOT NULL DEFAULT true,
    "default_validity_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disciplinary_action_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_case_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disciplinary_case_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workflow_definition_code" TEXT NOT NULL,
    "default_acknowledgement_due_days" INTEGER,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disciplinary_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warning_letter_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warning_letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_relation_case_sequences" (
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "employee_relation_case_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "employee_relation_cases" (
    "id" TEXT NOT NULL,
    "case_number" TEXT NOT NULL,
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
    "incident_date" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category_id" TEXT,
    "category_name_snapshot" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "internal_notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "closed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "assigned_to_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_relation_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_actions" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "action_type_id" TEXT NOT NULL,
    "action_type_code_snapshot" TEXT NOT NULL,
    "action_type_name_snapshot" TEXT NOT NULL,
    "requires_warning_letter" BOOLEAN NOT NULL DEFAULT true,
    "requires_acknowledgement" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "effective_date" TEXT,
    "validity_days" INTEGER,
    "issued_date" TEXT,
    "valid_until" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
    "letter_template_id" TEXT,
    "letter_subject" TEXT,
    "letter_body" TEXT,
    "acknowledgement_due_date" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "decline_note" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "issued_by_user_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disciplinary_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warning_letters" (
    "id" TEXT NOT NULL,
    "disciplinary_action_id" TEXT NOT NULL,
    "letter_number" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "position_snapshot" TEXT,
    "department_snapshot" TEXT,
    "organization_snapshot" TEXT,
    "incident_date_snapshot" TEXT NOT NULL,
    "action_name_snapshot" TEXT NOT NULL,
    "body_snapshot" TEXT NOT NULL,
    "valid_until_snapshot" TEXT,
    "acknowledgement_text_snapshot" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warning_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disciplinary_acknowledgements" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL,
    "acknowledgement_text_snapshot" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "disciplinary_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disciplinary_action_types_code_key" ON "disciplinary_action_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "disciplinary_case_categories_code_key" ON "disciplinary_case_categories"("code");

-- CreateIndex
CREATE INDEX "disciplinary_policies_organization_id_is_active_idx" ON "disciplinary_policies"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "warning_letter_templates_code_key" ON "warning_letter_templates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_relation_cases_case_number_key" ON "employee_relation_cases"("case_number");

-- CreateIndex
CREATE INDEX "employee_relation_cases_employee_id_status_idx" ON "employee_relation_cases"("employee_id", "status");

-- CreateIndex
CREATE INDEX "employee_relation_cases_department_id_idx" ON "employee_relation_cases"("department_id");

-- CreateIndex
CREATE INDEX "employee_relation_cases_incident_date_idx" ON "employee_relation_cases"("incident_date");

-- CreateIndex
CREATE UNIQUE INDEX "disciplinary_actions_workflow_instance_id_key" ON "disciplinary_actions"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "disciplinary_actions_case_id_idx" ON "disciplinary_actions"("case_id");

-- CreateIndex
CREATE INDEX "disciplinary_actions_employee_id_status_idx" ON "disciplinary_actions"("employee_id", "status");

-- CreateIndex
CREATE INDEX "disciplinary_actions_status_valid_until_idx" ON "disciplinary_actions"("status", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "warning_letters_disciplinary_action_id_key" ON "warning_letters"("disciplinary_action_id");

-- CreateIndex
CREATE UNIQUE INDEX "warning_letters_letter_number_key" ON "warning_letters"("letter_number");

-- CreateIndex
CREATE UNIQUE INDEX "disciplinary_acknowledgements_action_id_key" ON "disciplinary_acknowledgements"("action_id");

-- CreateIndex
CREATE UNIQUE INDEX "disciplinary_acknowledgements_action_id_employee_id_key" ON "disciplinary_acknowledgements"("action_id", "employee_id");

-- AddForeignKey
ALTER TABLE "disciplinary_policies" ADD CONSTRAINT "disciplinary_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_relation_cases" ADD CONSTRAINT "employee_relation_cases_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_relation_cases" ADD CONSTRAINT "employee_relation_cases_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "disciplinary_case_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_relation_cases" ADD CONSTRAINT "employee_relation_cases_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_actions" ADD CONSTRAINT "disciplinary_actions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "employee_relation_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_actions" ADD CONSTRAINT "disciplinary_actions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_actions" ADD CONSTRAINT "disciplinary_actions_action_type_id_fkey" FOREIGN KEY ("action_type_id") REFERENCES "disciplinary_action_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warning_letters" ADD CONSTRAINT "warning_letters_disciplinary_action_id_fkey" FOREIGN KEY ("disciplinary_action_id") REFERENCES "disciplinary_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_acknowledgements" ADD CONSTRAINT "disciplinary_acknowledgements_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "disciplinary_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_acknowledgements" ADD CONSTRAINT "disciplinary_acknowledgements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disciplinary_acknowledgements" ADD CONSTRAINT "disciplinary_acknowledgements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
