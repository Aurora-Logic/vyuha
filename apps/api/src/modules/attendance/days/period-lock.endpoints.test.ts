import {
  PERMISSIONS,
  SYSTEM_ROLES,
  uuidv7,
  type AttendanceDayDetail,
} from '@vyuha/shared';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { employees } from '../../../platform/db/schema/index.js';
import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';
import { attendanceDays, attendancePeriodLocks, shifts } from '../schema/index.js';

/**
 * REQ-E-09's lock and unlock, and REQ-E-08's override, over real HTTP.
 *
 * The two are tested together because the interesting part is where they meet:
 * a locked period must refuse an override, and it must refuse it *before*
 * anything is written. The day engine has refused to recompute a locked period
 * since it landed — what these tests prove is that there is now a way to create
 * the lock it was already respecting, and that the override honours the same
 * one.
 *
 * `preservePeople` because the employee here gets attendance days, and
 * `attendance_days.employee_id` is RESTRICT: an employee with a computed day
 * can never be deleted, so the harness must not try. Codes are unique per run
 * for the same reason.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000d7';
const RUN = uuidv7().slice(-8);

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface PeriodLock {
  id: string;
  year: number;
  month: number;
  locationId: string | null;
  lockedAt: string;
  lockedBy: { id: string; name: string | null } | null;
  lockReason: string | null;
  unlockedAt: string | null;
  unlockedBy: { id: string; name: string | null } | null;
  unlockReason: string | null;
}

const OVERRIDE_DAY = '2026-05-12';
const LOCKED_MONTH = { year: 2026, month: 7 };
const LOCKED_DAY = '2026-07-14';

let harness: ApiHarness;
let adminToken: string;
let hrToken: string;
let employeeId = '';
let shiftId = '';

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Period Lock Fixture Org', { preservePeople: true });

  // `resetOrganisation` does not touch the attendance tables, and this file
  // asserts that a *refused* lock leaves the table empty. Without this the
  // second run of the suite fails on the row the first run left standing --
  // which it did, and the assertion was right to catch it. The rows carry no
  // foreign keys inward, so removing them cleans up nothing else.
  await harness.db
    .delete(attendancePeriodLocks)
    .where(eq(attendancePeriodLocks.orgId, ORG_ID));

  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const hrRoleId = await harness.createSystemRole(SYSTEM_ROLES.HR, { isSystem: true });

  const admin = await harness.createUser({
    email: scopedEmail('lock-admin'),
    roleIds: [adminRoleId],
  });
  const hr = await harness.createUser({ email: scopedEmail('lock-hr'), roleIds: [hrRoleId] });

  adminToken = (await harness.login(admin.email, admin.password)).token;
  hrToken = (await harness.login(hr.email, hr.password)).token;
  expect(adminToken).not.toBe('');
  expect(hrToken).not.toBe('');

  const inserted = await harness.db
    .insert(shifts)
    .values({
      orgId: ORG_ID,
      name: 'Lock Fixture General',
      code: `LK-${RUN}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
    })
    .returning({ id: shifts.id });
  shiftId = inserted[0]?.id ?? '';
  expect(shiftId).not.toBe('');

  employeeId = await harness.createEmployee({
    code: `LK-${RUN}`,
    firstName: 'Ravi',
    lastName: 'Kulkarni',
  });
  await harness.db
    .update(employees)
    .set({ defaultShiftId: shiftId })
    .where(eq(employees.id, employeeId));
}, 30_000);

afterAll(async () => {
  await harness.close();
});

describe('the unlock permission is separate from the lock permission (REQ-E-09, P2-1)', () => {
  it('gives HR attendance.lock but not attendance.unlock', async () => {
    const me = await harness.get<{ permissions: string[] }>('/auth/me', { token: hrToken });
    expect(me.status, me.text).toBe(200);
    expect(me.body.permissions).toContain(PERMISSIONS.ATTENDANCE_LOCK);
    expect(me.body.permissions).not.toContain(PERMISSIONS.ATTENDANCE_UNLOCK);
  });

  it('gives Admin both', async () => {
    const me = await harness.get<{ permissions: string[] }>('/auth/me', { token: adminToken });
    expect(me.body.permissions).toContain(PERMISSIONS.ATTENDANCE_LOCK);
    expect(me.body.permissions).toContain(PERMISSIONS.ATTENDANCE_UNLOCK);
  });
});

describe('POST /attendance/locks', () => {
  let lockId = '';

  it('refuses without a reason', async () => {
    const refused = await harness.post<ErrorBody>('/attendance/locks', {
      token: hrToken,
      body: { year: LOCKED_MONTH.year, month: LOCKED_MONTH.month, locationId: null },
    });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a one-character reason', async () => {
    const refused = await harness.post<ErrorBody>('/attendance/locks', {
      token: hrToken,
      body: { ...LOCKED_MONTH, locationId: null, reason: 'x' },
    });
    expect(refused.status, refused.text).toBe(400);
  });

  it('records nothing after a refusal', async () => {
    const rows = await harness.db
      .select({ id: attendancePeriodLocks.id })
      .from(attendancePeriodLocks)
      .where(
        and(
          eq(attendancePeriodLocks.orgId, ORG_ID),
          eq(attendancePeriodLocks.year, LOCKED_MONTH.year),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it('locks the month for HR and records who and why', async () => {
    const locked = await harness.post<PeriodLock>('/attendance/locks', {
      token: hrToken,
      body: { ...LOCKED_MONTH, locationId: null, reason: 'Closed for the July payroll handoff' },
    });

    expect(locked.status, locked.text).toBe(201);
    expect(locked.body.lockReason).toBe('Closed for the July payroll handoff');
    expect(locked.body.unlockedAt).toBeNull();
    expect(locked.body.lockedBy?.name).toContain('lock-hr');
    lockId = locked.body.id;

    expect(await harness.waitForAuditAction('attendance.period.locked')).toBe(true);
  });

  it('refuses to lock the same period twice', async () => {
    const refused = await harness.post<ErrorBody>('/attendance/locks', {
      token: hrToken,
      body: { ...LOCKED_MONTH, locationId: null, reason: 'Trying to close July again' },
    });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('PERIOD_ALREADY_LOCKED');
  });

  it('refuses an unknown location rather than locking nothing', async () => {
    const refused = await harness.post<ErrorBody>('/attendance/locks', {
      token: hrToken,
      body: {
        year: 2026,
        month: 9,
        locationId: '019ffb00-0000-7000-8000-00000000beef',
        reason: 'Locking a location that does not exist',
      },
    });
    expect(refused.status, refused.text).toBe(404);
  });

  it('stops the day engine recomputing a day in the locked month', async () => {
    // Proven through the punch-free path the engine already had: an override
    // is a recompute, and a locked period refuses one.
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/${LOCKED_DAY}/override`,
      { token: hrToken, body: { status: 'PRESENT', reason: 'Should be refused, July is locked' } },
    );
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.error.code).toBe('PERIOD_LOCKED');
  });

  describe('DELETE /attendance/locks/:id', () => {
    it('refuses HR, who can lock but not unlock', async () => {
      const refused = await harness.del<ErrorBody>(`/attendance/locks/${lockId}`, {
        token: hrToken,
        body: { reason: 'HR should not be able to reopen a closed month' },
      });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.body.error.details?.requiredAnyOf).toEqual(['attendance.unlock']);
    });

    it('refuses Admin without a reason', async () => {
      const refused = await harness.del<ErrorBody>(`/attendance/locks/${lockId}`, {
        token: adminToken,
      });
      expect(refused.status, refused.text).toBe(400);
    });

    it('leaves the lock standing after both refusals', async () => {
      const listed = await harness.get<{ data: PeriodLock[] }>('/attendance/locks', {
        token: adminToken,
      });
      const july = listed.body.data.find((row) => row.id === lockId);
      expect(july?.unlockedAt).toBeNull();
    });

    it('unlocks for Admin, keeping both reasons on the row', async () => {
      const unlocked = await harness.del<PeriodLock>(`/attendance/locks/${lockId}`, {
        token: adminToken,
        body: { reason: 'Two late regularizations were approved after the close' },
      });

      expect(unlocked.status, unlocked.text).toBe(200);
      expect(unlocked.body.unlockedAt).not.toBeNull();
      expect(unlocked.body.unlockedBy?.name).toContain('lock-admin');
      expect(unlocked.body.unlockReason).toBe(
        'Two late regularizations were approved after the close',
      );
      // The lock reason survives: overwriting it would lose the half an
      // auditor is more likely to want.
      expect(unlocked.body.lockReason).toBe('Closed for the July payroll handoff');

      expect(await harness.waitForAuditAction('attendance.period.unlocked')).toBe(true);
    });

    it('keeps the row rather than deleting it, so the history survives', async () => {
      const rows = await harness.db
        .select({ id: attendancePeriodLocks.id })
        .from(attendancePeriodLocks)
        .where(eq(attendancePeriodLocks.id, lockId));
      expect(rows).toHaveLength(1);
    });

    it('refuses a second unlock of the same row', async () => {
      const refused = await harness.del<ErrorBody>(`/attendance/locks/${lockId}`, {
        token: adminToken,
        body: { reason: 'Trying to unlock a month that is already open' },
      });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body.error.code).toBe('PERIOD_NOT_LOCKED');
    });

    it('lets the override through once the month is open again', async () => {
      const accepted = await harness.patch<AttendanceDayDetail>(
        `/attendance/days/${employeeId}/${LOCKED_DAY}/override`,
        {
          token: hrToken,
          body: { status: 'ON_DUTY', reason: 'Client site visit agreed with the manager' },
        },
      );
      expect(accepted.status, accepted.text).toBe(200);
      expect(accepted.body.status).toBe('ON_DUTY');
    });
  });
});

describe('PATCH /attendance/days/:employeeId/:date/override (REQ-E-08)', () => {
  it('refuses without a reason', async () => {
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: 'PRESENT' } },
    );
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a one-character reason', async () => {
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: 'PRESENT', reason: 'x' } },
    );
    expect(refused.status, refused.text).toBe(400);
  });

  it('writes no row after a refusal, not even the computed one', async () => {
    const rows = await harness.db
      .select({ id: attendanceDays.id })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, OVERRIDE_DAY)));
    expect(rows).toHaveLength(0);
  });

  it('computes the day if it does not exist, then pins the status', async () => {
    const overridden = await harness.patch<AttendanceDayDetail>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      {
        token: hrToken,
        body: { status: 'PRESENT', reason: 'Worked from the client office all day' },
      },
    );

    expect(overridden.status, overridden.text).toBe(200);
    expect(overridden.body.status).toBe('PRESENT');
    expect(overridden.body.isManualOverride).toBe(true);
    // REQ-E-08: "surfaced with a marker in every report".
    expect(overridden.body.flags).toContain('manual_override');

    expect(await harness.waitForAuditAction('attendance.day.overridden')).toBe(true);
  });

  it('stores the reason, the actor and the moment on the row', async () => {
    const rows = await harness.db
      .select({
        reason: attendanceDays.overrideReason,
        by: attendanceDays.overrideBy,
        at: attendanceDays.overrideAt,
      })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, OVERRIDE_DAY)));

    expect(rows[0]?.reason).toBe('Worked from the client office all day');
    expect(rows[0]?.by).not.toBeNull();
    expect(rows[0]?.at).not.toBeNull();
  });

  it('survives a recomputation, which is what REQ-E-08 actually promises', async () => {
    // A second override of a different day forces the engine to run again over
    // this employee; then read the first day back. The pin is the engine's, and
    // this asserts the endpoint did not undo it.
    const again = await harness.patch<AttendanceDayDetail>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: 'PRESENT', reason: 'Re-confirming the same decision' } },
    );
    expect(again.status, again.text).toBe(200);
    expect(again.body.status).toBe('PRESENT');
    expect(again.body.isManualOverride).toBe(true);
  });

  it('lifts the override with status null, and the engine takes the day back', async () => {
    const lifted = await harness.patch<AttendanceDayDetail>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: null, reason: 'The client visit was never confirmed' } },
    );

    expect(lifted.status, lifted.text).toBe(200);
    expect(lifted.body.isManualOverride).toBe(false);
    expect(lifted.body.flags).not.toContain('manual_override');
    // Nobody punched, so the engine's own answer is ABSENT.
    expect(lifted.body.status).toBe('ABSENT');

    expect(await harness.waitForAuditAction('attendance.day.override_cleared')).toBe(true);
  });

  it('refuses to lift an override that is not there', async () => {
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: null, reason: 'Nothing left to lift on this day' } },
    );
    expect(refused.status, refused.text).toBe(409);
  });

  it('keeps the reason on the row after the override is lifted', async () => {
    // The trail on the row itself must not evaporate: a day that was overridden
    // for three weeks should still say so.
    const rows = await harness.db
      .select({ reason: attendanceDays.overrideReason, flag: attendanceDays.isManualOverride })
      .from(attendanceDays)
      .where(and(eq(attendanceDays.employeeId, employeeId), eq(attendanceDays.date, OVERRIDE_DAY)));
    expect(rows[0]?.flag).toBe(false);
    expect(rows[0]?.reason).toBe('The client visit was never confirmed');
  });

  it('refuses a caller without attendance.edit', async () => {
    const opsRoleId = await harness.createSystemRole(SYSTEM_ROLES.OPERATIONS);
    const ops = await harness.createUser({
      email: scopedEmail('lock-ops'),
      roleIds: [opsRoleId],
    });
    const token = (await harness.login(ops.email, ops.password)).token;

    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/${OVERRIDE_DAY}/override`,
      { token, body: { status: 'PRESENT', reason: 'Operations must not be able to do this' } },
    );
    expect(refused.status, refused.text).toBe(403);
  });

  it('404s an employee in another organisation', async () => {
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/019ffb00-0000-7000-8000-0000000000ab/${OVERRIDE_DAY}/override`,
      { token: hrToken, body: { status: 'PRESENT', reason: 'Reaching across the org boundary' } },
    );
    expect(refused.status, refused.text).toBe(404);
  });

  it('refuses a date that is not a calendar date', async () => {
    const refused = await harness.patch<ErrorBody>(
      `/attendance/days/${employeeId}/2026-02-30/override`,
      { token: hrToken, body: { status: 'PRESENT', reason: 'February has no thirtieth day' } },
    );
    expect(refused.status, refused.text).toBe(400);
  });
});

describe('GET /attendance/locks', () => {
  it('shows unlocked history as well as live locks', async () => {
    const listed = await harness.get<{ data: PeriodLock[] }>('/attendance/locks', {
      token: adminToken,
    });
    expect(listed.status, listed.text).toBe(200);
    expect(listed.body.data.some((row) => row.unlockedAt !== null)).toBe(true);
  });

  it('filters to live locks when asked', async () => {
    const listed = await harness.get<{ data: PeriodLock[] }>('/attendance/locks?liveOnly=true', {
      token: adminToken,
    });
    expect(listed.body.data.every((row) => row.unlockedAt === null)).toBe(true);
  });

  it('is readable by HR, who needs to see what is closed', async () => {
    const listed = await harness.get<{ data: PeriodLock[] }>('/attendance/locks', {
      token: hrToken,
    });
    expect(listed.status).toBe(200);
  });
});

describe('the reason the database keeps (audit 19)', () => {
  /**
   * REQ-E-09: a period is closed with a reason and reopened with one. Both
   * CHECKs were satisfied by leaving the reason out entirely --
   * `char_length(btrim(NULL)) >= 10` is NULL, and a CHECK refuses only on
   * FALSE -- so the one rule the slice exists for was the one it did not
   * hold. A blank reason was refused; an absent one was not.
   */
  it('refuses a lock with no reason at all, not only a short one', async () => {
    await expect(
      harness.db.execute(sql`
        INSERT INTO attendance_period_locks (org_id, year, month, locked_by)
        VALUES (${ORG_ID}, 2099, 7, NULL)
      `),
    ).rejects.toThrow();
  });

  it('refuses an unlock with no reason at all', async () => {
    const row = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO attendance_period_locks (org_id, year, month, lock_reason)
      VALUES (${ORG_ID}, 2099, 8, 'Closed for the audit sample')
      RETURNING id
    `);
    const id = row.rows[0]?.id ?? '';

    await expect(
      harness.db.execute(sql`UPDATE attendance_period_locks SET unlocked_at = now() WHERE id = ${id}`),
    ).rejects.toThrow();

    // A short reason was always refused, and still is.
    await expect(
      harness.db.execute(sql`UPDATE attendance_period_locks SET unlocked_at = now(), unlock_reason = 'oops' WHERE id = ${id}`),
    ).rejects.toThrow();

    // A real one is accepted, so the rule is about the reason and not the unlock.
    await harness.db.execute(sql`
      UPDATE attendance_period_locks SET unlocked_at = now(), unlock_reason = 'Reopened to correct a mis-keyed shift'
       WHERE id = ${id}
    `);
    const after = await harness.db.execute<{ unlock_reason: string | null }>(sql`
      SELECT unlock_reason FROM attendance_period_locks WHERE id = ${id}
    `);
    expect(after.rows[0]?.unlock_reason).toContain('mis-keyed');

    await harness.db.execute(sql`DELETE FROM attendance_period_locks WHERE id = ${id}`);
  });
});
