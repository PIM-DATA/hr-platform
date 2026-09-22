-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "module" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT
);

-- CreateTable
CREATE TABLE "workflow_definition_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definition_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "approver_type" TEXT NOT NULL,
    "approver_user_id" TEXT,
    "approver_role_id" TEXT,
    "on_self" TEXT NOT NULL DEFAULT 'FAIL',
    "on_unresolved" TEXT NOT NULL DEFAULT 'FAIL',
    CONSTRAINT "workflow_definition_steps_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_definition_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "workflow_definition_steps_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "roles" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_instances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definition_id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "requester_employee_id" TEXT NOT NULL,
    "requester_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "current_step_order" INTEGER,
    "submitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "workflow_instances_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "workflow_definitions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_instances_requester_employee_id_fkey" FOREIGN KEY ("requester_employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "workflow_instances_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_instance_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instance_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "approver_type" TEXT NOT NULL,
    "approver_employee_id" TEXT,
    "approver_user_id" TEXT,
    "approver_role_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "skip_reason" TEXT,
    "acted_by_user_id" TEXT,
    "acted_at" DATETIME,
    "comment" TEXT,
    CONSTRAINT "workflow_instance_steps_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_instance_steps_approver_employee_id_fkey" FOREIGN KEY ("approver_employee_id") REFERENCES "employees" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "workflow_instance_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "workflow_instance_steps_acted_by_user_id_fkey" FOREIGN KEY ("acted_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "instance_id" TEXT NOT NULL,
    "step_order" INTEGER,
    "action" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_actions_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "workflow_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_actions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "workflow_definitions_code_is_active_idx" ON "workflow_definitions"("code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_code_version_key" ON "workflow_definitions"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definition_steps_definition_id_step_order_key" ON "workflow_definition_steps"("definition_id", "step_order");

-- CreateIndex
CREATE INDEX "workflow_instances_module_entity_type_entity_id_idx" ON "workflow_instances"("module", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "workflow_instances_requester_employee_id_idx" ON "workflow_instances"("requester_employee_id");

-- CreateIndex
CREATE INDEX "workflow_instances_status_idx" ON "workflow_instances"("status");

-- CreateIndex
CREATE INDEX "workflow_instance_steps_approver_user_id_status_idx" ON "workflow_instance_steps"("approver_user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instance_steps_instance_id_step_order_key" ON "workflow_instance_steps"("instance_id", "step_order");

-- CreateIndex
CREATE INDEX "workflow_actions_instance_id_created_at_idx" ON "workflow_actions"("instance_id", "created_at");
