-- CreateTable
CREATE TABLE "service_sequences" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "service_sequences_pkey" PRIMARY KEY ("kind","year")
);

-- CreateTable
CREATE TABLE "service_request_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "organization_id" TEXT,
    "workflow_code" TEXT,
    "target_days" INTEGER,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "employee_selectable" BOOLEAN NOT NULL DEFAULT true,
    "fulfillment_type" TEXT NOT NULL DEFAULT 'GENERAL',
    "letter_template_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_request_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_type_fields" (
    "id" TEXT NOT NULL,
    "request_type_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "options_json" TEXT,
    "max_length" INTEGER,
    "employee_visible" BOOLEAN NOT NULL DEFAULT true,
    "help_text" TEXT,

    CONSTRAINT "service_request_type_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" TEXT NOT NULL,
    "request_number" TEXT NOT NULL,
    "request_type_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "request_type_code_snapshot" TEXT NOT NULL,
    "request_type_name_snapshot" TEXT NOT NULL,
    "category_snapshot" TEXT NOT NULL,
    "fulfillment_type_snapshot" TEXT NOT NULL,
    "target_days_snapshot" INTEGER,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "assigned_to_user_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "workflow_instance_id" TEXT,
    "workflow_status" TEXT,
    "submitted_date" TEXT,
    "due_date" TEXT,
    "submitted_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "result_note" TEXT,
    "reject_reason_code" TEXT,
    "reject_explanation" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_values" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "label_snapshot" TEXT NOT NULL,
    "field_type_snapshot" TEXT NOT NULL,
    "employee_visible_snapshot" BOOLEAN NOT NULL DEFAULT true,
    "display_order_snapshot" INTEGER NOT NULL DEFAULT 0,
    "value" TEXT NOT NULL,

    CONSTRAINT "service_request_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_messages" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_request_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_request_status_history" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "reason_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_request_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_letter_templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization_id" TEXT,
    "letter_type" TEXT NOT NULL,
    "subject_template" TEXT,
    "body_template" TEXT NOT NULL,
    "requires_salary_access" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_letters" (
    "id" TEXT NOT NULL,
    "letter_number" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "service_request_id" TEXT,
    "template_id" TEXT NOT NULL,
    "template_code_snapshot" TEXT NOT NULL,
    "template_name_snapshot" TEXT NOT NULL,
    "letter_type_snapshot" TEXT NOT NULL,
    "employee_code_snapshot" TEXT NOT NULL,
    "employee_name_snapshot" TEXT NOT NULL,
    "organization_snapshot" TEXT,
    "department_snapshot" TEXT,
    "job_snapshot" TEXT,
    "position_snapshot" TEXT,
    "rendered_subject_snapshot" TEXT,
    "rendered_body_snapshot" TEXT NOT NULL,
    "salary_amount_snapshot" DECIMAL(18,2),
    "salary_currency_snapshot" TEXT,
    "issued_date" TEXT NOT NULL,
    "issued_by_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "voided_at" TIMESTAMP(3),
    "voided_by_user_id" TEXT,
    "void_reason_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_request_types_code_key" ON "service_request_types"("code");

-- CreateIndex
CREATE INDEX "service_request_types_is_active_category_idx" ON "service_request_types"("is_active", "category");

-- CreateIndex
CREATE UNIQUE INDEX "service_request_type_fields_request_type_id_key_key" ON "service_request_type_fields"("request_type_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_request_number_key" ON "service_requests"("request_number");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_workflow_instance_id_key" ON "service_requests"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "service_requests_employee_id_status_idx" ON "service_requests"("employee_id", "status");

-- CreateIndex
CREATE INDEX "service_requests_status_submitted_at_idx" ON "service_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "service_requests_assigned_to_user_id_status_idx" ON "service_requests"("assigned_to_user_id", "status");

-- CreateIndex
CREATE INDEX "service_requests_request_type_id_status_idx" ON "service_requests"("request_type_id", "status");

-- CreateIndex
CREATE INDEX "service_requests_due_date_idx" ON "service_requests"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "service_request_values_request_id_field_key_key" ON "service_request_values"("request_id", "field_key");

-- CreateIndex
CREATE INDEX "service_request_messages_request_id_created_at_idx" ON "service_request_messages"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "service_request_status_history_request_id_created_at_idx" ON "service_request_status_history"("request_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "hr_letter_templates_code_key" ON "hr_letter_templates"("code");

-- CreateIndex
CREATE INDEX "hr_letter_templates_is_active_letter_type_idx" ON "hr_letter_templates"("is_active", "letter_type");

-- CreateIndex
CREATE UNIQUE INDEX "hr_letters_letter_number_key" ON "hr_letters"("letter_number");

-- CreateIndex
CREATE INDEX "hr_letters_employee_id_status_idx" ON "hr_letters"("employee_id", "status");

-- CreateIndex
CREATE INDEX "hr_letters_letter_type_snapshot_issued_date_idx" ON "hr_letters"("letter_type_snapshot", "issued_date");

-- CreateIndex
CREATE INDEX "hr_letters_service_request_id_idx" ON "hr_letters"("service_request_id");

-- AddForeignKey
ALTER TABLE "service_request_types" ADD CONSTRAINT "service_request_types_letter_template_id_fkey" FOREIGN KEY ("letter_template_id") REFERENCES "hr_letter_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_type_fields" ADD CONSTRAINT "service_request_type_fields_request_type_id_fkey" FOREIGN KEY ("request_type_id") REFERENCES "service_request_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_request_type_id_fkey" FOREIGN KEY ("request_type_id") REFERENCES "service_request_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_values" ADD CONSTRAINT "service_request_values_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_request_messages" ADD CONSTRAINT "service_request_messages_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_letters" ADD CONSTRAINT "hr_letters_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_letters" ADD CONSTRAINT "hr_letters_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "hr_letter_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
