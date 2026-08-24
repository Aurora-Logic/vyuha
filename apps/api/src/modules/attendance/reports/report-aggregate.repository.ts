import {
  MUSTER_STATUS_CODES,
  employeeDisplayName,
  type AbsenteeismSource,
  type AttendanceExceptionSource,
  type HeadcountSource,
  type LeaveAvailedSource,
  type LeaveBalanceSource,
  type LeaveLedgerSource,
  type MissingPunchSource,
  type MusterGridSource,
  type ReportKey,
  type SortTerm,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../../platform/db/db.provider.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { ReportRepository } from './report.repository.js';

/**
 * The queries behind the reports that aggregate (REQ-J-01).
 *
 * Written as SQL rather than through the query builder, and grouped in
 * Postgres rather than in JavaScript. Both are the same decision: a report over
 * a quarter for two hundred people is tens of thousands of `attendance_days`
 * rows, and the only honest way to answer "how many days was this person late"
 * is to make the database count them. Reading a page of rows and summing what
 * arrived would produce a number that is a fraction of the truth and looks
 * exactly like a real one.
 *
 * Every statement here takes its scope fragment from `ScopeService` and its
 * department/location narrowing from `ReportRepository.employeePredicate`, so
 * "my team" means the same set in an aggregate as it does in the register. No
 * statement builds a scope of its own, and none omits `org_id`.
 *
 * Dates and instants are cast to text in SQL. `db.execute` bypasses drizzle's
 * column mapping, so a `date` would otherwise arrive as a JS `Date` at the
 * driver's local midnight -- which west of Greenwich is the previous day.
 */

export interface AggregateFilters {
  /** Resolved by `ScopeService`; never built here and never optional. */
  readonly scope: SQL;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly locationId?: string | undefined;
}

export interface AggregatePage<T> {
  readonly rows: T[];
  readonly total: number;
}

/**
 * Which column of `attendance_days` the exception reports measure.
 *
 * A closed union, and the only thing interpolated raw into those statements.
 * The report key picks it; nothing a caller sends reaches it.
 */
export type ExceptionMeasure = 'late_minutes' | 'early_exit_minutes' | 'ot_minutes';

/** Sort field to the SQL it orders by, per report. Anything else is dropped. */
type SortMap = Readonly<Record<string, string>>;

const EXCEPTION_SORTS: SortMap = {
  employeeCode: '"employees"."employee_code"',
  occurrences: 'occurrences',
  totalMinutes: 'total_minutes',
  worstMinutes: 'worst_minutes',
};

const MUSTER_GRID_SORTS: SortMap = {
  employeeCode: '"employees"."employee_code"',
  presentDays: 'present_days',
  absentDays: 'absent_days',
  workedMinutes: 'worked_minutes',
};

const ABSENTEEISM_SORTS: SortMap = {
  month: 'month',
  employeeCode: '"employees"."employee_code"',
  absentDays: 'absent_days',
  absencePercent: 'absence_percent',
};

const MISSING_PUNCH_SORTS: SortMap = {
  date: '"attendance_days"."date"',
  employeeCode: '"employees"."employee_code"',
  status: '"attendance_days"."status"',
};

const LEAVE_BALANCE_SORTS: SortMap = {
  employeeCode: '"employees"."employee_code"',
  leaveTypeCode: '"leave_types"."code"',
  availed: '"leave_balances"."availed"',
  closing: '"leave_balances"."closing"',
};

const LEAVE_LEDGER_SORTS: SortMap = {
  postedAt: '"leave_ledger"."created_at"',
  employeeCode: '"employees"."employee_code"',
  movementType: '"leave_ledger"."movement_type"',
  days: '"leave_ledger"."days"',
};

const LEAVE_AVAILED_SORTS: SortMap = {
  employeeCode: '"employees"."employee_code"',
  leaveTypeCode: '"leave_types"."code"',
  days: 'days',
};

const HEADCOUNT_SORTS: SortMap = {
  month: 'month',
  joiners: 'joiners',
  leavers: 'leavers',
  closing: 'closing',
};


/**
 * Which fields each aggregate report actually orders by.
 *
 * The call sites read this table rather than the maps directly, so
 * `AttendanceReportSource.sortableFields` can answer from the same object the
 * ORDER BY is built from. A column that advertises `sortField` in the
 * catalogue and is missing here fails `report-sorting.test.ts`.
 */
export const AGGREGATE_SORTS = {
  'late-arrivals': EXCEPTION_SORTS,
  'early-exits': EXCEPTION_SORTS,
  overtime: EXCEPTION_SORTS,
  'monthly-muster': MUSTER_GRID_SORTS,
  absenteeism: ABSENTEEISM_SORTS,
  'missing-punch': MISSING_PUNCH_SORTS,
  'leave-balance': LEAVE_BALANCE_SORTS,
  'leave-ledger': LEAVE_LEDGER_SORTS,
  'leave-availed': LEAVE_AVAILED_SORTS,
  headcount: HEADCOUNT_SORTS,
} satisfies Partial<Record<ReportKey, SortMap>>;

/**
 * `ORDER BY` from the parsed sort terms and a whitelist.
 *
 * `sql.raw` is safe here and only here: both halves come from constants in this
 * file, and a term naming anything else is dropped rather than passed through.
 * The tiebreak is not decoration -- without a total order, one row can appear
 * on two pages while another appears on none.
 */
function orderBy(sort: readonly SortTerm[], allowed: SortMap, tiebreak: string): SQL {
  const clauses: string[] = [];
  for (const term of sort) {
    /*
     * `Object.hasOwn`, not a bare lookup.
     *
     * `allowed` is an object literal, so `term.field` of "constructor" or
     * "toString" resolves up the prototype chain to a function, which
     * `${column}` then stringifies straight into a `sql.raw` ORDER BY. It is
     * unreachable today -- `parseSort` gates fields against an array with
     * `includes`, which prototype keys fail -- but that gate is in a different
     * file, and this is the line that would pay for its removal.
     */
    if (!Object.hasOwn(allowed, term.field)) continue;
    const column = allowed[term.field];
    if (column === undefined) continue;
    clauses.push(`${column} ${term.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  }
  clauses.push(tiebreak);
  return sql.raw(`ORDER BY ${clauses.join(', ')}`);
}

/** UTC ISO-8601 with a literal Z, matching `AttendanceDayRepository`. */
const INSTANT_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);

interface NamedEmployeeRow {
  readonly employee_code: string;
  readonly first_name: string;
  readonly last_name: string | null;
}

function named(row: NamedEmployeeRow): { employee: { name: string }; employeeCode: string } {
  return {
    employee: { name: employeeDisplayName(row.first_name, row.last_name) },
    employeeCode: row.employee_code,
  };
}

export class ReportAggregateRepository {
  constructor(
    private readonly db: Database,
    private readonly ctx: OrgContext,
  ) {}

  /**
   * The filters every report over `attendance_days` shares.
   *
   * `deleted_at IS NULL` is here rather than assumed: these statements do not
   * go through `ScopedRepository`, and a soft-deleted day quietly counted into
   * an absenteeism percentage is the kind of wrong nobody can see.
   */
  private dayWhere(filters: AggregateFilters): SQL {
    return sql`"attendance_days"."org_id" = ${this.ctx.orgId}
      AND "attendance_days"."deleted_at" IS NULL
      AND ${filters.scope}
      ${this.employeeNarrowing(filters)}
      ${filters.employeeId === undefined ? sql`` : sql` AND "attendance_days"."employee_id" = ${filters.employeeId}::uuid`}
      ${filters.from === undefined ? sql`` : sql` AND "attendance_days"."date" >= ${filters.from}::date`}
      ${filters.to === undefined ? sql`` : sql` AND "attendance_days"."date" <= ${filters.to}::date`}`;
  }

  private employeeNarrowing(filters: AggregateFilters): SQL {
    const predicate = ReportRepository.employeePredicate(filters);
    return predicate === undefined ? sql`` : sql` AND ${predicate}`;
  }

  /** The joins every report over `attendance_days` shares. */
  private dayJoins(): SQL {
    return sql`
      FROM "attendance_days"
      INNER JOIN "employees"
        ON "employees"."id" = "attendance_days"."employee_id"
       AND "employees"."org_id" = ${this.ctx.orgId}
       AND "employees"."deleted_at" IS NULL
      LEFT JOIN "departments"
        ON "departments"."id" = "employees"."department_id"
       AND "departments"."deleted_at" IS NULL
      LEFT JOIN "locations"
        ON "locations"."id" = "employees"."location_id"
       AND "locations"."deleted_at" IS NULL`;
  }

  // ------------------------------------------------------------ muster grid

  async musterGrid(
    filters: AggregateFilters,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<MusterGridSource>> {
    const result = await this.db.execute<{
      employee_id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      days: Record<string, string> | null;
      present_days: number;
      absent_days: number;
      leave_days: number;
      half_days: number;
      on_duty_days: number;
      weekly_off_days: number;
      holiday_days: number;
      worked_minutes: number;
      ot_minutes: number;
      late_days: number;
    }>(sql`
      SELECT "employees"."id" AS employee_id,
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             jsonb_object_agg(to_char("attendance_days"."date", '"d"DD'), "attendance_days"."status")
               AS days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'PRESENT')::int AS present_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'ABSENT')::int AS absent_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'ON_LEAVE')::int AS leave_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'HALF_DAY')::int AS half_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'ON_DUTY')::int AS on_duty_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'WEEKLY_OFF')::int AS weekly_off_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'HOLIDAY')::int AS holiday_days,
             coalesce(sum("attendance_days"."worked_minutes"), 0)::int AS worked_minutes,
             coalesce(sum("attendance_days"."ot_minutes"), 0)::int AS ot_minutes,
             count(*) FILTER (WHERE "attendance_days"."late_minutes" > 0)::int AS late_days
        ${this.dayJoins()}
       WHERE ${this.dayWhere(filters)}
       GROUP BY "employees"."id", "employees"."employee_code", "employees"."first_name",
                "employees"."last_name", "departments"."name"
       ${orderBy(sort, AGGREGATE_SORTS['monthly-muster'], '"employees"."employee_code" ASC')}
       LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: row.employee_id,
      ...named(row),
      departmentName: row.department_name,
      days: toStatusCodes(row.days),
      presentDays: row.present_days,
      absentDays: row.absent_days,
      leaveDays: row.leave_days,
      halfDays: row.half_days,
      onDutyDays: row.on_duty_days,
      weeklyOffDays: row.weekly_off_days,
      holidayDays: row.holiday_days,
      workedMinutes: row.worked_minutes,
      otMinutes: row.ot_minutes,
      lateDays: row.late_days,
    }));

    return { rows, total: await this.countEmployeesWithDays(filters) };
  }

  private async countEmployeesWithDays(filters: AggregateFilters): Promise<number> {
    const result = await this.db.execute<{ value: number }>(sql`
      SELECT count(DISTINCT "attendance_days"."employee_id")::int AS value
        ${this.dayJoins()}
       WHERE ${this.dayWhere(filters)}
    `);
    return result.rows[0]?.value ?? 0;
  }

  // ------------------------------------------------------ exception summary

  /**
   * Late arrivals, early exits and overtime.
   *
   * `> 0` on the measure is what makes `occurrences` mean "days this happened"
   * rather than "days in the period". A person with no late arrival has no row
   * at all, which is what a report called "Late arrivals" should say about
   * them.
   */
  async exceptions(
    measure: ExceptionMeasure,
    filters: AggregateFilters,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<AttendanceExceptionSource>> {
    const column = sql.raw(`"attendance_days"."${measure}"`);
    const where = sql`${this.dayWhere(filters)} AND ${column} > 0`;

    const result = await this.db.execute<{
      employee_id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      location_name: string | null;
      occurrences: number;
      total_minutes: number;
      average_minutes: number;
      worst_minutes: number;
      first_date: string | null;
      last_date: string | null;
    }>(sql`
      SELECT "employees"."id" AS employee_id,
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             "locations"."name" AS location_name,
             count(*)::int AS occurrences,
             coalesce(sum(${column}), 0)::int AS total_minutes,
             coalesce(round(avg(${column})), 0)::int AS average_minutes,
             coalesce(max(${column}), 0)::int AS worst_minutes,
             min("attendance_days"."date")::text AS first_date,
             max("attendance_days"."date")::text AS last_date
        ${this.dayJoins()}
       WHERE ${where}
       GROUP BY "employees"."id", "employees"."employee_code", "employees"."first_name",
                "employees"."last_name", "departments"."name", "locations"."name"
       ${orderBy(sort, AGGREGATE_SORTS['late-arrivals'], '"employees"."employee_code" ASC')}
       LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: row.employee_id,
      ...named(row),
      departmentName: row.department_name,
      locationName: row.location_name,
      occurrences: row.occurrences,
      totalMinutes: row.total_minutes,
      averageMinutes: row.average_minutes,
      worstMinutes: row.worst_minutes,
      firstDate: row.first_date,
      lastDate: row.last_date,
    }));

    const totals = await this.db.execute<{ value: number }>(sql`
      SELECT count(DISTINCT "attendance_days"."employee_id")::int AS value
        ${this.dayJoins()}
       WHERE ${where}
    `);

    return { rows, total: totals.rows[0]?.value ?? 0 };
  }

  // ------------------------------------------------------------ absenteeism

  /**
   * REQ-J-01: "absent days and percentage by employee, department, month".
   *
   * The denominator is every day that was not a weekly off and not a holiday --
   * the days the person was expected. Nothing here reads a roster: the day
   * engine has already resolved one into a status, and a second reading of the
   * same question would be a second answer to it.
   *
   * Rows with no absence are dropped. A report named "Absenteeism" listing
   * everybody at 0.0% buries the four people it is about.
   */
  async absenteeism(
    filters: AggregateFilters,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<AbsenteeismSource>> {
    const grouped = sql`
        ${this.dayJoins()}
       WHERE ${this.dayWhere(filters)}
       GROUP BY "employees"."id", "employees"."employee_code", "employees"."first_name",
                "employees"."last_name", "departments"."name", "locations"."name",
                to_char("attendance_days"."date", 'YYYY-MM')
      HAVING count(*) FILTER (WHERE "attendance_days"."status" = 'ABSENT') > 0`;

    const result = await this.db.execute<{
      employee_id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      location_name: string | null;
      month: string;
      scheduled_days: number;
      present_days: number;
      leave_days: number;
      absent_days: number;
      absence_percent: number | null;
      total_groups: number;
    }>(sql`
      SELECT "employees"."id" AS employee_id,
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             "locations"."name" AS location_name,
             to_char("attendance_days"."date", 'YYYY-MM') AS month,
             count(*) FILTER (
               WHERE "attendance_days"."status" NOT IN ('WEEKLY_OFF', 'HOLIDAY')
             )::int AS scheduled_days,
             count(*) FILTER (
               WHERE "attendance_days"."status" IN ('PRESENT', 'ON_DUTY', 'HALF_DAY')
             )::int AS present_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'ON_LEAVE')::int AS leave_days,
             count(*) FILTER (WHERE "attendance_days"."status" = 'ABSENT')::int AS absent_days,
             round(
               100.0 * count(*) FILTER (WHERE "attendance_days"."status" = 'ABSENT')
               / nullif(
                   count(*) FILTER (WHERE "attendance_days"."status" NOT IN ('WEEKLY_OFF', 'HOLIDAY')),
                   0
                 ),
               1
             )::float8 AS absence_percent,
             /*
              * The row count, taken from the same pass.
              *
              * This used to be a second count(*) over the identical GROUP BY,
              * which meant scanning and grouping the whole period twice. At the
              * size NFR-02 names -- 500 employees, 24 months -- each half cost
              * about 850ms and the pair went over the 1.5s the requirement
              * allows. A window over the grouped set is evaluated after GROUP BY
              * and HAVING and before LIMIT, which is exactly the number the
              * pager needs, for one scan instead of two.
              */
             count(*) OVER ()::int AS total_groups
       ${grouped}
       ${orderBy(sort, AGGREGATE_SORTS.absenteeism, 'month DESC, "employees"."employee_code" ASC')}
       LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      // Not a record id: a grouped row is not an entity. Stable across pages,
      // which is all the table needs it for.
      id: `${row.employee_id}:${row.month}`,
      ...named(row),
      departmentName: row.department_name,
      locationName: row.location_name,
      month: row.month,
      scheduledDays: row.scheduled_days,
      presentDays: row.present_days,
      leaveDays: row.leave_days,
      absentDays: row.absent_days,
      // Null only when the denominator was zero, which cannot happen while the
      // HAVING clause requires an absent day -- an absence is itself a
      // scheduled day. Read defensively anyway: this is a division.
      absencePercent: row.absence_percent ?? 0,
    }));

    // Zero rows means zero groups; the window produced no row to read it from.
    return { rows, total: result.rows[0]?.total_groups ?? 0 };
  }

  // ---------------------------------------------------------- missing punch

  /**
   * REQ-J-01: "days flagged `missing_punch`, and their regularization status".
   *
   * The correction is the latest one raised for that employee and date, read
   * through a LATERAL rather than a join, so a day with two attempts produces
   * one row rather than two -- a duplicated day in a list of exceptions reads
   * as two problems.
   */
  async missingPunch(
    filters: AggregateFilters,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<MissingPunchSource>> {
    const joins = sql`
      ${this.dayJoins()}
      LEFT JOIN "shifts"
        ON "shifts"."id" = "attendance_days"."shift_id"
       AND "shifts"."org_id" = ${this.ctx.orgId}
       AND "shifts"."deleted_at" IS NULL
      LEFT JOIN "punches" AS "vy_in"
        ON "vy_in"."id" = "attendance_days"."first_in_punch_id"
      LEFT JOIN "punches" AS "vy_out"
        ON "vy_out"."id" = "attendance_days"."last_out_punch_id"
      LEFT JOIN LATERAL (
        SELECT "vy_reg"."status", "vy_reg"."kind", "vy_reg"."decided_at", "vy_reg"."reason"
          FROM "regularizations" AS "vy_reg"
         WHERE "vy_reg"."org_id" = ${this.ctx.orgId}
           AND "vy_reg"."employee_id" = "attendance_days"."employee_id"
           AND "vy_reg"."date" = "attendance_days"."date"
           AND "vy_reg"."deleted_at" IS NULL
         ORDER BY "vy_reg"."created_at" DESC, "vy_reg"."id" DESC
         LIMIT 1
      ) AS "vy_correction" ON true`;

    const where = sql`${this.dayWhere(filters)}
      AND "attendance_days"."flags" && ARRAY['missing_punch']::text[]`;

    const result = await this.db.execute<{
      id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      date: string;
      status: string;
      shift_name: string | null;
      punched_in_at: string | null;
      punched_out_at: string | null;
      flags: string[] | null;
      regularization_status: string | null;
      regularization_kind: string | null;
      regularization_decided_at: string | null;
      regularization_reason: string | null;
    }>(sql`
      SELECT "attendance_days"."id",
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             "attendance_days"."date"::text AS date,
             "attendance_days"."status"::text AS status,
             "shifts"."name" AS shift_name,
             to_char("vy_in"."server_time" AT TIME ZONE 'UTC', ${INSTANT_FORMAT}) AS punched_in_at,
             to_char("vy_out"."server_time" AT TIME ZONE 'UTC', ${INSTANT_FORMAT}) AS punched_out_at,
             "attendance_days"."flags",
             "vy_correction"."status"::text AS regularization_status,
             "vy_correction"."kind"::text AS regularization_kind,
             to_char("vy_correction"."decided_at" AT TIME ZONE 'UTC', ${INSTANT_FORMAT})
               AS regularization_decided_at,
             "vy_correction"."reason" AS regularization_reason
      ${joins}
       WHERE ${where}
       ${orderBy(sort, AGGREGATE_SORTS['missing-punch'], '"attendance_days"."id" ASC')}
       LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: row.id,
      ...named(row),
      departmentName: row.department_name,
      date: row.date,
      status: row.status,
      shiftName: row.shift_name,
      punchedInAt: row.punched_in_at,
      punchedOutAt: row.punched_out_at,
      flags: row.flags ?? [],
      regularizationStatus: row.regularization_status,
      regularizationKind: row.regularization_kind,
      regularizationDecidedAt: row.regularization_decided_at,
      regularizationReason: row.regularization_reason,
    }));

    const totals = await this.db.execute<{ value: number }>(sql`
      SELECT count(*)::int AS value ${this.dayJoins()} WHERE ${where}
    `);

    return { rows, total: totals.rows[0]?.value ?? 0 };
  }

  // -------------------------------------------------------------- the leave

  /** The joins the three leave reports share, over their own employee column. */
  private leaveJoins(employeeColumn: SQL): SQL {
    return sql`
      INNER JOIN "employees"
         ON "employees"."id" = ${employeeColumn}
        AND "employees"."org_id" = ${this.ctx.orgId}
        AND "employees"."deleted_at" IS NULL
      LEFT JOIN "departments"
         ON "departments"."id" = "employees"."department_id"
        AND "departments"."deleted_at" IS NULL`;
  }

  private leaveWhere(filters: AggregateFilters, employeeColumn: SQL): SQL {
    return sql`${filters.scope}
      ${this.employeeNarrowing(filters)}
      ${filters.employeeId === undefined ? sql`` : sql` AND ${employeeColumn} = ${filters.employeeId}::uuid`}`;
  }

  /** REQ-J-01's leave balance, for the leave year the caller's period falls in. */
  async leaveBalance(
    filters: AggregateFilters,
    leaveYear: number,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<LeaveBalanceSource>> {
    const employeeColumn = sql.raw('"leave_balances"."employee_id"');
    const body = sql`
        FROM "leave_balances"
        ${this.leaveJoins(employeeColumn)}
        INNER JOIN "leave_types"
           ON "leave_types"."id" = "leave_balances"."leave_type_id"
          AND "leave_types"."deleted_at" IS NULL
       WHERE "leave_balances"."org_id" = ${this.ctx.orgId}
         AND "leave_balances"."deleted_at" IS NULL
         AND "leave_balances"."leave_year" = ${leaveYear}
         AND ${this.leaveWhere(filters, employeeColumn)}`;

    const result = await this.db.execute<{
      employee_id: string;
      leave_type_id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      leave_type_code: string;
      leave_type_name: string;
      leave_year: number;
      opening: number;
      accrued: number;
      availed: number;
      adjusted: number;
      carried_forward: number;
      closing: number;
    }>(sql`
      SELECT "employees"."id" AS employee_id,
             "leave_types"."id" AS leave_type_id,
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             "leave_types"."code" AS leave_type_code,
             "leave_types"."name" AS leave_type_name,
             "leave_balances"."leave_year"::int AS leave_year,
             "leave_balances"."opening"::float8 AS opening,
             "leave_balances"."accrued"::float8 AS accrued,
             "leave_balances"."availed"::float8 AS availed,
             "leave_balances"."adjusted"::float8 AS adjusted,
             "leave_balances"."carried_forward"::float8 AS carried_forward,
             "leave_balances"."closing"::float8 AS closing
      ${body}
      ${orderBy(sort, AGGREGATE_SORTS['leave-balance'], '"employees"."employee_code" ASC, "leave_types"."code" ASC')}
      LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: `${row.employee_id}:${row.leave_type_id}`,
      ...named(row),
      departmentName: row.department_name,
      leaveTypeCode: row.leave_type_code,
      leaveTypeName: row.leave_type_name,
      leaveYear: row.leave_year,
      opening: row.opening,
      accrued: row.accrued,
      availed: row.availed,
      adjusted: row.adjusted,
      carriedForward: row.carried_forward,
      closing: row.closing,
    }));

    const totals = await this.db.execute<{ value: number }>(
      sql`SELECT count(*)::int AS value ${body}`,
    );
    return { rows, total: totals.rows[0]?.value ?? 0 };
  }

  /**
   * REQ-J-01's leave ledger, filtered by when a movement was posted.
   *
   * `created_at` is the only time the ledger carries, and it is an instant, so
   * the period is bounded at local midnight in the organisation's timezone
   * rather than at UTC. Asia/Kolkata is +05:30: reading it as UTC would put
   * five and a half hours of every day into the wrong month.
   */
  async leaveLedger(
    filters: AggregateFilters,
    timezone: string,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<LeaveLedgerSource>> {
    const employeeColumn = sql.raw('"leave_ledger"."employee_id"');
    const body = sql`
        FROM "leave_ledger"
        ${this.leaveJoins(employeeColumn)}
        INNER JOIN "leave_types"
           ON "leave_types"."id" = "leave_ledger"."leave_type_id"
          AND "leave_types"."deleted_at" IS NULL
       WHERE "leave_ledger"."org_id" = ${this.ctx.orgId}
         AND ${this.leaveWhere(filters, employeeColumn)}
         ${
           filters.from === undefined
             ? sql``
             : sql` AND "leave_ledger"."created_at" >= (${filters.from}::date)::timestamp AT TIME ZONE ${timezone}`
         }
         ${
           filters.to === undefined
             ? sql``
             : sql` AND "leave_ledger"."created_at" < ((${filters.to}::date + 1)::timestamp AT TIME ZONE ${timezone})`
         }`;

    const result = await this.db.execute<{
      id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      leave_type_code: string;
      leave_type_name: string;
      leave_year: number;
      posted_at: string;
      movement_type: string;
      days: number;
      reference_type: string | null;
      period_key: string | null;
      note: string | null;
    }>(sql`
      SELECT "leave_ledger"."id",
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "leave_types"."code" AS leave_type_code,
             "leave_types"."name" AS leave_type_name,
             "leave_ledger"."leave_year"::int AS leave_year,
             to_char("leave_ledger"."created_at" AT TIME ZONE 'UTC', ${INSTANT_FORMAT}) AS posted_at,
             "leave_ledger"."movement_type"::text AS movement_type,
             "leave_ledger"."days"::float8 AS days,
             "leave_ledger"."reference_type" AS reference_type,
             "leave_ledger"."period_key" AS period_key,
             "leave_ledger"."note"
      ${body}
      ${orderBy(sort, AGGREGATE_SORTS['leave-ledger'], '"leave_ledger"."id" DESC')}
      LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: row.id,
      ...named(row),
      leaveTypeCode: row.leave_type_code,
      leaveTypeName: row.leave_type_name,
      leaveYear: row.leave_year,
      postedAt: row.posted_at,
      movementType: row.movement_type,
      days: row.days,
      referenceType: row.reference_type,
      periodKey: row.period_key,
      note: row.note,
    }));

    const totals = await this.db.execute<{ value: number }>(
      sql`SELECT count(*)::int AS value ${body}`,
    );
    return { rows, total: totals.rows[0]?.value ?? 0 };
  }

  /**
   * REQ-J-01's leave availed, counted over `leave_request_days`.
   *
   * Over the expanded days rather than `leave_requests.total_days`, because a
   * request that starts in March and ends in April must contribute its March
   * days to March. Summing the request's total into whichever month it started
   * in is the mistake this shape exists to prevent, and REQ-G-06 stores the
   * expansion precisely so it need not be recomputed.
   *
   * `FULL` counts one and either half counts a half, which is
   * `portionValue` in `leave-days.ts`. Two spellings of that rule would be two
   * answers to "how much leave did this person take".
   */
  async leaveAvailed(
    filters: AggregateFilters,
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<LeaveAvailedSource>> {
    const employeeColumn = sql.raw('"leave_requests"."employee_id"');
    const body = sql`
        FROM "leave_request_days"
        INNER JOIN "leave_requests"
           ON "leave_requests"."id" = "leave_request_days"."leave_request_id"
          AND "leave_requests"."deleted_at" IS NULL
        ${this.leaveJoins(employeeColumn)}
        INNER JOIN "leave_types"
           ON "leave_types"."id" = "leave_requests"."leave_type_id"
          AND "leave_types"."deleted_at" IS NULL
       WHERE "leave_request_days"."org_id" = ${this.ctx.orgId}
         AND "leave_request_days"."deleted_at" IS NULL
         AND "leave_request_days"."is_counted" = true
         AND "leave_requests"."status" = 'APPROVED'
         AND "leave_requests"."cancelled_at" IS NULL
         AND ${this.leaveWhere(filters, employeeColumn)}
         ${filters.from === undefined ? sql`` : sql` AND "leave_request_days"."date" >= ${filters.from}::date`}
         ${filters.to === undefined ? sql`` : sql` AND "leave_request_days"."date" <= ${filters.to}::date`}
       GROUP BY "employees"."id", "employees"."employee_code", "employees"."first_name",
                "employees"."last_name", "departments"."name",
                "leave_types"."id", "leave_types"."code", "leave_types"."name", "leave_types"."is_paid"`;

    const result = await this.db.execute<{
      employee_id: string;
      leave_type_id: string;
      employee_code: string;
      first_name: string;
      last_name: string | null;
      department_name: string | null;
      leave_type_code: string;
      leave_type_name: string;
      is_paid: boolean;
      requests: number;
      days: number;
      first_date: string | null;
      last_date: string | null;
    }>(sql`
      SELECT "employees"."id" AS employee_id,
             "leave_types"."id" AS leave_type_id,
             "employees"."employee_code",
             "employees"."first_name",
             "employees"."last_name",
             "departments"."name" AS department_name,
             "leave_types"."code" AS leave_type_code,
             "leave_types"."name" AS leave_type_name,
             "leave_types"."is_paid" AS is_paid,
             count(DISTINCT "leave_requests"."id")::int AS requests,
             sum(CASE WHEN "leave_request_days"."portion" = 'FULL' THEN 1 ELSE 0.5 END)::float8 AS days,
             min("leave_request_days"."date")::text AS first_date,
             max("leave_request_days"."date")::text AS last_date
      ${body}
      ${orderBy(sort, AGGREGATE_SORTS['leave-availed'], '"employees"."employee_code" ASC, "leave_types"."code" ASC')}
      LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = result.rows.map((row) => ({
      id: `${row.employee_id}:${row.leave_type_id}`,
      ...named(row),
      departmentName: row.department_name,
      leaveTypeCode: row.leave_type_code,
      leaveTypeName: row.leave_type_name,
      isPaid: row.is_paid,
      requests: row.requests,
      days: row.days,
      firstDate: row.first_date,
      lastDate: row.last_date,
    }));

    const totals = await this.db.execute<{ value: number }>(sql`
      SELECT count(*)::int AS value FROM (SELECT 1 AS one ${body}) AS vy_availed_groups
    `);

    return { rows, total: totals.rows[0]?.value ?? 0 };
  }

  // -------------------------------------------------------------- headcount

  /**
   * REQ-J-01's headcount: "active headcount, joiners, leavers by month".
   *
   * The months come from `generate_series` rather than from the data, so a
   * month in which nobody joined and nobody left still has a row stating the
   * headcount. A gap in a headcount series reads as a month with no staff.
   *
   * `LEFT JOIN` and not `CROSS JOIN`: an organisation whose scope resolves to
   * nobody must still answer with its months at zero, rather than with nothing
   * at all -- which would look like the report failing.
   */
  async headcount(
    filters: AggregateFilters & { from: string; to: string },
    sort: readonly SortTerm[],
    limit: number,
    offset: number,
  ): Promise<AggregatePage<HeadcountSource>> {
    const employeeColumn = sql.raw('"employees"."id"');
    const body = sql`
        FROM (
          SELECT generate_series(
                   date_trunc('month', ${filters.from}::date)::timestamp,
                   date_trunc('month', ${filters.to}::date)::timestamp,
                   interval '1 month'
                 )::date AS month_start
        ) AS "vy_months"
        LEFT JOIN "employees"
          ON "employees"."org_id" = ${this.ctx.orgId}
         AND "employees"."deleted_at" IS NULL
         AND ${this.leaveWhere(filters, employeeColumn)}
       GROUP BY "vy_months"."month_start"`;

    const result = await this.db.execute<{
      month: string;
      opening: number;
      joiners: number;
      leavers: number;
      closing: number;
    }>(sql`
      SELECT to_char("vy_months"."month_start", 'YYYY-MM') AS month,
             count(*) FILTER (
               WHERE "employees"."date_of_joining" < "vy_months"."month_start"
                 AND ("employees"."date_of_leaving" IS NULL
                      OR "employees"."date_of_leaving" >= "vy_months"."month_start")
             )::int AS opening,
             count(*) FILTER (
               WHERE "employees"."date_of_joining" >= "vy_months"."month_start"
                 AND "employees"."date_of_joining"
                     < ("vy_months"."month_start" + interval '1 month')
             )::int AS joiners,
             count(*) FILTER (
               WHERE "employees"."date_of_leaving" >= "vy_months"."month_start"
                 AND "employees"."date_of_leaving"
                     < ("vy_months"."month_start" + interval '1 month')
             )::int AS leavers,
             count(*) FILTER (
               WHERE "employees"."date_of_joining"
                     < ("vy_months"."month_start" + interval '1 month')
                 AND ("employees"."date_of_leaving" IS NULL
                      OR "employees"."date_of_leaving"
                         >= ("vy_months"."month_start" + interval '1 month'))
             )::int AS closing
      ${body}
      ${orderBy(sort, AGGREGATE_SORTS.headcount, '"vy_months"."month_start" ASC')}
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totals = await this.db.execute<{ value: number }>(sql`
      SELECT count(*)::int AS value FROM (SELECT 1 AS one ${body}) AS vy_headcount_groups
    `);

    return {
      rows: result.rows.map((row) => ({ id: row.month, ...row })),
      total: totals.rows[0]?.value ?? 0,
    };
  }
}

/**
 * The grid's statuses as the codes the sheet prints.
 *
 * A status with no code is kept as it is rather than dropped: an enum value
 * added to `attendance_days` and not to `MUSTER_STATUS_CODES` should show up as
 * `SOMETHING_NEW` in the cell, which somebody will report, rather than as a
 * blank, which reads as a day with no record.
 */
function toStatusCodes(days: Record<string, string> | null): Record<string, string> {
  if (days === null) return {};
  const codes: Record<string, string> = {};
  for (const [key, status] of Object.entries(days)) {
    codes[key] = MUSTER_STATUS_CODES[status] ?? status;
  }
  return codes;
}
