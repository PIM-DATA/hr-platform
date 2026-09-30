/**
 * Task 48 — reconciliation of a benefit claim / expense report handed over to payroll (T44-P1-15).
 *
 * The source and its payroll line must agree at all times: the source points at a line that exists, the line points back
 * at the source (reference type + id), the amounts are equal to the satang, and the line is in the source's currency.
 */
import { expect } from 'vitest';
import { prisma } from '../src/lib/prisma';

export async function expectHandoffReconciled(kind: 'BENEFIT_CLAIM' | 'EXPENSE_REPORT', sourceId: string) {
  const source = kind === 'BENEFIT_CLAIM'
    ? await prisma.benefitClaim.findUniqueOrThrow({ where: { id: sourceId }, select: { status: true, currency: true, payrollResultItemId: true, approvedAmount: true, claimedAmount: true } })
        .then((c) => ({ status: c.status, currency: c.currency, itemId: c.payrollResultItemId, amount: (c.approvedAmount ?? c.claimedAmount).toFixed(2) }))
    : await prisma.expenseReport.findUniqueOrThrow({ where: { id: sourceId }, select: { status: true, currency: true, payrollResultItemId: true, totalAmount: true } })
        .then((r) => ({ status: r.status, currency: r.currency, itemId: r.payrollResultItemId, amount: r.totalAmount.toFixed(2) }));
  expect(['SENT_TO_PAYROLL', 'PAID']).toContain(source.status);
  expect(source.itemId, `${kind} ${sourceId} has no payroll line`).toBeTruthy();
  const line = await prisma.payrollResultItem.findUnique({ where: { id: source.itemId! }, include: { payrollResult: { select: { currencyCode: true, run: { select: { currencyCode: true } } } } } });
  expect(line, `${kind} ${sourceId} points at a payroll line that does not exist`).not.toBeNull();
  expect({ referenceType: line!.referenceType, referenceId: line!.referenceId, isManual: line!.isManual, amount: line!.amount.toFixed(2), currency: line!.payrollResult.run.currencyCode })
    .toEqual({ referenceType: kind, referenceId: sourceId, isManual: true, amount: source.amount, currency: source.currency });
  expect(await prisma.payrollResultItem.count({ where: { referenceType: kind, referenceId: sourceId } })).toBe(1);
  return { itemId: line!.id };
}
