import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel as NotificationChannelKey } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { env } from '../common/env.js';
import { describeError } from '../common/errors.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { ChannelRegistry, type RenderedNotification } from './notification-channel.js';
import {
  NOTIFICATION_TEMPLATES,
  type NotificationAudience,
  type NotificationEventType,
  type NotificationPayload,
} from './notification-events.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';
import { RecipientResolver } from './recipient-resolver.service.js';

/**
 * Technical design §12. The only thing a feature calls.
 *
 * ```ts
 * await notifications.emit({
 *   orgId, type: NOTIFICATION_EVENTS.LEAVE_APPROVED,
 *   audience: { kind: 'employees', employeeIds: [request.employeeId] },
 *   payload: { leaveType, fromDate, toDate, approverName },
 * });
 * ```
 *
 * There is no channel in that call and no way to add one. A caller cannot send
 * "just an email", cannot skip the bell, and cannot reach a transport -- which
 * is what makes WhatsApp a new class in `channels/` and nothing else.
 *
 * `emit` queues; `deliver` does the work. The split matters because delivery
 * touches SMTP, and a leave approval must not be slow or fail because a mail
 * server is having a bad afternoon.
 */

export interface NotificationEvent {
  readonly orgId: string;
  readonly type: NotificationEventType;
  readonly audience: NotificationAudience;
  readonly payload?: NotificationPayload;
  /**
   * Makes a repeated emit a no-op. For anything driven by a cron sweep --
   * "you did not punch out yesterday" -- where the sweep may run twice.
   */
  readonly idempotencyKey?: string;
}

/**
 * BullMQ rejects a job id containing a colon -- it builds Redis keys by
 * joining on one. Rejected rather than rewritten: silently replacing the
 * character would make `punch:2026-08-12` and `punch-2026-08-12` the same
 * key, and two events that should be distinct would deduplicate into one
 * missing notification.
 */
function assertUsableAsJobId(key: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(key)) {
    throw new Error(
      `Notification idempotency key "${key}" must use only letters, digits, dot, dash, or underscore.`,
    );
  }
  return key;
}

export interface DeliveryReport {
  readonly recipients: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
}

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly channels: ChannelRegistry,
    private readonly recipients: RecipientResolver,
    private readonly preferences: NotificationPreferencesService,
    private readonly jobs: JobRunner,
    private readonly audit: AuditService,
  ) {}

  /**
   * The accounts that have explicitly switched an event **on** (REQ-K-04).
   *
   * Exposed here rather than by exporting `NotificationPreferencesService`,
   * which stays internal for the reason the module comment gives: a feature
   * that could read the preference table could also decide delivery for
   * itself, and the whole point of this class is that it cannot.
   *
   * This answers one narrow question and grants nothing. It exists for the
   * opt-in events, where the people who have asked for it are the only
   * candidates worth building a dispatch for -- the punch reminder sweep would
   * otherwise resolve a shift for every employee in the organisation every
   * fifteen minutes to produce nothing. It narrows candidates; `deliver` still
   * consults the preferences for every recipient, so nothing here can let a
   * suppressed notification through.
   */
  usersOptedIn(orgId: string, type: NotificationEventType): Promise<string[]> {
    return this.preferences.usersOptedIn(orgId, type);
  }

  /**
   * Hands the event to the `notification` queue and returns.
   *
   * An idempotency key is claimed in the database first. It used to be
   * BullMQ's own job id and nothing else, which suppresses a duplicate only
   * while the completed job still exists -- and `DEFAULT_JOB_OPTIONS` keeps
   * two hundred of them, so on a busy day the key meant to stop a repeat for
   * ever was evicted and the sweep told everybody a second time about a punch
   * they had already been told about. Nothing failed; the notice simply went
   * out again.
   *
   * The job id is still passed. It costs nothing and it catches the narrower
   * case the row cannot: two emits racing before either has committed.
   */
  async emit(event: NotificationEvent): Promise<string> {
    if (event.idempotencyKey !== undefined) {
      // The same id a duplicate has always returned -- BullMQ answered with
      // the existing job's id rather than enqueuing a second, and callers
      // that keep the id must go on getting it. Only the enqueue is skipped.
      const jobId = `notify-${assertUsableAsJobId(event.idempotencyKey)}`;
      if (!(await this.claimIdempotencyKey(event.orgId, event.idempotencyKey))) return jobId;
    }
    return this.jobs.enqueue(
      'send-notification',
      {
        orgId: event.orgId,
        eventType: event.type,
        audience: event.audience,
        payload: { ...(event.payload ?? {}) },
      },
      event.idempotencyKey === undefined
        ? {}
        : { jobId: `notify-${assertUsableAsJobId(event.idempotencyKey)}` },
    );
  }

  /**
   * The same emit, for callers whose work is already committed.
   *
   * Found live, 31 Aug 2026: a task saved, its audit row was written, and
   * then the notification enqueue timed out against a Redis blip -- so the
   * screen said "Saving the task failed" about a task that exists, and the
   * obvious retry made a second one. A notice is a courtesy; the record is
   * the point. Once the record is committed, a failure to tell somebody is
   * logged and swallowed, because the alternative is losing the work or
   * lying about it.
   *
   * Not the behaviour of `emit` itself: a caller inside a job wants the
   * throw, so its retry can carry the notice.
   */
  async emitAfterCommit(event: NotificationEvent): Promise<void> {
    try {
      await this.emit(event);
    } catch (error) {
      this.logger.warn({
        msg: 'Notification could not be queued; the work it describes is committed',
        eventType: event.type,
        orgId: event.orgId,
        error: describeError(error),
      });
    }
  }

  /** True the first time this organisation claims this key, false after. */
  private async claimIdempotencyKey(orgId: string, key: string): Promise<boolean> {
    const claimed = await this.db.execute<{ key: string }>(sql`
      INSERT INTO notification_idempotency (org_id, key) VALUES (${orgId}, ${key})
      ON CONFLICT (org_id, key) DO NOTHING
      RETURNING key
    `);
    return claimed.rows.length > 0;
  }

  /**
   * Resolve, render, filter by preference, fan out.
   *
   * Failure policy, stated because the alternative is tempting and wrong: a
   * per-channel failure is counted and logged, and the dispatch still
   * completes. Throwing would make BullMQ retry the whole event, and the
   * recipients who *did* get their bell notification would get a second one.
   * A duplicated notification is worse than a missed one that is visible in
   * the job's result and in the log.
   *
   * A failure to resolve or render does throw: nothing was delivered, so a
   * retry is safe and is exactly what should happen.
   */
  async deliver(event: NotificationEvent): Promise<DeliveryReport> {
    const template = NOTIFICATION_TEMPLATES[event.type];
    const payload = event.payload ?? {};

    const audience = await this.recipients.resolve(event.orgId, event.audience);
    if (audience.length === 0) {
      this.logger.log({ msg: 'Notification had no reachable recipients', eventType: event.type });
      return { recipients: 0, delivered: 0, failed: 0, suppressed: 0 };
    }

    const path = template.path(payload);
    const message: RenderedNotification = {
      eventType: event.type,
      title: template.title(payload),
      body: template.body(payload),
      actionUrl: path === null ? null : `${env.WEB_BASE_URL}${path}`,
      payload,
    };

    const lookup = await this.preferences.lookupFor(
      event.orgId,
      event.type,
      audience.map((recipient) => recipient.userId),
    );

    let delivered = 0;
    let failed = 0;
    let suppressed = 0;

    for (const recipient of audience) {
      const wanted = this.channels
        .all()
        .filter((channel) => lookup.isEnabled(recipient.userId, channel.key));

      if (wanted.length === 0) {
        suppressed += 1;
        continue;
      }

      const succeeded: NotificationChannelKey[] = [];

      for (const channel of wanted) {
        try {
          // The record-keeping channel sorts last (see `ChannelRegistry.all`),
          // so by the time it runs `succeeded` is what genuinely went out.
          await channel.send(recipient, message, { channels: [...succeeded, channel.key] });
          succeeded.push(channel.key);
          delivered += 1;
        } catch (error: unknown) {
          failed += 1;
          this.logger.error({
            msg: 'Notification channel failed for one recipient.',
            eventType: event.type,
            channel: channel.key,
            userId: recipient.userId,
            reason: describeError(error),
          });
        }
      }
    }

    // REQ-M-01. One row for the event, not one per recipient per channel:
    // a dispatch to a department would otherwise put a hundred rows into the
    // trail for a single approval.
    await this.audit.write({
      orgId: event.orgId,
      actorUserId: null,
      action: 'notification.dispatched',
      entityType: 'notification',
      after: {
        eventType: event.type,
        recipients: audience.length,
        delivered,
        failed,
        suppressed,
        channels: [...this.channels.keys()],
      },
    });

    return { recipients: audience.length, delivered, failed, suppressed };
  }
}
