-- CreateTable
CREATE TABLE "overtime_policies" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "workday_multiplier" DOUBLE PRECISION NOT NULL,
    "off_day_multiplier" DOUBLE PRECISION NOT NULL,
    "holiday_multiplier" DOUBLE PRECISION NOT NULL,
    "minimum_eligible_minutes" INTEGER,
    "maximum_approved_minutes_per_day" INTEGER,
    "workflow_definition_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_requests" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "attendance_date" TEXT NOT NULL,
    "claimed_minutes" INTEGER NOT NULL,
    "eligible_minutes_snapshot" INTEGER,
    "approved_minutes" INTEGER,
    "day_type" TEXT,
    "rate_multiplier_snapshot" DOUBLE PRECISION,
    "policy_id" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "workflow_instance_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "organization_id" TEXT,
    "department_id" TEXT,
    "position_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,

    CONSTRAINT "overtime_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "overtime_policies_organization_id_is_active_effective_from_idx" ON "overtime_policies"("organization_id", "is_active", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_requests_workflow_instance_id_key" ON "overtime_requests"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "overtime_requests_employee_id_attendance_date_idx" ON "overtime_requests"("employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "overtime_requests_employee_id_status_idx" ON "overtime_requests"("employee_id", "status");

-- CreateIndex
CREATE INDEX "overtime_requests_attendance_date_status_idx" ON "overtime_requests"("attendance_date", "status");

-- CreateIndex
CREATE INDEX "overtime_requests_organization_id_attendance_date_idx" ON "overtime_requests"("organization_id", "attendance_date");

-- CreateIndex
CREATE INDEX "overtime_requests_policy_id_idx" ON "overtime_requests"("policy_id");

-- AddForeignKey
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "overtime_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
