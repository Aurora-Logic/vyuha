import {
  employeeDisplayName,
  type EmployeeDetail,
  type EmployeeListItem,
  type EmployeeSortField,
  type EmployeeStatus,
  type EmploymentType,
  type NamedRef,
  type SortTerm,
} from '@vyuha/shared';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { Database } from '../db/db.provider.js';
import {
  departments,
  designations,
  employees,
  locations,
} from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';
import { employeeNameSql } from './employee-name.js';

/**
 * The employee read and write surface (REQ-A-03).
 *
 * It extends `ScopedRepository` rather than sitting beside it because ADR 0001
 * makes that base class "the only sanctioned way to reach a scoped table": the
 * list query below joins four tables and still starts from `this.scoped(...)`,
 * so `org_id` and `deleted_at IS NULL` are on the statement before any filter
 * a caller supplied.
 */

/**
 * Created once at module scope. `alias()` mints a new object each call, and a
 * join built from one instance while the select reads another produces SQL
 * referring to two different aliases -- which Postgres accepts and answers
 * with a cross join.
 */
const managers = alias(employees, 'reporting_manager');

/**
 * `EmployeeDetail` plus the holiday calendar link (OS-3, REQ-H-02): the
 * employee's own calendar, overriding the location's in the day engine.
 * Declared here rather than in `@vyuha/shared` because the id is validated
 * against an attendance-owned table the shared package knows nothing about.
 */
export interface EmployeeDetailView extends EmployeeDetail {
  readonly holidayCalendarId: string | null;
}

const SORT_COLUMNS: Record<EmployeeSortField, PgColumn> = {
  employeeCode: employees.employeeCode,
  firstName: employees.firstName,
  lastName: employees.lastName,
  dateOfJoining: employees.dateOfJoining,
  dateOfLeaving: employees.dateOfLeaving,
  employmentType: employees.employmentType,
  status: employees.status,
};

export interface EmployeeListFilters {
  /** Resolved by `ScopeService`; never built here and never optional. */
  readonly scope: SQL;
  readonly q?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly status?: EmployeeStatus | undefined;
  readonly sort: readonly SortTerm[];
  readonly limit: number;
  readonly offset: number;
}

/** The flat shape the joined select produces, before it is nested for the client. */
interface JoinedRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string | null;
  workEmail: string | null;
  personalEmail: string | null;
  mobile: string | null;
  dateOfJoining: string;
  dateOfLeaving: string | null;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  isFieldStaff: boolean;
  holidayCalendarId: string | null;
  tallyRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  departmentId: string | null;
  departmentName: string | null;
  designationId: string | null;
  designationName: string | null;
  locationId: string | null;
  locationName: string | null;
  managerId: string | null;
  managerFirstName: string | null;
  managerLastName: string | null;
}

export class EmployeeRepository extends ScopedRepository<typeof employees> {
  constructor(db: Database, ctx: OrgContext) {
    super(db, employees, ctx);
  }

  async list(filters: EmployeeListFilters): Promise<{ rows: EmployeeListItem[]; total: number }> {
    const where = this.scoped(filters.scope, this.filterPredicate(filters));

    // Two statements rather than a window function. `count(*) OVER ()` would
    // return no row at all for an empty page, and the difference between "no
    // rows" and "total zero" is the difference between an empty state and a
    // pagination bug the user sees as a blank page three.
    const rows = await this.joinedSelect()
      .where(where)
      .orderBy(...this.orderBy(filters.sort))
      .limit(filters.limit)
      .offset(filters.offset);

    const totals = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(employees)
      .where(where);

    return { rows: rows.map(toListItem), total: totals[0]?.value ?? 0 };
  }

  /**
   * `scope` is required here too. A detail read that skipped it would be the
   * IDOR the scoping exists to prevent: the id comes from the client, and an
   * Operations user who guesses one outside their team must get the same
   * answer as for an id that does not exist.
   */
  async detail(id: string, scope: SQL): Promise<EmployeeDetailView | null> {
    const rows = await this.joinedSelect()
      .where(this.scoped(scope, eq(employees.id, id)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toDetail(row);
  }

  /** REQ-A-04: unique per organisation, among the living. */
  async findIdByCode(employeeCode: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(this.scoped(eq(employees.employeeCode, employeeCode)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * REQ-A-07, the multi-level case. Walks *up* from the proposed manager: if
   * the employee being edited is anywhere in that chain, pointing at this
   * manager closes a loop.
   *
   * A recursive CTE rather than a loop in JavaScript, which would be one round
   * trip per level and would still have to decide when to give up. Self-
   * reference falls out of the same query -- the anchor row is the proposed
   * manager, so a manager who *is* the employee matches immediately.
   *
   * `UNION`, not `UNION ALL`: a cycle that already exists in the data, from a
   * repair script or a restored backup, must terminate rather than recurse
   * until Postgres runs out of memory. Deduplicating each round is what makes
   * the validator survive the very thing it validates against.
   */
  async wouldCloseReportingCycle(employeeId: string, proposedManagerId: string): Promise<boolean> {
    const orgId = this.ctx.orgId;

    const result = await this.db.execute<{ hit: number }>(sql`
      WITH RECURSIVE vy_manager_chain AS (
        SELECT ${employees.id} AS id, ${employees.reportingManagerId} AS manager_id
          FROM ${employees}
         WHERE ${employees.orgId} = ${orgId}
           AND ${employees.deletedAt} IS NULL
           AND ${employees.id} = ${proposedManagerId}
        UNION
        SELECT ${employees.id}, ${employees.reportingManagerId}
          FROM ${employees}
          JOIN vy_manager_chain ON ${employees.id} = vy_manager_chain.manager_id
         WHERE ${employees.orgId} = ${orgId}
           AND ${employees.deletedAt} IS NULL
      )
      SELECT 1 AS hit FROM vy_manager_chain WHERE id = ${employeeId} LIMIT 1
    `);

    return result.rows.length > 0;
  }

  // ------------------------------------------------------------- internals

  /**
   * Every join carries the organisation and the soft-delete predicate of the
   * table it joins. The foreign keys make a cross-organisation row impossible
   * today, but a join is where that stops being true first -- and a deleted
   * department must read as "none", not as a name nobody can see on the
   * departments screen.
   */
  private joinedSelect() {
    const orgId = this.ctx.orgId;

    return this.db
      .select({
        id: employees.id,
        employeeCode: employees.employeeCode,
        firstName: employees.firstName,
        lastName: employees.lastName,
        workEmail: employees.workEmail,
        personalEmail: employees.personalEmail,
        mobile: employees.mobile,
        dateOfJoining: employees.dateOfJoining,
        dateOfLeaving: employees.dateOfLeaving,
        employmentType: employees.employmentType,
        status: employees.status,
        isFieldStaff: employees.isFieldStaff,
        holidayCalendarId: employees.holidayCalendarId,
        tallyRef: employees.tallyRef,
        createdAt: employees.createdAt,
        updatedAt: employees.updatedAt,
        departmentId: departments.id,
        departmentName: departments.name,
        designationId: designations.id,
        designationName: designations.name,
        locationId: locations.id,
        locationName: locations.name,
        managerId: managers.id,
        managerFirstName: managers.firstName,
        managerLastName: managers.lastName,
      })
      .from(employees)
      .leftJoin(
        departments,
        and(
          eq(departments.id, employees.departmentId),
          eq(departments.orgId, orgId),
          isNull(departments.deletedAt),
        ),
      )
      .leftJoin(
        designations,
        and(
          eq(designations.id, employees.designationId),
          eq(designations.orgId, orgId),
          isNull(designations.deletedAt),
        ),
      )
      .leftJoin(
        locations,
        and(
          eq(locations.id, employees.locationId),
          eq(locations.orgId, orgId),
          isNull(locations.deletedAt),
        ),
      )
      .leftJoin(
        managers,
        and(
          eq(managers.id, employees.reportingManagerId),
          eq(managers.orgId, orgId),
          isNull(managers.deletedAt),
        ),
      );
  }

  /**
   * REQ-A-06: everything the import planner needs to resolve a spreadsheet,
   * in four queries rather than four per row.
   *
   * A hundred-row file naming a department on every row would otherwise be a
   * hundred lookups for the same handful of names. The masters are small
   * enough to read whole, and reading them whole also means the planner sees
   * one consistent picture rather than a moving one.
   */
  async importLookups(): Promise<{
    departments: Map<string, string>;
    designations: Map<string, string>;
    locations: Map<string, string>;
    employeesByCode: Map<string, string>;
    managerEdges: Map<string, string>;
  }> {
    const orgId = this.ctx.orgId;
    const byLowerName = (rows: readonly { id: string; name: string }[]): Map<string, string> =>
      new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));

    const [departmentRows, designationRows, locationRows] = await Promise.all([
      this.db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(and(eq(departments.orgId, orgId), isNull(departments.deletedAt))),
      this.db
        .select({ id: designations.id, name: designations.name })
        .from(designations)
        .where(and(eq(designations.orgId, orgId), isNull(designations.deletedAt))),
      this.db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(and(eq(locations.orgId, orgId), isNull(locations.deletedAt))),
    ]);

    // Codes and edges come from one pass. Reading them separately could show a
    // manager that the code map does not contain.
    const manager = alias(employees, 'import_manager');
    const peopleRows = await this.db
      .select({
        code: employees.employeeCode,
        id: employees.id,
        managerCode: manager.employeeCode,
      })
      .from(employees)
      .leftJoin(manager, eq(employees.reportingManagerId, manager.id))
      .where(and(eq(employees.orgId, orgId), isNull(employees.deletedAt)));

    const employeesByCode = new Map<string, string>();
    const managerEdges = new Map<string, string>();
    for (const person of peopleRows) {
      employeesByCode.set(person.code.toUpperCase(), person.id);
      if (person.managerCode !== null) {
        managerEdges.set(person.code.toUpperCase(), person.managerCode.toUpperCase());
      }
    }

    return {
      departments: byLowerName(departmentRows),
      designations: byLowerName(designationRows),
      locations: byLowerName(locationRows),
      employeesByCode,
      managerEdges,
    };
  }

  private filterPredicate(filters: EmployeeListFilters): SQL | undefined {
    const parts: SQL[] = [];

    if (filters.departmentId !== undefined) {
      parts.push(eq(employees.departmentId, filters.departmentId));
    }
    if (filters.locationId !== undefined) {
      parts.push(eq(employees.locationId, filters.locationId));
    }
    if (filters.status !== undefined) {
      parts.push(eq(employees.status, filters.status));
    }
    if (filters.q !== undefined) {
      parts.push(searchPredicate(filters.q));
    }

    return parts.length === 0 ? undefined : and(...parts);
  }

  /**
   * The id tiebreak is not decoration. Two employees with the same surname
   * would otherwise come back in whatever order Postgres found convenient, and
   * that order can differ between two requests -- so a row could appear on
   * page one and again on page two while another never appears at all.
   */
  private orderBy(sort: readonly SortTerm[]): (SQL | PgColumn)[] {
    const clauses: (SQL | PgColumn)[] = [];
    for (const term of sort) {
      const column = SORT_COLUMNS[term.field as EmployeeSortField];
      if (column === undefined) continue;
      clauses.push(term.direction === 'desc' ? desc(column) : asc(column));
    }
    if (clauses.length === 0) clauses.push(asc(employees.employeeCode));
    clauses.push(asc(employees.id));
    return clauses;
  }
}

/**
 * Free text over the code and both name parts, plus the two joined together so
 * that "asha men" finds "Asha Menon".
 *
 * The pattern escapes the wildcards before wrapping the term. Without that, a
 * search for `%` matches every employee in the organisation -- not a security
 * hole, since the scope predicate still applies, but a filter that silently
 * stops filtering is worse than one that finds nothing.
 */
function searchPredicate(term: string): SQL {
  const pattern = `%${term.replace(/([\\%_])/gu, '\\$1')}%`;
  return sql`(
    ${employees.employeeCode} ILIKE ${pattern}
    OR ${employees.firstName} ILIKE ${pattern}
    OR coalesce(${employees.lastName}, '') ILIKE ${pattern}
    OR ${employeeNameSql(employees.firstName, employees.lastName)} ILIKE ${pattern}
  )`;
}

function namedRef(id: string | null, name: string | null): NamedRef | null {
  return id === null || name === null ? null : { id, name };
}

function toListItem(row: JoinedRow): EmployeeListItem {
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    workEmail: row.workEmail,
    mobile: row.mobile,
    dateOfJoining: row.dateOfJoining,
    dateOfLeaving: row.dateOfLeaving,
    employmentType: row.employmentType,
    status: row.status,
    department: namedRef(row.departmentId, row.departmentName),
    designation: namedRef(row.designationId, row.designationName),
    location: namedRef(row.locationId, row.locationName),
    reportingManager:
      row.managerId === null || row.managerFirstName === null
        ? null
        : { id: row.managerId, name: employeeDisplayName(row.managerFirstName, row.managerLastName) },
  };
}

function toDetail(row: JoinedRow): EmployeeDetailView {
  return {
    ...toListItem(row),
    personalEmail: row.personalEmail,
    isFieldStaff: row.isFieldStaff,
    holidayCalendarId: row.holidayCalendarId,
    tallyRef: row.tallyRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
