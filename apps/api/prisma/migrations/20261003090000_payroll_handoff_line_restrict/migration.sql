-- Task 48 (T44-P1-15): a benefit claim / expense report handed over to payroll points at its payroll line, and that
-- line can no longer be deleted while it does (ON DELETE RESTRICT).
--
-- Repair first: before Task 48 a recalculation re-created payroll lines with new ids, so an existing pointer may dangle.
-- It is re-linked to the manual line carrying the same (reference_type, reference_id) — the handoff's own idempotency
-- key. A pointer whose line is genuinely gone (deleted through the old "remove adjustment") cannot be re-linked; it is
-- cleared so the constraint can exist, and the source keeps its SENT_TO_PAYROLL status — such rows are listed by the
-- reconciliation query in docs/payroll.md ("Handoff lines").

UPDATE "benefit_claims" c
SET "payroll_result_item_id" = (
  SELECT i."id" FROM "payroll_result_items" i
  WHERE i."reference_type" = 'BENEFIT_CLAIM' AND i."reference_id" = c."id" AND i."is_manual" = true
  ORDER BY i."created_at" DESC LIMIT 1
)
WHERE c."payroll_result_item_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "payroll_result_items" x WHERE x."id" = c."payroll_result_item_id");

UPDATE "expense_reports" r
SET "payroll_result_item_id" = (
  SELECT i."id" FROM "payroll_result_items" i
  WHERE i."reference_type" = 'EXPENSE_REPORT' AND i."reference_id" = r."id" AND i."is_manual" = true
  ORDER BY i."created_at" DESC LIMIT 1
)
WHERE r."payroll_result_item_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "payroll_result_items" x WHERE x."id" = r."payroll_result_item_id");

-- AddForeignKey
ALTER TABLE "benefit_claims" ADD CONSTRAINT "benefit_claims_payroll_result_item_id_fkey" FOREIGN KEY ("payroll_result_item_id") REFERENCES "payroll_result_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_payroll_result_item_id_fkey" FOREIGN KEY ("payroll_result_item_id") REFERENCES "payroll_result_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
