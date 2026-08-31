import { and, asc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';

import type { Database } from '../../../platform/db/db.provider.js';
import { employees, organizations, users } from '../../../platform/db/schema/index.js';
import { attendanceDays } from '../schema/index.js';

/**
 * The two reads the punch notification sweeps need, and nothing else.
 *
 * Constructed per organisation like every other repository, but by a job
 * rather than by a request -- so `listOrganisations` is static, for the reason
 * `LeaveRepository.listOrganisationIds` is: a job has no org context to build
 * one from, and it is exactly the thing it is going to enumerate.
 */

export interface OrganisationRow {
  readonly id: string;
  /** REQ-L-01 / NFR-05. The zone "yesterday" and "today" are resolved in. */
  readonly timezone: string;
}

/** An employee with a login, for a sweep that starts from user accounts. */
export interface ReminderCandidate {
  readonly employeeId: string;
  readonly userId: string;
}

export interface MissingOutCandidate {
  readonly employeeId: string;
  readonly employeeName: string;
  /** REQ-E-07 notifies the manager too. Null when nobody is above them. */
  readonly managerEmployeeId: string | null;
}

export class PunchNotificationRepository {
  constructor(
    private readonly db: Database,
    private readonly orgId: string,
  ) {}

  static async listOrganisations(db: Database): Promise<OrganisationRow[]> {
    return db
      .select({ id: organizations.id, timezone: organizations.timezone })
      .from(organizations)
      .where(isNull(organizations.deletedAt))
      .orderBy(asc(organizations.id));
  }

  /**
   * The opted-in accounts that are actually somebody who punches.
   *
   * An account with no employee record (REQ-B-02) has no shift and no punch,
   * so it drops out here rather than producing a reminder about nothing. The
   * user ids come from the preference table via the platform service, so this
   * query never reads a notification table from inside the attendance module.
   */
  async employeesForUsers(userIds: readonly string[]): Promise<ReminderCandidate[]> {
    if (userIds.length === 0) return [];

    const rows = await this.db
      .select({ employeeId: employees.id, userId: users.id })
      .from(users)
      .innerJoin(
        employees,
        and(eq(employees.id, users.employeeId), isNull(employees.deletedAt)),
      )
      .where(
        and(
          eq(users.orgId, this.orgId),
          inArray(users.id, [...userIds]),
          eq(users.status, 'ACTIVE'),
          isNull(users.deletedAt),
          // REQ-A-05: somebody on their last day still punches; somebody
          // already gone does not.
          eq(employees.status, 'ACTIVE'),
        ),
      );

    return rows;
  }

  /**
   * REQ-E-07's candidates for one date: a day with an IN punch and no OUT.
   *
   * Deliberately not "days already flagged `missing_punch`". The flag is only
   * written when the shift window has closed, and the row was last computed at
   * the moment of the IN punch, when it had not -- so selecting on the flag
   * would find nothing on precisely the days this sweep exists for. The sweep
   * recomputes each candidate and reads the flag off the result.
   *
   * Locked days are excluded here rather than left to the engine's own refusal:
   * REQ-E-09 says a locked period is not recomputed, and there is no point
   * spending a recompute to be told so.
   */
  async missingOutCandidates(date: string): Promise<MissingOutCandidate[]> {
    const rows = await this.db
      .select({
        employeeId: attendanceDays.employeeId,
        firstName: employees.firstName,
        lastName: employees.lastName,
        managerEmployeeId: employees.reportingManagerId,
      })
      .from(attendanceDays)
      .innerJoin(
        employees,
        and(eq(employees.id, attendanceDays.employeeId), isNull(employees.deletedAt)),
      )
      .where(
        and(
          eq(attendanceDays.orgId, this.orgId),
          eq(attendanceDays.date, date),
          isNull(attendanceDays.deletedAt),
          eq(attendanceDays.locked, false),
          sql`${attendanceDays.firstInPunchId} IS NOT NULL`,
          isNull(attendanceDays.lastOutPunchId),
        ),
      )
      .orderBy(asc(attendanceDays.employeeId));

    return rows.map((row) => ({
      employeeId: row.employeeId,
      employeeName:
        row.lastName === null || row.lastName.length === 0
          ? row.firstName
          : `${row.firstName} ${row.lastName}`,
      managerEmployeeId: row.managerEmployeeId,
    }));
  }

  /**
   * Active employees with no attendance day for the date -- nobody wrote one,
   * which means no punch, no leave, no override touched it. The engine decides
   * what that day is (ABSENT for an expected working day, or the rest-day
   * status); this only finds who to ask about. A non-rostered account resolves
   * to no shift and the engine skips it, so it costs one compute and no row.
   */
  async absentCandidates(date: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.orgId, this.orgId),
          // REQ-A-05: on their last day they still work; already gone, they do not.
          eq(employees.status, 'ACTIVE'),
          isNull(employees.deletedAt),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(attendanceDays)
              .where(
                and(
                  eq(attendanceDays.orgId, this.orgId),
                  eq(attendanceDays.employeeId, employees.id),
                  eq(attendanceDays.date, date),
                  isNull(attendanceDays.deletedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(employees.id));

    return rows.map((row) => row.id);
  }
}
