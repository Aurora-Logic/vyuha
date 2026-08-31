import { NOTIFICATION_CHANNELS, type NotificationChannel } from './enums.js';
import { pageQuerySchema } from './pagination.js';

import { z } from 'zod';

/**
 * REQ-K-02 to REQ-K-05: the event catalogue, the read surface behind the bell,
 * and the per-user preference rows.
 *
 * The catalogue lives here rather than in the API because both ends need it:
 * the dispatcher keys its template table off these values, and the preferences
 * screen renders one row per event. It was declared once inside the API, which
 * left the web client with no way to name an event except by copying the
 * strings -- the drift `vyuha-structure` §2 exists to stop.
 *
 * The string values are stored in `notifications.event_type` and
 * `notification_preferences.event_type` as plain text, so they are a published
 * contract in the strongest sense: changing one orphans every row that carries
 * it. Add events; do not rename them.
 */

export const NOTIFICATION_EVENTS = {
  PUNCH_REMINDER: 'punch.reminder',
  PUNCH_MISSING_OUT: 'punch.missing_out',
  PUNCH_FLAGGED: 'punch.flagged',

  LEAVE_APPLIED: 'leave.applied',
  LEAVE_APPROVED: 'leave.approved',
  LEAVE_REJECTED: 'leave.rejected',
  LEAVE_CANCELLED: 'leave.cancelled',
  LEAVE_BALANCE_LOW: 'leave.balance_low',
  LEAVE_COMP_OFF_EXPIRING: 'leave.comp_off_expiring',

  REGULARIZATION_DECIDED: 'regularization.decided',
  APPROVAL_OVERDUE: 'approval.overdue',

  PERIOD_LOCKED: 'period.locked',
  PERIOD_UNLOCKED: 'period.unlocked',

  SYNC_AGENT_STALE: 'sync.agent_stale',
  SYNC_AGENT_RECOVERED: 'sync.agent_recovered',

  TASK_ASSIGNED: 'task.assigned',
  TASK_DUE_TODAY: 'task.due_today',
  TASK_OVERDUE: 'task.overdue',

  /** REQ-AJ-05: a question the help panel could not answer, sent on by its asker. */
  HELP_QUESTION_ASKED: 'help.question_asked',

  /** 13 REQ-X-28: stock arrived for an order that was waiting on it. */
  PROCUREMENT_STOCK_ARRIVED: 'procurement.stock_arrived',
  /** 12 REQ-AA-15: an order has waited for its invoice longer than the configured hours. */
  SALES_INVOICE_WAITING: 'sales.invoice_waiting',
  /** D-46: the morning digest, sent only when an exception report has rows. */
  /** 15 REQ-AJ-09: promises past their date with nothing against them, each morning. */
  COLLECTIONS_PROMISES_BROKEN: 'collections.promises_broken',
} as const;

export type NotificationEventType =
  (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

/**
 * The catalogue as a list, in the order REQ-K-03 states it and in the order the
 * preferences screen renders it. Derived from the object above rather than
 * written twice, so an event cannot exist in one and not the other.
 */
export const NOTIFICATION_EVENT_TYPES = Object.values(
  NOTIFICATION_EVENTS,
) as readonly NotificationEventType[];

export const notificationEventTypeSchema = z.enum(
  NOTIFICATION_EVENT_TYPES as [NotificationEventType, ...NotificationEventType[]],
);

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/**
 * How the preferences screen names an event, and the groups it files them
 * under. Labels rather than raw keys, because `leave.comp_off_expiring` is a
 * database value and not a sentence anybody should have to read.
 */
export const NOTIFICATION_EVENT_GROUPS = [
  'Punch',
  'Leave',
  'Approvals',
  'Attendance',
  'Integrations',
  'Tasks',
  'Orders',
  'Reports',
  'Receivables',
  'Workspace',
] as const;
export type NotificationEventGroup = (typeof NOTIFICATION_EVENT_GROUPS)[number];

export interface NotificationEventDescriptor {
  readonly group: NotificationEventGroup;
  readonly label: string;
  /** One line saying when it fires. Rendered under the label. */
  readonly note: string;
}

export const NOTIFICATION_EVENT_DESCRIPTORS: Record<
  NotificationEventType,
  NotificationEventDescriptor
> = {
  'punch.reminder': {
    group: 'Punch',
    label: 'Shift starting soon',
    note: 'Before your shift starts. Off unless you switch it on.',
  },
  'punch.missing_out': {
    group: 'Punch',
    label: 'Missing punch out',
    note: 'When a day closes with no punch out recorded.',
  },
  'punch.flagged': {
    group: 'Punch',
    label: 'Punch needs review',
    note: 'When a punch is flagged for an approver to look at.',
  },
  'leave.applied': {
    group: 'Leave',
    label: 'Leave applied for',
    note: 'When somebody you approve for applies for leave.',
  },
  'leave.approved': {
    group: 'Leave',
    label: 'Leave approved',
    note: 'When your leave request is approved.',
  },
  'leave.rejected': {
    group: 'Leave',
    label: 'Leave declined',
    note: 'When your leave request is declined, with the reason.',
  },
  'leave.cancelled': {
    group: 'Leave',
    label: 'Leave cancelled',
    note: 'When a leave request is cancelled.',
  },
  'leave.balance_low': {
    group: 'Leave',
    label: 'Leave balance low',
    note: 'When approving leave leaves you with little of that type.',
  },
  'leave.comp_off_expiring': {
    group: 'Leave',
    label: 'Comp-off expiring',
    note: 'Seven days and again two days before a credit lapses.',
  },
  'regularization.decided': {
    group: 'Approvals',
    label: 'Regularization decided',
    note: 'When your regularization request is approved or declined.',
  },
  'approval.overdue': {
    group: 'Approvals',
    label: 'Approval overdue',
    note: 'When a request routed to you has waited too long.',
  },
  'period.locked': {
    group: 'Attendance',
    label: 'Period locked',
    note: 'When an attendance month is closed for export.',
  },
  'period.unlocked': {
    group: 'Attendance',
    label: 'Period unlocked',
    note: 'When a closed month is reopened, with the reason.',
  },
  'help.question_asked': {
    group: 'Workspace',
    label: 'Unanswered help question',
    note: 'When somebody sends the help panel a question it could not answer (REQ-AJ-05).',
  },
  'sync.agent_stale': {
    group: 'Integrations',
    label: 'Tally agent gone quiet',
    note: 'When a connection stops heartbeating for five minutes (REQ-Q-04).',
  },
  'sync.agent_recovered': {
    group: 'Integrations',
    label: 'Tally agent back',
    note: 'When a quiet connection starts heartbeating again.',
  },
  'task.assigned': {
    group: 'Tasks',
    label: 'Task assigned to you',
    note: 'When somebody assigns you a task, or moves one onto you.',
  },
  'task.due_today': {
    group: 'Tasks',
    label: 'Task due today',
    note: 'On the morning a task of yours falls due.',
  },
  'task.overdue': {
    group: 'Tasks',
    label: 'Task overdue',
    note: 'The morning after a task of yours went past its date. Once per task.',
  },
  'procurement.stock_arrived': {
    group: 'Orders',
    label: 'Stock arrived for your order',
    note: 'When a receipt releases a sales order of yours back to the pick queue.',
  },
  'sales.invoice_waiting': {
    group: 'Orders',
    label: 'Packed order waiting for its invoice',
    note: 'To accounts, once per order, when packed goods have waited longer than the configured hours (REQ-AA-15).',
  },
  'collections.promises_broken': {
    group: 'Receivables',
    label: 'Promises not kept',
    note: 'Each morning a promise to pay came due with nothing, or not enough, received against the bills it named.',
  },
};

/**
 * Where opening a notification goes.
 *
 * Here rather than inside the API's template table because it is the one part
 * of a template the *web app* has to agree with, and it was wrong for eight of
 * the thirteen events for as long as the catalogue has existed: `/leave/{id}`,
 * `/attendance/periods`, `/punch-audit/{id}` and `/approvals/{id}` are not
 * routes this app renders, so every one of them would have landed on the
 * not-found placeholder. Nobody noticed, because until the bell existed there
 * was no way to click one.
 *
 * A base route only. Where a detail screen exists the template appends the id;
 * where one does not, the list is the honest destination and a route that does
 * not exist is not. `notification-routes.test.ts` in the web app reads the real
 * router and fails if any value here stops resolving.
 */
export const NOTIFICATION_EVENT_ROUTES: Record<NotificationEventType, string> = {
  'punch.reminder': '/punch',
  'punch.missing_out': '/my-attendance',
  // A flagged punch is an approval subject (REQ-I-01), and the inbox is where
  // it is cleared. PRD §5 screen 9 (Punch Audit) has no route yet.
  'punch.flagged': '/approvals',
  'leave.applied': '/approvals',
  'leave.approved': '/my-leave',
  'leave.rejected': '/my-leave',
  'leave.cancelled': '/my-leave',
  'leave.balance_low': '/my-leave',
  'leave.comp_off_expiring': '/my-leave',
  // The person's own corrections, where the decision and the approver's reason
  // are read together (REQ-F-05). This pointed at /my-attendance while the
  // regularization slice was being built in parallel and had no screen yet.
  // The corrections screen is gone (owner, 21 Aug 2026); the decision shows on the person's own day.
  'regularization.decided': '/my-attendance',
  'approval.overdue': '/approvals',
  'period.locked': '/period-lock',
  'period.unlocked': '/period-lock',
  // An honest downgrade the way punch.flagged takes /approvals: no admin
  // screen lists help questions yet, so the bell carries the question itself
  // and lands on the organisation screen.
  'help.question_asked': '/organisation',
  'sync.agent_stale': '/integrations',
  'sync.agent_recovered': '/integrations',
  'task.assigned': '/tasks',
  'task.due_today': '/tasks',
  'task.overdue': '/tasks',
  'procurement.stock_arrived': '/sales/orders',
  'sales.invoice_waiting': '/sales/awaiting-invoice',
  'collections.promises_broken': '/collections',
};

/** Only the channels this phase actually delivers on (REQ-K-02). */
export const DELIVERABLE_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'in_app',
  'email',
];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'Bell',
  email: 'Email',
  whatsapp: 'WhatsApp',
};

// ------------------------------------------------------------------ reading

/**
 * One row behind the bell.
 *
 * `actionUrl` is where opening it goes. It is stored inside the jsonb payload
 * by the in-app channel and lifted out here, so the client never reaches into
 * an untyped blob to find its own destination.
 */
export interface NotificationSummary {
  readonly id: string;
  readonly eventType: NotificationEventType;
  readonly title: string;
  readonly body: string;
  /** Absolute or path-relative; null when there is nothing to open. */
  readonly actionUrl: string | null;
  /** ISO instant, or null while unread. */
  readonly readAt: string | null;
  readonly createdAt: string;
}

export const notificationListQuerySchema = pageQuerySchema.extend({
  /**
   * The bell's own list. A boolean rather than a status filter because there
   * are exactly two states and `?unreadOnly=true` reads at a glance.
   */
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/** What the bell asks for on its own: a number, not a page of rows. */
export interface NotificationUnreadCount {
  readonly unread: number;
}

/**
 * What marking read answers. The count travels back with it so the bell can
 * settle on the server's number rather than decrementing its own and drifting
 * away from it after a second device reads the same row.
 */
export interface NotificationReadResult {
  readonly marked: number;
  readonly unread: number;
}

// -------------------------------------------------------------- preferences

/**
 * REQ-K-04, one row per event per channel.
 *
 * `enabled` is what the server would do today: the stored row when there is
 * one, the template default when there is not. `isDefault` says which of those
 * it is, so the screen can show "following the default" without the client
 * guessing at defaults the server owns.
 */
export interface NotificationPreference {
  readonly eventType: NotificationEventType;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

export const notificationPreferenceUpdateSchema = z
  .object({
    eventType: notificationEventTypeSchema,
    channel: z.enum(
      DELIVERABLE_NOTIFICATION_CHANNELS as [NotificationChannel, ...NotificationChannel[]],
    ),
    enabled: z.boolean(),
  })
  .strict();

export type NotificationPreferenceUpdate = z.infer<typeof notificationPreferenceUpdateSchema>;

/**
 * A batch, because a person flipping three switches should not be able to end
 * up half-saved. Capped so a request cannot ask for more writes than the whole
 * catalogue contains.
 */
export const notificationPreferencesInputSchema = z
  .object({
    preferences: z
      .array(notificationPreferenceUpdateSchema)
      .min(1)
      .max(NOTIFICATION_EVENT_TYPES.length * DELIVERABLE_NOTIFICATION_CHANNELS.length),
  })
  .strict();

export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesInputSchema>;
