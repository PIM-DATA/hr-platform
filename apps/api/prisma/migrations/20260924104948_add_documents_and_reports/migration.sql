-- CreateTable
CREATE TABLE "document_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope_type" TEXT NOT NULL DEFAULT 'GENERAL',
    "default_classification" TEXT NOT NULL DEFAULT 'EMPLOYEE_PRIVATE',
    "allowed_extensions" TEXT,
    "max_file_size_bytes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_sequences" (
    "year" INTEGER NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category_id" TEXT NOT NULL,
    "owner_employee_id" TEXT,
    "organization_id" TEXT,
    "classification" TEXT NOT NULL DEFAULT 'EMPLOYEE_PRIVATE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "current_version_id" TEXT,
    "issued_date" TEXT,
    "expiry_date" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "relation_type" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dataset_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "definition" JSONB NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_categories_code_key" ON "document_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "documents_document_number_key" ON "documents"("document_number");

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_version_id_key" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "documents_owner_employee_id_status_idx" ON "documents"("owner_employee_id", "status");

-- CreateIndex
CREATE INDEX "documents_category_id_idx" ON "documents"("category_id");

-- CreateIndex
CREATE INDEX "documents_classification_idx" ON "documents"("classification");

-- CreateIndex
CREATE INDEX "documents_expiry_date_idx" ON "documents"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_links_entity_type_entity_id_idx" ON "document_links"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_document_id_entity_type_entity_id_key" ON "document_links"("document_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "saved_reports_owner_user_id_idx" ON "saved_reports"("owner_user_id");

-- CreateIndex
CREATE INDEX "saved_reports_visibility_dataset_id_idx" ON "saved_reports"("visibility", "dataset_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "document_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_employee_id_fkey" FOREIGN KEY ("owner_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
