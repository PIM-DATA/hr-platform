-- CreateTable
CREATE TABLE "leave_entitlements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employee_id" TEXT NOT NULL,
    "leave_type_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_resolved_date" TEXT NOT NULL,
    "period_start" TEXT NOT NULL,
    "period_end" TEXT NOT NULL,
    "granted" REAL NOT NULL DEFAULT 0,
    "carried_forward" REAL NOT NULL DEFAULT 0,
    "adjustment" REAL NOT NULL DEFAULT 0,
    "reserved" REAL NOT NULL DEFAULT 0,
    "used" REAL NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by_user_id" TEXT,
    CONSTRAINT "leave_entitlements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leave_entitlements_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leave_entitlements_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "leave_policies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "leave_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entitlement_id" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "units" REAL NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "operation_key" TEXT NOT NULL,
    "note" TEXT,
    "created_by_user_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_ledger_entitlement_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "leave_entitlements" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "leave_ledger_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "leave_entitlements_employee_id_leave_type_id_idx" ON "leave_entitlements"("employee_id", "leave_type_id");

-- CreateIndex
CREATE INDEX "leave_entitlements_period_start_period_end_idx" ON "leave_entitlements"("period_start", "period_end");

-- CreateIndex
CREATE INDEX "leave_entitlements_policy_id_idx" ON "leave_entitlements"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "leave_entitlements_employee_id_leave_type_id_period_start_key" ON "leave_entitlements"("employee_id", "leave_type_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "leave_ledger_operation_key_key" ON "leave_ledger"("operation_key");

-- CreateIndex
CREATE INDEX "leave_ledger_entitlement_id_created_at_idx" ON "leave_ledger"("entitlement_id", "created_at");
