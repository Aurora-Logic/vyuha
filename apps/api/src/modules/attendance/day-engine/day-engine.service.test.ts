import { uuidv7 } from '@vyuha/shared';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service.js';
import { env } from '../../../platform/common/env.js';
import type { Database } from '../../../platform/db/db.provider.js';
import {
  auditLogs,
  employees,
  files,
  locations,
  organizations,
  settings,
} from '../../../platform/db/schema/index.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import {
  attendanceAdjustments,
  attendanceDays,
  attendancePeriodLocks,
  holidayCalendars,
  holidays,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  punches,
  shiftAssignments,
  shifts,
  weeklyOffPatterns,
} from '../schema/index.js';
import { DayEngine } from './day-engine.service.js';
import { DayEngineRepository, SETTING_KEYS } from './day-engine.repository.js';

/**
 * The engine against real rows, real SQL and the real constraints.
 *
 * Everything runs inside one transaction that is rolled back at the end. That
 * is not tidiness: `punches` is append-only (REQ-D-12), so a test that inserted
 * one could not clean up after itself without dropping the very trigger the
 * suite exists to verify. A rollback leaves nothing behind and weakens nothing.
 *
 * The rows the `computeDayResult` table already covers are not repeated here.
 * What is tested is the part that only exists once a database is involved: the
 * roster and timezone resolution, the period lock, the write-only-if-changed
 * rule, and the two constraints migration 0004 adds by hand.
 */

const ORG_ID = uuidv7();
const LOCATION_ID = uuidv7();
const DAY_SHIFT_ID = uuidv7();
const NIGHT_SHIFT_ID = uuidv7();
const PATTERN_ID = uuidv7();
const CALENDAR_ID = uuidv7();
const EMPLOYEE_ID = uuidv7();
/** Has no default shift and no roster row: the misconfiguration case. */
const SHIFTLESS_EMPLOYEE_ID = uuidv7();
const PHOTO_ID = uuidv7();
/** REQ-D-03a: every punch points at a full image and a 256px thumbnail. */
const THUMB_ID = uuidv7();
const LEAVE_TYPE_ID = uuidv7();

const ctx: OrgContext = { orgId: ORG_ID, actorUserId: null };

let pool: Pool;
let client: PoolClient;
let db: Database;
let engine: DayEngine;

/** Asia/Kolkata, from `organizations.timezone`. */
const OFFSET = '+05:30';
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${OFFSET}`);

const NORMAL_DAY = '2026-03-10';
const CHANGING_DAY = '2026-03-11';
const NIGHT_DAY = '2026-03-13';
const SUNDAY = '2026-03-08';
const HOLIDAY = '2026-03-16';
const LEAVE_DAY = '2026-03-17';
const CAPPED_DAY = '2026-03-18';
const ADJUSTED_DAY = '2026-03-19';
const LOCKED_DAY = '2026-04-06';

/** After every window in the fixture has closed. */
const AFTER_HOURS = at('2026-04-30', '23:00');

let punchSequence = 0;
async function insertPunch(options: {
  employeeId?: string;
  date: string;
  type: 'IN' | 'OUT';
  at: Date;
  source?: 'WEB' | 'MOBILE' | 'OFFLINE_SYNC';
}): Promise<string> {
  punchSequence += 1;
  const rows = await db
    .insert(punches)
    .values({
      orgId: ORG_ID,
      employeeId: options.employeeId ?? EMPLOYEE_ID,
      attendanceDate: options.date,
      punchType: options.type,
      serverTime: options.at,
      photoFileId: PHOTO_ID,
      thumbnailFileId: THUMB_ID,
      source: options.source ?? 'MOBILE',
      idempotencyKey: `test-${String(punchSequence)}`,
    })
    .returning({ id: punches.id });

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('punch fixture insert returned no row');
  return id;
}

/** The tuple version. It changes if and only if the row was rewritten. */
async function rowVersion(attendanceDayId: string): Promise<string> {
  const result = await db.execute<{ xmin: string; snapshot: string }>(
    sql`SELECT xmin::text AS xmin, to_jsonb(d.*)::text AS snapshot
          FROM attendance_days d WHERE id = ${attendanceDayId}`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`attendance_days row ${attendanceDayId} not found`);
  return `${row.xmin}|${row.snapshot}`;
}

async function auditCount(entityId: string): Promise<number> {
  const rows = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.orgId, ORG_ID), eq(auditLogs.entityId, entityId)));
  return rows[0]?.value ?? 0;
}

/**
 * Runs a statement expected to be refused, inside a savepoint so the failure
 * does not poison the surrounding transaction, and returns the Postgres error.
 */
async function expectRefused(statement: string): Promise<Error> {
  await client.query('SAVEPOINT probe');
  let thrown: unknown;
  try {
    await client.query(statement);
  } catch (error: unknown) {
    thrown = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT probe');
  await client.query('RELEASE SAVEPOINT probe');

  if (!(thrown instanceof Error)) {
    throw new Error(`Postgres accepted a statement it must refuse: ${statement}`);
  }
  return thrown;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });

  // The compose file publishes 55432. A Homebrew Postgres answering on 5432
  // would let every assertion below pass against the wrong schema.
  expect(new URL(env.DATABASE_URL).port).toBe('55432');

  client = await pool.connect();
  await client.query('BEGIN');
  db = drizzle(client);

  await db.insert(organizations).values({ id: ORG_ID, name: 'Day Engine Test Org' });
  await db.insert(locations).values({
    id: LOCATION_ID,
    orgId: ORG_ID,
    name: 'Test Office',
    code: `HO-${ORG_ID.slice(-8)}`,
    // Null on purpose: the engine must fall back to the organisation timezone.
    timezone: null,
  });

  // The general shift's real timings are still unanswered (OPEN-QUESTIONS
  // item 2). These are fixtures, not defaults; the policy numbers around them
  // are REQ-C-01's stated defaults and are left to the column defaults.
  await db.insert(shifts).values([
    {
      id: DAY_SHIFT_ID,
      orgId: ORG_ID,
      name: 'Test Day',
      code: 'TDAY',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    },
    {
      id: NIGHT_SHIFT_ID,
      orgId: ORG_ID,
      name: 'Test Night',
      code: 'TNIGHT',
      startTime: '22:00:00',
      endTime: '06:00:00',
      crossesMidnight: true,
      breakMinutes: 60,
    },
  ]);

  await db.insert(weeklyOffPatterns).values({
    id: PATTERN_ID,
    orgId: ORG_ID,
    name: 'Sundays off',
    config: { weekdays: [7] },
  });

  await db
    .insert(holidayCalendars)
    .values({ id: CALENDAR_ID, orgId: ORG_ID, name: 'Test Calendar', year: 2026 });
  await db.insert(holidays).values({
    orgId: ORG_ID,
    calendarId: CALENDAR_ID,
    date: HOLIDAY,
    name: 'Test Holiday',
  });

  await db.insert(employees).values([
    {
      id: EMPLOYEE_ID,
      orgId: ORG_ID,
      employeeCode: `E-${ORG_ID.slice(-8)}`,
      firstName: 'Test',
      dateOfJoining: '2026-01-01',
      locationId: LOCATION_ID,
      defaultShiftId: DAY_SHIFT_ID,
      weeklyOffPatternId: PATTERN_ID,
      holidayCalendarId: CALENDAR_ID,
    },
    {
      id: SHIFTLESS_EMPLOYEE_ID,
      orgId: ORG_ID,
      employeeCode: `X-${ORG_ID.slice(-8)}`,
      firstName: 'Unrostered',
      dateOfJoining: '2026-01-01',
      locationId: LOCATION_ID,
    },
  ]);

  await db.insert(files).values([
    {
      id: PHOTO_ID,
      orgId: ORG_ID,
      storageKey: `test/${ORG_ID}/photo.jpg`,
      mime: 'image/jpeg',
      bytes: 1024,
      checksum: 'test-checksum',
      purpose: 'PUNCH_PHOTO',
    },
    {
      id: THUMB_ID,
      orgId: ORG_ID,
      storageKey: `test/${ORG_ID}/photo_thumb.jpg`,
      mime: 'image/jpeg',
      bytes: 256,
      checksum: 'test-checksum-thumb',
      purpose: 'PUNCH_PHOTO_THUMB',
    },
  ]);

  await db
    .insert(leaveTypes)
    .values({ id: LEAVE_TYPE_ID, orgId: ORG_ID, name: 'Test Casual', code: 'TCL' });

  engine = new DayEngine(new DayEngineRepository(db, ctx), new AuditService(db), ctx);
});

afterAll(async () => {
  // Nothing written by this file survives. `punches` cannot be deleted
  // (REQ-D-12), so a rollback is the only cleanup that does not require
  // dismantling the guarantee under test.
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
});

describe('DayEngine against Postgres', () => {
  it('resolves the shift, converts its wall clock through the location timezone, and writes one row', async () => {
    await insertPunch({ date: NORMAL_DAY, type: 'IN', at: at(NORMAL_DAY, '09:00') });
    await insertPunch({ date: NORMAL_DAY, type: 'OUT', at: at(NORMAL_DAY, '18:00') });

    const result = await engine.computeDay(EMPLOYEE_ID, NORMAL_DAY, { now: AFTER_HOURS });

    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;

    expect(result.day.status).toBe('PRESENT');
    expect(result.day.workedMinutes).toBe(480);
    expect(result.day.shiftId).toBe(DAY_SHIFT_ID);
    // 09:00 Asia/Kolkata, resolved by Postgres from the shift's `time` column.
    // The location has no timezone of its own, so this also proves the fallback
    // to `organizations.timezone` rather than to the server's zone.
    expect(result.day.scheduledIn.toISOString()).toBe('2026-03-10T03:30:00.000Z');
    expect(result.day.scheduledOut.toISOString()).toBe('2026-03-10T12:30:00.000Z');

    const stored = await db
      .select()
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, EMPLOYEE_ID), eq(attendanceDays.date, NORMAL_DAY)));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('PRESENT');
    expect(stored[0]?.workedMinutes).toBe(480);
  });

  it('writes nothing on a recompute of an unchanged day (REQ-E-06)', async () => {
    const first = await engine.computeDay(EMPLOYEE_ID, NORMAL_DAY, { now: AFTER_HOURS });
    expect(first.outcome).toBe('unchanged');
    if (first.outcome === 'locked') return;

    const before = await rowVersion(first.attendanceDayId);
    const auditsBefore = await auditCount(first.attendanceDayId);

    // A different `now` on the second run, so the assertion cannot pass merely
    // because the two calls were identical.
    const second = await engine.computeDay(EMPLOYEE_ID, NORMAL_DAY, {
      now: new Date(AFTER_HOURS.getTime() + 3_600_000),
    });
    expect(second.outcome).toBe('unchanged');

    // xmin is the tuple version. Identical means no UPDATE ran at all, which is
    // stronger than "the columns hold the same values": a row rewritten with
    // the same values would still move `updated_at` and `computed_at`.
    expect(await rowVersion(first.attendanceDayId)).toBe(before);
    // Step 11: "write audit entry only if the row materially changed".
    expect(await auditCount(first.attendanceDayId)).toBe(auditsBefore);
  });

  it('rewrites the row and audits it when a punch changes the day', async () => {
    const inPunch = await insertPunch({
      date: CHANGING_DAY,
      type: 'IN',
      at: at(CHANGING_DAY, '09:00'),
    });

    const pending = await engine.computeDay(EMPLOYEE_ID, CHANGING_DAY, { now: AFTER_HOURS });
    expect(pending.outcome).toBe('written');
    if (pending.outcome !== 'written') return;
    expect(pending.day.status).toBe('PENDING');
    expect(pending.day.flags).toEqual(['missing_punch']);
    expect(pending.day.firstInPunchId).toBe(inPunch);

    const versionBefore = await rowVersion(pending.attendanceDayId);
    const auditsBefore = await auditCount(pending.attendanceDayId);

    await insertPunch({ date: CHANGING_DAY, type: 'OUT', at: at(CHANGING_DAY, '18:00') });
    const closed = await engine.computeDay(EMPLOYEE_ID, CHANGING_DAY, { now: AFTER_HOURS });

    expect(closed.outcome).toBe('written');
    if (closed.outcome !== 'written') return;
    expect(closed.day.status).toBe('PRESENT');
    expect(closed.day.workedMinutes).toBe(480);
    expect(closed.attendanceDayId).toBe(pending.attendanceDayId);
    expect(await rowVersion(pending.attendanceDayId)).not.toBe(versionBefore);
    expect(await auditCount(pending.attendanceDayId)).toBe(auditsBefore + 1);
  });

  it('attributes a midnight-crossing shift to its start date (REQ-C-02)', async () => {
    await db.insert(shiftAssignments).values({
      orgId: ORG_ID,
      employeeId: EMPLOYEE_ID,
      shiftId: NIGHT_SHIFT_ID,
      effectiveFrom: NIGHT_DAY,
      effectiveTo: NIGHT_DAY,
    });

    await insertPunch({ date: NIGHT_DAY, type: 'IN', at: at(NIGHT_DAY, '21:50') });
    // The next calendar day, but the same attendance date.
    await insertPunch({ date: NIGHT_DAY, type: 'OUT', at: at('2026-03-14', '07:00') });

    const result = await engine.computeDay(EMPLOYEE_ID, NIGHT_DAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;

    expect(result.day.shiftId).toBe(NIGHT_SHIFT_ID);
    // scheduled_out lands on the following date because `crosses_midnight` is
    // set -- computed by Postgres, not by adding 24 hours in JavaScript.
    expect(result.day.scheduledIn.toISOString()).toBe('2026-03-13T16:30:00.000Z');
    expect(result.day.scheduledOut.toISOString()).toBe('2026-03-14T00:30:00.000Z');
    expect(result.day.status).toBe('PRESENT');
    expect(result.day.workedMinutes).toBe(490);
  });

  it('falls back to the default shift on a date the roster does not cover', async () => {
    // The night assignment above covers one day only, and this is not it.
    const result = await engine.computeDay(EMPLOYEE_ID, CAPPED_DAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;
    expect(result.day.shiftId).toBe(DAY_SHIFT_ID);
  });

  it('reads the weekly off pattern from the employee row (REQ-C-03)', async () => {
    const result = await engine.computeDay(EMPLOYEE_ID, SUNDAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;
    expect(result.day.status).toBe('WEEKLY_OFF');
  });

  it('reads the holiday from the calendar the employee is attached to (REQ-H-01)', async () => {
    const result = await engine.computeDay(EMPLOYEE_ID, HOLIDAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;
    expect(result.day.status).toBe('HOLIDAY');
  });

  it('reads approved leave and records the request on the day (REQ-G-06)', async () => {
    const requestRows = await db
      .insert(leaveRequests)
      .values({
        orgId: ORG_ID,
        employeeId: EMPLOYEE_ID,
        leaveTypeId: LEAVE_TYPE_ID,
        fromDate: LEAVE_DAY,
        toDate: LEAVE_DAY,
        totalDays: 1,
        status: 'APPROVED',
      })
      .returning({ id: leaveRequests.id });
    const requestId = requestRows[0]?.id;
    expect(requestId).toBeDefined();
    if (requestId === undefined) return;

    await db
      .insert(leaveRequestDays)
      .values({ orgId: ORG_ID, leaveRequestId: requestId, date: LEAVE_DAY, portion: 'FULL' });

    const result = await engine.computeDay(EMPLOYEE_ID, LEAVE_DAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;
    expect(result.day.status).toBe('ON_LEAVE');
    expect(result.day.leaveRequestId).toBe(requestId);
  });

  it('applies an approved adjustment over the punches without touching them (REQ-F-03)', async () => {
    const inPunch = await insertPunch({
      date: ADJUSTED_DAY,
      type: 'IN',
      at: at(ADJUSTED_DAY, '09:00'),
    });
    await db.insert(attendanceAdjustments).values({
      orgId: ORG_ID,
      employeeId: EMPLOYEE_ID,
      attendanceDate: ADJUSTED_DAY,
      adjustedOut: at(ADJUSTED_DAY, '18:00'),
      reason: 'Forgot to punch out',
    });

    const result = await engine.computeDay(EMPLOYEE_ID, ADJUSTED_DAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;
    expect(result.day.status).toBe('PRESENT');
    expect(result.day.workedMinutes).toBe(480);
    // The original punch is untouched and still referenced.
    expect(result.day.firstInPunchId).toBe(inPunch);
    expect(result.day.lastOutPunchId).toBeNull();
  });

  it('takes the worked-minutes cap from settings, not from a constant (REQ-E-03)', async () => {
    await insertPunch({ date: CAPPED_DAY, type: 'IN', at: at(CAPPED_DAY, '09:00') });
    await insertPunch({ date: CAPPED_DAY, type: 'OUT', at: at(CAPPED_DAY, '22:00') });

    const uncapped = await engine.computeDay(EMPLOYEE_ID, CAPPED_DAY, { now: AFTER_HOURS });
    expect(uncapped.outcome).toBe('written');
    if (uncapped.outcome !== 'written') return;
    // 13 hours less the hour of break, under the 16-hour default.
    expect(uncapped.day.workedMinutes).toBe(720);

    await db.insert(settings).values({
      orgId: ORG_ID,
      scope: 'ORG',
      key: SETTING_KEYS.maxWorkMinutes,
      value: 600,
    });

    const capped = await engine.computeDay(EMPLOYEE_ID, CAPPED_DAY, { now: AFTER_HOURS });
    expect(capped.outcome).toBe('written');
    if (capped.outcome !== 'written') return;
    expect(capped.day.workedMinutes).toBe(600);

    // Left behind, it would silently cap every later test in this file.
    await db
      .delete(settings)
      .where(and(eq(settings.orgId, ORG_ID), eq(settings.key, SETTING_KEYS.maxWorkMinutes)));
  });

  it('refuses a malformed setting rather than falling back to the default', async () => {
    await db.insert(settings).values({
      orgId: ORG_ID,
      scope: 'ORG',
      key: SETTING_KEYS.maxWorkMinutes,
      value: 'sixteen hours',
    });

    await expect(engine.computeDay(EMPLOYEE_ID, CAPPED_DAY, { now: AFTER_HOURS })).rejects.toThrow(
      /not a positive whole number/u,
    );

    await db
      .delete(settings)
      .where(and(eq(settings.orgId, ORG_ID), eq(settings.key, SETTING_KEYS.maxWorkMinutes)));
  });

  it('keeps the status a manual override pinned, and recomputes everything else (REQ-E-08)', async () => {
    const before = await db
      .select({ id: attendanceDays.id })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, EMPLOYEE_ID), eq(attendanceDays.date, NORMAL_DAY)));
    const dayId = before[0]?.id;
    expect(dayId).toBeDefined();
    if (dayId === undefined) return;

    // What the HR override screen will do: set the status and the reason.
    await db
      .update(attendanceDays)
      .set({
        status: 'ON_DUTY',
        isManualOverride: true,
        overrideReason: 'Client visit, agreed with the manager',
        overrideAt: AFTER_HOURS,
      })
      .where(eq(attendanceDays.id, dayId));

    const result = await engine.computeDay(EMPLOYEE_ID, NORMAL_DAY, { now: AFTER_HOURS });
    expect(result.outcome).toBe('written');
    if (result.outcome !== 'written') return;

    expect(result.day.status).toBe('ON_DUTY');
    expect(result.day.isManualOverride).toBe(true);
    expect(result.day.flags).toContain('manual_override');
    // The hours are still measured: an override is a decision about status, not
    // an instruction to stop counting.
    expect(result.day.workedMinutes).toBe(480);

    const stored = await db
      .select({ status: attendanceDays.status, reason: attendanceDays.overrideReason })
      .from(attendanceDays)
      .where(eq(attendanceDays.id, dayId));
    expect(stored[0]?.status).toBe('ON_DUTY');
    // The engine does not own the reason and must not clear it.
    expect(stored[0]?.reason).toBe('Client visit, agreed with the manager');
  });

  it('does not touch a locked period (REQ-E-09)', async () => {
    await insertPunch({ date: LOCKED_DAY, type: 'IN', at: at(LOCKED_DAY, '09:00') });
    await insertPunch({ date: LOCKED_DAY, type: 'OUT', at: at(LOCKED_DAY, '18:00') });

    // Unlocked first, so the "locked" assertion below cannot pass merely
    // because nothing would have been written anyway.
    const open = await engine.computeDay(EMPLOYEE_ID, LOCKED_DAY, { now: AFTER_HOURS });
    expect(open.outcome).toBe('written');
    if (open.outcome !== 'written') return;
    const versionBefore = await rowVersion(open.attendanceDayId);

    await db.insert(attendancePeriodLocks).values({
      orgId: ORG_ID,
      locationId: null,
      year: 2026,
      month: 4,
      lockReason: 'Month closed for payroll input',
    });

    // A change that would certainly rewrite the row if it were considered.
    await insertPunch({ date: LOCKED_DAY, type: 'OUT', at: at(LOCKED_DAY, '19:30') });

    const locked = await engine.computeDay(EMPLOYEE_ID, LOCKED_DAY, { now: AFTER_HOURS });
    expect(locked.outcome).toBe('locked');
    expect(await rowVersion(open.attendanceDayId)).toBe(versionBefore);

    // Lifting the lock lets the same recompute through, which proves the lock
    // was the reason and not something else about the date.
    await db
      .update(attendancePeriodLocks)
      // REQ-E-09: reopening carries a reason, and the database keeps that.
      .set({ unlockedAt: AFTER_HOURS, unlockReason: 'Reopened for the engine fixture' })
      .where(and(eq(attendancePeriodLocks.orgId, ORG_ID), eq(attendancePeriodLocks.month, 4)));

    const reopened = await engine.computeDay(EMPLOYEE_ID, LOCKED_DAY, { now: AFTER_HOURS });
    expect(reopened.outcome).toBe('written');
    expect(await rowVersion(open.attendanceDayId)).not.toBe(versionBefore);
  });

  it('refuses to guess when an employee has no shift for the date (REQ-C-01)', async () => {
    // Marking the day ABSENT would read as a fact about the employee rather
    // than a fact about the configuration, and every policy threshold the
    // engine applies lives on the shift row.
    await expect(
      engine.computeDay(SHIFTLESS_EMPLOYEE_ID, NORMAL_DAY, { now: AFTER_HOURS }),
    ).rejects.toThrow(/no shift for this date/u);
  });

  it('refuses an employee from another organisation', async () => {
    await expect(engine.computeDay(uuidv7(), NORMAL_DAY, { now: AFTER_HOURS })).rejects.toThrow(
      /not found/u,
    );
  });

  it('refuses a date that is not a date', async () => {
    await expect(engine.computeDay(EMPLOYEE_ID, '10-03-2026')).rejects.toThrow(/YYYY-MM-DD/u);
  });
});

describe('the constraints migration 0004 adds by hand', () => {
  it('makes overlapping roster assignments impossible (REQ-C-04)', async () => {
    // The fixture already holds 2026-03-13 .. 2026-03-13 for this employee.
    const error = await expectRefused(`
      INSERT INTO shift_assignments (org_id, employee_id, shift_id, effective_from, effective_to)
      VALUES ('${ORG_ID}', '${EMPLOYEE_ID}', '${NIGHT_SHIFT_ID}', '2026-03-13', '2026-03-20')
    `);
    expect(error.message).toMatch(/exclusion constraint "shift_assignments_no_overlap"/u);

    // And a range that only touches the inclusive end date still conflicts,
    // which the half-open default would have allowed.
    const boundary = await expectRefused(`
      INSERT INTO shift_assignments (org_id, employee_id, shift_id, effective_from, effective_to)
      VALUES ('${ORG_ID}', '${EMPLOYEE_ID}', '${NIGHT_SHIFT_ID}', '2026-03-13', NULL)
    `);
    expect(boundary.message).toMatch(/shift_assignments_no_overlap/u);
  });

  it('accepts an adjacent range, so the constraint is not simply refusing everything', async () => {
    await client.query('SAVEPOINT adjacent');
    await client.query(`
      INSERT INTO shift_assignments (org_id, employee_id, shift_id, effective_from, effective_to)
      VALUES ('${ORG_ID}', '${EMPLOYEE_ID}', '${NIGHT_SHIFT_ID}', '2026-03-14', '2026-03-20')
    `);
    await client.query('ROLLBACK TO SAVEPOINT adjacent');
    await client.query('RELEASE SAVEPOINT adjacent');
  });

  it.each([
    ['UPDATE', `UPDATE punches SET reason = 'edited' WHERE org_id = '${ORG_ID}'`],
    ['DELETE', `DELETE FROM punches WHERE org_id = '${ORG_ID}'`],
    // Statement-level, so a DELETE matching nothing is refused too: a statement
    // that succeeds because the table happened to be empty teaches the wrong
    // lesson.
    ['DELETE matching no rows', `DELETE FROM punches WHERE id = '${uuidv7()}'`],
    ['TRUNCATE', 'TRUNCATE TABLE punches CASCADE'],
  ])('refuses %s on punches (REQ-D-12)', async (_label, statement) => {
    const error = await expectRefused(statement);
    expect(error.message).toMatch(/Table punches is append-only/u);
  });

  it('refuses to mutate the leave ledger (REQ-G-03)', async () => {
    const error = await expectRefused(`DELETE FROM leave_ledger WHERE org_id = '${ORG_ID}'`);
    expect(error.message).toMatch(/Table leave_ledger is append-only/u);
  });

  it('keeps one attendance_days row per employee per date (REQ-E-01)', async () => {
    const error = await expectRefused(`
      INSERT INTO attendance_days (org_id, employee_id, date, status)
      VALUES ('${ORG_ID}', '${EMPLOYEE_ID}', '${NORMAL_DAY}', 'ABSENT')
    `);
    expect(error.message).toMatch(/attendance_days_employee_date_uq/u);
  });

  it('refuses a manual override with no reason (REQ-E-08)', async () => {
    const error = await expectRefused(`
      UPDATE attendance_days SET is_manual_override = true, override_reason = NULL
       WHERE org_id = '${ORG_ID}' AND date = '${CHANGING_DAY}'
    `);
    expect(error.message).toMatch(/attendance_days_override_has_reason/u);
  });
});
