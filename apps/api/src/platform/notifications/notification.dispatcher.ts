import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel as NotificationChannelKey } from '@vyuha/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { notificationIdempotency, notificationOutbox } from '../db/schema/index.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DeliveryReport {
  readonly recipients: number;
  readonly delivered: number;
  readonly failed: number;
  readonly suppressed: number;
}

const OUTBOX_BATCH_SIZE = 200;

interface StagedNotification {
  readonly id: string;
  readonly jobId: string;
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
   * Persists the envelope, then hands it to the notification queue.
   *
   * The outbox and idempotency claim are one database transaction. A process
   * dying after that commit leaves a PENDING row for the drain job, while a
   * process dying after queue acceptance retries with the same BullMQ job id.
   * Queue failure is therefore not released/discarded and is not a reason to
   * fail already-committed business work.
   */
  async emit(event: NotificationEvent): Promise<string> {
    const staged = await this.stage(event);
    if (staged === null) {
      // Historical idempotency rows may predate the outbox. They name an event
      // that was already accepted, so preserve the old stable return value.
      const key = event.idempotencyKey;
      if (key === undefined) throw new Error('A notification without an idempotency key was not staged.');
      return `notify-${assertUsableAsJobId(key)}`;
    }

    await this.enqueueOutbox(staged);
    return staged.jobId;
  }

  private async stage(event: NotificationEvent): Promise<StagedNotification | null> {
    const key = event.idempotencyKey;
    const jobId = key === undefined
      ? null
      : `notify-${assertUsableAsJobId(key)}`;

    return this.db.transaction(async (tx) => {
      if (key !== undefined) {
        const claimed = await tx
          .insert(notificationIdempotency)
          .values({ orgId: event.orgId, key })
          .onConflictDoNothing()
          .returning({ key: notificationIdempotency.key });

        if (claimed.length === 0) {
          const existing = await tx
            .select({ id: notificationOutbox.id })
            .from(notificationOutbox)
            .where(
              and(
                eq(notificationOutbox.orgId, event.orgId),
                eq(notificationOutbox.idempotencyKey, key),
              ),
            )
            .limit(1);
          return existing[0] === undefined ? null : { id: existing[0].id, jobId: jobId ?? '' };
        }
      }

      const inserted = await tx
        .insert(notificationOutbox)
        .values({
          orgId: event.orgId,
          eventType: event.type,
          audience: event.audience,
          payload: { ...(event.payload ?? {}) },
          idempotencyKey: key ?? null,
        })
        .returning({ id: notificationOutbox.id });
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error('Notification outbox insert returned no row.');
      return { id, jobId: jobId ?? `notify-outbox-${id}` };
    });
  }

  /**
   * Attempts one durable hand-off. False means the PENDING row remains for a
   * scheduled retry; callers do not need to turn that into their own retry.
   */
  private async enqueueOutbox(staged: StagedNotification): Promise<boolean> {
    try {
      const rows = await this.db
        .select({
          orgId: notificationOutbox.orgId,
          eventType: notificationOutbox.eventType,
          audience: notificationOutbox.audience,
          payload: notificationOutbox.payload,
        })
        .from(notificationOutbox)
        .where(and(eq(notificationOutbox.id, staged.id), eq(notificationOutbox.state, 'PENDING')))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return true;

      await this.jobs.enqueue(
        'send-notification',
        {
          orgId: row.orgId,
          eventType: row.eventType,
          audience: row.audience,
          payload: isRecord(row.payload) ? row.payload : {},
        },
        { jobId: staged.jobId },
      );

      await this.db
        .update(notificationOutbox)
        .set({ state: 'ENQUEUED', enqueuedAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(and(eq(notificationOutbox.id, staged.id), eq(notificationOutbox.state, 'PENDING')));
      return true;
    } catch (error: unknown) {
      try {
        await this.db
          .update(notificationOutbox)
          .set({
            attempts: sql`${notificationOutbox.attempts} + 1`,
            runAfter: new Date(Date.now() + 30_000),
            lastError: describeError(error).slice(0, 500),
            updatedAt: new Date(),
          })
          .where(and(eq(notificationOutbox.id, staged.id), eq(notificationOutbox.state, 'PENDING')));
      } catch (recordError: unknown) {
        this.logger.error({
          msg: 'Notification outbox could not record a failed queue hand-off.',
          outboxId: staged.id,
          enqueueError: describeError(error),
          recordError: describeError(recordError),
        });
      }
      this.logger.warn({
        msg: 'Notification remains pending in the outbox after queue hand-off failed.',
        outboxId: staged.id,
        error: describeError(error),
      });
      return false;
    }
  }

  /** Drained by a recurring maintenance job and callable directly in tests. */
  async drainOutbox(now: Date = new Date()): Promise<{
    scanned: number;
    enqueued: number;
    failed: number;
    remaining: number;
  }> {
    const pending = await this.db
      .select({ id: notificationOutbox.id, idempotencyKey: notificationOutbox.idempotencyKey })
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.state, 'PENDING'), lte(notificationOutbox.runAfter, now)))
      .orderBy(asc(notificationOutbox.runAfter))
      .limit(OUTBOX_BATCH_SIZE);

    let enqueued = 0;
    for (const row of pending) {
      const jobId = row.idempotencyKey === null
        ? `notify-outbox-${row.id}`
        : `notify-${assertUsableAsJobId(row.idempotencyKey)}`;
      if (await this.enqueueOutbox({ id: row.id, jobId })) enqueued += 1;
    }

    const remainingRows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.state, 'PENDING'));
    return {
      scanned: pending.length,
      enqueued,
      failed: pending.length - enqueued,
      remaining: remainingRows[0]?.value ?? 0,
    };
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
   * Queue outages are already absorbed by `emit` because the outbox owns that
   * retry. This catch is for the narrower case where even the database could
   * not accept the durable envelope.
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
