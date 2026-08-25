import type { AttendanceFlag } from '@vyuha/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { ALIVE, primaryId, standardColumns } from '../../../platform/db/columns.js';
import { employees, locations, organizations, users } from '../../../platform/db/schema/index.js';
import { leaveRequests } from './leave.schema.js';
import { punches } from './punch.schema.js';
import { shifts } from './shift.schema.js';

/**
 * REQ-E-02, in resolution order. The order of the values in this enum is the
 * order the engine resolves them in, and it matches `ATTENDANCE_STATUSES` in
 * `@vyuha/shared` value for value — `enum-parity.test.ts` fails if they drift.
 */
export const attendanceStatusEnum = pgEnum('attendance_status', [
  'HOLIDAY',
  'WEEKLY_OFF',
  'ON_LEAVE',
  'PRESENT',
  'HALF_DAY',
  'ON_DUTY',
  'PENDING',
  'ABSENT',
]);

/**
 * REQ-E-01: exactly one row per active employee per date, no gaps. Everything
 * in the product reports off this table, which is why the engine that writes
 * it is the piece technical design §5 calls "the single most important logic in
 * the product".
 *
 * The row is derived data. Nothing outside `DayEngine` writes it, and the
 * engine never reads its own previous output except to preserve
 * `is_manual_override` and the status an override pinned (technical design §5,
 * step 3).
 */
export const attendanceDays = pgTable(
  'attendance_days',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),

    shiftId: uuid('shift_id').references(() => shifts.id, { onDelete: 'set null' }),

    // Instants, not wall clock: the day engine resolves the shift's local
    // start and end against the location timezone for this specific date, and
    // for a midnight-crossing shift `scheduled_out` lands on the next date.
    scheduledIn: timestamp('scheduled_in', { withTimezone: true }),
    scheduledOut: timestamp('scheduled_out', { withTimezone: true }),

    firstInPunchId: uuid('first_in_punch_id').references(() => punches.id, {
      onDelete: 'restrict',
    }),
    lastOutPunchId: uuid('last_out_punch_id').references(() => punches.id, {
      onDelete: 'restrict',
    }),

    workedMinutes: integer('worked_minutes').notNull().default(0),
    breakMinutes: integer('break_minutes').notNull().default(0),
    /** REQ-E-05: a number of minutes. No rate, no multiplier, no money. */
    otMinutes: integer('ot_minutes').notNull().default(0),

    status: attendanceStatusEnum('status').notNull(),
    lateMinutes: integer('late_minutes').notNull().default(0),
    earlyExitMinutes: integer('early_exit_minutes').notNull().default(0),
    /** Owner, 21 Aug 2026: the early-arrival recognition. Minutes before start, the verdict, and the running streak. */
    earlyArrivalMinutes: integer('early_arrival_minutes').notNull().default(0),
    earlyArrival: boolean('early_arrival').notNull().default(false),
    earlyStreak: integer('early_streak').notNull().default(0),

    /** REQ-E-04. Independent of status; a day may carry several. */
    flags: text('flags')
      .array()
      .notNull()
      .$type<AttendanceFlag[]>()
      .default(sql`'{}'::text[]`),

    /** Set on ON_LEAVE and on the REQ-E-02 half-day-leave-plus-worked-half case. */
    leaveRequestId: uuid('leave_request_id').references(() => leaveRequests.id, {
      onDelete: 'set null',
    }),

    /** REQ-E-08. The reason, the actor and the moment are all required. */
    isManualOverride: boolean('is_manual_override').notNull().default(false),
    overrideReason: text('override_reason'),
    overrideBy: uuid('override_by').references(() => users.id, { onDelete: 'set null' }),
    overrideAt: timestamp('override_at', { withTimezone: true }),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    /** REQ-E-09: stamped when the period lock is applied, read by every writer. */
    locked: boolean('locked').notNull().default(false),

    ...standardColumns(),
  },
  (t) => [
    // Technical design §4.3, all three verbatim.
    index('attendance_days_muster_idx').on(t.orgId, t.date, t.employeeId),
    index('attendance_days_timeline_idx').on(t.orgId, t.employeeId, t.date),
    // The partial one. Absentees are a small fraction of rows, so the index is
    // a fraction of the size and the absenteeism report never touches a
    // present day.
    index('attendance_days_absent_idx')
      .on(t.orgId, t.date)
      .where(sql`status = 'ABSENT'`),

    // REQ-E-01's "exactly one row per employee per date", enforced rather than
    // intended. No `deleted_at IS NULL` predicate: a soft-deleted day would
    // otherwise let a second row exist for the same date, and the engine's
    // upsert needs an unconditional conflict target.
    uniqueIndex('attendance_days_employee_date_uq').on(t.employeeId, t.date),

    check('attendance_days_worked_minutes_non_negative', sql`worked_minutes >= 0`),
    // REQ-E-08: an override without a reason is an unexplained edit to the
    // record that payroll is computed from.
    check(
      'attendance_days_override_has_reason',
      sql`is_manual_override = false OR override_reason IS NOT NULL`,
    ),
  ],
);

/**
 * REQ-E-09. A null `location_id` is an org-wide lock; 05-decisions ships the
 * per-location variant hidden because there is one location today.
 *
 * Unlocking writes `unlocked_at` on the existing row rather than deleting it,
 * so "who locked March, who unlocked it, and why" survives — REQ-E-09 requires
 * both actions be audited, and a deleted row audits badly.
 */
export const attendancePeriodLocks = pgTable(
  'attendance_period_locks',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
    year: integer('year').notNull(),
    month: integer('month').notNull(),
    lockedBy: uuid('locked_by').references(() => users.id, { onDelete: 'set null' }),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    unlockedBy: uuid('unlocked_by').references(() => users.id, { onDelete: 'set null' }),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }),
    /**
     * REQ-E-09 requires a reason for both actions, and one column cannot hold
     * two — an unlock would overwrite the reason the month was closed for.
     * Renamed from `reason` in migration 0011; both are enforced by NOT VALID
     * CHECKs, so every lock and unlock from here on carries a real sentence
     * while the rows written before the rule existed are left as they are.
     */
    /**
     * Why the period was closed. REQ-E-09 requires one, so the column does
     * too: it was nullable, and the CHECK beside it compares
     * char_length(btrim(lock_reason)) >= 10 -- which is NULL when the reason
     * is NULL, and a CHECK only refuses on FALSE. The rule the slice was
     * written for passed anything that simply left the reason out.
     */
    lockReason: text('lock_reason').notNull(),
    unlockReason: text('unlock_reason'),
    ...standardColumns(),
  },
  (t) => [
    // At most one *live* lock per scope and period. COALESCE for the same
    // reason `settings_scope_key_uq` needs it: Postgres treats NULLs as
    // distinct, so the org-wide row would otherwise be unlimited.
    uniqueIndex('attendance_period_locks_uq')
      .on(
        t.orgId,
        sql`coalesce(${t.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.year,
        t.month,
      )
      .where(sql`deleted_at IS NULL AND unlocked_at IS NULL`),
    index('attendance_period_locks_period_idx').on(t.orgId, t.year, t.month).where(ALIVE),
    check('attendance_period_locks_month_valid', sql`month BETWEEN 1 AND 12`),
    /*
     * Declared here as well as in migration 0011, so drizzle's snapshot
     * records them and the next generate does not propose adding them again.
     * The unlock rule names the null explicitly: without that clause an
     * unlock with no reason at all satisfied it, which is the one thing
     * REQ-E-09 asks the database to prevent.
     */
    check('attendance_period_locks_lock_has_reason', sql`char_length(btrim(lock_reason)) >= 10`),
    check(
      'attendance_period_locks_unlock_has_reason',
      sql`unlocked_at IS NULL OR (unlock_reason IS NOT NULL AND char_length(btrim(unlock_reason)) >= 10)`,
    ),
  ],
);
