import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_ROUTES,
  type NotificationChannel as NotificationChannelKey,
  type NotificationEventType,
  type PermissionKey,
} from '@vyuha/shared';

/**
 * The templates that turn a REQ-K-03 event into words.
 *
 * The catalogue itself moved to `@vyuha/shared` when the bell and the
 * preferences screen were built: both ends need to name an event, and a second
 * copy of thirteen strings is drift with a countdown on it. It is re-exported
 * here so no call site changed, and so this file is still the one place a
 * reader looks for "what events exist and what do they say".
 *
 * A call site emits an event type and a payload. It does not choose a channel,
 * does not know who receives it, and does not write any prose -- technical
 * design §12: "If a feature call site names a channel directly, it's wrong."
 *
 * Payloads are flat scalars. They are serialised into a BullMQ job and back,
 * so a `Date` would arrive as a string and an object would arrive without its
 * prototype. Ids and pre-formatted strings only; anything richer is looked up
 * by the renderer.
 */

export { NOTIFICATION_EVENTS };
export type { NotificationEventType };

export type NotificationPayload = Readonly<Record<string, string | number | boolean | null>>;

/** Who a dispatch is for. Resolved to user accounts by `RecipientResolver`. */
export type NotificationAudience =
  | { readonly kind: 'users'; readonly userIds: readonly string[] }
  /** Employees, resolved to whichever of them have a login (REQ-B-02). */
  | { readonly kind: 'employees'; readonly employeeIds: readonly string[] }
  /** Everyone in the organisation holding a permission -- "notify HR". */
  | { readonly kind: 'permission'; readonly key: PermissionKey };

export interface NotificationTemplate {
  readonly title: (payload: NotificationPayload) => string;
  readonly body: (payload: NotificationPayload) => string;
  /** A path on the web client, or null when there is nothing to open. */
  readonly path: (payload: NotificationPayload) => string | null;
  /**
   * Where this event goes when the user has expressed no preference.
   *
   * An empty list means opt-in: nothing is delivered until the user creates a
   * `notification_preferences` row enabling it. REQ-K-03 marks the punch
   * reminder that way, and it is the only one -- a reminder before every shift
   * is the fastest way to teach a workforce to ignore the bell.
   */
  readonly defaultChannels: readonly NotificationChannelKey[];
}

const IN_APP_AND_EMAIL: readonly NotificationChannelKey[] = ['in_app', 'email'];
const IN_APP_ONLY: readonly NotificationChannelKey[] = ['in_app'];

function text(payload: NotificationPayload, key: string, fallback = ''): string {
  const value = payload[key];
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * Where opening this notification goes.
 *
 * `NOTIFICATION_EVENT_ROUTES` is the authority, and it lives in the shared
 * contract because the web app is what has to render it -- see the note there
 * about the eight paths that named no route at all. Ids were appended to some
 * of those paths; none of the detail screens they implied exists, so the list
 * screen is the destination until one does.
 */
function routeFor(type: NotificationEventType): string {
  return NOTIFICATION_EVENT_ROUTES[type];
}

/**
 * `Record<NotificationEventType, ...>` on purpose: adding an event to the
 * catalogue without deciding what it says and where it goes is a compile
 * error, rather than a dispatch that silently renders as "undefined".
 */
export const NOTIFICATION_TEMPLATES: Record<NotificationEventType, NotificationTemplate> = {
  'punch.reminder': {
    title: () => 'Your shift starts soon',
    body: (p) => `Your ${text(p, 'shiftName', 'shift')} starts at ${text(p, 'startsAt')}.`,
    path: () => routeFor('punch.reminder'),
    defaultChannels: [],
  },
  /**
   * REQ-E-07 sends this to the employee *and* their manager, which is why it
   * reads the payload the way `punch.flagged` does. One template, two
   * dispatches: the employee's carries no name and renders in the second
   * person, the manager's names the employee it is about. A single dispatch to
   * both would have told a manager "you did not punch out" about somebody
   * else's day -- uninterpretable, and the wrong person's fact in their bell.
   */
  'punch.missing_out': {
    title: (p) =>
      text(p, 'employeeName') === ''
        ? 'You did not punch out'
        : `${text(p, 'employeeName')} did not punch out`,
    body: (p) =>
      text(p, 'employeeName') === ''
        ? `No punch out was recorded for ${text(p, 'date')}. Raise a regularization if you were at work.`
        : `No punch out was recorded for ${text(p, 'employeeName')} on ${text(p, 'date')}.`,
    // The manager's copy opens the team screen; the employee's opens their own.
    path: (p) =>
      text(p, 'employeeName') === '' ? routeFor('punch.missing_out') : '/team-attendance',
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'punch.flagged': {
    title: () => 'A punch needs review',
    body: (p) =>
      `${text(p, 'employeeName', 'An employee')} recorded a punch on ${text(p, 'date')} flagged as ${text(p, 'flags', 'unusual')}.`,
    path: () => routeFor('punch.flagged'),
    defaultChannels: IN_APP_ONLY,
  },

  'leave.applied': {
    title: (p) => `Leave request from ${text(p, 'employeeName', 'an employee')}`,
    body: (p) =>
      `${text(p, 'employeeName', 'An employee')} applied for ${text(p, 'leaveType', 'leave')} from ${text(p, 'fromDate')} to ${text(p, 'toDate')}.`,
    path: () => routeFor('leave.applied'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'leave.approved': {
    title: () => 'Your leave was approved',
    body: (p) =>
      `${text(p, 'leaveType', 'Leave')} from ${text(p, 'fromDate')} to ${text(p, 'toDate')} was approved by ${text(p, 'approverName', 'your approver')}.`,
    path: () => routeFor('leave.approved'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'leave.rejected': {
    title: () => 'Your leave was not approved',
    body: (p) =>
      `${text(p, 'leaveType', 'Leave')} from ${text(p, 'fromDate')} to ${text(p, 'toDate')} was declined. Reason: ${text(p, 'reason', 'not given')}.`,
    path: () => routeFor('leave.rejected'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'leave.cancelled': {
    title: () => 'A leave request was cancelled',
    body: (p) =>
      `${text(p, 'leaveType', 'Leave')} from ${text(p, 'fromDate')} to ${text(p, 'toDate')} was cancelled.`,
    path: () => routeFor('leave.cancelled'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'leave.balance_low': {
    title: (p) => `${text(p, 'leaveType', 'Leave')} balance is running low`,
    body: (p) =>
      `You have ${text(p, 'remainingDays', '0')} day(s) of ${text(p, 'leaveType', 'leave')} left this year.`,
    path: () => routeFor('leave.balance_low'),
    defaultChannels: IN_APP_ONLY,
  },
  'leave.comp_off_expiring': {
    title: () => 'A comp-off credit is about to expire',
    body: (p) =>
      `${text(p, 'days', '1')} day(s) of comp-off earned for ${text(p, 'earnedForDate')} ` +
      `expire on ${text(p, 'expiresOn')}, in ${text(p, 'daysRemaining')} day(s).`,
    path: () => routeFor('leave.comp_off_expiring'),
    defaultChannels: IN_APP_AND_EMAIL,
  },

  'regularization.decided': {
    title: (p) => `Regularization ${text(p, 'outcome', 'updated')}`,
    body: (p) =>
      `Your regularization for ${text(p, 'date')} was ${text(p, 'outcome', 'updated')}.`,
    path: () => routeFor('regularization.decided'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'approval.overdue': {
    title: () => 'An approval has been waiting too long',
    body: (p) =>
      `A ${text(p, 'approvalType', 'request')} has been pending for ${text(p, 'days', 'several')} day(s).`,
    path: () => routeFor('approval.overdue'),
    defaultChannels: IN_APP_AND_EMAIL,
  },

  'period.locked': {
    title: () => 'An attendance period was locked',
    body: (p) => `${text(p, 'period')} was locked by ${text(p, 'actorName', 'an administrator')}.`,
    path: () => routeFor('period.locked'),
    defaultChannels: IN_APP_ONLY,
  },
  'period.unlocked': {
    title: () => 'An attendance period was unlocked',
    body: (p) =>
      `${text(p, 'period')} was unlocked by ${text(p, 'actorName', 'an administrator')}. Reason: ${text(p, 'reason', 'not given')}.`,
    path: () => routeFor('period.unlocked'),
    defaultChannels: IN_APP_ONLY,
  },
  /**
   * REQ-Q-04. Email by default, unlike most of the catalogue: an agent going
   * quiet is precisely the situation where nobody is looking at the app, and
   * the person who can fix it is at the Tally machine, not the bell.
   */
  'sync.agent_stale': {
    title: (p) => `Tally agent for ${text(p, 'connectionName', 'a connection')} has gone quiet`,
    body: (p) =>
      `No heartbeat since ${text(p, 'lastHeartbeatAt', 'its last report')} — sync is paused. ` +
      'Check the machine that runs TallyPrime and the agent on it.',
    path: () => routeFor('sync.agent_stale'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'sync.agent_recovered': {
    title: (p) => `Tally agent for ${text(p, 'connectionName', 'a connection')} is back`,
    body: () => 'Heartbeats resumed; queued work continues on the next poll.',
    path: () => routeFor('sync.agent_recovered'),
    defaultChannels: IN_APP_ONLY,
  },
  // REQ-V-08. Paths carry the task id so the bell opens the task's sheet.
  'task.assigned': {
    title: (p) => `${text(p, 'assignedBy', 'Somebody')} assigned you a task`,
    body: (p) =>
      `${text(p, 'title')}${text(p, 'dueDate') === '' ? '' : `, due ${text(p, 'dueDate')}`}` +
      `${text(p, 'subjectLabel') === '' ? '' : ` — on ${text(p, 'subjectLabel')}`}.`,
    path: (p) => `${routeFor('task.assigned')}/${text(p, 'taskId')}`,
    defaultChannels: IN_APP_AND_EMAIL,
  },
  'task.due_today': {
    title: (p) => `Due today: ${text(p, 'title')}`,
    body: (p) =>
      text(p, 'subjectLabel') === '' ? 'Assigned to you, due today.' : `On ${text(p, 'subjectLabel')}, due today.`,
    path: (p) => `${routeFor('task.due_today')}/${text(p, 'taskId')}`,
    defaultChannels: IN_APP_ONLY,
  },
  'task.overdue': {
    title: (p) => `Overdue: ${text(p, 'title')}`,
    body: (p) => `Was due ${text(p, 'dueDate')} and is still open.`,
    path: (p) => `${routeFor('task.overdue')}/${text(p, 'taskId')}`,
    defaultChannels: IN_APP_AND_EMAIL,
  },
  // 13 REQ-X-28: the order's owner hears that the balance is packable again.
  'procurement.stock_arrived': {
    title: (p) => `Stock arrived for ${text(p, 'orderNumber', 'your order')}`,
    body: (p) => `${text(p, 'stockItemName')}: ${text(p, 'quantity')} received on ${text(p, 'grnNumber')}. The balance is back on the pick queue.`,
    path: (p) => `${routeFor('procurement.stock_arrived')}/${text(p, 'orderId')}`,
    defaultChannels: IN_APP_ONLY,
  },
  // 12 REQ-AA-15: accounts hears once per order that packed goods are waiting on a bill.
  'sales.invoice_waiting': {
    title: (p) => `${text(p, 'orderNumber', 'An order')} has waited ${text(p, 'waitingHours')}h for its invoice`,
    body: (p) => `${text(p, 'customerName')}: ${text(p, 'packedUninvoicedQty')} packed and uninvoiced since ${text(p, 'waitingSince')}. Nothing leaves until it is billed.`,
    path: () => routeFor('sales.invoice_waiting'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
  // 15 REQ-AJ-09 / D-38: only when a promise has actually been broken. A daily
  // "nothing broken" trains people to ignore the morning it is not.
  'collections.promises_broken': {
    title: (p) => `${text(p, 'summary', 'Promises')} not kept`,
    body: (p) => `${text(p, 'detail')}. The broken promises report ranks them by what is short; a broken promise flags the credit check and never blocks an order.`,
    path: () => routeFor('collections.promises_broken'),
    defaultChannels: IN_APP_AND_EMAIL,
  },
};
