import { NOTIFICATION_EVENTS, uuidv7 } from '@vyuha/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../../test-support/api-harness.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import {
  employees,
  files,
  notificationPreferences,
  notifications,
} from '../../../platform/db/schema/index.js';
import { JobRegistry } from '../../../platform/jobs/job-handler.js';
import { JobRunner } from '../../../platform/jobs/job-runner.service.js';
import { SCHEDULED_JOBS, QUEUES } from '../../../platform/jobs/queue.registry.js';
import { DayEngineService } from '../day-engine/day-engine.service.js';
import { attendanceDays, punches, shifts } from '../schema/index.js';
import {
  MarkAbsentSweepHandler,
  MissingOutSweepHandler,
  PunchReminderHandler,
} from './punch-notification-jobs.handler.js';

/**
 * The two REQ-K-03 events that had templates and no call site, driven through
 * the real handlers, the real day engine and the real notification queue.
 *
 * `preservePeople` because both fixtures write a punch, and `punches` is
 * append-only with a RESTRICT foreign key onto `employees` (REQ-D-12) -- an
 * employee who has ever punched can never be deleted, so the harness cannot
 * wipe people between runs and the codes below are unique per run instead.
 *
 * The workers are started deliberately. `emit` only enqueues, so a test that
 * stopped at the queue would prove the sweep found somebody and nothing about
 * whether a notification ever reaches a bell.
 */

const ORG_ID = '01900000-0000-7000-8000-0000000000f5';
const RUN = uuidv7().slice(-8);

/** Asia/Kolkata, the organisation's timezone from `DEFAULT_TIMEZONE`. */
const TIMEZONE = 'Asia/Kolkata';

let harness: ApiHarness;
let runner: JobRunner;
let reminders: PunchReminderHandler;
let sweep: MissingOutSweepHandler;
let absentSweep: MarkAbsentSweepHandler;
let engine: DayEngineService;

let reminderEmployeeId: string;
let reminderUserId: string;
let reminderOffEmployeeId: string;
let reminderOffUserId: string;
let workerEmployeeId: string;
let workerUserId: string;
let managerEmployeeId: string;
let managerUserId: string;

const ctx: OrgContext = { orgId: ORG_ID, actorUserId: null };

async function bellFor(userId: string) {
  return harness.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, ORG_ID), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt));
}

/**
 * Waits for the notification queue to go quiet, so the bell can be asserted.
 *
 * `delayed` is deliberately not counted. `JobRunner.installSchedules` upserts
 * a repeatable entry for every `SCHEDULED_JOBS` row, and a scheduler's next
 * occurrence sits in the delayed set permanently -- waiting on it to reach
 * zero waits forever, which is exactly how this helper failed the first time
 * it was written.
 */
async function drainNotifications(): Promise<void> {
  const queue = runner.queueFor(QUEUES.NOTIFICATION);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const counts = await queue.getJobCounts('waiting', 'active');
    const outstanding = (counts.waiting ?? 0) + (counts.active ?? 0);
    if (outstanding === 0) break;
    if (Date.now() >= deadline) throw new Error('Notification queue never drained.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The last job's own writes land inside its handler, which has completed by
  // the time the count reaches zero; a short settle keeps the assertion off
  // the boundary.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/** The wall-clock time in the organisation zone, `minutes` from now. */
function localTimeIn(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000);
  return `${new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  }).format(at)}`;
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Punch Notification Jobs Fixture Org', {
    preservePeople: true,
  });
  runner = harness.resolve(JobRunner);
  reminders = harness.resolve(PunchReminderHandler);
  sweep = harness.resolve(MissingOutSweepHandler);
  absentSweep = harness.resolve(MarkAbsentSweepHandler);
  engine = harness.resolve(DayEngineService);
  runner.startWorkers();

  const reminderShiftId = uuidv7();
  const dayShiftId = uuidv7();

  // Starts twenty minutes from now, so the sweep's thirty-minute lead covers
  // it whatever time of day the suite happens to run -- including a run that
  // makes the shift start after local midnight, which is the case the handler
  // resolves tomorrow's date for.
  const reminderStart = localTimeIn(20);
  const reminderEnd = localTimeIn(500);

  await harness.db.insert(shifts).values([
    {
      id: reminderShiftId,
      orgId: ORG_ID,
      name: 'Imminent',
      code: `IMM-${RUN}`,
      startTime: reminderStart,
      endTime: reminderEnd,
      // `shifts_schedule_ordered` refuses an end before a start unless the
      // shift says it crosses midnight (REQ-C-01).
      crossesMidnight: reminderEnd < reminderStart,
    },
    {
      id: dayShiftId,
      orgId: ORG_ID,
      name: 'Sweep Day',
      code: `SWP-${RUN}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
    },
  ]);

  reminderEmployeeId = await harness.createEmployee({ code: `RM-${RUN}`, firstName: 'Nita' });
  reminderOffEmployeeId = await harness.createEmployee({ code: `RO-${RUN}`, firstName: 'Sunil' });
  managerEmployeeId = await harness.createEmployee({ code: `MG-${RUN}`, firstName: 'Prakash' });
  workerEmployeeId = await harness.createEmployee({
    code: `WK-${RUN}`,
    firstName: 'Devi',
    lastName: 'Rao',
    reportingManagerId: managerEmployeeId,
  });

  // The fixture helper takes no default shift, and REQ-C-04 falls back to one
  // when no roster row covers the date -- which is what both sweeps resolve
  // against here.
  await harness.db
    .update(employees)
    .set({ defaultShiftId: reminderShiftId })
    .where(inArray(employees.id, [reminderEmployeeId, reminderOffEmployeeId]));
  await harness.db
    .update(employees)
    .set({ defaultShiftId: dayShiftId })
    .where(inArray(employees.id, [workerEmployeeId, managerEmployeeId]));

  const reminderUser = await harness.createUser({
    email: scopedEmail('sweep.nita'),
    employeeId: reminderEmployeeId,
  });
  const workerUser = await harness.createUser({
    email: scopedEmail('sweep.devi'),
    employeeId: workerEmployeeId,
  });
  const managerUser = await harness.createUser({
    email: scopedEmail('sweep.prakash'),
    employeeId: managerEmployeeId,
  });
  const reminderOffUser = await harness.createUser({
    email: scopedEmail('sweep.sunil'),
    employeeId: reminderOffEmployeeId,
  });
  reminderUserId = reminderUser.id;
  reminderOffUserId = reminderOffUser.id;
  workerUserId = workerUser.id;
  managerUserId = managerUser.id;
}, 90_000);

afterEach(async () => {
  await harness.db.delete(notifications).where(eq(notifications.orgId, ORG_ID));
  await harness.db
    .delete(notificationPreferences)
    .where(eq(notificationPreferences.orgId, ORG_ID));
});

afterAll(async () => {
  await harness.close();
});

describe('the schedulers are registered (technical design §11)', () => {
  it('has a handler and a cron entry for both new jobs', () => {
    const registry = harness.resolve(JobRegistry);
    expect(registry.registeredJobNames()).toContain('send-punch-reminders');
    expect(registry.registeredJobNames()).toContain('sweep-missing-out');
    expect(registry.registeredJobNames()).toContain('mark-absent');
    expect(registry.get('send-punch-reminders')).toBeInstanceOf(PunchReminderHandler);
    expect(registry.get('sweep-missing-out')).toBeInstanceOf(MissingOutSweepHandler);
    expect(registry.get('mark-absent')).toBeInstanceOf(MarkAbsentSweepHandler);

    const scheduled = SCHEDULED_JOBS.map((job) => job.jobName);
    expect(scheduled).toContain('send-punch-reminders');
    expect(scheduled).toContain('sweep-missing-out');
    expect(scheduled).toContain('mark-absent');
  });
});

describe('mark-absent sweep (a no-show becomes ABSENT)', () => {
  it('writes an ABSENT day for an employee who never punched', async () => {
    // A Monday, safely in the past; the worker carries the 09:00-18:00 default
    // shift, so REQ-C-04 resolves one for the date and nothing else touched it.
    const date = '2026-02-02';
    await absentSweep.run({ date }, { jobId: 'test', attempt: 1 });

    const rows = await harness.db
      .select({ status: attendanceDays.status })
      .from(attendanceDays)
      .where(
        and(
          eq(attendanceDays.orgId, ORG_ID),
          eq(attendanceDays.employeeId, workerEmployeeId),
          eq(attendanceDays.date, date),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ABSENT');
  });
});

describe('punch reminder (REQ-K-03, opt-in)', () => {
  it('sends nothing to somebody who has not opted in', async () => {
    const result = await reminders.run({ requestedAt: new Date().toISOString() }, {
      jobId: 'test',
      attempt: 1,
    });
    expect(result.reminded).toBe(0);
    await drainNotifications();
    expect(await bellFor(reminderUserId)).toHaveLength(0);
  }, 40_000);

  /**
   * Delivery and idempotency in one test on purpose. The dedupe key is the
   * employee and the date, and a completed job stays in the queue for days --
   * so a second test reusing the same employee would be deduplicated by the
   * first one and would pass whatever the handler did.
   */
  it('reminds an opted-in employee once, however many times the sweep runs', async () => {
    await harness.db.insert(notificationPreferences).values({
      orgId: ORG_ID,
      userId: reminderUserId,
      eventType: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      channel: 'in_app',
      enabled: true,
    });

    const first = await reminders.run({ requestedAt: new Date().toISOString() }, {
      jobId: 'a',
      attempt: 1,
    });
    expect(first).toMatchObject({ considered: 1, reminded: 1 });
    await drainNotifications();

    const bell = await bellFor(reminderUserId);
    expect(bell).toHaveLength(1);
    expect(bell[0]?.eventType).toBe(NOTIFICATION_EVENTS.PUNCH_REMINDER);
    expect(bell[0]?.title).toBe('Your shift starts soon');

    // The sweep finds them again -- `reminded` is 1 a second time, so the
    // no-op is the queue keeping one job, not the sweep finding nothing.
    const second = await reminders.run({ requestedAt: new Date().toISOString() }, {
      jobId: 'b',
      attempt: 1,
    });
    expect(second).toMatchObject({ considered: 1, reminded: 1 });
    await drainNotifications();

    expect(await bellFor(reminderUserId)).toHaveLength(1);
  }, 60_000);

  it('does not remind somebody who has switched the channel off', async () => {
    // A different account from the one above: the idempotency key is per
    // employee per date, so reusing the reminded employee would make this pass
    // on the dedupe rather than on the preference.
    await harness.db.insert(notificationPreferences).values({
      orgId: ORG_ID,
      userId: reminderOffUserId,
      eventType: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      channel: 'in_app',
      enabled: false,
    });

    // A disabled row is not an opt-in, so this account is never a candidate.
    const result = await reminders.run({ requestedAt: new Date().toISOString() }, {
      jobId: 'test',
      attempt: 1,
    });
    expect(result.considered).toBe(0);

    await drainNotifications();
    expect(await bellFor(reminderOffUserId)).toHaveLength(0);
  }, 40_000);
});

describe('missing-OUT sweep (REQ-E-07)', () => {
  /** Long enough ago that no window is still open, and unique to this run. */
  const SWEEP_DATE = '2026-02-17';

  async function punchInWithNoOut(): Promise<void> {
    const photoId = uuidv7();
    const thumbId = uuidv7();
    await harness.db.insert(files).values([
      {
        id: photoId,
        orgId: ORG_ID,
        storageKey: `test/${ORG_ID}/${RUN}-photo.jpg`,
        mime: 'image/jpeg',
        bytes: 1024,
        checksum: `c-${RUN}`,
        purpose: 'PUNCH_PHOTO',
      },
      {
        id: thumbId,
        orgId: ORG_ID,
        storageKey: `test/${ORG_ID}/${RUN}-thumb.jpg`,
        mime: 'image/jpeg',
        bytes: 256,
        checksum: `t-${RUN}`,
        purpose: 'PUNCH_PHOTO_THUMB',
      },
    ]);

    await harness.db.insert(punches).values({
      orgId: ORG_ID,
      employeeId: workerEmployeeId,
      attendanceDate: SWEEP_DATE,
      punchType: 'IN',
      serverTime: new Date(`${SWEEP_DATE}T09:00:00+05:30`),
      photoFileId: photoId,
      thumbnailFileId: thumbId,
      source: 'MOBILE',
      idempotencyKey: `sweep-${RUN}`,
    });

    // Computed as it would have been at the moment of the IN punch: the shift
    // window is still open, so the day is not yet flagged. This is exactly the
    // state the sweep exists to close out, and the reason it cannot select on
    // the flag.
    const written = await engine
      .forOrg(ctx)
      .computeDay(workerEmployeeId, SWEEP_DATE, {
        now: new Date(`${SWEEP_DATE}T10:00:00+05:30`),
      });
    expect(written.outcome).toBe('written');
    if (written.outcome === 'written') {
      expect(written.day.flags).not.toContain('missing_punch');
    }
  }

  it('recomputes the day, flags it, and tells the employee and the manager', async () => {
    await punchInWithNoOut();

    const result = await sweep.run(
      { requestedAt: new Date().toISOString(), date: SWEEP_DATE },
      { jobId: 'test', attempt: 1 },
    );
    // Greater-or-equal, not equal: `punches` cannot be deleted (REQ-D-12), so
    // an earlier run of this file leaves its own open day on this date behind
    // for good. The exact assertions below are per account, which is the part
    // a leftover cannot move.
    expect(Number(result.recomputed)).toBeGreaterThanOrEqual(1);
    expect(Number(result.notified)).toBeGreaterThanOrEqual(2);

    await drainNotifications();

    const employeeBell = await bellFor(workerUserId);
    expect(employeeBell).toHaveLength(1);
    expect(employeeBell[0]?.title).toBe('You did not punch out');
    // The employee's copy names nobody, because it is about them.
    expect(employeeBell[0]?.body).not.toContain('Devi');

    const managerBell = await bellFor(managerUserId);
    expect(managerBell).toHaveLength(1);
    // The manager's copy names the person, or it is a sentence about nobody.
    expect(managerBell[0]?.title).toBe('Devi Rao did not punch out');
    expect(managerBell[0]?.body).toContain(SWEEP_DATE);

    // REQ-E-07's other two clauses: the day is now PENDING and flagged.
    const day = await harness.db.execute<{ status: string; flags: string[] }>(
      sql`SELECT status, flags FROM attendance_days
            WHERE org_id = ${ORG_ID} AND employee_id = ${workerEmployeeId}
              AND date = ${SWEEP_DATE}`,
    );
    expect(day.rows[0]?.status).toBe('PENDING');
    expect(day.rows[0]?.flags).toContain('missing_punch');
  }, 60_000);

  it('sweeps again without notifying again', async () => {
    const result = await sweep.run(
      { requestedAt: new Date().toISOString(), date: SWEEP_DATE },
      { jobId: 'test', attempt: 1 },
    );
    // Still found, still recomputed to the same values -- so nothing was
    // written -- and the idempotency key keeps the second notification out.
    expect(Number(result.scanned)).toBeGreaterThanOrEqual(1);
    expect(result.recomputed).toBe(0);

    await drainNotifications();
    expect(await bellFor(workerUserId)).toHaveLength(0);
    expect(await bellFor(managerUserId)).toHaveLength(0);
  }, 60_000);

  it('finds nobody on a date with no open day', async () => {
    const result = await sweep.run(
      { requestedAt: new Date().toISOString(), date: '2026-02-01' },
      { jobId: 'test', attempt: 1 },
    );
    expect(result).toMatchObject({ scanned: 0, notified: 0 });
  }, 40_000);
});
