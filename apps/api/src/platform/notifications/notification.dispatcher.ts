import { Injectable, Logger } from '@nestjs/common';
import { uuidv7, type NotificationChannel as NotificationChannelKey } from '@vyuha/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { InjectDatabase, type Database, type Transaction } from '../db/db.provider.js';
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
import { DeliveryProgress } from './delivery-progress.js';
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

  private stage(event: NotificationEvent): Promise<StagedNotification | null> {
    return this.db.transaction((tx) => this.stageInTransaction(event, tx));
  }

  /** Persist intent with the business mutation. The periodic drain owns hand-off. */
  async stageInTransaction(
    event: NotificationEvent,
    tx: Database | Transaction,
  ): Promise<StagedNotification | null> {
    const key = event.idempotencyKey;
    if (key !== undefined) assertUsableAsJobId(key);

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
        return existing[0] === undefined ? null : { id: existing[0].id, jobId: `notify-outbox-${existing[0].id}` };
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
    return { id, jobId: `notify-outbox-${id}` };
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
        .where(and(eq(notificationOutbox.id, staged.id), sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return true;

      await this.jobs.enqueue(
        'send-notification',
        {
          outboxId: staged.id,
          orgId: row.orgId,
          eventType: row.eventType,
          audience: row.audience,
          payload: isRecord(row.payload) ? row.payload : {},
        },
        { jobId: staged.jobId },
      );

      await this.db
        .update(notificationOutbox)
        .set({ state: 'ENQUEUED', enqueuedAt: new Date(), runAfter: new Date(Date.now() + 300_000), lastError: null, updatedAt: new Date() })
        .where(and(eq(notificationOutbox.id, staged.id), sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`));
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
          .where(and(eq(notificationOutbox.id, staged.id), sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`));
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
      .where(and(sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`, lte(notificationOutbox.runAfter, now)))
      .orderBy(asc(notificationOutbox.runAfter))
      .limit(OUTBOX_BATCH_SIZE);

    let enqueued = 0;
    for (const row of pending) {
      const jobId = `notify-outbox-${row.id}`;
      if (await this.enqueueOutbox({ id: row.id, jobId: `${jobId}-retry-${uuidv7()}` })) enqueued += 1;
    }

    const remainingRows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(sql`${notificationOutbox.state} IN ('PENDING', 'ENQUEUED')`);
    return {
      scanned: pending.length,
      enqueued,
      failed: pending.length - enqueued,
      remaining: remainingRows[0]?.value ?? 0,
    };
  }

  /**
   * Resolve, render, filter by preference, fan out.
   *
   * Outbox-backed events persist per-channel progress. Failed sends are
   * retried by the drain, acknowledged sends are skipped, and an interrupted
   * external send is held for reconciliation. Legacy direct calls retain
   * their best-effort behavior; they have no durable event identity.
   */
  async deliver(event: NotificationEvent, outboxId?: string): Promise<DeliveryReport> {
    const progress = outboxId === undefined ? null : await DeliveryProgress.claim(this.db, event.orgId, outboxId);
    if (outboxId !== undefined && progress === null) {
      return { recipients: 0, delivered: 0, failed: 0, suppressed: 0 };
    }
    const template = NOTIFICATION_TEMPLATES[event.type];
    const payload = event.payload ?? {};

    const audience = await this.recipients.resolve(event.orgId, event.audience);
    if (audience.length === 0) {
      this.logger.log({ msg: 'Notification had no reachable recipients', eventType: event.type });
      await progress?.finish(0);
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
        const key = `${recipient.userId}.${channel.key}`;
        const previous = progress?.outcome(key);
        if (previous === 'SENT') {
          succeeded.push(channel.key);
          if (outboxId !== undefined) {
            await channel.reconcileReceipt?.(recipient, `${outboxId}.${key}`, succeeded);
          }
          continue;
        }
        // A dead worker may have reached SMTP before it could acknowledge.
        // Only the record channel has a durable idempotency key. Never guess
        // that an ambiguous external send failed and silently duplicate it.
        if (previous === 'UNCERTAIN' || (previous === 'SENDING' && !channel.persistsRecord)) {
          await progress?.record(key, 'UNCERTAIN');
          this.logger.error({ msg: 'Notification delivery requires reconciliation', outboxId, key });
          continue;
        }
        await progress?.record(key, 'SENDING');
        try {
          await channel.send(recipient, message, {
            channels: [...succeeded, channel.key],
            ...(outboxId === undefined ? {} : { deliveryKey: `${outboxId}.${key}` }),
          });
        } catch (error: unknown) {
          failed += 1;
          await progress?.record(key, 'FAILED');
          this.logger.error({
            msg: 'Notification channel failed for one recipient.',
            eventType: event.type,
            channel: channel.key,
            userId: recipient.userId,
            reason: describeError(error),
          });
          continue;
        }
        // Outside the send catch: an acknowledgement DB failure is ambiguous,
        // not proof that the external transport rejected the message.
        await progress?.record(key, 'SENT');
        succeeded.push(channel.key);
        delivered += 1;
      }
    }

    // REQ-M-01. One row for the event, not one per recipient per channel:
    // a dispatch to a department would otherwise put a hundred rows into the
    // trail for a single approval.
    const audited = await this.audit.write({
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

    if (progress !== null) {
      if (!audited) throw new Error('Notification audit pending; recorded deliveries will not repeat.');
      await progress.finish(failed);
    }
    return { recipients: audience.length, delivered, failed, suppressed };
  }
}
