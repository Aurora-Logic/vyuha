import {
  roundLeaveDays,
  type ApprovalStatus,
  type EmploymentType,
  type LeaveDayPortion,
  type LeaveMovementType,
} from '@vyuha/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../../platform/db/db.provider.js';
import {
  departments,
  employees,
  locations,
  organizations,
  settings,
  users,
} from '../../../platform/db/schema/index.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { employeeNameSql } from '../../../platform/people/employee-name.js';
import { parseWeeklyOffConfig, type WeeklyOffConfig } from '../day-engine/weekly-off.js';
import {
  attendancePeriodLocks,
  compOffCredits,
  leaveBalances,
  leaveLedger,
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
} from '../schema/index.js';
import type { ProjectedBalance } from './leave-balance.js';

/**
 * Every query the leave slice runs.
 *
 * `ScopedRepository` is not the base class, for the reason `DayEngineRepository`
 * gives: `leave_ledger` has no soft-delete columns and most of the reads here
 * are joins or aggregates rather than single-table selects. The rule it exists
 * to enforce still holds -- every statement below filters `org_id` from `ctx`,
 * and `deleted_at IS NULL` wherever the table has one -- and `orgScoped()` is
 * the single helper that does it, so a new query cannot start from an empty
 * WHERE by accident.
 */

/** Settings this slice reads (REQ-L-02 puts org policy in `settings`). */
export const LEAVE_SETTING_KEYS = {
  /** REQ-G-04: "leave year start month is configurable (default April)". */
  yearStartMonth: 'leave.year_start_month',
  /** REQ-G-11: "credits expire 30 days after the earned date (configurable)". */
  compOffExpiryDays: 'leave.comp_off_expiry_days',
  /** REQ-G-12: per-department concurrent-absence warning threshold. */
  concurrentAbsenceThreshold: 'leave.concurrent_absence_threshold',
} as const;

export interface EmployeeLeaveContext {
  readonly id: string;
  readonly name: string;
  readonly dateOfJoining: string;
  readonly dateOfLeaving: string | null;
  readonly employmentType: EmploymentType;
  readonly locationId: string | null;
  /** The employee's own calendar, falling back to the location's. */
  readonly holidayCalendarId: string | null;
  readonly weeklyOffPatternId: string | null;
}

export interface LeaveTypeRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isPaid: boolean;
  readonly accrualMethod: 'NONE' | 'MONTHLY' | 'YEARLY' | 'ON_JOINING';
  readonly annualEntitlement: number;
  readonly carryForwardAllowed: boolean;
  readonly carryForwardCap: number | null;
  readonly negativeBalanceLimit: number;
  readonly isEncashable: boolean;
  readonly allowsHalfDay: boolean;
  readonly minDays: number | null;
  readonly maxDays: number | null;
  readonly noticeDays: number;
  readonly attachmentRequiredAfterDays: number | null;
  readonly countsSandwichDays: boolean;
  readonly requiresTwoStepApproval: boolean;
  readonly applicableEmploymentTypes: string[];
  readonly isActive: boolean;
}

export interface LedgerRow {
  readonly id: string;
  readonly leaveTypeId: string;
  readonly leaveYear: number;
  readonly movementType: LeaveMovementType;
  readonly days: number;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface LedgerAppend {
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly leaveYear: number;
  readonly movementType: LeaveMovementType;
  readonly days: number;
  readonly referenceType?: string | null;
  readonly referenceId?: string | null;
  readonly note?: string | null;
  /** Set only by a scheduled job; the unique index makes a retry a no-op. */
  readonly periodKey?: string | null;
}

export interface LeaveRequestRow {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly leaveTypeCode: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly totalDays: number;
  readonly reason: string | null;
  readonly status: ApprovalStatus;
  readonly attachmentFileId: string | null;
  readonly approvalRequestId: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly decidedByName: string | null;
  readonly decisionReason: string | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
}

export interface CompOffCreditRow {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly leaveTypeCode: string;
  readonly earnedForDate: string;
  readonly days: number;
  readonly expiresOn: string;
  readonly consumedByLeaveRequestId: string | null;
  readonly lapsedAt: Date | null;
  readonly expiryWarnedDays: number | null;
  readonly createdAt: Date;
}

/** `employees.first_name` plus the surname when there is one. */
const employeeName = employeeNameSql(employees.firstName, employees.lastName);

export class LeaveRepository {
  constructor(
    private readonly db: Database,
    private readonly ctx: OrgContext,
  ) {}

  /**
   * Runs `fn` against a repository bound to one transaction.
   *
   * Needed wherever a ledger append and a status change have to land together.
   * `leave_ledger` is append-only, so a ledger row written by a step whose
   * partner then failed cannot be taken back -- and a retry would post a
   * second one. A transaction is what makes "approved and deducted" a single
   * fact rather than two that usually agree.
   */
  async transaction<T>(
    fn: (repository: LeaveRepository, executor: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => fn(new LeaveRepository(tx, this.ctx), tx));
  }

  /**
   * The same repository bound to somebody else's transaction.
   *
   * The approval framework hands its handler the executor the decision is
   * running in, and the leave writes that decision causes have to land in it --
   * a ledger row committed separately from the approval that caused it is the
   * pair of facts this whole join exists to keep together.
   */
  on(executor: Database): LeaveRepository {
    return new LeaveRepository(executor, this.ctx);
  }

  /** Mirrors `ScopedRepository.scoped()`; see the class comment. */
  private orgScoped(orgPredicate: SQL, ...extra: (SQL | undefined)[]): SQL {
    const predicate = and(orgPredicate, ...extra);
    if (predicate === undefined) {
      throw new Error('Scope predicate collapsed to undefined; refusing to run an unscoped query.');
    }
    return predicate;
  }

  // ------------------------------------------------------------- settings

  private async readOrgSetting(key: string): Promise<unknown> {
    const rows = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(
        this.orgScoped(
          eq(settings.orgId, this.ctx.orgId),
          eq(settings.scope, 'ORG'),
          isNull(settings.scopeId),
          eq(settings.key, key),
          isNull(settings.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.value;
  }

  /**
   * A whole number from `settings`, or the caller's default.
   *
   * Throws on a malformed value rather than falling back, for the reason the
   * day engine gives about its own settings: a configuration mistake that
   * silently reverts to a default is a mistake nobody finds, and here it would
   * quietly move everybody's leave year.
   */
  async readIntSetting(key: string, fallback: number, min: number, max: number): Promise<number> {
    const value = await this.readOrgSetting(key);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `Setting "${key}" must be a whole number between ${String(min)} and ${String(max)}; found ${JSON.stringify(value)}.`,
      );
    }
    return value;
  }

  // -------------------------------------------------------------- calendar

  async findEmployee(employeeId: string): Promise<EmployeeLeaveContext | null> {
    const rows = await this.db
      .select({
        id: employees.id,
        name: employeeName,
        dateOfJoining: employees.dateOfJoining,
        dateOfLeaving: employees.dateOfLeaving,
        employmentType: employees.employmentType,
        locationId: employees.locationId,
        holidayCalendarId: sql<
          string | null
        >`coalesce(${employees.holidayCalendarId}, ${locations.holidayCalendarId})`,
        weeklyOffPatternId: employees.weeklyOffPatternId,
      })
      .from(employees)
      .leftJoin(locations, and(eq(locations.id, employees.locationId), isNull(locations.deletedAt)))
      .where(
        this.orgScoped(
          eq(employees.orgId, this.ctx.orgId),
          eq(employees.id, employeeId),
          isNull(employees.deletedAt),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * The live login belonging to an employee, if they have one (REQ-B-02).
   *
   * REQ-I-05 is written about the *requester*, so an approval for somebody's
   * leave has to name that somebody -- not whoever typed the application in.
   * HR applying on behalf of an employee (REQ-G-06) would otherwise produce a
   * request the employee themselves could approve, and one the employee's own
   * manager could not see under the inbox's requester-scoped predicate.
   */
  async findUserIdForEmployee(employeeId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        this.orgScoped(
          eq(users.orgId, this.ctx.orgId),
          eq(users.employeeId, employeeId),
          isNull(users.deletedAt),
          eq(users.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(users.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Every holiday in the range, as a set of dates.
   *
   * A restricted holiday (REQ-H-03) is deliberately excluded unless the
   * employee elected it: it is only a holiday for the people who chose it, and
   * treating it as one for everybody would skip a day the rest of the office
   * is expected to work.
   */
  async findHolidayDates(
    employee: EmployeeLeaveContext,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const calendarId = employee.holidayCalendarId;
    if (calendarId === null) return new Set();

    const rows = await this.db.execute<{ date: string }>(sql`
      SELECT h.date::text AS date
        FROM holidays h
        LEFT JOIN restricted_holiday_elections e
          ON e.holiday_id = h.id
         AND e.employee_id = ${employee.id}
         AND e.deleted_at IS NULL
       WHERE h.org_id = ${this.ctx.orgId}
         AND h.calendar_id = ${calendarId}
         AND h.deleted_at IS NULL
         AND h.date BETWEEN ${from} AND ${to}
         AND (h.is_restricted = false OR e.id IS NOT NULL)
    `);

    return new Set(rows.rows.map((row) => row.date));
  }

  /** REQ-C-03. Employee pattern first, then the org-level default. */
  async findWeeklyOffConfig(employee: EmployeeLeaveContext): Promise<WeeklyOffConfig | null> {
    const patternId =
      employee.weeklyOffPatternId ??
      (await this.readOrgSetting('attendance.default_weekly_off_pattern_id'));
    if (typeof patternId !== 'string' || patternId.length === 0) return null;

    const rows = await this.db.execute<{ id: string; config: unknown }>(sql`
      SELECT id, config FROM weekly_off_patterns
       WHERE org_id = ${this.ctx.orgId} AND id = ${patternId}::uuid AND deleted_at IS NULL
       LIMIT 1
    `);

    const row = rows.rows[0];
    if (row === undefined) return null;
    return parseWeeklyOffConfig(row.config, row.id);
  }

  /** REQ-E-09 / REQ-G-07: "date not in a locked period". */
  async findLockedMonths(
    locationId: string | null,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const rows = await this.db
      .select({ year: attendancePeriodLocks.year, month: attendancePeriodLocks.month })
      .from(attendancePeriodLocks)
      .where(
        this.orgScoped(
          eq(attendancePeriodLocks.orgId, this.ctx.orgId),
          isNull(attendancePeriodLocks.deletedAt),
          isNull(attendancePeriodLocks.unlockedAt),
          // An org-wide lock has no location and covers everybody.
          locationId === null
            ? isNull(attendancePeriodLocks.locationId)
            : or(
                isNull(attendancePeriodLocks.locationId),
                eq(attendancePeriodLocks.locationId, locationId),
              ),
          gte(
            sql`${attendancePeriodLocks.year} * 100 + ${attendancePeriodLocks.month}`,
            Number(from.slice(0, 4)) * 100 + Number(from.slice(5, 7)),
          ),
          lte(
            sql`${attendancePeriodLocks.year} * 100 + ${attendancePeriodLocks.month}`,
            Number(to.slice(0, 4)) * 100 + Number(to.slice(5, 7)),
          ),
        ),
      );

    return new Set(
      rows.map((row) => `${String(row.year)}-${String(row.month).padStart(2, '0')}`),
    );
  }

  // ----------------------------------------------------------- leave types

  async listLeaveTypes(options: {
    active?: boolean;
    limit: number;
    offset: number;
  }): Promise<{ rows: LeaveTypeRow[]; total: number }> {
    const where = this.orgScoped(
      eq(leaveTypes.orgId, this.ctx.orgId),
      isNull(leaveTypes.deletedAt),
      options.active === undefined ? undefined : eq(leaveTypes.isActive, options.active),
    );

    const rows = await this.db
      .select(this.leaveTypeColumns())
      .from(leaveTypes)
      .where(where)
      .orderBy(desc(leaveTypes.isActive), asc(leaveTypes.name))
      .limit(options.limit)
      .offset(options.offset);

    const counted = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(leaveTypes)
      .where(where);

    return { rows, total: counted[0]?.value ?? 0 };
  }

  async findLeaveType(id: string): Promise<LeaveTypeRow | null> {
    const rows = await this.db
      .select(this.leaveTypeColumns())
      .from(leaveTypes)
      .where(
        this.orgScoped(
          eq(leaveTypes.orgId, this.ctx.orgId),
          eq(leaveTypes.id, id),
          isNull(leaveTypes.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findLeaveTypeByCode(code: string): Promise<LeaveTypeRow | null> {
    const rows = await this.db
      .select(this.leaveTypeColumns())
      .from(leaveTypes)
      .where(
        this.orgScoped(
          eq(leaveTypes.orgId, this.ctx.orgId),
          eq(leaveTypes.code, code),
          isNull(leaveTypes.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insertLeaveType(values: typeof leaveTypes.$inferInsert): Promise<LeaveTypeRow> {
    const now = new Date();
    const rows = await this.db
      .insert(leaveTypes)
      .values({
        ...values,
        orgId: this.ctx.orgId,
        createdAt: now,
        updatedAt: now,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
        deletedAt: null,
      })
      .returning(this.leaveTypeColumns());

    const row = rows[0];
    if (row === undefined) throw new Error('Leave type insert returned no row.');
    return row;
  }

  async updateLeaveType(
    id: string,
    values: Partial<typeof leaveTypes.$inferInsert>,
  ): Promise<LeaveTypeRow | null> {
    const rows = await this.db
      .update(leaveTypes)
      .set({ ...values, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(
        this.orgScoped(
          eq(leaveTypes.orgId, this.ctx.orgId),
          eq(leaveTypes.id, id),
          isNull(leaveTypes.deletedAt),
        ),
      )
      .returning(this.leaveTypeColumns());
    return rows[0] ?? null;
  }

  private leaveTypeColumns() {
    return {
      id: leaveTypes.id,
      name: leaveTypes.name,
      code: leaveTypes.code,
      isPaid: leaveTypes.isPaid,
      accrualMethod: leaveTypes.accrualMethod,
      annualEntitlement: leaveTypes.annualEntitlement,
      carryForwardAllowed: leaveTypes.carryForwardAllowed,
      carryForwardCap: leaveTypes.carryForwardCap,
      negativeBalanceLimit: leaveTypes.negativeBalanceLimit,
      isEncashable: leaveTypes.isEncashable,
      allowsHalfDay: leaveTypes.allowsHalfDay,
      minDays: leaveTypes.minDays,
      maxDays: leaveTypes.maxDays,
      noticeDays: leaveTypes.noticeDays,
      attachmentRequiredAfterDays: leaveTypes.attachmentRequiredAfterDays,
      countsSandwichDays: leaveTypes.countsSandwichDays,
      requiresTwoStepApproval: leaveTypes.requiresTwoStepApproval,
      applicableEmploymentTypes: leaveTypes.applicableEmploymentTypes,
      isActive: leaveTypes.isActive,
    } as const;
  }

  // ---------------------------------------------------------------- ledger

  /**
   * REQ-G-03. The only writer of `leave_ledger`, and it only ever appends --
   * the table refuses anything else (migration 0004's trigger).
   *
   * `onConflictDoNothing` on the period index is what makes a retried
   * scheduled job safe: the second attempt inserts nothing and reports it,
   * rather than doubling an accrual that can never be taken back.
   */
  async appendLedger(entries: readonly LedgerAppend[]): Promise<number> {
    if (entries.length === 0) return 0;

    const rows = await this.db
      .insert(leaveLedger)
      .values(
        entries.map((entry) => ({
          orgId: this.ctx.orgId,
          employeeId: entry.employeeId,
          leaveTypeId: entry.leaveTypeId,
          leaveYear: entry.leaveYear,
          movementType: entry.movementType,
          days: roundLeaveDays(entry.days),
          referenceType: entry.referenceType ?? null,
          referenceId: entry.referenceId ?? null,
          note: entry.note ?? null,
          periodKey: entry.periodKey ?? null,
          createdBy: this.ctx.actorUserId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: leaveLedger.id });

    return rows.length;
  }

  /** Every movement for one employee, type and year, oldest first. */
  async readLedger(
    employeeId: string,
    leaveYear: number,
    leaveTypeId?: string,
  ): Promise<LedgerRow[]> {
    return this.db
      .select({
        id: leaveLedger.id,
        leaveTypeId: leaveLedger.leaveTypeId,
        leaveYear: leaveLedger.leaveYear,
        movementType: leaveLedger.movementType,
        days: leaveLedger.days,
        referenceType: leaveLedger.referenceType,
        referenceId: leaveLedger.referenceId,
        note: leaveLedger.note,
        createdAt: leaveLedger.createdAt,
      })
      .from(leaveLedger)
      .where(
        this.orgScoped(
          eq(leaveLedger.orgId, this.ctx.orgId),
          eq(leaveLedger.employeeId, employeeId),
          eq(leaveLedger.leaveYear, leaveYear),
          leaveTypeId === undefined ? undefined : eq(leaveLedger.leaveTypeId, leaveTypeId),
        ),
      )
      .orderBy(asc(leaveLedger.createdAt), asc(leaveLedger.id));
  }

  // -------------------------------------------------------------- balances

  /**
   * Writes the projection back into the cache row.
   *
   * The check constraint added in migration 0009 is what makes this safe to
   * call from anywhere: a projection that does not close correctly is refused
   * by the database, not merely by the code that computed it.
   */
  async upsertBalance(
    employeeId: string,
    leaveTypeId: string,
    leaveYear: number,
    balance: ProjectedBalance,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insert(leaveBalances)
      .values({
        orgId: this.ctx.orgId,
        employeeId,
        leaveTypeId,
        leaveYear,
        ...balance,
        createdAt: now,
        updatedAt: now,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
      })
      .onConflictDoUpdate({
        target: [leaveBalances.employeeId, leaveBalances.leaveTypeId, leaveBalances.leaveYear],
        targetWhere: isNull(leaveBalances.deletedAt),
        set: { ...balance, updatedAt: now, updatedBy: this.ctx.actorUserId },
      });
  }

  async readBalances(
    employeeId: string,
    leaveYear: number,
  ): Promise<
    { leaveTypeId: string; leaveTypeName: string; leaveTypeCode: string; balance: ProjectedBalance }[]
  > {
    const rows = await this.db
      .select({
        leaveTypeId: leaveBalances.leaveTypeId,
        leaveTypeName: leaveTypes.name,
        leaveTypeCode: leaveTypes.code,
        opening: leaveBalances.opening,
        accrued: leaveBalances.accrued,
        availed: leaveBalances.availed,
        adjusted: leaveBalances.adjusted,
        carriedForward: leaveBalances.carriedForward,
        closing: leaveBalances.closing,
      })
      .from(leaveBalances)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
      .where(
        this.orgScoped(
          eq(leaveBalances.orgId, this.ctx.orgId),
          eq(leaveBalances.employeeId, employeeId),
          eq(leaveBalances.leaveYear, leaveYear),
          isNull(leaveBalances.deletedAt),
          isNull(leaveTypes.deletedAt),
        ),
      )
      .orderBy(asc(leaveTypes.name));

    return rows.map(({ leaveTypeId, leaveTypeName, leaveTypeCode, ...balance }) => ({
      leaveTypeId,
      leaveTypeName,
      leaveTypeCode,
      balance,
    }));
  }

  // -------------------------------------------------------------- requests

  /**
   * REQ-G-07's overlap check.
   *
   * Compares counted days rather than the request's outer range: a leave that
   * ends on Friday and one that starts on the following Monday overlap on the
   * weekend as ranges, and refusing that pair would be wrong.
   *
   * CANCELLED and REJECTED requests are excluded -- they consume nothing, and
   * a rejected application must not block the corrected one that replaces it.
   */
  async findOverlappingDates(
    employeeId: string,
    dates: readonly string[],
    excludeRequestId?: string,
  ): Promise<string[]> {
    if (dates.length === 0) return [];

    const rows = await this.db
      .selectDistinct({ date: leaveRequestDays.date })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.leaveRequestId))
      .where(
        this.orgScoped(
          eq(leaveRequestDays.orgId, this.ctx.orgId),
          inArray(leaveRequestDays.date, [...dates]),
          eq(leaveRequestDays.isCounted, true),
          isNull(leaveRequestDays.deletedAt),
          eq(leaveRequests.employeeId, employeeId),
          inArray(leaveRequests.status, ['PENDING', 'APPROVED', 'ESCALATED']),
          isNull(leaveRequests.cancelledAt),
          isNull(leaveRequests.deletedAt),
          excludeRequestId === undefined ? undefined : ne(leaveRequests.id, excludeRequestId),
        ),
      );

    return rows.map((row) => row.date);
  }

  async insertRequest(
    values: {
      employeeId: string;
      leaveTypeId: string;
      fromDate: string;
      toDate: string;
      totalDays: number;
      reason: string | null;
      attachmentFileId: string | null;
    },
    days: readonly { date: string; portion: LeaveDayPortion; isCounted: boolean }[],
  ): Promise<string> {
    const now = new Date();
    const inserted = await this.db
      .insert(leaveRequests)
      .values({
        ...values,
        orgId: this.ctx.orgId,
        totalDays: roundLeaveDays(values.totalDays),
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
      })
      .returning({ id: leaveRequests.id });

    const row = inserted[0];
    if (row === undefined) throw new Error('Leave request insert returned no row.');

    if (days.length > 0) {
      await this.db.insert(leaveRequestDays).values(
        days.map((day) => ({
          orgId: this.ctx.orgId,
          leaveRequestId: row.id,
          date: day.date,
          portion: day.portion,
          isCounted: day.isCounted,
          createdAt: now,
          updatedAt: now,
          createdBy: this.ctx.actorUserId,
          updatedBy: this.ctx.actorUserId,
        })),
      );
    }

    return row.id;
  }

  async findRequest(id: string, scope?: SQL): Promise<LeaveRequestRow | null> {
    const rows = await this.db
      .select(this.requestColumns())
      .from(leaveRequests)
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(
        this.orgScoped(
          eq(leaveRequests.orgId, this.ctx.orgId),
          eq(leaveRequests.id, id),
          isNull(leaveRequests.deletedAt),
          scope,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The request's status, with the row locked for the rest of the transaction.
   *
   * Cancellation branches on the status it reads -- an approved leave needs a
   * REVERSAL row and a pending one must not get one -- and a plain read makes
   * that a check-then-act. An approval committing in the gap would leave the
   * AVAILED row standing with nothing to reverse it, which the append-only
   * ledger has no way to correct afterwards. `FOR UPDATE` is what makes the
   * read and the write one decision.
   *
   * Single-table on purpose: `findRequest` joins employees and leave types,
   * and locking those as well would have a cancellation queue behind an
   * unrelated edit to the employee.
   */
  async lockRequestStatus(id: string): Promise<ApprovalStatus | null> {
    const rows = await this.db
      .select({ status: leaveRequests.status })
      .from(leaveRequests)
      .where(
        this.orgScoped(
          eq(leaveRequests.orgId, this.ctx.orgId),
          eq(leaveRequests.id, id),
          isNull(leaveRequests.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    return rows[0]?.status ?? null;
  }

  async findRequestDays(
    requestId: string,
  ): Promise<{ date: string; portion: LeaveDayPortion; isCounted: boolean }[]> {
    return this.db
      .select({
        date: leaveRequestDays.date,
        portion: leaveRequestDays.portion,
        isCounted: leaveRequestDays.isCounted,
      })
      .from(leaveRequestDays)
      .where(
        this.orgScoped(
          eq(leaveRequestDays.orgId, this.ctx.orgId),
          eq(leaveRequestDays.leaveRequestId, requestId),
          isNull(leaveRequestDays.deletedAt),
        ),
      )
      .orderBy(asc(leaveRequestDays.date));
  }

  async listRequests(options: {
    scope: SQL;
    status?: ApprovalStatus;
    employeeId?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: LeaveRequestRow[]; total: number }> {
    const where = this.orgScoped(
      eq(leaveRequests.orgId, this.ctx.orgId),
      isNull(leaveRequests.deletedAt),
      options.scope,
      options.status === undefined ? undefined : eq(leaveRequests.status, options.status),
      options.employeeId === undefined ? undefined : eq(leaveRequests.employeeId, options.employeeId),
      // A range filter asks "which leaves touch these dates", so the
      // comparison is against the far end of each -- not both ends of one.
      options.to === undefined ? undefined : lte(leaveRequests.fromDate, options.to),
      options.from === undefined ? undefined : gte(leaveRequests.toDate, options.from),
    );

    const rows = await this.db
      .select(this.requestColumns())
      .from(leaveRequests)
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(where)
      .orderBy(desc(leaveRequests.fromDate), desc(leaveRequests.id))
      .limit(options.limit)
      .offset(options.offset);

    const counted = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(leaveRequests)
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(where);

    return { rows, total: counted[0]?.value ?? 0 };
  }

  async updateRequest(
    id: string,
    values: Partial<typeof leaveRequests.$inferInsert>,
  ): Promise<LeaveRequestRow | null> {
    const updated = await this.db
      .update(leaveRequests)
      .set({ ...values, updatedAt: new Date(), updatedBy: this.ctx.actorUserId })
      .where(
        this.orgScoped(
          eq(leaveRequests.orgId, this.ctx.orgId),
          eq(leaveRequests.id, id),
          isNull(leaveRequests.deletedAt),
        ),
      )
      .returning({ id: leaveRequests.id });

    return updated.length === 0 ? null : this.findRequest(id);
  }

  private requestColumns() {
    return {
      id: leaveRequests.id,
      employeeId: leaveRequests.employeeId,
      employeeName,
      leaveTypeId: leaveRequests.leaveTypeId,
      leaveTypeName: leaveTypes.name,
      leaveTypeCode: leaveTypes.code,
      fromDate: leaveRequests.fromDate,
      toDate: leaveRequests.toDate,
      totalDays: leaveRequests.totalDays,
      reason: leaveRequests.reason,
      status: leaveRequests.status,
      attachmentFileId: leaveRequests.attachmentFileId,
      approvalRequestId: leaveRequests.approvalRequestId,
      createdAt: leaveRequests.createdAt,
      decidedAt: leaveRequests.decidedAt,
      decidedBy: leaveRequests.decidedBy,
      // Resolved through the decider's own employee row when they have one;
      // an escalation decided by a job has neither and reads as null.
      decidedByName: sql<string | null>`(
        SELECT ${employeeNameSql(sql`e.first_name`, sql`e.last_name`)}
          FROM users u JOIN employees e ON e.id = u.employee_id AND e.org_id = ${leaveRequests.orgId}
         WHERE u.id = ${leaveRequests.decidedBy} AND u.org_id = ${leaveRequests.orgId} AND e.deleted_at IS NULL
      )`,
      decisionReason: leaveRequests.decisionReason,
      cancelledAt: leaveRequests.cancelledAt,
      cancellationReason: leaveRequests.cancellationReason,
    } as const;
  }

  // -------------------------------------------------------------- comp-off

  async insertCompOff(values: {
    employeeId: string;
    leaveTypeId: string;
    earnedForDate: string;
    days: number;
    expiresOn: string;
  }): Promise<string> {
    const now = new Date();
    const rows = await this.db
      .insert(compOffCredits)
      .values({
        ...values,
        orgId: this.ctx.orgId,
        days: roundLeaveDays(values.days),
        createdAt: now,
        updatedAt: now,
        createdBy: this.ctx.actorUserId,
        updatedBy: this.ctx.actorUserId,
      })
      .returning({ id: compOffCredits.id });

    const row = rows[0];
    if (row === undefined) throw new Error('Comp-off credit insert returned no row.');
    return row.id;
  }

  async listCompOff(options: {
    scope: SQL;
    employeeId?: string;
    state?: 'ACTIVE' | 'LAPSED' | 'CONSUMED';
    limit: number;
    offset: number;
  }): Promise<{ rows: CompOffCreditRow[]; total: number }> {
    const stateFilter =
      options.state === 'LAPSED'
        ? sql`${compOffCredits.lapsedAt} IS NOT NULL`
        : options.state === 'CONSUMED'
          ? sql`${compOffCredits.consumedByLeaveRequestId} IS NOT NULL`
          : options.state === 'ACTIVE'
            ? sql`${compOffCredits.lapsedAt} IS NULL AND ${compOffCredits.consumedByLeaveRequestId} IS NULL`
            : undefined;

    const where = this.orgScoped(
      eq(compOffCredits.orgId, this.ctx.orgId),
      isNull(compOffCredits.deletedAt),
      options.scope,
      options.employeeId === undefined ? undefined : eq(compOffCredits.employeeId, options.employeeId),
      stateFilter,
    );

    const columns = {
      id: compOffCredits.id,
      employeeId: compOffCredits.employeeId,
      employeeName,
      leaveTypeId: compOffCredits.leaveTypeId,
      leaveTypeName: leaveTypes.name,
      leaveTypeCode: leaveTypes.code,
      earnedForDate: compOffCredits.earnedForDate,
      days: compOffCredits.days,
      expiresOn: compOffCredits.expiresOn,
      consumedByLeaveRequestId: compOffCredits.consumedByLeaveRequestId,
      lapsedAt: compOffCredits.lapsedAt,
      expiryWarnedDays: compOffCredits.expiryWarnedDays,
      createdAt: compOffCredits.createdAt,
    } as const;

    const rows = await this.db
      .select(columns)
      .from(compOffCredits)
      .innerJoin(employees, eq(employees.id, compOffCredits.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, compOffCredits.leaveTypeId))
      .where(where)
      .orderBy(desc(compOffCredits.earnedForDate), desc(compOffCredits.id))
      .limit(options.limit)
      .offset(options.offset);

    const counted = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(compOffCredits)
      .innerJoin(employees, eq(employees.id, compOffCredits.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, compOffCredits.leaveTypeId))
      .where(where);

    return { rows, total: counted[0]?.value ?? 0 };
  }

  /** The sweep's working set: credits still standing on or before `asOf`. */
  async findCompOffExpiringOnOrBefore(asOf: string): Promise<CompOffCreditRow[]> {
    return this.db
      .select({
        id: compOffCredits.id,
        employeeId: compOffCredits.employeeId,
        employeeName,
        leaveTypeId: compOffCredits.leaveTypeId,
        leaveTypeName: leaveTypes.name,
        leaveTypeCode: leaveTypes.code,
        earnedForDate: compOffCredits.earnedForDate,
        days: compOffCredits.days,
        expiresOn: compOffCredits.expiresOn,
        consumedByLeaveRequestId: compOffCredits.consumedByLeaveRequestId,
        lapsedAt: compOffCredits.lapsedAt,
        expiryWarnedDays: compOffCredits.expiryWarnedDays,
        createdAt: compOffCredits.createdAt,
      })
      .from(compOffCredits)
      .innerJoin(employees, eq(employees.id, compOffCredits.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, compOffCredits.leaveTypeId))
      .where(
        this.orgScoped(
          eq(compOffCredits.orgId, this.ctx.orgId),
          isNull(compOffCredits.deletedAt),
          isNull(compOffCredits.lapsedAt),
          isNull(compOffCredits.consumedByLeaveRequestId),
          lte(compOffCredits.expiresOn, asOf),
        ),
      )
      .orderBy(asc(compOffCredits.expiresOn));
  }

  /**
   * REQ-G-11's 7-day and 2-day warnings.
   *
   * Stores the threshold rather than a boolean, so a sweep that missed the
   * 7-day mark still sends the 2-day one instead of concluding "already
   * warned" and saying nothing.
   */
  async recordCompOffWarning(id: string, thresholdDays: number, at: Date): Promise<void> {
    await this.db
      .update(compOffCredits)
      .set({ expiryWarnedDays: thresholdDays, updatedAt: at, updatedBy: this.ctx.actorUserId })
      .where(
        this.orgScoped(
          eq(compOffCredits.orgId, this.ctx.orgId),
          eq(compOffCredits.id, id),
          isNull(compOffCredits.deletedAt),
        ),
      );
  }

  async markCompOffLapsed(ids: readonly string[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .update(compOffCredits)
      .set({ lapsedAt: at, updatedAt: at, updatedBy: this.ctx.actorUserId })
      .where(
        this.orgScoped(
          eq(compOffCredits.orgId, this.ctx.orgId),
          inArray(compOffCredits.id, [...ids]),
          isNull(compOffCredits.lapsedAt),
          isNull(compOffCredits.deletedAt),
        ),
      )
      .returning({ id: compOffCredits.id });
    return rows.length;
  }

  // ------------------------------------------------------------- calendar

  /** REQ-G-12. Approved leave only: a pending request is not an absence yet. */
  async listCalendarEntries(options: {
    scope: SQL;
    from: string;
    to: string;
    departmentId?: string;
  }): Promise<
    {
      employeeId: string;
      employeeName: string;
      departmentId: string | null;
      departmentName: string | null;
      leaveTypeId: string;
      leaveTypeName: string;
      leaveTypeCode: string;
      date: string;
      portion: LeaveDayPortion;
      leaveRequestId: string;
    }[]
  > {
    return this.db
      .select({
        employeeId: leaveRequests.employeeId,
        employeeName,
        departmentId: employees.departmentId,
        departmentName: departments.name,
        leaveTypeId: leaveRequests.leaveTypeId,
        leaveTypeName: leaveTypes.name,
        leaveTypeCode: leaveTypes.code,
        date: leaveRequestDays.date,
        portion: leaveRequestDays.portion,
        leaveRequestId: leaveRequests.id,
      })
      .from(leaveRequestDays)
      .innerJoin(leaveRequests, eq(leaveRequests.id, leaveRequestDays.leaveRequestId))
      .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .leftJoin(
        departments,
        and(eq(departments.id, employees.departmentId), isNull(departments.deletedAt)),
      )
      .where(
        this.orgScoped(
          eq(leaveRequestDays.orgId, this.ctx.orgId),
          gte(leaveRequestDays.date, options.from),
          lte(leaveRequestDays.date, options.to),
          eq(leaveRequestDays.isCounted, true),
          isNull(leaveRequestDays.deletedAt),
          eq(leaveRequests.status, 'APPROVED'),
          isNull(leaveRequests.cancelledAt),
          isNull(leaveRequests.deletedAt),
          isNull(employees.deletedAt),
          options.scope,
          options.departmentId === undefined
            ? undefined
            : eq(employees.departmentId, options.departmentId),
        ),
      )
      .orderBy(asc(leaveRequestDays.date), asc(leaveRequests.employeeId));
  }

  // ----------------------------------------------------------------- jobs

  /**
   * Every organisation with at least one live employee.
   *
   * The scheduled jobs run for the whole installation rather than for one
   * caller's organisation, so they need this and nothing else can supply it --
   * a repository is constructed per org context, and a job has none.
   */
  static async listOrganisationIds(db: Database): Promise<string[]> {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(isNull(organizations.deletedAt))
      .orderBy(asc(organizations.id));
    return rows.map((row) => row.id);
  }

  /** Everybody the accrual has to consider: in service at any point in the range. */
  async listAccruableEmployees(
    periodStart: string,
    periodEnd: string,
  ): Promise<{ id: string; dateOfJoining: string; dateOfLeaving: string | null; employmentType: EmploymentType }[]> {
    return this.db
      .select({
        id: employees.id,
        dateOfJoining: employees.dateOfJoining,
        dateOfLeaving: employees.dateOfLeaving,
        employmentType: employees.employmentType,
      })
      .from(employees)
      .where(
        this.orgScoped(
          eq(employees.orgId, this.ctx.orgId),
          isNull(employees.deletedAt),
          lte(employees.dateOfJoining, periodEnd),
          or(isNull(employees.dateOfLeaving), gte(employees.dateOfLeaving, periodStart)),
        ),
      )
      .orderBy(asc(employees.id));
  }

  /** Every distinct (employee, type) pair that has any movement in a year. */
  async listBalanceKeys(
    leaveYear: number,
  ): Promise<{ employeeId: string; leaveTypeId: string }[]> {
    return this.db
      .selectDistinct({
        employeeId: leaveLedger.employeeId,
        leaveTypeId: leaveLedger.leaveTypeId,
      })
      .from(leaveLedger)
      .where(
        this.orgScoped(eq(leaveLedger.orgId, this.ctx.orgId), eq(leaveLedger.leaveYear, leaveYear)),
      )
      .orderBy(asc(leaveLedger.employeeId), asc(leaveLedger.leaveTypeId));
  }
}
