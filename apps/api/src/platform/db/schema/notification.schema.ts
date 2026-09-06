import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../columns.js';
import { users } from './identity.schema.js';
import { organizations } from './organizations.schema.js';

/**
 * REQ-K-02. WhatsApp is listed now although only in-app and email ship in this
 * phase: the channel is a value in the data, so adding a channel later is a
 * new implementation of the interface and a row here, not a schema change and
 * not an edit to any call site.
 */
export const notificationChannelEnum = pgEnum('notification_channel', [
  'in_app',
  'email',
  'whatsapp',
]);

export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    eventType: text('event_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload'),
    deliveryKey: text('delivery_key'),

    readAt: timestamp('read_at', { withTimezone: true }),
    channelsSent: text('channels_sent')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    ...standardColumns(),
  },
  (t) => [
    // REQ-K-05 renders an unread count on every page load, so the partial
    // index covers exactly that query rather than scanning read history.
    index('notifications_unread_idx')
      .on(t.userId, t.createdAt.desc())
      .where(sql`read_at IS NULL AND deleted_at IS NULL`),
    index('notifications_user_idx').on(t.orgId, t.userId, t.createdAt.desc()),
    uniqueIndex('notifications_delivery_key_uq').on(t.orgId, t.deliveryKey),
  ],
);

/** REQ-K-04: per-user, per-event, per-channel. Absence means the default. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    channel: notificationChannelEnum('channel').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    ...standardColumns(),
  },
  (t) => [
    uniqueIndex('notification_prefs_uq')
      .on(t.userId, t.eventType, t.channel)
      .where(ALIVE),
  ],
);

/**
 * Which notifications have already been sent, for the events that must not be
 * sent twice.
 *
 * This used to be BullMQ's own job id: `emit` passed `jobId: notify-<key>` and
 * relied on the queue refusing a duplicate. That works only while the
 * completed job still exists, and `DEFAULT_JOB_OPTIONS` keeps 200 of them --
 * so on any busy day the key that was meant to suppress a repeat for ever was
 * evicted, and the morning sweep told everybody a second time about a punch
 * they had already been told about. The retention window was the silent part:
 * nothing failed, the notice simply went out again.
 *
 * A row here is the claim, so the promise no longer depends on how many other
 * jobs ran. Pruned by the daily sweep, well past any window in which a repeat
 * would still read as a repeat.
 */
export const notificationIdempotency = pgTable(
  'notification_idempotency',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] }), index('notification_idempotency_age_idx').on(t.createdAt)],
);

/**
 * Durable hand-off between committed application work and the queue.
 * `notification_idempotency` says an event was accepted; this row preserves
 * the envelope until BullMQ/the Postgres fallback has durably accepted it.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    audience: jsonb('audience').notNull(),
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key'),
    state: text('state').notNull().default('PENDING'), // PENDING | ENQUEUED
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    claimToken: uuid('claim_token'),
    claimUntil: timestamp('claim_until', { withTimezone: true }),
    ...standardColumns(),
  },
  (t) => [
    index('notification_outbox_pending_idx').on(t.state, t.runAfter),
    uniqueIndex('notification_outbox_idempotency_uq')
      .on(t.orgId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
