/*
  Warnings:

  - You are about to drop the column `assignment_id` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `department_id_snapshot` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `employee_id` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `job_id_snapshot` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `organization_id_snapshot` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `position_id_snapshot` on the `engagement_responses` table. All the data in the column will be lost.
  - You are about to drop the column `submitted_at` on the `engagement_responses` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "engagement_responses_assignment_id_key";

-- DropIndex
DROP INDEX "engagement_responses_survey_id_department_id_snapshot_idx";

-- DropIndex
DROP INDEX "engagement_responses_survey_id_job_id_snapshot_idx";

-- AlterTable
ALTER TABLE "engagement_responses" DROP COLUMN "assignment_id",
DROP COLUMN "department_id_snapshot",
DROP COLUMN "employee_id",
DROP COLUMN "job_id_snapshot",
DROP COLUMN "organization_id_snapshot",
DROP COLUMN "position_id_snapshot",
DROP COLUMN "submitted_at",
ADD COLUMN     "dept_cohort_id" TEXT,
ADD COLUMN     "job_cohort_id" TEXT,
ADD COLUMN     "org_cohort_id" TEXT;

-- AlterTable
ALTER TABLE "engagement_survey_assignments" ADD COLUMN     "dept_cohort_id" TEXT,
ADD COLUMN     "job_cohort_id" TEXT,
ADD COLUMN     "org_cohort_id" TEXT;

-- CreateTable
CREATE TABLE "engagement_survey_cohorts" (
    "id" TEXT NOT NULL,
    "survey_id" TEXT NOT NULL,
    "dimension_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,

    CONSTRAINT "engagement_survey_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_identified_respondents" (
    "response_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagement_identified_respondents_pkey" PRIMARY KEY ("response_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "engagement_survey_cohorts_survey_id_dimension_type_source_i_key" ON "engagement_survey_cohorts"("survey_id", "dimension_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_identified_respondents_assignment_id_key" ON "engagement_identified_respondents"("assignment_id");

-- CreateIndex
CREATE INDEX "engagement_identified_respondents_employee_id_idx" ON "engagement_identified_respondents"("employee_id");

-- CreateIndex
CREATE INDEX "engagement_responses_survey_id_dept_cohort_id_idx" ON "engagement_responses"("survey_id", "dept_cohort_id");

-- CreateIndex
CREATE INDEX "engagement_responses_survey_id_job_cohort_id_idx" ON "engagement_responses"("survey_id", "job_cohort_id");

-- CreateIndex
CREATE INDEX "engagement_survey_assignments_survey_id_dept_cohort_id_idx" ON "engagement_survey_assignments"("survey_id", "dept_cohort_id");

-- AddForeignKey
ALTER TABLE "engagement_survey_cohorts" ADD CONSTRAINT "engagement_survey_cohorts_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "engagement_surveys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_identified_respondents" ADD CONSTRAINT "engagement_identified_respondents_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "engagement_responses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_identified_respondents" ADD CONSTRAINT "engagement_identified_respondents_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "engagement_survey_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
