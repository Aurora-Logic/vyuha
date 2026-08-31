import { Injectable } from '@nestjs/common';
import {
  DEFAULT_EMPLOYEE_SORT,
  EMPLOYEE_SORT_FIELDS,
  ERROR_CODES,
  PERMISSIONS,
  pageSlice,
  paginated,
  parseSort,
  type EmployeeImportReport,
  type EmployeeImportRequest,
  type EmployeeListItem,
  type EmployeeListQuery,
  type EmployeeStatus,
  type Paginated,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { departments, designations, employees, locations } from '../db/schema/index.js';
import { ScopedRepository } from '../db/scoped-repository.js';
import { assertHolidayCalendarInOrg } from '../org/holiday-calendar-ref.js';
import { orgContextOf, type Principal } from '../rbac/principal.js';
import { ScopeService, type ScopeGrants } from '../rbac/scope.service.js';
import {
  countImportActions,
  planEmployeeImport,
} from './employee-import.js';
import type { CreateEmployeeBody, UpdateEmployeeBody } from './employee.dto.js';
import { EmployeeRepository, type EmployeeDetailView } from './employee.repository.js';

/**
 * Employee master data (REQ-A-03 … REQ-A-07). Everything that decides anything
 * lives here: the controller parses and delegates, the repository runs SQL.
 */

/**
 * PRD §2.1 grants `employee.view` to Operations marked "(team)" and to HR and
 * Admin unmarked. There is no `employee.view.all` key to read that from, and
 * the only thing separating the two rows of the matrix is `employee.manage` --
 * so that is what widens the breadth.
 *
 * `self` is the same key as `team` on purpose. Read literally, PRD §2's
 * definition of a team excludes the manager, and a directory that hides the
 * viewer's own record from them would be a bug rather than a control: `/auth/me`
 * already returns more about that one person than this endpoint does.
 */
export const EMPLOYEE_SCOPE_GRANTS: ScopeGrants = {
  self: PERMISSIONS.EMPLOYEE_VIEW,
  team: PERMISSIONS.EMPLOYEE_VIEW,
  all: PERMISSIONS.EMPLOYEE_MANAGE,
};

/** The three masters an employee points at, and the field that names each. */
const REFERENCE_TABLES = {
  departmentId: departments,
  designationId: designations,
  locationId: locations,
} as const;

@Injectable()
export class EmployeeService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
    private readonly auditContext: AuditContext,
  ) {}

  async list(principal: Principal, query: EmployeeListQuery): Promise<Paginated<EmployeeListItem>> {
    const { limit, offset } = pageSlice(query);

    const { rows, total } = await this.repository(principal).list({
      scope: this.scopeFor(principal),
      q: query.q,
      departmentId: query.departmentId,
      locationId: query.locationId,
      status: query.status,
      sort: parseSort(query.sort ?? DEFAULT_EMPLOYEE_SORT, EMPLOYEE_SORT_FIELDS),
      limit,
      offset,
    });

    return paginated(rows, query, total);
  }

  /**
   * REQ-U-05 / REQ-V-02, fixed 31 Aug 2026: the owner picker on a deal and
   * the assignee picker on a task were reading the employee register, whose
   * `all` breadth is `employee.manage` -- a key Sales, Sales manager and
   * Relationship manager do not hold. They were not seeing a short list;
   * they were seeing a 403. This is the narrow directory those pickers
   * actually need: living ACTIVE colleagues, name and code only.
   */
  async assignable(principal: Principal): Promise<{ id: string; firstName: string; lastName: string | null; employeeCode: string }[]> {
    // A roster, not a page: every picker wants the whole list to search
    // locally. The cap is a guard against an absurd org, not a page size.
    return this.repository(principal).assignable(1000);
  }

  async findOne(principal: Principal, id: string): Promise<EmployeeDetailView> {
    const employee = await this.repository(principal).detail(id, this.scopeFor(principal));
    // Out of scope and non-existent are the same answer deliberately. A 403
    // here would confirm that the id names a real employee, which is the
    // information an Operations user probing ids is trying to obtain.
    if (employee === null) throw AppError.notFound('Employee', id);
    return employee;
  }

  async create(principal: Principal, input: CreateEmployeeBody): Promise<EmployeeDetailView> {
    const repository = this.repository(principal);

    await this.assertCodeAvailable(repository, input.employeeCode);
    await this.assertReferencesExist(principal, input);
    assertLifecycleConsistent(input.status, input.dateOfJoining, input.dateOfLeaving ?? null);

    // A new row cannot be its own ancestor -- nothing reports to an id that
    // did not exist a moment ago -- so REQ-A-07 needs only the existence check
    // above here. The cycle check belongs on update, where it can happen.
    const created = await this.insert(repository, input);
    const detail = await this.readBack(repository, created.id);

    this.auditContext.record({
      action: 'employee.created',
      entityType: 'employee',
      entityId: detail.id,
      before: null,
      after: detail,
    });

    return detail;
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateEmployeeBody,
  ): Promise<EmployeeDetailView> {
    const repository = this.repository(principal);
    const existing = await repository.detail(id, this.scopeFor(principal));
    if (existing === null) throw AppError.notFound('Employee', id);

    assertCodeUnchanged(existing.employeeCode, input.employeeCode);
    await this.assertReferencesExist(principal, input);
    await this.assertNoReportingCycle(repository, existing, input);

    assertLifecycleConsistent(
      input.status ?? existing.status,
      input.dateOfJoining ?? existing.dateOfJoining,
      input.dateOfLeaving !== undefined ? input.dateOfLeaving : existing.dateOfLeaving,
    );

    // Dropped rather than written back: it is either absent or identical to
    // what is already stored, and passing it to the update statement would
    // make the immutable column part of a SET clause for no reason.
    const { employeeCode: _immutable, ...changes } = input;

    const updated = await repository.update(id, changes);
    if (updated === null) throw AppError.notFound('Employee', id);

    const detail = await this.readBack(repository, id);

    this.auditContext.record({
      action: 'employee.updated',
      entityType: 'employee',
      entityId: id,
      before: existing,
      after: detail,
    });

    return detail;
  }

  // ------------------------------------------------------------- internals

  private repository(principal: Principal): EmployeeRepository {
    return new EmployeeRepository(this.db, orgContextOf(principal));
  }

  /**
   * Technical design §10: the fragment comes from `ScopeService`, never from
   * here. `employees.id` is the column it is written against, because on this
   * table the employee a row is *about* is the row itself.
   */
  private scopeFor(principal: Principal): SQL {
    return this.scopes.resolve(principal, EMPLOYEE_SCOPE_GRANTS, employees.id).where;
  }

  /**
   * REQ-A-06, the preview. Writes nothing, ever.
   *
   * Separate from the commit rather than a flag on it, because "show me what
   * this file would do" and "do it" are different intentions and a boolean is
   * a poor place to keep them apart -- particularly on the one operation that
   * can create several hundred people.
   */
  async validateImport(
    principal: Principal,
    request: EmployeeImportRequest,
  ): Promise<EmployeeImportReport> {
    const plan = planEmployeeImport(request.rows, await this.repository(principal).importLookups());
    return {
      rows: plan.results,
      counts: countImportActions(plan.results),
      committed: false,
      createdCount: 0,
    };
  }

  /**
   * REQ-A-06, the commit. Partial by design: the valid rows are created and the
   * bad ones are reported, because refusing a hundred good rows over one typo
   * is how somebody ends up editing records by hand instead.
   *
   * The plan is recomputed here rather than carried over from the preview. A
   * preview is a photograph of a moment, and between the two calls somebody may
   * have taken the employee code this file wants.
   */
  async commitImport(
    principal: Principal,
    request: EmployeeImportRequest,
  ): Promise<EmployeeImportReport> {
    const repository = this.repository(principal);
    const plan = planEmployeeImport(request.rows, await repository.importLookups());

    const createdIdByCode = new Map<string, string>();
    for (const row of plan.creatable) {
      const created = await this.insert(repository, {
        employeeCode: row.employeeCode,
        firstName: row.firstName,
        lastName: row.lastName,
        workEmail: row.workEmail,
        personalEmail: row.personalEmail,
        mobile: row.mobile,
        dateOfJoining: row.dateOfJoining,
        dateOfLeaving: null,
        employmentType: row.employmentType,
        status: row.status,
        departmentId: row.departmentId,
        designationId: row.designationId,
        locationId: row.locationId,
        reportingManagerId: row.reportingManagerId,
        isFieldStaff: row.isFieldStaff,
      });
      createdIdByCode.set(row.employeeCode.toUpperCase(), created.id);
    }

    // Managers who were themselves in this file could not be linked on insert:
    // their id did not exist yet. Linking is a second pass rather than a sort,
    // because a sort cannot order a chain that arrives in any order and would
    // still leave the first row pointing at nothing.
    for (const row of plan.creatable) {
      if (row.reportingManagerCode === null) continue;
      const managerId = createdIdByCode.get(row.reportingManagerCode);
      const selfId = createdIdByCode.get(row.employeeCode.toUpperCase());
      if (managerId === undefined || selfId === undefined) continue;
      await repository.update(selfId, { reportingManagerId: managerId });
    }

    // One audit row for the import, not one per employee: the individual
    // creations are already audited by `insert`, and REQ-M-01 wants the action
    // somebody took to be findable, which was "imported this file".
    this.auditContext.record({
      action: 'employee.imported',
      entityType: 'employee',
      entityId: null,
      before: null,
      after: {
        rows: request.rows.length,
        created: plan.creatable.length,
        errors: plan.results.filter((row) => row.action === 'ERROR').length,
      },
    });

    return {
      rows: plan.results,
      counts: countImportActions(plan.results),
      committed: true,
      createdCount: plan.creatable.length,
    };
  }

  private async insert(
    repository: EmployeeRepository,
    input: CreateEmployeeBody,
  ): Promise<{ id: string }> {
    try {
      return await repository.insert(input);
    } catch (error: unknown) {
      // The pre-flight check above answered for the instant it ran. The
      // partial unique index is what actually decides, and losing that race
      // must read as a conflict rather than as a crash.
      if (isUniqueViolation(error)) {
        throw codeTakenError(input.employeeCode, error);
      }
      throw error;
    }
  }

  /**
   * The row was just written by this caller, inside their own organisation, so
   * it is read back unscoped: a creator whose breadth is narrower than the row
   * they authored should still be handed what they created rather than a 404.
   * `ScopedRepository` still applies `org_id`, which is the boundary that matters.
   */
  private async readBack(repository: EmployeeRepository, id: string): Promise<EmployeeDetailView> {
    const detail = await repository.detail(id, sql`true`);
    if (detail === null) {
      throw new Error(`Employee ${id} was written but could not be read back.`);
    }
    return detail;
  }

  private async assertCodeAvailable(
    repository: EmployeeRepository,
    employeeCode: string,
  ): Promise<void> {
    const existingId = await repository.findIdByCode(employeeCode);
    if (existingId !== null) throw codeTakenError(employeeCode);
  }

  /**
   * Every id in the payload has to name a live row in this organisation.
   * Without this the foreign key would refuse the insert and the caller would
   * get a 500 naming a constraint, and a *soft-deleted* department would be
   * accepted outright -- the constraint cannot see `deleted_at`.
   */
  private async assertReferencesExist(
    principal: Principal,
    input: CreateEmployeeBody | UpdateEmployeeBody,
  ): Promise<void> {
    const ctx = orgContextOf(principal);

    for (const [field, table] of Object.entries(REFERENCE_TABLES)) {
      const id: unknown = input[field as keyof typeof REFERENCE_TABLES];
      if (typeof id !== 'string') continue;
      const exists = await new ScopedRepository(this.db, table, ctx).exists(id);
      if (!exists) throw unknownReferenceError(field, id);
    }

    const managerId = input.reportingManagerId;
    if (typeof managerId === 'string') {
      const exists = await new EmployeeRepository(this.db, ctx).exists(managerId);
      if (!exists) throw unknownReferenceError('reportingManagerId', managerId);
    }

    // Not in REFERENCE_TABLES: holiday_calendars is attendance-owned, so the
    // check goes through raw SQL rather than a drizzle table this layer may
    // not import (OS-3, REQ-H-02).
    await assertHolidayCalendarInOrg(this.db, ctx.orgId, input.holidayCalendarId);
  }

  /** REQ-A-07, including the self-reference and the multi-level A -> B -> C -> A. */
  private async assertNoReportingCycle(
    repository: EmployeeRepository,
    existing: EmployeeDetailView,
    input: UpdateEmployeeBody,
  ): Promise<void> {
    const proposed = input.reportingManagerId;
    if (proposed === undefined || proposed === null) return;
    if (proposed === existing.reportingManager?.id) return;

    if (await repository.wouldCloseReportingCycle(existing.id, proposed)) {
      throw new AppError(
        ERROR_CODES.REPORTING_CYCLE,
        proposed === existing.id
          ? 'An employee cannot report to themselves.'
          : 'That manager already reports to this employee, directly or through someone else.',
        { details: { employeeId: existing.id, reportingManagerId: proposed } },
      );
    }
  }
}

/** REQ-A-04: the code identifies the person on every report; it never changes. */
function assertCodeUnchanged(current: string, submitted: string | undefined): void {
  if (submitted === undefined || submitted === current) return;
  throw new AppError(
    ERROR_CODES.EMPLOYEE_CODE_IMMUTABLE,
    'The employee code cannot be changed after the record is created.',
    { details: { employeeCode: current, submitted } },
  );
}

/**
 * REQ-A-05. "Deactivate with a last working date" is one action, not two: an
 * inactive employee with no last working day cannot be reported on, and the
 * punch rule ("cannot punch from the day after their last working date") has
 * no date to compare against.
 *
 * The mirror rule is what makes reactivation honest. Leaving a leaving date on
 * an ACTIVE record would silently keep that punch block in force, and the
 * screen would say active while the employee could not punch.
 */
function assertLifecycleConsistent(
  status: EmployeeStatus,
  dateOfJoining: string,
  dateOfLeaving: string | null,
): void {
  if (status === 'INACTIVE' && dateOfLeaving === null) {
    throw AppError.validation('Deactivating an employee requires a last working date.', {
      fields: [{ path: 'dateOfLeaving', message: 'required when status is INACTIVE' }],
    });
  }

  if (status === 'ACTIVE' && dateOfLeaving !== null) {
    throw AppError.validation('An active employee cannot have a last working date.', {
      fields: [{ path: 'dateOfLeaving', message: 'must be null when status is ACTIVE' }],
    });
  }

  if (dateOfLeaving !== null && dateOfLeaving < dateOfJoining) {
    throw AppError.validation('The last working date is before the joining date.', {
      fields: [{ path: 'dateOfLeaving', message: `must not be earlier than ${dateOfJoining}` }],
    });
  }
}

function codeTakenError(employeeCode: string, cause?: unknown): AppError {
  return new AppError(
    ERROR_CODES.CONFLICT,
    'Another employee already uses that employee code.',
    { details: { employeeCode }, ...(cause === undefined ? {} : { cause }) },
  );
}

function unknownReferenceError(field: string, id: string): AppError {
  return AppError.validation('One or more references do not exist in this organisation.', {
    fields: [{ path: field, message: 'no such record', value: id }],
  });
}
