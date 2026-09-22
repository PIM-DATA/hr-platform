/**
 * Task 10.5 — concurrency validation of BalanceService on PostgreSQL.
 *
 * Every scenario opens REAL concurrent interactive transactions (separate pooled connections) and relies only on
 * the row lock in loadEntitlementForMutation (SELECT … FOR UPDATE) for correctness: no retries, no sleeps to hide
 * races, no application mutex. `waitForBlockedSession` proves at the database level that the competing transaction
 * is actually waiting on the lock before the holder proceeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { balanceService, loadEntitlementForMutation, type Tx } from '../src/modules/leave/balance.service';
import { AppError } from '../src/lib/errors';
import { resetDatabase, waitForBlockedSession } from './helpers';

let orgId: string, employeeId: string, typeId: string, policyId: string, actorId: string;
let seq = 0;
const key = (p: string) => `${p}:${++seq}`;
const meta = (operationKey: string) => ({ operationKey, actorUserId: actorId });

/** Fresh entitlement with `granted` units available (own ledger GRANT). */
async function mkEntitlement(granted: number, allowNegativeBalance = false) {
  const policy = allowNegativeBalance ? await prisma.leavePolicy.findFirstOrThrow({ where: { name: 'neg' } }) : { id: policyId };
  seq += 1;
  const start = new Date(2000 + seq, 0, 1); // unique period per entitlement (employee+type+periodStart is unique)
  const ps = start.toISOString().slice(0, 10), pe = `${start.getFullYear()}-12-31`;
  const e = await prisma.leaveEntitlement.create({ data: { employeeId, leaveTypeId: typeId, policyId: policy.id, policyResolvedDate: ps, periodStart: ps, periodEnd: pe, createdByUserId: actorId } });
  if (granted > 0) await prisma.$transaction((tx) => balanceService.grant(tx, e.id, granted, meta(`grant:${e.id}`)));
  return e.id;
}
const cached = (id: string) => prisma.leaveEntitlement.findUniqueOrThrow({ where: { id }, select: { granted: true, carriedForward: true, adjustment: true, reserved: true, used: true } });
const ledgerOf = (id: string, entryType?: string) => prisma.leaveLedger.findMany({ where: { entitlementId: id, ...(entryType ? { entryType } : {}) } });
async function expectReconciled(id: string) { const r = await balanceService.reconcile(prisma, id); expect(r.matches, JSON.stringify(r)).toBe(true); return r; }
const errCode = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? (r.reason instanceof AppError ? r.reason.code : String(r.reason)) : 'OK');

const reserveTx = (id: string, units: number, operationKey: string) => prisma.$transaction((tx) => balanceService.reserve(tx, id, units, meta(operationKey)));

beforeAll(async () => {
  await resetDatabase();
  orgId = (await prisma.organization.create({ data: { code: 'CC', name: 'Concurrency' } })).id;
  const dept = await prisma.department.create({ data: { organizationId: orgId, code: 'D', name: 'D' } });
  const pos = await prisma.position.create({ data: { departmentId: dept.id, code: 'P', title: 'P' } });
  employeeId = (await prisma.employee.create({ data: { employeeCode: 'CC1', firstName: 'C', lastName: 'C', email: 'cc1@cc.local', hireDate: new Date('2020-01-01'), organizationId: orgId, departmentId: dept.id, positionId: pos.id, employmentType: 'FULL_TIME', employmentStatus: 'ACTIVE' } })).id;
  actorId = (await prisma.user.create({ data: { email: 'actor@cc.local', passwordHash: 'x' } })).id;
  typeId = (await prisma.leaveType.create({ data: { code: 'CC', name: 'CC' } })).id;
  policyId = (await prisma.leavePolicy.create({ data: { name: 'std', leaveTypeId: typeId, annualUnits: 10, effectiveFrom: '2000-01-01', isActive: true, carryForwardMaxUnits: 5 } })).id;
  await prisma.leavePolicy.create({ data: { name: 'neg', leaveTypeId: typeId, annualUnits: 10, effectiveFrom: '2000-01-01', isActive: true, allowNegativeBalance: true, organizationId: orgId } });
});
afterAll(async () => { await resetDatabase(); await prisma.$disconnect(); });

describe('PostgreSQL row lock — BalanceService concurrency', () => {
  it('lock is a real PostgreSQL row lock: second transaction blocks on FOR UPDATE until the first commits', async () => {
    const id = await mkEntitlement(2);
    let bStartedAt = 0, aCommittedAt = 0, bFinishedAt = 0;
    let locked!: () => void; const aHoldsLock = new Promise<void>((r) => { locked = r; });
    const a = prisma.$transaction(async (tx) => {
      await loadEntitlementForMutation(tx, id); // lock
      locked();
      await waitForBlockedSession(); // B is now waiting on this row at the DB level
      const r = await balanceService.reserve(tx, id, 2, meta('A'));
      aCommittedAt = Date.now();
      return r;
    });
    await aHoldsLock; // deterministic ordering: B starts only once A holds the row lock
    bStartedAt = Date.now();
    const b = reserveTx(id, 2, 'B').finally(() => { bFinishedAt = Date.now(); });
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(errCode(rb)).toBe('INSUFFICIENT_LEAVE_BALANCE');
    expect(bStartedAt).toBeLessThan(aCommittedAt); // B was in flight before A committed …
    expect(bFinishedAt).toBeGreaterThanOrEqual(aCommittedAt); // … and could only finish after A released the lock
    expect(await cached(id)).toMatchObject({ granted: 2, reserved: 2, used: 0 });
    expect(await ledgerOf(id, 'RESERVE')).toHaveLength(1);
    await expectReconciled(id);
  });

  it('14. available 2, concurrent reserve 2 + reserve 2 → exactly one succeeds (repeated 5×)', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await mkEntitlement(2);
      const results = await Promise.allSettled([reserveTx(id, 2, key('A')), reserveTx(id, 2, key('B'))]);
      const codes = results.map(errCode).sort();
      expect(codes, `round ${round}`).toEqual(['INSUFFICIENT_LEAVE_BALANCE', 'OK']);
      const c = await cached(id);
      expect(c).toMatchObject({ reserved: 2, used: 0 });
      expect(c.granted + c.carriedForward + c.adjustment - c.reserved - c.used).toBe(0);
      expect(await ledgerOf(id, 'RESERVE')).toHaveLength(1);
      await expectReconciled(id);
    }
  });

  it('15. available 5, 10 concurrent reserve 1 → exactly 5 succeed, 5 insufficient (repeated 5×)', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await mkEntitlement(5);
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveTx(id, 1, key(`r${round}-${i}`))));
      const codes = results.map(errCode);
      expect(codes.filter((c) => c === 'OK'), `round ${round}: ${codes.join(',')}`).toHaveLength(5);
      expect(codes.filter((c) => c === 'INSUFFICIENT_LEAVE_BALANCE')).toHaveLength(5);
      expect(await cached(id)).toMatchObject({ reserved: 5, used: 0, granted: 5 });
      expect(await ledgerOf(id, 'RESERVE')).toHaveLength(5);
      await expectReconciled(id);
    }
  });

  it('16. same operationKey + same payload concurrently → both callers succeed, exactly one ledger row', async () => {
    const id = await mkEntitlement(5);
    const k = key('same');
    const results = await Promise.allSettled([reserveTx(id, 1, k), reserveTx(id, 1, k)]);
    expect(results.map(errCode)).toEqual(['OK', 'OK']);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ idempotentReplay: boolean; available: number }>).value);
    expect(values.filter((v) => v.idempotentReplay)).toHaveLength(1);
    expect(values.map((v) => v.available)).toEqual([4, 4]);
    expect(await ledgerOf(id, 'RESERVE')).toHaveLength(1);
    expect(await cached(id)).toMatchObject({ reserved: 1 });
    await expectReconciled(id);
  });

  it('17. same operationKey, different payload (units / type / entitlement) → 409 LEDGER_OPERATION_CONFLICT, never a silent replay', async () => {
    const id = await mkEntitlement(5);
    const other = await mkEntitlement(5);
    const k = key('conflict');
    const concurrent = await Promise.allSettled([reserveTx(id, 1, k), reserveTx(id, 2, k)]);
    expect(concurrent.map(errCode).sort()).toEqual(['LEDGER_OPERATION_CONFLICT', 'OK']);
    // sequential: different entry type, different entitlement
    await expect(prisma.$transaction((tx) => balanceService.use(tx, id, 1, meta(k)))).rejects.toMatchObject({ code: 'LEDGER_OPERATION_CONFLICT' });
    await expect(reserveTx(other, 1, k)).rejects.toMatchObject({ code: 'LEDGER_OPERATION_CONFLICT' });
    // concurrent on DIFFERENT entitlements (each holds its own row lock → unique index is the backstop)
    const k2 = key('cross');
    const cross = await Promise.allSettled([reserveTx(id, 1, k2), reserveTx(other, 1, k2)]);
    expect(cross.map(errCode).sort()).toEqual(['LEDGER_OPERATION_CONFLICT', 'OK']);
    expect(await prisma.leaveLedger.count({ where: { operationKey: { in: [k, k2] } } })).toBe(2);
    await expectReconciled(id); await expectReconciled(other);
  });

  it('19. lock granularity = entitlement row: a mutation on entitlement B completes while A is still locked', async () => {
    const a = await mkEntitlement(5), b = await mkEntitlement(5);
    let releaseA!: () => void;
    const held = new Promise<void>((r) => { releaseA = r; });
    let bDoneWhileAHeld = false;
    let locked!: () => void; const aHoldsLock = new Promise<void>((r) => { locked = r; });
    const txA = prisma.$transaction(async (tx) => { await loadEntitlementForMutation(tx, a); locked(); await held; return balanceService.reserve(tx, a, 1, meta(key('A'))); }, { timeout: 10000 });
    await aHoldsLock;
    const txB = reserveTx(b, 1, key('B')).then((r) => { bDoneWhileAHeld = true; return r; });
    const rb = await Promise.race([txB, new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500))]);
    expect(rb).not.toBe('blocked');
    expect(bDoneWhileAHeld).toBe(true);
    releaseA();
    await txA;
    expect(await cached(a)).toMatchObject({ reserved: 1 }); expect(await cached(b)).toMatchObject({ reserved: 1 });
  });

  it('20. rollback releases the lock: A reserves then throws → B acquires the lock and succeeds; no A ledger row', async () => {
    const id = await mkEntitlement(2);
    let locked!: () => void; const aHoldsLock = new Promise<void>((r) => { locked = r; });
    const a = prisma.$transaction(async (tx) => {
      await balanceService.reserve(tx, id, 2, meta('rollback-A')); // takes the row lock
      locked();
      await waitForBlockedSession(); // B is blocked behind A's lock right now
      throw new Error('simulated failure after ledger insert');
    });
    await aHoldsLock;
    const b = reserveTx(id, 2, 'rollback-B');
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('rejected');
    expect(errCode(rb)).toBe('OK');
    const rows = await ledgerOf(id, 'RESERVE');
    expect(rows.map((r) => r.operationKey)).toEqual(['rollback-B']);
    expect(await cached(id)).toMatchObject({ reserved: 2 });
    await expectReconciled(id);
    const stale = await prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid WHERE l.locktype = 'transactionid' AND s.datname = current_database() AND s.state = 'idle in transaction'`;
    expect(Number(stale[0].c)).toBe(0);
  });

  it('21. allowNegativeBalance from the referenced policy applies under contention (both reservations succeed)', async () => {
    const id = await mkEntitlement(2, true);
    const results = await Promise.allSettled([reserveTx(id, 2, key('n')), reserveTx(id, 2, key('n'))]);
    expect(results.map(errCode)).toEqual(['OK', 'OK']);
    expect(await cached(id)).toMatchObject({ reserved: 4 });
    await expectReconciled(id);
  });

  it('22. summary recompute on PostgreSQL: every entry type with 0.5 increments matches exactly', async () => {
    const id = await mkEntitlement(10);
    await prisma.$transaction(async (tx) => {
      await balanceService.carryForward(tx, id, 2.5, meta(key('cf')));
      await balanceService.adjust(tx, id, -0.5, meta(key('adj')));
      await balanceService.reserve(tx, id, 3.5, meta(key('res')));
      await balanceService.release(tx, id, 1.5, meta(key('rel')));
      await balanceService.use(tx, id, 4.5, meta(key('use')));
      await balanceService.refund(tx, id, 0.5, meta(key('ref')));
    });
    const c = await cached(id);
    expect(c).toEqual({ granted: 10, carriedForward: 2.5, adjustment: -0.5, reserved: 2, used: 4 });
    expect((await balanceService.getBalance(prisma, id)).available).toBe(6);
    const r = await expectReconciled(id);
    expect(r.expected).toEqual(c);
  });

  it('23. float stress: 40 × 0.5 reserve concurrently in batches, then 40 × 0.5 release → exact values, no drift', async () => {
    const id = await mkEntitlement(20);
    for (let batch = 0; batch < 4; batch++) {
      const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => reserveTx(id, 0.5, key(`f${batch}-${i}`))));
      expect(res.map(errCode).every((c) => c === 'OK'), res.map(errCode).join(',')).toBe(true);
    }
    expect(await cached(id)).toMatchObject({ reserved: 20 });
    expect((await balanceService.getBalance(prisma, id)).available).toBe(0);
    // one more 0.5 must fail on exact boundary
    await expect(reserveTx(id, 0.5, key('over'))).rejects.toMatchObject({ code: 'INSUFFICIENT_LEAVE_BALANCE' });
    for (let i = 0; i < 40; i++) await prisma.$transaction((tx) => balanceService.release(tx, id, 0.5, meta(key('rl'))));
    const c = await cached(id);
    expect(c.reserved).toBe(0);
    expect(Object.is(c.reserved, 0) || c.reserved === 0).toBe(true);
    const sum = await prisma.leaveLedger.aggregate({ where: { entitlementId: id, entryType: { in: ['RESERVE', 'RELEASE'] } }, _sum: { units: true } });
    expect(sum._sum.units).toBe(0);
    await expectReconciled(id);
  });
});
