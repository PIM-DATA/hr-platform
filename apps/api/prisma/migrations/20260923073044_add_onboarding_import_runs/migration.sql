-- CreateTable
CREATE TABLE "onboarding_import_runs" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "organization_count" INTEGER NOT NULL DEFAULT 0,
    "department_count" INTEGER NOT NULL DEFAULT 0,
    "job_count" INTEGER NOT NULL DEFAULT 0,
    "position_count" INTEGER NOT NULL DEFAULT 0,
    "employee_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_import_runs_file_hash_key" ON "onboarding_import_runs"("file_hash");

-- CreateIndex
CREATE INDEX "onboarding_import_runs_created_at_idx" ON "onboarding_import_runs"("created_at");

-- AddForeignKey
ALTER TABLE "onboarding_import_runs" ADD CONSTRAINT "onboarding_import_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
