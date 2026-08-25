import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, standardColumns } from '../columns.js';
import { files } from './file.schema.js';
import { users } from './identity.schema.js';
import { organizations } from './organizations.schema.js';

/**
 * Report exports and saved views (REQ-J-01, REQ-J-03, REQ-J-06).
 *
 * Platform rather than attendance, and the tables were here before this slice
 * was: an export is a queued job that turns rows into a file with a retention
 * date, and none of that is attendance-specific. The CRM and ERP modules will
 * export through the same tray. What the attendance module owns is the *row
 * source* -- which report exists, and what a row of it looks like -- and that
 * lives in `modules/attendance/reports/`.
 *
 * Both tables moved here from `file.schema.ts`, which now holds only `files`.
 * They were sharing that file with the object-storage pointer purely because
 * they reference it, and the report slice needed to extend them.
 */

export const exportJobStatusEnum = pgEnum('export_job_status', [
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
]);

/**
 * REQ-J-03: exports run as background jobs and land in a Downloads tray.
 *
 * `format`, `filename` and `progress` are migration 0010. Progress is a
 * percentage rather than a row count because the tray shows a bar and the
 * denominator is not known until the count query has run; the count itself is
 * `row_count`, written once at the end.
 *
 * There is deliberately no `expires_at` here. Retention belongs to the file
 * (REQ-J-03's seven days is `files.expires_at`, which the existing purge job
 * already sweeps), and a second copy of the date on this row would be a second
 * thing to keep in step with the only one that decides anything.
 */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    reportKey: text('report_key').notNull(),
    /** Recorded so REQ-J-06 can audit exactly what was exported, not just that something was. */
    filters: jsonb('filters').notNull(),

    status: exportJobStatusEnum('status').notNull().default('QUEUED'),
    /**
     * Text with a check constraint rather than a second enum: adding XLSX is
     * then one constraint change instead of an `ALTER TYPE`, and the value is
     * read by name in exactly one place.
     */
    format: text('format').notNull().default('CSV'),
    /** What the browser will call the file. Written at request time so the tray has a name to show while the job is still queued. */
    filename: text('filename'),
    /** 0-100. The tray reads it while the job runs; nothing else does. */
    progress: smallint('progress').notNull().default(0),

    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    rowCount: integer('row_count'),
    error: text('error'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),

    ...standardColumns(),
  },
  (t) => [index('export_jobs_requester_idx').on(t.orgId, t.requestedBy, t.createdAt.desc())],
);

/**
 * REQ-J-01: saved views on the shared report shell.
 *
 * The unique index (migration 0010) is on the lower-cased name, so "Late last
 * month" and "late last month" cannot both exist for one reader -- saving over
 * an existing view is the intended way to update it, and two views a reader
 * cannot tell apart is the failure that makes them stop using the feature.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportKey: text('report_key').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    ...standardColumns(),
  },
  (t) => [
    index('saved_views_lookup_idx').on(t.orgId, t.reportKey, t.userId),
    uniqueIndex('saved_views_name_unique_idx')
      .on(t.orgId, t.userId, t.reportKey, sql`lower(${t.name})`)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Customisable dashboards (owner, 25 Aug 2026): which report tiles a board
 * shows, per person. One row per (user, dashboard); no row means the shipped
 * preset renders, so a reset is a soft delete rather than a write of the
 * default -- the default lives in code, not in data.
 */
export const dashboardLayouts = pgTable(
  'dashboard_layouts',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dashboard: text('dashboard').notNull(),
    config: jsonb('config').notNull(),
    ...standardColumns(),
  },
  (t) => [
    index('dashboard_layouts_lookup_idx').on(t.orgId, t.userId),
    uniqueIndex('dashboard_layouts_unique_idx')
      .on(t.orgId, t.userId, t.dashboard)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const reportScheduleCadenceEnum = pgEnum('report_schedule_cadence', [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
]);

/**
 * REQ-J-05: a saved report configuration produced on a timer.
 *
 * The requirement says "emailed"; this product has no mail transport, so a run
 * lands in the Downloads tray instead -- the same file, the same seven-day
 * retention, the same signed URL. `packages/shared/src/reports.ts` carries the
 * reasoning for that substitution.
 *
 * Platform rather than attendance, beside `export_jobs` and for the same
 * reason: a schedule is a queued job that turns rows into a file, and the CRM
 * and ERP modules will schedule through it unchanged. What the attendance
 * module owns is which report exists and what a row of it looks like.
 *
 * There is deliberately no `from` or `to` in `filters`. The period a run covers
 * is derived from the cadence at run time (`scheduleWindow`), because a stored
 * range would export the same fortnight of August for ever while looking
 * entirely healthy.
 */
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * Whose schedule it is, and whose tray the file lands in. `cascade`,
     * unlike `export_jobs.requested_by`: a produced file is a record that has
     * to survive its requester leaving, but a schedule with no owner is a timer
     * nobody can see, edit or stop.
     */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    reportKey: text('report_key').notNull(),
    name: text('name').notNull(),
    filters: jsonb('filters').notNull(),
    columns: jsonb('columns').notNull(),
    sort: text('sort'),
    /** Text with a check constraint, matching `export_jobs.format`. */
    format: text('format').notNull().default('XLSX'),

    cadence: reportScheduleCadenceEnum('cadence').notNull(),
    /** On the organisation's wall clock (NFR-05), never the server's. */
    hour: smallint('hour').notNull(),
    minute: smallint('minute').notNull().default(0),
    /** Weekly only. ISO-8601, so 1 is Monday and 7 is Sunday. */
    weekday: smallint('weekday'),
    /** Monthly only, capped at 28 so no month can skip a run. */
    dayOfMonth: smallint('day_of_month'),

    isActive: boolean('is_active').notNull().default(true),

    /**
     * The organisation-local date this last produced a file for, and the
     * idempotency key the sweep tests. A date rather than an instant because
     * the question is "has it run today", and the sweep asks it every fifteen
     * minutes -- an instant would need a window comparison that is wrong twice
     * a year wherever the clocks change.
     */
    lastRunOn: date('last_run_on'),
    lastExportJobId: uuid('last_export_job_id').references(() => exportJobs.id, {
      onDelete: 'set null',
    }),

    ...standardColumns(),
  },
  (t) => [
    index('report_schedules_owner_idx').on(t.orgId, t.ownerUserId, t.createdAt.desc()),
    // The sweep's own query: every active schedule in the organisation. Partial
    // on `is_active` because a paused schedule is never a candidate and the
    // index should not carry it.
    index('report_schedules_due_idx')
      .on(t.orgId, t.cadence)
      .where(sql`is_active AND deleted_at IS NULL`),
  ],
);

/**
 * REQ-AD-09 / D14-6: who opened which report, when. The quarterly review of
 * the catalogue reads this — a report nobody has opened in ninety days is a
 * retirement candidate. Twelve months' retention, pruned by the same daily
 * sweep that sends the exception digests.
 */
export const reportUsage = pgTable(
  'report_usage',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    reportKey: text('report_key').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('report_usage_org_key_idx').on(t.orgId, t.reportKey, t.openedAt)],
);
