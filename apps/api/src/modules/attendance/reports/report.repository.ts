import type { PunchRecord } from '@vyuha/shared';
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../../../platform/db/db.provider.js';
import { employees } from '../../../platform/db/schema/index.js';
import type { OrgContext } from '../../../platform/db/scoped-repository.js';
import { PUNCH_COLUMNS, toPunchRecord, type PunchRow } from '../punch/punch.repository.js';
import { punches } from '../schema/index.js';

/**
 * The rows behind the punch audit report.
 *
 * The organisation profile, the export requester and the filter labels used
 * to live here too; they read only platform tables and were what pinned the
 * export framework inside this module, so REQ-P-02 moved them to
 * `platform/export/export-context.repository.ts`.
 *
 * The attendance register is deliberately *not* here: `AttendanceDayRepository`
 * already produces exactly that row, and a second copy of those joins would be
 * a second place for the muster and the register to disagree about what a day
 * looks like. `ReportService` calls it directly and folds the report's extra
 * filters into the scope predicate it passes.
 *
 * The punch audit does need its own query. `PunchRepository.feed` is
 * cursor-paginated by design -- it serves a live feed that only grows -- and a
 * report shell pages by number and shows a total. Those are different
 * questions of the same table, not the same question twice.
 */

export interface ReportScopeFilters {
  /** Resolved by `ScopeService`; never built here and never optional. */
  readonly scope: SQL;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly punchType?: 'IN' | 'OUT' | undefined;
}

export interface PunchAuditPage {
  readonly rows: PunchRecord[];
  readonly total: number;
}

/** Sort fields the punch audit will honour, mapped to real columns. */
export const PUNCH_SORT_COLUMNS: Record<string, PgColumn> = {
  serverTime: punches.serverTime,
  attendanceDate: punches.attendanceDate,
  employeeCode: employees.employeeCode,
};

export class ReportRepository {
  constructor(
    private readonly db: Database,
    private readonly ctx: OrgContext,
  ) {}

  /** Mirrors `ScopedRepository.scoped()`; `punches` carries no soft-delete columns. */
  private orgScoped(...extra: (SQL | undefined)[]): SQL {
    const predicate = and(eq(punches.orgId, this.ctx.orgId), ...extra);
    if (predicate === undefined) {
      throw new Error('Scope predicate collapsed to undefined; refusing to run an unscoped query.');
    }
    return predicate;
  }

  /**
   * The report's own filters as one predicate over the joined employee.
   *
   * Public because the attendance register applies the same department and
   * location narrowing through `AttendanceDayRepository`, which joins the same
   * `employees` alias and accepts an arbitrary scope fragment. One function,
   * so "department" cannot mean the employee's department in one report and
   * something else in the other.
   */
  static employeePredicate(filters: {
    departmentId?: string | undefined;
    locationId?: string | undefined;
  }): SQL | undefined {
    const parts: SQL[] = [];
    if (filters.departmentId !== undefined) {
      parts.push(eq(employees.departmentId, filters.departmentId));
    }
    if (filters.locationId !== undefined) {
      parts.push(eq(employees.locationId, filters.locationId));
    }
    return parts.length === 0 ? undefined : and(...parts);
  }

  // ------------------------------------------------------------ punch audit

  async punchAudit(
    filters: ReportScopeFilters,
    sort: readonly { field: string; direction: 'asc' | 'desc' }[],
    limit: number,
    offset: number,
  ): Promise<PunchAuditPage> {
    const where = this.punchWhere(filters);

    const rows = await this.punchSelect()
      .where(where)
      .orderBy(...this.punchOrderBy(sort))
      .limit(limit)
      .offset(offset);

    return { rows: rows.map((row: PunchRow) => toPunchRecord(row)), total: await this.countPunches(filters) };
  }

  async countPunches(filters: ReportScopeFilters): Promise<number> {
    const rows = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(punches)
      .innerJoin(
        employees,
        and(
          eq(employees.id, punches.employeeId),
          eq(employees.orgId, this.ctx.orgId),
          isNull(employees.deletedAt),
        ),
      )
      .where(this.punchWhere(filters));
    return rows[0]?.value ?? 0;
  }

  private punchSelect() {
    return this.db
      .select(PUNCH_COLUMNS)
      .from(punches)
      // Inner, matching the muster: a punch whose employee has been
      // soft-deleted is not a row any report should render, and an outer join
      // would produce one with a nameless employee.
      .innerJoin(
        employees,
        and(
          eq(employees.id, punches.employeeId),
          eq(employees.orgId, this.ctx.orgId),
          isNull(employees.deletedAt),
        ),
      );
  }

  private punchWhere(filters: ReportScopeFilters): SQL {
    return this.orgScoped(
      filters.scope,
      ReportRepository.employeePredicate(filters),
      filters.employeeId === undefined ? undefined : eq(punches.employeeId, filters.employeeId),
      filters.from === undefined ? undefined : gte(punches.attendanceDate, filters.from),
      filters.to === undefined ? undefined : lte(punches.attendanceDate, filters.to),
      filters.punchType === undefined ? undefined : eq(punches.punchType, filters.punchType),
    );
  }

  /**
   * The id tiebreak is not decoration: two punches can share a millisecond --
   * a double tap produces exactly that -- and without it one row appears on
   * two pages while another never appears at all.
   */
  private punchOrderBy(
    sort: readonly { field: string; direction: 'asc' | 'desc' }[],
  ): (SQL | PgColumn)[] {
    const clauses: (SQL | PgColumn)[] = [];
    for (const term of sort) {
      const column = PUNCH_SORT_COLUMNS[term.field];
      if (column === undefined) continue;
      clauses.push(term.direction === 'desc' ? desc(column) : asc(column));
    }
    if (clauses.length === 0) clauses.push(desc(punches.serverTime));
    clauses.push(desc(punches.id));
    return clauses;
  }
}
