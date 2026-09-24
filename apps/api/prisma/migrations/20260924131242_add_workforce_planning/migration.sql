-- CreateTable
CREATE TABLE "workforce_planning_cycles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organization_id" TEXT,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "finalized_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_planning_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_plan_items" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "job_id" TEXT,
    "grain_key" TEXT NOT NULL,
    "department_name_snapshot" TEXT NOT NULL,
    "job_title_snapshot" TEXT,
    "current_headcount_snapshot" INTEGER NOT NULL,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "planned_headcount" INTEGER NOT NULL,
    "reason" TEXT,
    "priority" TEXT,
    "target_date" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_plan_requisitions" (
    "id" TEXT NOT NULL,
    "plan_item_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workforce_plan_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_planned_movements" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "employee_id" TEXT,
    "from_department_id" TEXT,
    "to_department_id" TEXT,
    "from_job_id" TEXT,
    "to_job_id" TEXT,
    "target_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_planned_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_design_scenarios" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organization_id" TEXT NOT NULL,
    "planning_cycle_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "final_snapshot" JSONB,
    "finalized_at" TIMESTAMP(3),
    "duplicated_from_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_design_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_design_nodes" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parent_node_id" TEXT,
    "source_organization_id" TEXT,
    "source_department_id" TEXT,
    "planned_only" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_design_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_design_positions" (
    "id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "job_id" TEXT,
    "planned_job_title" TEXT,
    "planned_headcount" INTEGER NOT NULL,
    "reports_to_node_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_design_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workforce_planning_cycles_code_key" ON "workforce_planning_cycles"("code");

-- CreateIndex
CREATE INDEX "workforce_planning_cycles_status_idx" ON "workforce_planning_cycles"("status");

-- CreateIndex
CREATE INDEX "workforce_plan_items_cycle_id_department_id_idx" ON "workforce_plan_items"("cycle_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "workforce_plan_items_cycle_id_grain_key_key" ON "workforce_plan_items"("cycle_id", "grain_key");

-- CreateIndex
CREATE UNIQUE INDEX "workforce_plan_requisitions_requisition_id_key" ON "workforce_plan_requisitions"("requisition_id");

-- CreateIndex
CREATE INDEX "workforce_plan_requisitions_plan_item_id_idx" ON "workforce_plan_requisitions"("plan_item_id");

-- CreateIndex
CREATE INDEX "workforce_planned_movements_cycle_id_status_idx" ON "workforce_planned_movements"("cycle_id", "status");

-- CreateIndex
CREATE INDEX "organization_design_scenarios_organization_id_status_idx" ON "organization_design_scenarios"("organization_id", "status");

-- CreateIndex
CREATE INDEX "organization_design_nodes_scenario_id_parent_node_id_idx" ON "organization_design_nodes"("scenario_id", "parent_node_id");

-- CreateIndex
CREATE INDEX "organization_design_positions_scenario_id_node_id_idx" ON "organization_design_positions"("scenario_id", "node_id");

-- AddForeignKey
ALTER TABLE "workforce_plan_items" ADD CONSTRAINT "workforce_plan_items_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "workforce_planning_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_plan_requisitions" ADD CONSTRAINT "workforce_plan_requisitions_plan_item_id_fkey" FOREIGN KEY ("plan_item_id") REFERENCES "workforce_plan_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_planned_movements" ADD CONSTRAINT "workforce_planned_movements_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "workforce_planning_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_design_scenarios" ADD CONSTRAINT "organization_design_scenarios_planning_cycle_id_fkey" FOREIGN KEY ("planning_cycle_id") REFERENCES "workforce_planning_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_design_nodes" ADD CONSTRAINT "organization_design_nodes_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "organization_design_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_design_nodes" ADD CONSTRAINT "organization_design_nodes_parent_node_id_fkey" FOREIGN KEY ("parent_node_id") REFERENCES "organization_design_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_design_positions" ADD CONSTRAINT "organization_design_positions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "organization_design_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_design_positions" ADD CONSTRAINT "organization_design_positions_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "organization_design_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
