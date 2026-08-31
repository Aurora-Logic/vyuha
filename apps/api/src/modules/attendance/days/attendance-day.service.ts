import { Injectable } from '@nestjs/common';
import {
  DEFAULT_ATTENDANCE_DAY_SORT,
  ATTENDANCE_DAY_SORT_FIELDS,
  pageSlice,
  paginated,
  parseAttendanceFlags,
  parseSort,
  type AttendanceDayDetail,
  type AttendanceDayQuery,
  type AttendanceDaySummary,
  type Paginated,
} from '@vyuha/shared';
import type { SQL } from 'drizzle-orm';

import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import { orgContextOf, type Principal } from '../../../platform/rbac/principal.js';
import { ScopeService } from '../../../platform/rbac/scope.service.js';
import { attendanceDays } from '../schema/index.js';
import { ATTENDANCE_SCOPE_GRANTS } from '../punch/attendance-scope.js';
import { PunchRepository } from '../punch/punch.repository.js';
import { AttendanceDayRepository } from './attendance-day.repository.js';
import {
  dayDetailForViewer,
  dayForViewer,
  overtimeVisibleTo,
} from './attendance-day-visibility.js';

/**
 * The muster and the single-day view (REQ-E-01 … REQ-E-05, PRD §5).
 *
 * Read only. Every writer of `attendance_days` is the day engine, and the two
 * mutating routes technical design §6 lists for this resource -- the REQ-E-08
 * override and the REQ-E-09 lock -- are their own slices and are deliberately
 * not smuggled in here.
 */
@Injectable()
export class AttendanceDayService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly scopes: ScopeService,
  ) {}

  async list(
    principal: Principal,
    query: AttendanceDayQuery,
  ): Promise<Paginated<AttendanceDaySummary>> {
    const { limit, offset } = pageSlice(query);

    const { rows, total } = await this.repository(principal).list({
      scope: this.scopeFor(principal),
      from: query.from,
      to: query.to,
      employeeId: query.employeeId,
      departmentId: query.departmentId,
      status: query.status,
      flags: parseAttendanceFlags(query.flags),
      sort: parseSort(query.sort ?? DEFAULT_ATTENDANCE_DAY_SORT, ATTENDANCE_DAY_SORT_FIELDS),
      limit,
      offset,
    });

    // Scope decides *which* rows this caller gets; this decides which fields
    // are on them. Applied here rather than in the controller because it is a
    // rule about the data, and controllers validate and delegate (CLAUDE.md
    // §6).
    const canSeeOvertime = overtimeVisibleTo(principal);

    return paginated(
      rows.map((row) => dayForViewer(row, canSeeOvertime)),
      query,
      total,
    );
  }

  /**
   * One day with its punches (REQ-M-02's history panel, and the punch audit
   * view). The punches are read through the same scope predicate as the day,
   * so a caller who can see the day can see what produced it and no more.
   */
  async findDay(
    principal: Principal,
    employeeId: string,
    date: string,
  ): Promise<AttendanceDayDetail> {
    const scope = this.scopeFor(principal);
    const day = await this.repository(principal).findDay(employeeId, date, scope);

    // Out of scope and non-existent answer the same, as everywhere else: a 403
    // would confirm that the employee id names somebody real.
    if (day === null) throw AppError.notFound('Attendance day');

    const punches = await new PunchRepository(this.db, orgContextOf(principal)).findForDay(
      employeeId,
      date,
    );

    return dayDetailForViewer({ ...day, punches }, overtimeVisibleTo(principal));
  }

  // ------------------------------------------------------------- internals

  private repository(principal: Principal): AttendanceDayRepository {
    return new AttendanceDayRepository(this.db, orgContextOf(principal));
  }

  /**
   * Technical design §10: the fragment comes from `ScopeService`, never from
   * here. Written against `attendance_days.employee_id`, which is the column
   * naming the person the row is about.
   */
  private scopeFor(principal: Principal): SQL {
    return this.scopes.resolve(principal, ATTENDANCE_SCOPE_GRANTS, attendanceDays.employeeId).where;
  }
}
