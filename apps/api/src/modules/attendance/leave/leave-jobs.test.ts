import { isLeaveBalanceConsistent, uuidv7 } from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { employees } from '../../../platform/db/schema/index.js';
import type { JobContext } from '../../../platform/jobs/job-handler.js';
import { ApiHarness } from '../../../test-support/api-harness.js';
import { addDays } from '../day-engine/calendar-date.js';
import { compOffCredits, leaveBalances, leaveLedger, leaveTypes } from '../schema/index.js';
import {
  AccrueLeaveHandler,
  CarryForwardLeaveHandler,
  ExpireCompOffHandler,
} from './leave-jobs.handler.js';
import { LeaveRepository } from './leave.repository.js';

/**
 * The three scheduled jobs against the real database (REQ-G-05, REQ-G-01,
 * REQ-G-11).
 *
 * The handlers are pulled out of the running container rather than
 * constructed, so what runs is the fully injected instance the queue would
 * call. The queue itself is not involved: `JOBS_WORKER_ENABLED=false` in the
 * vitest config, and what these tests are about is what the handler does, not
 * whether BullMQ delivers it -- `jobs.test.ts` already covers that.
 *
 * The assertion each of them exists for is **the second run**. A job that is
 * merely correct once is not enough: `leave_ledger` is append-only, so an
 * accrual posted twice cannot be taken back, and the retry that posts it is
 * the ordinary case rather than the exotic one.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000e2';
const CONTEXT: JobContext = { jobId: 'test', attempt: 1 };

let harness: ApiHarness;
let runId: string;

let accrue: AccrueLeaveHandler;
let carryForward: CarryForwardLeaveHandler;
let expireCompOff: ExpireCompOffHandler;

let veteranId: string;
let joinerId: string;
let leaverId: string;
let monthlyTypeId = '';
let cappedTypeId = '';
let compOffTypeId = '';

/** A leave year comfortably in the past, so nothing here collides with today. */
const LEAVE_YEAR = 2024;
const ACCRUAL_MONTH = '2024-04';
const NEXT_YEAR_OPENS = '2025-04-01';

async function balanceRow(
  employeeId: string,
  leaveTypeId: string,
  leaveYear: number,
): Promise<{
  opening: number;
  accrued: number;
  availed: number;
  adjusted: number;
  carriedForward: number;
  closing: number;
} | null> {
  const rows = await harness.db
    .select({
      opening: leaveBalances.opening,
      accrued: leaveBalances.accrued,
      availed: leaveBalances.availed,
      adjusted: leaveBalances.adjusted,
      carriedForward: leaveBalances.carriedForward,
      closing: leaveBalances.closing,
    })
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.orgId, ORG_ID),
        eq(leaveBalances.employeeId, employeeId),
        eq(leaveBalances.leaveTypeId, leaveTypeId),
        eq(leaveBalances.leaveYear, leaveYear),
      ),
    );
  return rows[0] ?? null;
}

async function countLedger(employeeId: string, leaveTypeId: string): Promise<number> {
  const rows = await harness.db
    .select({ value: sql<number>`count(*)::int` })
    .from(leaveLedger)
    .where(
      and(
        eq(leaveLedger.orgId, ORG_ID),
        eq(leaveLedger.employeeId, employeeId),
        eq(leaveLedger.leaveTypeId, leaveTypeId),
      ),
    );
  return rows[0]?.value ?? 0;
}

async function createType(values: Partial<typeof leaveTypes.$inferInsert>): Promise<string> {
  const rows = await harness.db
    .insert(leaveTypes)
    .values({ orgId: ORG_ID, name: 'Job Probe Type', code: `JP${runId}`, ...values })
    .returning({ id: leaveTypes.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('leave type fixture returned no row');
  return id;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Leave Jobs Fixture Org', { preservePeople: true });
  runId = uuidv7().slice(-6).toUpperCase();

  // Types from a previous run would be accrued into again by the very jobs
  // under test, and a type with ledger rows can never be deleted.
  await harness.db.execute(
    sql`UPDATE leave_types SET deleted_at = now() WHERE org_id = ${ORG_ID} AND deleted_at IS NULL`,
  );

  veteranId = await harness.createEmployee({
    code: `JB-V-${runId}`,
    firstName: 'Vikram',
    dateOfJoining: '2019-01-01',
  });
  joinerId = await harness.createEmployee({
    code: `JB-J-${runId}`,
    firstName: 'Jaya',
    // Half of a 30-day April.
    dateOfJoining: '2024-04-16',
  });
  leaverId = await harness.createEmployee({
    code: `JB-L-${runId}`,
    firstName: 'Latha',
    dateOfJoining: '2019-01-01',
    dateOfLeaving: '2024-03-31',
    status: 'INACTIVE',
  });

  monthlyTypeId = await createType({
    name: 'Job Probe Monthly',
    code: `JM${runId}`,
    accrualMethod: 'MONTHLY',
    annualEntitlement: 12,
  });
  cappedTypeId = await createType({
    name: 'Job Probe Capped',
    code: `JC${runId}`,
    accrualMethod: 'NONE',
    annualEntitlement: 0,
    carryForwardAllowed: true,
    carryForwardCap: 5,
  });
  compOffTypeId = await createType({
    name: 'Job Probe Comp Off',
    code: `JO${runId}`,
    accrualMethod: 'NONE',
    annualEntitlement: 0,
  });

  accrue = harness.resolve(AccrueLeaveHandler);
  carryForward = harness.resolve(CarryForwardLeaveHandler);
  expireCompOff = harness.resolve(ExpireCompOffHandler);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('accrual (REQ-G-05)', () => {
  /*
   * 30s on this test and the first carry-forward, not vitest's default 5:
   * both jobs sweep every organisation, and the shared dev database now
   * holds a hundred-plus of them with three-quarters of a million ledger
   * rows, so the first heavy run crosses 5s on data volume alone. At 5s the
   * pair fails in a way that reads as an accrual bug — the exact
   * misdirection `exclusive-run.ts` documents sending three sessions
   * chasing. The later runs in each describe reuse warmed state and stay
   * fast; the assertions are untouched.
   */
  it('posts one month of a monthly entitlement, pro-rated for a joiner', async () => {
    const result = await accrue.run(
      { requestedAt: new Date().toISOString(), month: ACCRUAL_MONTH },
      CONTEXT,
    );
    expect(result.month).toBe(ACCRUAL_MONTH);
    expect(Number(result.posted)).toBeGreaterThan(0);

    // 12 / 12 months, whole month served.
    const veteran = await balanceRow(veteranId, monthlyTypeId, LEAVE_YEAR);
    expect(veteran?.accrued).toBe(1);
    expect(veteran?.closing).toBe(1);

    // Joined on 16 April: 15 of April's 30 days, so half a month's share.
    const joiner = await balanceRow(joinerId, monthlyTypeId, LEAVE_YEAR);
    expect(joiner?.accrued).toBe(0.5);

    // Left before the period opened, so nothing at all -- not a zero row.
    expect(await balanceRow(leaverId, monthlyTypeId, LEAVE_YEAR)).toBeNull();
    expect(await countLedger(leaverId, monthlyTypeId)).toBe(0);
  }, 30_000);

  it('posts nothing the second time, because the ledger cannot take one back', async () => {
    const before = await countLedger(veteranId, monthlyTypeId);

    const result = await accrue.run(
      { requestedAt: new Date().toISOString(), month: ACCRUAL_MONTH },
      CONTEXT,
    );
    expect(result.posted).toBe(0);
    expect(Number(result.alreadyPosted)).toBeGreaterThan(0);

    expect(await countLedger(veteranId, monthlyTypeId)).toBe(before);
    expect((await balanceRow(veteranId, monthlyTypeId, LEAVE_YEAR))?.accrued).toBe(1);
  });

  it('treats a different month as a different posting', async () => {
    const result = await accrue.run(
      { requestedAt: new Date().toISOString(), month: '2024-05' },
      CONTEXT,
    );
    expect(Number(result.posted)).toBeGreaterThan(0);
    expect((await balanceRow(veteranId, monthlyTypeId, LEAVE_YEAR))?.accrued).toBe(2);
    // The joiner served all of May, so a whole month's share this time.
    expect((await balanceRow(joinerId, monthlyTypeId, LEAVE_YEAR))?.accrued).toBe(1.5);
  });

  it('derives the month from the clock when none is given', async () => {
    // The scheduler runs on the 1st and must accrue the month that ended.
    const result = await accrue.run({ requestedAt: '2024-07-01T01:30:00.000Z' }, CONTEXT);
    expect(result.month).toBe('2024-06');
  });

  it('refuses a malformed month rather than accruing something plausible', async () => {
    await expect(
      accrue.run({ requestedAt: new Date().toISOString(), month: '2024-13' }, CONTEXT),
    ).rejects.toThrow(/not a real month/u);
    await expect(
      accrue.run({ requestedAt: new Date().toISOString(), month: 'June' }, CONTEXT),
    ).rejects.toThrow(/YYYY-MM/u);
  });

  it('leaves every balance it wrote reconcilable against its ledger', async () => {
    for (const employeeId of [veteranId, joinerId]) {
      const balance = await balanceRow(employeeId, monthlyTypeId, LEAVE_YEAR);
      expect(balance).not.toBeNull();
      if (balance === null) continue;
      expect(isLeaveBalanceConsistent(balance)).toBe(true);
    }
  });
});

describe('carry forward (REQ-G-01)', () => {
  it('does nothing on a day that opens nobody s leave year', async () => {
    const result = await carryForward.run({ requestedAt: '2025-06-15T02:00:00.000Z' }, CONTEXT);
    expect(result.organisations).toBe(0);
    expect(result.carried).toBe(0);
  });

  it('splits the closing balance into a carry and a lapse, at the cap', async () => {
    // 8 days standing in the closing year, on a type capped at 5.
    const repository = new LeaveRepository(harness.db, { orgId: ORG_ID, actorUserId: null });
    await repository.appendLedger([
      {
        employeeId: veteranId,
        leaveTypeId: cappedTypeId,
        leaveYear: LEAVE_YEAR,
        movementType: 'OPENING',
        days: 8,
        note: 'Fixture opening balance',
      },
    ]);
    await repository.upsertBalance(veteranId, cappedTypeId, LEAVE_YEAR, {
      opening: 8,
      accrued: 0,
      availed: 0,
      adjusted: 0,
      carriedForward: 0,
      closing: 8,
    });

    const result = await carryForward.run(
      { requestedAt: `${NEXT_YEAR_OPENS}T02:00:00.000Z` },
      CONTEXT,
    );
    expect(Number(result.organisations)).toBeGreaterThan(0);

    const closingYear = await balanceRow(veteranId, cappedTypeId, LEAVE_YEAR);
    const openingYear = await balanceRow(veteranId, cappedTypeId, LEAVE_YEAR + 1);

    // 5 carried, 3 lapsed, and the closing year is emptied by the pair.
    expect(openingYear?.carriedForward).toBe(5);
    expect(openingYear?.closing).toBe(5);
    expect(closingYear?.carriedForward).toBe(-5);
    expect(closingYear?.adjusted).toBe(-3);
    expect(closingYear?.closing).toBe(0);

    // Nothing was created or destroyed at the boundary.
    expect(closingYear).not.toBeNull();
    expect(openingYear).not.toBeNull();
    if (closingYear === null || openingYear === null) return;
    expect(isLeaveBalanceConsistent(closingYear)).toBe(true);
    expect(isLeaveBalanceConsistent(openingYear)).toBe(true);
    // 30s for the same data-volume reason as the first accrual run above.
  }, 30_000);

  it('carries nothing a second time', async () => {
    const before = await countLedger(veteranId, cappedTypeId);

    const result = await carryForward.run(
      { requestedAt: `${NEXT_YEAR_OPENS}T02:00:00.000Z` },
      CONTEXT,
    );
    // The handler still visits the organisation -- the date is still the
    // boundary -- but the unique index refuses every row it tries to post.
    expect(Number(result.organisations)).toBeGreaterThan(0);
    expect(await countLedger(veteranId, cappedTypeId)).toBe(before);

    const openingYear = await balanceRow(veteranId, cappedTypeId, LEAVE_YEAR + 1);
    expect(openingYear?.carriedForward).toBe(5);
  });

  it('lapses the whole balance for a type that cannot carry forward', async () => {
    // Three months were accrued above -- April, May, and the June the clock
    // test posted -- at one day each, and the monthly type allows no carry
    // forward, so the whole three lapse.
    const closingYear = await balanceRow(veteranId, monthlyTypeId, LEAVE_YEAR);
    expect(closingYear?.accrued).toBe(3);
    expect(closingYear?.adjusted).toBe(-3);
    expect(closingYear?.closing).toBe(0);
    expect(await balanceRow(veteranId, monthlyTypeId, LEAVE_YEAR + 1)).toBeNull();
  });
});

describe('comp-off expiry (REQ-G-11)', () => {
  const earnedFor = '2024-02-10';
  let creditId = '';
  let soonCreditId = '';

  it('lapses a credit whose expiry has passed, and posts the LAPSE row', async () => {
    const repository = new LeaveRepository(harness.db, { orgId: ORG_ID, actorUserId: null });

    creditId = await repository.insertCompOff({
      employeeId: joinerId,
      leaveTypeId: compOffTypeId,
      earnedForDate: earnedFor,
      days: 1,
      expiresOn: addDays(earnedFor, 30),
    });
    await repository.appendLedger([
      {
        employeeId: joinerId,
        leaveTypeId: compOffTypeId,
        leaveYear: 2023,
        movementType: 'ACCRUAL',
        days: 1,
        referenceType: 'comp_off_credit',
        referenceId: creditId,
      },
    ]);
    await repository.upsertBalance(joinerId, compOffTypeId, 2023, {
      opening: 0,
      accrued: 1,
      availed: 0,
      adjusted: 0,
      carriedForward: 0,
      closing: 1,
    });

    const result = await expireCompOff.run({ requestedAt: '2024-05-01T03:30:00.000Z' }, CONTEXT);
    expect(Number(result.lapsed)).toBeGreaterThan(0);

    const balance = await balanceRow(joinerId, compOffTypeId, 2023);
    expect(balance).not.toBeNull();
    if (balance === null) return;
    expect(balance.adjusted).toBe(-1);
    expect(balance.closing).toBe(0);
    expect(isLeaveBalanceConsistent(balance)).toBe(true);

    // REQ-G-11: it appears on a report rather than vanishing.
    const rows = await harness.db
      .select({ lapsedAt: compOffCredits.lapsedAt })
      .from(compOffCredits)
      .where(eq(compOffCredits.id, creditId));
    expect(rows[0]?.lapsedAt).not.toBeNull();
  });

  it('lapses nothing the second time', async () => {
    const before = await countLedger(joinerId, compOffTypeId);
    const result = await expireCompOff.run({ requestedAt: '2024-05-02T03:30:00.000Z' }, CONTEXT);
    expect(result.lapsed).toBe(0);
    expect(await countLedger(joinerId, compOffTypeId)).toBe(before);
  });

  it('warns at seven days and again at two, and not twice at the same threshold', async () => {
    const repository = new LeaveRepository(harness.db, { orgId: ORG_ID, actorUserId: null });
    soonCreditId = await repository.insertCompOff({
      employeeId: veteranId,
      leaveTypeId: compOffTypeId,
      earnedForDate: '2024-06-01',
      days: 1,
      expiresOn: '2024-07-01',
    });

    async function warnedDays(): Promise<number | null> {
      const rows = await harness.db
        .select({ value: compOffCredits.expiryWarnedDays })
        .from(compOffCredits)
        .where(eq(compOffCredits.id, soonCreditId));
      return rows[0]?.value ?? null;
    }

    // Eight days out: outside every threshold.
    let result = await expireCompOff.run({ requestedAt: '2024-06-23T03:30:00.000Z' }, CONTEXT);
    expect(result.warned).toBe(0);
    expect(await warnedDays()).toBeNull();

    // Six days out: inside the seven-day threshold.
    result = await expireCompOff.run({ requestedAt: '2024-06-25T03:30:00.000Z' }, CONTEXT);
    expect(result.warned).toBe(1);
    expect(await warnedDays()).toBe(7);

    // Five days out: still the same threshold, so nothing more is sent.
    result = await expireCompOff.run({ requestedAt: '2024-06-26T03:30:00.000Z' }, CONTEXT);
    expect(result.warned).toBe(0);
    expect(await warnedDays()).toBe(7);

    // One day out: the nearer threshold, so it goes again.
    result = await expireCompOff.run({ requestedAt: '2024-06-30T03:30:00.000Z' }, CONTEXT);
    expect(result.warned).toBe(1);
    expect(await warnedDays()).toBe(2);
  });

  it('audits the sweep, because a job has no request to enrich', async () => {
    expect(await harness.waitForAuditAction('comp_off.lapsed')).toBe(true);
  });
});

describe('the fixture is not silently empty', () => {
  it('has the three employees the assertions above depend on', async () => {
    const rows = await harness.db
      .select({ value: sql<number>`count(*)::int` })
      .from(employees)
      .where(and(eq(employees.orgId, ORG_ID), sql`${employees.employeeCode} LIKE ${`JB-%-${runId}`}`));
    expect(rows[0]?.value).toBe(3);
  });
});
