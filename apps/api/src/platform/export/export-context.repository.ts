import { employeeDisplayName } from '@vyuha/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db/db.provider.js';
import { employees, organizations, users } from '../db/schema/index.js';
import type { OrgContext } from '../db/scoped-repository.js';

/**
 * The few facts the export framework needs about the world around a report:
 * the organisation's header-block conventions, who asked for the file, and
 * display names for the ids in a filter.
 *
 * These lived in the attendance module's `ReportRepository`, which is the one
 * place they could not stay: every table here is platform-owned, and they were
 * the imports keeping `ExportService` and `ScheduleService` pinned inside a
 * module whose knowledge they never actually used (REQ-P-02).
 */

export interface OrgProfile {
  readonly name: string;
  readonly timezone: string;
  readonly dateFormat: string;
  /** REQ-L-01. The leave balance report reads it to name the year (05-decisions: April). */
  readonly leaveYearStartMonth: number;
}

export interface ExportRequesterRow {
  readonly employeeId: string | null;
  readonly email: string;
  readonly status: 'INVITED' | 'ACTIVE' | 'SUSPENDED';
}

export class ExportContextRepository {
  constructor(
    private readonly db: Database,
    private readonly ctx: OrgContext,
  ) {}

  /** REQ-J-03's header block needs the organisation's name and conventions. */
  async orgProfile(): Promise<OrgProfile> {
    const rows = await this.db
      .select({
        name: organizations.name,
        timezone: organizations.timezone,
        dateFormat: organizations.dateFormat,
        leaveYearStartMonth: organizations.leaveYearStartMonth,
      })
      .from(organizations)
      .where(and(eq(organizations.id, this.ctx.orgId), isNull(organizations.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Organisation ${this.ctx.orgId} was not found while preparing an export.`);
    }
    return row;
  }

  /**
   * Who asked for the export, re-read at the moment the job runs.
   *
   * The job re-resolves the requester rather than trusting a snapshot taken
   * when the button was pressed. A person suspended, or stripped of the
   * permission, between queueing and running must not have a file produced for
   * them -- that gap can be minutes, and an export is exactly the artefact
   * somebody would race a revocation for.
   */
  async findRequester(userId: string): Promise<ExportRequesterRow | null> {
    const rows = await this.db
      .select({
        employeeId: users.employeeId,
        email: users.email,
        status: users.status,
      })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, this.ctx.orgId), isNull(users.deletedAt)))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Display names for the ids in a filter, so the header block reads
   * "Department: Production" rather than a UUID nobody can act on.
   *
   * Missing ids are simply absent from the map and `describeFilters` falls
   * back to the id. A filter naming a department that has since been deleted
   * is still a true statement about what was exported.
   */
  async filterLabels(ids: {
    employeeId?: string | undefined;
    departmentId?: string | undefined;
    locationId?: string | undefined;
    partyId?: string | undefined;
  }): Promise<Record<string, string>> {
    const labels: Record<string, string> = {};

    if (ids.employeeId !== undefined) {
      const rows = await this.db
        .select({
          id: employees.id,
          code: employees.employeeCode,
          firstName: employees.firstName,
          lastName: employees.lastName,
        })
        .from(employees)
        .where(and(eq(employees.id, ids.employeeId), eq(employees.orgId, this.ctx.orgId)))
        .limit(1);
      const row = rows[0];
      if (row !== undefined) {
        labels[row.id] = `${row.code} ${employeeDisplayName(row.firstName, row.lastName)}`;
      }
    }

    for (const [id, table] of [
      [ids.departmentId, 'departments'] as const,
      [ids.locationId, 'locations'] as const,
    ]) {
      if (id === undefined) continue;
      // Two tables with an identical shape and no shared drizzle type; a raw
      // statement is honest about that rather than pretending to a union.
      const rows = await this.db.execute<{ id: string; name: string }>(
        sql`SELECT id, name FROM ${sql.raw(`"${table}"`)}
             WHERE id = ${id} AND org_id = ${this.ctx.orgId} LIMIT 1`,
      );
      const row = rows.rows[0];
      if (row !== undefined) labels[row.id] = row.name;
    }

    if (ids.partyId !== undefined) {
      // Parties are a projection of Tally's ledgers, so they are read the
      // same raw way as the two tables above rather than through a schema
      // this module does not own.
      const rows = await this.db.execute<{ id: string; name: string }>(
        sql`SELECT id, name FROM parties WHERE id = ${ids.partyId} AND org_id = ${this.ctx.orgId} LIMIT 1`,
      );
      const row = rows.rows[0];
      if (row !== undefined) labels[row.id] = row.name;
    }

    return labels;
  }
}
