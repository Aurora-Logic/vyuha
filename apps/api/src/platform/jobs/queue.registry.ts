import type { JobsOptions } from 'bullmq';

/**
 * The queue and job catalogue from technical design §11.
 *
 * Every queue in that table is declared here, including the ones whose jobs
 * arrive in later phases. Declaring them now costs nothing -- a queue is
 * created lazily on first use -- and means a Phase 1 job is a handler plus a
 * line in `JOB_QUEUE`, never a decision about which queue to invent.
 *
 * `JobPayloads` is what makes the runner typed end to end: `enqueue` accepts
 * exactly the payload its job declares, and a handler receives exactly that
 * type. There is no `Record<string, unknown>` crossing the boundary, which is
 * the usual way a queue turns into an untyped RPC channel.
 */

export const QUEUES = {
  ATTENDANCE: 'attendance',
  LEAVE: 'leave',
  EXPORT: 'export',
  NOTIFICATION: 'notification',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QUEUES);

/**
 * Payloads are plain JSON. They cross a process boundary and are stored in
 * Redis, so a `Date` would arrive as a string and a class instance as a bare
 * object -- ISO strings and ids only, and the handler reloads what it needs.
 */
export interface JobPayloads {
  /**
   * 15 REQ-AJ-09: each morning, every open promise is re-read against the
   * receipts Tally has sent, and whoever holds a collections view key hears
   * about the ones that are now broken.
   */
  'sweep-broken-promises': {
    /** Only for the trail; the handler works from the current clock. */
    readonly now?: string;
  };

  /**
   * 15 REQ-AO-13: duplicate detection after a masters pull. Enqueued by the
   * sync writer when a pull's final chunk lands, one job per organisation
   * and entity type (deduplicated by id), never run on a list render.
   */
  'detect-duplicates': {
    readonly orgId: string;
    /** Both when absent. */
    readonly entityType?: 'party' | 'stock_item';
    readonly requestedAt: string;
  };

  /**
   * REQ-L-03. Subsumes §11's `purge-expired-photos` and `purge-expired-exports`:
   * both are rows in `files` with an `expires_at`, and two jobs running the
   * same query against the same table is two places for the retention rule to
   * drift.
   */
  'purge-expired-files': {
    /** Only for the trail. The handler always works from the current clock. */
    readonly requestedAt: string;
  };

  /**
   * REQ-R-07: masters sync runs on a schedule. One sweep enqueues a pull job
   * per eligible connection per entity type with a writer, rather than a
   * BullMQ entry per connection -- connections are rows, and cron entries
   * that mirror rows drift from them. The real work happens when the agent
   * claims the job; this only makes work exist.
   */
  'enqueue-sync-pulls': {
    readonly now?: string;
  };

  /**
   * REQ-Q-04: notice the agent that stopped heartbeating, once per silence,
   * and the recovery. The transition state lives on the connection row
   * (`stale_notified_at`), so the payload carries nothing.
   */
  'check-agent-heartbeats': {
    readonly now?: string;
  };

  /**
   * D-20: null journal bodies past the 30-day retention window. Hashes stay
   * forever; the sweep is the one UPDATE the journal's guard permits.
   */
  'sweep-sync-journal-bodies': {
    readonly now?: string;
  };

  /**
   * Phase 6c: vouchers OpsTally delivered before the projection existed sit
   * retained in `sync_inbox.payload`; this drains them through the live
   * path. Cheap once drained -- one indexed SELECT that finds nothing.
   */
  'replay-sync-inbox': {
    readonly now?: string;
  };

  /**
   * REQ-M-05: everything the system holds about one employee, as a file.
   *
   * Only the `export_jobs` row id travels, so the tray and the worker can
   * never disagree about who asked and about whom. The reports module that
   * once shared this queue is gone (owner, 26 Aug 2026); this is the one
   * producer the Downloads tray has left.
   */
  'export-employee-data': {
    readonly orgId: string;
    readonly exportJobId: string;
    /** Only for the trail; the handler works from the row and the current clock. */
    readonly requestedAt: string;
  };

  /**
   * REQ-G-09 / REQ-I-05: approvals nobody has touched for N days move up a
   * level. §11 lists it on the notification queue, next to `punch-reminders`.
   */
  'escalate-stale-approvals': {
    /** Only for the trail. The handler always works from the current clock. */
    readonly requestedAt: string;
  };

  /**
   * REQ-V-08: due-today and overdue task reminders, each morning in each
   * organisation's own day. `date` overrides the clock for a replay.
   */
  'send-task-reminders': {
    readonly date?: string;
  };

  /** D-21: link Sales vouchers to the orders their narration names, every few minutes. */
  'link-sales-invoices': {
    readonly now?: string;
  };

  /** REQ-X-09: the nightly reorder check. */
  'raise-reorder-requirements': {
    readonly now?: string;
  };

  /**
   * D-22: materialise the daily closing balance series for receivables,
   * payables and stock. The nightly run resumes from `interest_build_state`
   * minus the recompute window, so a backdated voucher is re-walked rather
   * than trusted to a stale snapshot; the first run walks from the earliest
   * voucher the projection holds. The optional fields exist for the
   * on-demand recompute endpoint, which narrows the rebuild.
   */
  'build-interest-snapshots': {
    readonly now?: string;
    /** The occurrence's own creation time, stamped by the runner on scheduled runs; `now` beats it. */
    readonly requestedAt?: string;
    readonly orgId?: string;
    readonly partyId?: string;
    readonly stockItemId?: string;
    readonly from?: string;
  };

  /**
   * D-23: photograph each organisation's open receivable book for one IST
   * calendar day. The Virtual CFO's one irreversible piece — a day nobody
   * photographed cannot be rebuilt, because receipts keep settling bills
   * and the projection only holds the present. `now` and `orgId` exist for
   * tests and repairs; the routine run photographs the IST day of its own
   * occurrence (`requestedAt`), so even a retry that limps past midnight
   * still writes the day it woke for.
   */
  'snapshot-receivables': {
    readonly now?: string;
    /** The occurrence's own creation time, stamped by the runner on scheduled runs; `now` beats it. */
    readonly requestedAt?: string;
    readonly orgId?: string;
  };

  /** REQ-K-02: one queued envelope per domain event, fanned out by channel. */
  'send-notification': {
    readonly orgId: string;
    readonly eventType: string;
    readonly audience: unknown;
    readonly payload: Record<string, unknown>;
  };

  /**
   * REQ-B-04. Everything `POST /auth/password-resets` does after answering
   * 202: the account lookup, the row, the trail, and the mail.
   *
   * It is a job rather than request work because the endpoint's guarantee is
   * that an address with an account and one without are indistinguishable, and
   * that has to hold for the *clock* as well as the status and the body. Doing
   * the work inline made the known branch await a sweep, an insert, an audit
   * write and an SMTP round trip while the unknown branch returned straight
   * after the lookup -- a gap a remote attacker can measure.
   *
   * The payload carries the address the caller typed and nothing else. No user
   * id, because whether one exists is precisely the secret; and no token,
   * because a job payload is retained in Redis for days after it completes and
   * a live reset link has no business sitting there. The handler mints the
   * token itself.
   */
  'deliver-password-reset': {
    readonly email: string;
    /** Recorded on the row as `requested_ip`; null when the socket had none. */
    readonly ip: string | null;
    /** Only for the trail. The handler always works from the current clock. */
    readonly requestedAt: string;
  };

  /**
   * REQ-G-05. Posts the accrual for one calendar month across every
   * organisation.
   *
   * `month` is optional and exists for a backfill: the scheduler never sets
   * it, so the routine run always accrues the month that has just finished --
   * a job retried three days late must still post March, not June.
   */
  'accrue-leave': {
    readonly requestedAt: string;
    /** `YYYY-MM`. Omitted means the month before `requestedAt`. */
    readonly month?: string;
  };

  /**
   * REQ-G-01's carry forward, at the leave year boundary. Runs daily and does
   * nothing on the days that are not one: the start month is per-organisation
   * (REQ-G-04), so no cron expression can name the date for everybody.
   */
  'carry-forward-leave': {
    readonly requestedAt: string;
  };

  /** REQ-G-11: lapse expired comp-off credits, and warn before they lapse. */
  'expire-comp-off': {
    readonly requestedAt: string;
  };

  /**
   * REQ-K-03's opt-in reminder before a shift starts. Runs far more often than
   * the other schedulers because a reminder is only useful in the half hour it
   * names; see `PunchReminderHandler` for why the lead is twice the interval.
   */
  'send-punch-reminders': {
    /** Only for the trail. The handler always works from the current clock. */
    readonly requestedAt: string;
  };

  /**
   * REQ-E-07's nightly closeout: recompute yesterday's days that have an IN
   * and no OUT, then tell the employee and their manager about the ones that
   * come back flagged.
   *
   * `date` is optional and exists for a backfill, exactly as `accrue-leave`'s
   * `month` does: the scheduler never sets it, so the routine run always
   * sweeps the day that has just ended in each organisation's own timezone.
   */
  'sweep-missing-out': {
    readonly requestedAt: string;
    /** `YYYY-MM-DD`. Omitted means yesterday, per organisation. */
    readonly date?: string;
  };
}

export type JobName = keyof JobPayloads;

export const JOB_QUEUE: Record<JobName, QueueName> = {
  'purge-expired-files': QUEUES.MAINTENANCE,
  // On the export queue with the jobs it starts, so a backlog of exports also
  // delays the sweep that would add to it rather than racing ahead of it.
  'enqueue-sync-pulls': QUEUES.MAINTENANCE,
  'check-agent-heartbeats': QUEUES.MAINTENANCE,
  'sweep-sync-journal-bodies': QUEUES.MAINTENANCE,
  'replay-sync-inbox': QUEUES.MAINTENANCE,
  'export-employee-data': QUEUES.EXPORT,
  'escalate-stale-approvals': QUEUES.NOTIFICATION,
  'send-task-reminders': QUEUES.NOTIFICATION,
  'link-sales-invoices': QUEUES.MAINTENANCE,
  'detect-duplicates': QUEUES.MAINTENANCE,
  'sweep-broken-promises': QUEUES.NOTIFICATION,
  'raise-reorder-requirements': QUEUES.MAINTENANCE,
  'build-interest-snapshots': QUEUES.MAINTENANCE,
  'snapshot-receivables': QUEUES.MAINTENANCE,
  'send-notification': QUEUES.NOTIFICATION,
  'deliver-password-reset': QUEUES.NOTIFICATION,
  'accrue-leave': QUEUES.LEAVE,
  'carry-forward-leave': QUEUES.LEAVE,
  'expire-comp-off': QUEUES.LEAVE,
  'send-punch-reminders': QUEUES.NOTIFICATION,
  'sweep-missing-out': QUEUES.ATTENDANCE,
};

/**
 * "Failed jobs retry with backoff" (§11).
 *
 * Five attempts over roughly a minute: long enough to ride out a Redis
 * failover or a restarted MinIO, short enough that a genuinely broken job
 * reaches the failed set while whoever deployed it is still watching.
 *
 * Completed and failed jobs are retained by count rather than removed. The
 * admin job monitor reads the failed set directly, so removing failures would
 * delete the only durable record of them.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 200, age: 7 * 24 * 60 * 60 },
  removeOnFail: { count: 500, age: 30 * 24 * 60 * 60 },
};

/**
 * How long a request may wait for Redis to accept a job.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its connection
 * (`bull-connection.ts`), which means a command issued while Redis is
 * unreachable never settles -- not "fails after a while", never. Measured on
 * the production build with Redis behind a killed TCP proxy: `POST
 * /auth/password-resets` answered nothing after 40s, and the `try/catch` around
 * the enqueue that documents an always-202 contract never ran, because there
 * was no rejection for it to catch.
 *
 * Two seconds is far longer than a healthy enqueue (32ms end to end for that
 * endpoint against a live Redis) and far shorter than any caller's patience.
 * The bound turns "hangs forever" into "fails, and the caller decides", which
 * is the only thing that lets a caller keep its own promise.
 */
export const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * What the whole queue teardown gets, and what any single stage of it gets.
 *
 * `Worker.close()` waits on connections that retry forever, so a process that
 * has lived through a Redis outage never finished its Nest shutdown hook and
 * therefore ignored SIGTERM. Measured: an instance that survived a 20s outage
 * was still alive 90s after SIGTERM holding no port -- with Redis provably
 * back, `/ready` reporting `redis ok` at 38ms -- while an instance that never
 * lost Redis exited in 2s. On the production compose that is a deploy that
 * hangs until Docker sends SIGKILL.
 *
 * A budget for the whole teardown rather than one per stage, because per-stage
 * bounds multiply: three stages across workers and then two across queues is
 * five times the number, and the first version of this fix took 15s to exit --
 * past Docker's ten-second default grace, so the deploy was still killed.
 * `docker-compose.prod.yml` states a `stop_grace_period` with room for this
 * plus the Redis and Postgres hooks that follow it.
 */
export const SHUTDOWN_BUDGET_MS = 6_000;
export const SHUTDOWN_STAGE_MS = 2_000;

/**
 * The share of the budget the workers may spend, so the queues always get a
 * turn at the end of it.
 *
 * Workers are the half that wedges -- a worker holds a blocking read open, and
 * that is the connection that stops answering. A queue's connection closes in
 * milliseconds. Letting the workers spend everything meant the queues were
 * skipped entirely ("no budget left for queue close", three times) and their
 * sockets were still open when the hook returned, which is one more thing
 * holding the event loop after a shutdown that was supposed to end it.
 */
export const WORKER_SHUTDOWN_BUDGET_MS = 4_000;

/**
 * Recurring work, as job schedulers. §11 puts the maintenance sweep on a
 * weekly cron; 03:00 on Sunday is chosen so a large purge runs when nobody is
 * punching.
 *
 * A scheduler is upserted by id, so restarting or redeploying does not create
 * a second one and changing the pattern here updates the existing entry.
 */
export interface ScheduledJob {
  readonly schedulerId: string;
  readonly jobName: JobName;
  /** Standard five-field cron, interpreted in the server's timezone. */
  readonly pattern: string;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  { schedulerId: 'maintenance:purge-expired-files', jobName: 'purge-expired-files', pattern: '0 3 * * 0' },
  // Daily rather than weekly: REQ-G-09's threshold is measured in days, and a
  // weekly sweep would turn "escalate after 3 days" into "escalate after
  // somewhere between 3 and 10". 02:00 keeps it clear of the working day.
  { schedulerId: 'notification:escalate-stale-approvals', jobName: 'escalate-stale-approvals', pattern: '0 2 * * *' },
  // REQ-V-08. Early enough to be read with the first coffee; the handler
  // works out each organisation's own date, so one server-time cron serves all.
  { schedulerId: 'notification:send-task-reminders', jobName: 'send-task-reminders', pattern: '30 2 * * *' },
  // The accountant bills in Tally; the link lands within a few minutes of the pull.
  { schedulerId: 'sales:link-invoices', jobName: 'link-sales-invoices', pattern: '*/5 * * * *' },
  // After the night's pulls have landed and before the purchase team sits down.
  { schedulerId: 'purchase:reorder-sweep', jobName: 'raise-reorder-requirements', pattern: '15 1 * * *' },
  // D-46. After the reorder sweep, still before anyone reads the digest with breakfast.
  // After the exception sweep, before the working day: the promises that came due yesterday.
  { schedulerId: 'collections:broken-promises', jobName: 'sweep-broken-promises', pattern: '0 3 * * *' },
  // D-22: after the night's pulls and the collections sweep have settled the
  // projection, before anyone reads the interest reports with breakfast.
  { schedulerId: 'interest:build-snapshots', jobName: 'build-interest-snapshots', pattern: '20 3 * * *' },
  // D-23: after the journal-body sweep at 02:45 and clear of the interest
  // build. A miss here is history lost rather than late, so it runs early in
  // the quiet hours with the whole night left for a retry.
  { schedulerId: 'cfo:snapshot-receivables', jobName: 'snapshot-receivables', pattern: '50 2 * * *' },
  // REQ-G-05. On the 1st, for the month that has just finished. Accruing on
  // the last day of a month instead would need a cron that can say "last day",
  // and would pro-rate a leaver's final month before their last day had ended.
  { schedulerId: 'leave:accrue', jobName: 'accrue-leave', pattern: '30 1 1 * *' },
  // REQ-G-01/G-04. Daily, because the leave year start month is per
  // organisation and the handler is the only thing that can know whose year
  // opened today. A day that is nobody's boundary costs one settings read.
  { schedulerId: 'leave:carry-forward', jobName: 'carry-forward-leave', pattern: '0 2 * * *' },
  // REQ-G-11. Daily, because the warnings are at 7 and 2 days and a weekly
  // sweep would miss the 2-day one entirely.
  { schedulerId: 'leave:expire-comp-off', jobName: 'expire-comp-off', pattern: '30 3 * * *' },
  // REQ-J-05. Every 15 minutes, which is the resolution a schedule gets: one
  // set for 06:00 runs somewhere in 06:00-06:14. The sweep asks each
  // organisation what time it is there, so the cron's own timezone decides
  // nothing (NFR-05).
  // REQ-R-07's default cadence. The sweep is cheap when nothing is eligible
  // -- one query -- and the one-open-job invariant on sync_jobs means an
  // agent that has been away simply finds the same job still waiting, not
  // fifteen copies of it.
  { schedulerId: 'sync:enqueue-pulls', jobName: 'enqueue-sync-pulls', pattern: '*/15 * * * *' },
  // REQ-Q-04 names five minutes of silence as the alert threshold; a
  // two-minute cadence bounds the lag at ~seven, where a five-minute sweep
  // would let the SLA read "five" while delivering ten. The check is one
  // UPDATE over a table with a handful of rows.
  { schedulerId: 'sync:check-heartbeats', jobName: 'check-agent-heartbeats', pattern: '*/2 * * * *' },
  // D-20's retention. Nightly at 02:45, offset from the other overnight
  // sweeps so the maintenance queue is never a convoy.
  { schedulerId: 'sync:sweep-journal-bodies', jobName: 'sweep-sync-journal-bodies', pattern: '45 2 * * *' },
  // Drains retained vouchers within a quarter hour of a deploy that adds a
  // projection for them; after that it is one empty SELECT per run.
  { schedulerId: 'sync:replay-inbox', jobName: 'replay-sync-inbox', pattern: '*/15 * * * *' },
  // REQ-K-03. Every 15 minutes, because a reminder is only useful shortly
  // before the shift it names and shift start times are not on the hour. The
  // sweep costs one preference query per organisation when nobody has opted
  // in, which is the state it ships in.
  { schedulerId: 'notification:punch-reminders', jobName: 'send-punch-reminders', pattern: '*/15 * * * *' },
  // REQ-E-07's nightly closeout. 01:15 rather than midnight: a shift that
  // crosses midnight is attributed to its start date (REQ-C-02), so sweeping
  // at 00:00 would call a night shift's missing OUT before the shift had
  // finished. Ahead of the 02:00 escalation sweep, which reads the days this
  // one has just recomputed.
  { schedulerId: 'attendance:sweep-missing-out', jobName: 'sweep-missing-out', pattern: '15 1 * * *' },
  // After the closeout: whoever still has no attendance day for yesterday never
  // punched, so the engine marks them ABSENT. 01:30 leaves the closeout its
  // fifteen minutes and stays ahead of the 02:00 escalation sweep.
];
