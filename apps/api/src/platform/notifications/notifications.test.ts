import { PERMISSIONS, SYSTEM_ROLES, uuidv7 } from '@vyuha/shared';
import type { Job } from 'bullmq';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';
import { RecordingMailer } from '../../test-support/recording-mailer.js';
import { env } from '../common/env.js';
import { notificationPreferences, notifications } from '../db/schema/index.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { QUEUES } from '../jobs/queue.registry.js';
import { Mailer } from '../mail/mailer.js';
import {
  ChannelRegistry,
  type DeliveryContext,
  type NotificationChannel,
  type Recipient,
  type RenderedNotification,
} from './notification-channel.js';
import { NOTIFICATION_EVENTS, NOTIFICATION_TEMPLATES } from './notification-events.js';
import { NotificationDispatcher } from './notification.dispatcher.js';

const ORG_ID = '01900000-0000-7000-8000-0000000000f3';

let harness: ApiHarness;
let dispatcher: NotificationDispatcher;
let mail: RecordingMailer;

let employeeUserId: string;
let employeeId: string;
let hrUserId: string;

async function notificationsFor(userId: string) {
  return harness.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, ORG_ID), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt));
}

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Vyuha Notifications Test');
  dispatcher = harness.resolve(NotificationDispatcher);

  const mailer = harness.resolve<Mailer>(Mailer);
  if (!(mailer instanceof RecordingMailer)) throw new Error('Expected the recording mailer.');
  mail = mailer;

  await harness.ensurePermissionCatalogue();
  const hrRole = await harness.createSystemRole(SYSTEM_ROLES.HR);

  employeeId = await harness.createEmployee({ code: 'NOTIF-1', firstName: 'Asha' });
  const employee = await harness.createUser({
    email: scopedEmail('notif.employee'),
    employeeId,
  });
  const hr = await harness.createUser({ email: scopedEmail('notif.hr'), roleIds: [hrRole] });

  employeeUserId = employee.id;
  hrUserId = hr.id;
}, 60_000);

afterEach(async () => {
  await harness.db.delete(notifications).where(eq(notifications.orgId, ORG_ID));
  await harness.db
    .delete(notificationPreferences)
    .where(eq(notificationPreferences.orgId, ORG_ID));
  mail.clear();
});

afterAll(async () => {
  await harness.close();
});

describe('dispatch', () => {
  it('resolves an employee to their login and fans out to both channels', async () => {
    const report = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      audience: { kind: 'employees', employeeIds: [employeeId] },
      payload: {
        leaveType: 'Casual Leave',
        fromDate: '12-08-2026',
        toDate: '13-08-2026',
        approverName: 'Ravi',
        leaveRequestId: uuidv7(),
      },
    });

    expect(report).toMatchObject({ recipients: 1, failed: 0, suppressed: 0 });

    const rows = await notificationsFor(employeeUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Your leave was approved');
    expect(rows[0]?.body).toContain('Casual Leave');
    expect(rows[0]?.body).toContain('Ravi');
    // Recorded after the fact, so it says what went out rather than what was
    // intended: email ran first and succeeded, then the in-app row was written.
    expect(rows[0]?.channelsSent).toEqual(['email', 'in_app']);

    expect(mail.sent).toHaveLength(1);
    const email = mail.sent[0];
    expect(email?.subject).toBe('Your leave was approved');
    expect(email?.actionUrl).toContain(env.WEB_BASE_URL);
  });

  it('resolves an audience by permission rather than by role name', async () => {
    await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_FLAGGED,
      audience: { kind: 'permission', key: PERMISSIONS.ATTENDANCE_VIEW_ALL },
      payload: { employeeName: 'Asha', date: '12-08-2026', flags: 'outside geofence' },
    });

    // The HR user holds attendance.view.all through the seeded matrix; the
    // plain employee does not.
    expect(await notificationsFor(hrUserId)).toHaveLength(1);
    expect(await notificationsFor(employeeUserId)).toHaveLength(0);
  });

  it('delivers nothing, and says so, when the audience resolves to no one', async () => {
    const report = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      audience: { kind: 'users', userIds: [uuidv7()] },
      payload: {},
    });

    expect(report).toEqual({ recipients: 0, delivered: 0, failed: 0, suppressed: 0 });
    expect(mail.sent).toHaveLength(0);
  });

  it('will not deliver a user from another organisation', async () => {
    const report = await dispatcher.deliver({
      orgId: uuidv7(),
      type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      audience: { kind: 'users', userIds: [employeeUserId] },
      payload: {},
    });
    expect(report.recipients).toBe(0);
  });
});

describe('preferences (REQ-K-04)', () => {
  it('honours a row that turns one channel off, leaving the other on', async () => {
    await harness.db.insert(notificationPreferences).values({
      orgId: ORG_ID,
      userId: employeeUserId,
      eventType: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      channel: 'email',
      enabled: false,
    });

    const report = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      audience: { kind: 'users', userIds: [employeeUserId] },
      payload: { leaveType: 'Casual Leave' },
    });

    expect(report.delivered).toBe(1);
    expect(mail.sent).toHaveLength(0);

    const rows = await notificationsFor(employeeUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channelsSent).toEqual(['in_app']);
  });

  it('suppresses the recipient entirely when every channel is off', async () => {
    await harness.db.insert(notificationPreferences).values([
      {
        orgId: ORG_ID,
        userId: employeeUserId,
        eventType: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        channel: 'email',
        enabled: false,
      },
      {
        orgId: ORG_ID,
        userId: employeeUserId,
        eventType: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        channel: 'in_app',
        enabled: false,
      },
    ]);

    const report = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
      audience: { kind: 'users', userIds: [employeeUserId] },
      payload: {},
    });

    expect(report).toMatchObject({ recipients: 1, delivered: 0, suppressed: 1 });
    expect(await notificationsFor(employeeUserId)).toHaveLength(0);
  });

  it('sends nothing for an opt-in event until a row opts the user in', async () => {
    // REQ-K-03 marks the punch reminder opt-in, and the template says so with
    // an empty default channel list.
    expect(NOTIFICATION_TEMPLATES[NOTIFICATION_EVENTS.PUNCH_REMINDER].defaultChannels).toEqual([]);

    const before = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      audience: { kind: 'users', userIds: [employeeUserId] },
      payload: { shiftName: 'General', startsAt: '09:00' },
    });
    expect(before).toMatchObject({ delivered: 0, suppressed: 1 });

    await harness.db.insert(notificationPreferences).values({
      orgId: ORG_ID,
      userId: employeeUserId,
      eventType: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      channel: 'in_app',
      enabled: true,
    });

    const after = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_REMINDER,
      audience: { kind: 'users', userIds: [employeeUserId] },
      payload: { shiftName: 'General', startsAt: '09:00' },
    });
    expect(after.delivered).toBe(1);
    expect(await notificationsFor(employeeUserId)).toHaveLength(1);
  });
});

describe('the channel seam', () => {
  it('picks up a channel registered after the fact, with no call site change', async () => {
    // This is the WhatsApp rehearsal. The channel is written here, registered
    // here, and the emit below is byte-for-byte the same call as every other
    // one in this file -- no channel argument exists to add.
    const delivered: { to: string; title: string }[] = [];

    class RehearsalChannel implements NotificationChannel {
      // Reusing the declared `whatsapp` key from the schema enum, which is
      // there precisely so a third channel needs no migration.
      readonly key = 'whatsapp' as const;
      readonly persistsRecord = false;

      send(
        to: Recipient,
        message: RenderedNotification,
        _context: DeliveryContext,
      ): Promise<void> {
        delivered.push({ to: to.userId, title: message.title });
        return Promise.resolve();
      }
    }

    const registry = harness.resolve(ChannelRegistry);
    registry.register(new RehearsalChannel());

    try {
      // Default channels for this event are in_app and email, so the new one
      // needs a preference row -- which is itself the proof that a new channel
      // is governed by REQ-K-04 like the others, with no special case.
      await harness.db.insert(notificationPreferences).values({
        orgId: ORG_ID,
        userId: employeeUserId,
        eventType: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        channel: 'whatsapp',
        enabled: true,
      });

      await dispatcher.deliver({
        orgId: ORG_ID,
        type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        audience: { kind: 'users', userIds: [employeeUserId] },
        payload: { leaveType: 'Casual Leave' },
      });

      expect(delivered).toEqual([{ to: employeeUserId, title: 'Your leave was approved' }]);

      const rows = await notificationsFor(employeeUserId);
      expect(rows[0]?.channelsSent).toEqual(['email', 'whatsapp', 'in_app']);
    } finally {
      unregister(registry, 'whatsapp');
    }
  });

  it('refuses a second channel claiming to own the durable record', () => {
    const registry = harness.resolve(ChannelRegistry);
    expect(() =>
      registry.register({
        key: 'whatsapp',
        persistsRecord: true,
        send: () => Promise.resolve(),
      }),
    ).toThrow(/already does/u);
  });

  it('keeps going for the remaining channels when one throws', async () => {
    class BrokenChannel implements NotificationChannel {
      readonly key = 'whatsapp' as const;
      readonly persistsRecord = false;
      send(): Promise<void> {
        return Promise.reject(new Error('the gateway is down'));
      }
    }

    const registry = harness.resolve(ChannelRegistry);
    registry.register(new BrokenChannel());

    try {
      await harness.db.insert(notificationPreferences).values({
        orgId: ORG_ID,
        userId: employeeUserId,
        eventType: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        channel: 'whatsapp',
        enabled: true,
      });

      const report = await dispatcher.deliver({
        orgId: ORG_ID,
        type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
        audience: { kind: 'users', userIds: [employeeUserId] },
        payload: {},
      });

      expect(report.failed).toBe(1);
      expect(report.delivered).toBe(2);

      const rows = await notificationsFor(employeeUserId);
      // The failed channel is absent from the record rather than listed
      // optimistically.
      expect(rows[0]?.channelsSent).toEqual(['email', 'in_app']);
    } finally {
      unregister(registry, 'whatsapp');
    }
  });
});

/**
 * There is deliberately no `unregister` on `ChannelRegistry`: a channel that
 * can be removed at runtime is a channel that can be removed by mistake. These
 * two tests add one for the length of a single assertion, so they reach into
 * the map to undo it rather than widening the production surface.
 */
function unregister(registry: ChannelRegistry, key: string): void {
  (registry as unknown as { channels: Map<string, unknown> }).channels.delete(key);
}

describe('through the queue', () => {
  it('emits an event that the notification worker delivers', async () => {
    const runner = harness.resolve(JobRunner);
    runner.startWorkers();

    const jobId = await dispatcher.emit({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PERIOD_LOCKED,
      audience: { kind: 'users', userIds: [hrUserId] },
      payload: { period: 'August 2026', actorName: 'Admin' },
    });

    const queue = runner.queueFor(QUEUES.NOTIFICATION);
    const job = (await queue.getJob(jobId)) as Job;

    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') break;
      if (Date.now() >= deadline) throw new Error(`Notification job stuck in "${state}".`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const finished = await queue.getJob(jobId);
    expect(await job.getState()).toBe('completed');
    expect(finished?.returnvalue).toMatchObject({ recipients: 1, delivered: 1 });

    const rows = await notificationsFor(hrUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe(NOTIFICATION_EVENTS.PERIOD_LOCKED);
  }, 40_000);

  it('fails a queued event whose type the catalogue does not know', async () => {
    const runner = harness.resolve(JobRunner);
    runner.startWorkers();

    const queue = runner.queueFor(QUEUES.NOTIFICATION);
    const job = await queue.add(
      'send-notification',
      {
        orgId: ORG_ID,
        eventType: 'leave.invented',
        audience: { kind: 'users', userIds: [hrUserId] },
        payload: {},
      },
      { attempts: 1, removeOnFail: false },
    );

    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await job.getState();
      if (state === 'failed') break;
      if (state === 'completed') throw new Error('An unknown event type was accepted.');
      if (Date.now() >= deadline) throw new Error('Job never settled.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const failed = await queue.getJob(job.id ?? '');
    expect(failed?.failedReason).toContain('unknown event type');
    await failed?.remove();
  }, 40_000);

  it('deduplicates an emit that carries an idempotency key', async () => {
    const runner = harness.resolve(JobRunner);
    const key = `probe-${uuidv7()}`;

    const first = await dispatcher.emit({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PERIOD_LOCKED,
      audience: { kind: 'users', userIds: [hrUserId] },
      payload: { period: 'August 2026' },
      idempotencyKey: key,
    });
    const second = await dispatcher.emit({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PERIOD_LOCKED,
      audience: { kind: 'users', userIds: [hrUserId] },
      payload: { period: 'August 2026' },
      idempotencyKey: key,
    });

    expect(second).toBe(first);

    const queue = runner.queueFor(QUEUES.NOTIFICATION);
    const job = await queue.getJob(first);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const state = await job?.getState();
      if (state === 'completed' || state === 'failed' || state === undefined) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // One job, therefore one bell entry, not two.
    expect(await notificationsFor(hrUserId)).toHaveLength(1);
  }, 40_000);
});

describe('the audit trail', () => {
  it('records one row for the dispatch, not one per recipient per channel', async () => {
    const countDispatchRows = async (): Promise<number> => {
      const result = await harness.db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM audit_logs
            WHERE org_id = ${ORG_ID} AND action = 'notification.dispatched'`,
      );
      return Number(result.rows[0]?.count ?? '0');
    };

    const before = await countDispatchRows();

    const report = await dispatcher.deliver({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_FLAGGED,
      audience: { kind: 'users', userIds: [employeeUserId, hrUserId] },
      payload: { employeeName: 'Asha', date: '12-08-2026' },
    });

    // Two recipients on the in-app channel, so a naive per-delivery audit
    // would have added two rows -- or four once email is counted.
    expect(report.delivered).toBe(2);
    expect(await countDispatchRows()).toBe(before + 1);
  });
});

describe('housekeeping', () => {
  it('leaves no preference rows behind between tests', async () => {
    const rows = await harness.db
      .select()
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [employeeUserId, hrUserId]));
    expect(rows).toHaveLength(0);
  });
});

describe('an event that must not be sent twice (audit 20)', () => {
  /**
   * The promise is "this notice goes out once". It used to be kept by BullMQ
   * refusing a duplicate job id -- which holds only while the completed job
   * still exists, and `DEFAULT_JOB_OPTIONS` keeps two hundred of them. On a
   * busy day the key meant to suppress a repeat for ever was evicted by
   * ordinary traffic and the notice went out again, with nothing failing.
   */
  it('stays suppressed after the queue has forgotten the job', async () => {
    const dispatcher = harness.resolve(NotificationDispatcher);
    const queue = harness.resolve(JobRunner).queueFor(QUEUES.NOTIFICATION);
    const key = `audit-20-${uuidv7()}`;
    const event = {
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_FLAGGED,
      audience: { kind: 'permission', key: PERMISSIONS.ATTENDANCE_VIEW_ALL },
      payload: { punchId: uuidv7(), employeeName: 'Devi Rao', date: '2026-08-20', flags: 'outside_window' },
      idempotencyKey: key,
    } as const;

    const first = await dispatcher.emit(event);
    expect(await queue.getJob(first)).toBeDefined();

    // Exactly what retention does on a busy day, only sooner: this one job is
    // removed, so the job id has nothing left to refuse. One job rather than
    // the queue, because the queue is shared with every other file here -- and
    // only once it has settled, because a worker holds a lock on it while it
    // runs and BullMQ refuses to remove a locked job.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const job = await queue.getJob(first);
      if (job === undefined) break;
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') break;
      if (Date.now() > deadline) throw new Error(`job ${first} never settled (state ${state})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await queue.remove(first).catch(() => undefined);
    expect(await queue.getJob(first)).toBeUndefined();

    const second = await dispatcher.emit(event);
    // The caller still gets the id it always got -- and no second job was
    // enqueued behind it, which is the part the queue could no longer promise.
    expect(second).toBe(first);
    expect(await queue.getJob(first), 'the notice was queued a second time').toBeUndefined();

    const claims = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notification_idempotency WHERE org_id = ${ORG_ID} AND key = ${key}`,
    );
    expect(claims.rows[0]?.n).toBe(1);
  }, 60_000);

  it('lets a different key through', async () => {
    const dispatcher = harness.resolve(NotificationDispatcher);
    const queue = harness.resolve(JobRunner).queueFor(QUEUES.NOTIFICATION);
    const one = await dispatcher.emit({
      orgId: ORG_ID,
      type: NOTIFICATION_EVENTS.PUNCH_FLAGGED,
      audience: { kind: 'permission', key: PERMISSIONS.ATTENDANCE_VIEW_ALL },
      payload: { punchId: uuidv7(), employeeName: 'Devi Rao', date: '2026-08-20', flags: 'outside_window' },
      idempotencyKey: `audit-20-${uuidv7()}`,
    });
    expect(await queue.getJob(one)).toBeDefined();
  }, 60_000);
});
