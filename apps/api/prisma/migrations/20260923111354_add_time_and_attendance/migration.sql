-- CreateTable
CREATE TABLE "attendance_shifts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_grace_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_grace_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_overnight" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_schedules" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "shift_id" TEXT,
    "dayType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT,

    CONSTRAINT "attendance_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_clock_events" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "attendance_date" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,

    CONSTRAINT "attendance_clock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "attendance_date" TEXT NOT NULL,
    "shift_id" TEXT,
    "day_type" TEXT NOT NULL,
    "scheduled_start" TIMESTAMP(3),
    "scheduled_end" TIMESTAMP(3),
    "first_clock_in" TIMESTAMP(3),
    "last_clock_out" TIMESTAMP(3),
    "work_minutes" INTEGER NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "extra_minutes" INTEGER NOT NULL DEFAULT 0,
    "leave_units" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "correction_id" TEXT,
    "calculated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "attendance_date" TEXT NOT NULL,
    "requested_clock_in" TIMESTAMP(3),
    "requested_clock_out" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "workflow_instance_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_shifts_organization_id_is_active_idx" ON "attendance_shifts"("organization_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_shifts_organization_id_code_key" ON "attendance_shifts"("organization_id", "code");

-- CreateIndex
CREATE INDEX "attendance_schedules_date_idx" ON "attendance_schedules"("date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_schedules_employee_id_date_key" ON "attendance_schedules"("employee_id", "date");

-- CreateIndex
CREATE INDEX "attendance_clock_events_employee_id_occurred_at_idx" ON "attendance_clock_events"("employee_id", "occurred_at");

-- CreateIndex
CREATE INDEX "attendance_clock_events_employee_id_attendance_date_idx" ON "attendance_clock_events"("employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "attendance_records_attendance_date_status_idx" ON "attendance_records"("attendance_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_employee_id_attendance_date_key" ON "attendance_records"("employee_id", "attendance_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_corrections_workflow_instance_id_key" ON "attendance_corrections"("workflow_instance_id");

-- CreateIndex
CREATE INDEX "attendance_corrections_employee_id_attendance_date_idx" ON "attendance_corrections"("employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "attendance_corrections_status_attendance_date_idx" ON "attendance_corrections"("status", "attendance_date");

-- AddForeignKey
ALTER TABLE "attendance_shifts" ADD CONSTRAINT "attendance_shifts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "attendance_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_schedules" ADD CONSTRAINT "attendance_schedules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_clock_events" ADD CONSTRAINT "attendance_clock_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_clock_events" ADD CONSTRAINT "attendance_clock_events_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "attendance_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
