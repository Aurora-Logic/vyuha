import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ATTENDANCE_ANALYTICS_REPORTS,
  ATTENDANCE_ANALYTICS_REPORT_KEYS,
  PERMISSIONS,
  recordCell,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
} from '@vyuha/shared';
import { sql, type SQL } from 'drizzle-orm';

import { AppError } from '../../../platform/common/errors.js';
import { InjectDatabase, type Database } from '../../../platform/db/db.provider.js';
import {
  ReportSourceRegistry,
  type ReportSource,
  type ReportSourcePage,
} from '../../../platform/export/report-source.registry.js';
import { orderBy } from '../../../platform/export/report-order.js';
import { hasPermission, type Principal } from '../../../platform/rbac/principal.js';

/**
 * Owner, 22 Aug 2026: attendance's own analytics, each a query per report
 * and named by the decision it changes (data-analyst skill). Generic rows
 * like the Tally analytics source - one subquery whose output columns are
 * the report's column keys - gated on the org-wide attendance key, because
 * every one of them reads across people.
 */

interface AnalyticsPage extends ReportSourcePage {
  readonly key: ReportKey;
  readonly rows: readonly Record<string, unknown>[];
}

const SORTABLE: Partial<Record<ReportKey, Record<string, string>>> = {
  'flag-review-log': { reviewedAt: '"reviewedAt"', adminName: '"adminName"', employeeName: '"employeeName"' },
  'approvals-turnaround': { type: 'type', decided: 'decided', medianHours: '"medianHours"', oldestPendingHours: '"oldestPendingHours"' },
  'early-arrival-leaderboard': { employeeName: '"employeeName"', currentStreak: '"currentStreak"', earlyDays: '"earlyDays"' },
  'on-time-rate': { department: 'department', workedDays: '"workedDays"', onTimePct: '"onTimePct"::numeric' },
};

const DEFAULT_ORDER: Record<(typeof ATTENDANCE_ANALYTICS_REPORT_KEYS)[number], string> = {
  'flag-review-log': '"reviewedAt" DESC',
  'approvals-turnaround': '"oldestPendingHours" DESC NULLS LAST, type ASC',
  'early-arrival-leaderboard': '"currentStreak" DESC, "earlyDays" DESC, "employeeName" ASC',
  'on-time-rate': '"onTimePct"::numeric ASC, department ASC',
};

@Injectable()
export class AttendanceAnalyticsReportSource implements ReportSource, OnModuleInit {
  readonly keys: readonly ReportKey[] = ATTENDANCE_ANALYTICS_REPORT_KEYS;

  constructor(
    private readonly registry: ReportSourceRegistry,
    @InjectDatabase() private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  visibleDefinitions(principal: Principal): readonly ReportDefinition[] {
    return hasPermission(principal, PERMISSIONS.ATTENDANCE_VIEW_ALL) ? ATTENDANCE_ANALYTICS_REPORTS : [];
  }

  assertFiltersUsable(key: ReportKey, filters: ReportFilters): ReportFilters {
    if (!this.keys.includes(key)) throw new Error(`AttendanceAnalyticsReportSource does not serve "${key}".`);
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      throw AppError.validation('The period ends before it starts.', { fields: [{ path: 'to', message: 'must not precede from' }] });
    }
    return {
      ...(filters.from === undefined ? {} : { from: filters.from }),
      ...(filters.to === undefined ? {} : { to: filters.to }),
      ...(filters.employeeId === undefined ? {} : { employeeId: filters.employeeId }),
      ...(filters.departmentId === undefined ? {} : { departmentId: filters.departmentId }),
    };
  }

  sortableFields(key: ReportKey): readonly string[] {
    return Object.keys(SORTABLE[key] ?? {});
  }

  async count(principal: Principal, key: ReportKey, filters: ReportFilters): Promise<number> {
    this.requireHolder(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const rows = await this.db.execute<{ value: number }>(sql`SELECT count(*)::int AS value FROM (${this.body(key, principal.orgId, usable)}) t`);
    return Number(rows.rows[0]?.value ?? 0);
  }

  async page(
    principal: Principal,
    key: ReportKey,
    filters: ReportFilters & { sort?: string | undefined },
    limit: number,
    offset: number,
  ): Promise<ReportSourcePage> {
    this.requireHolder(principal);
    const usable = this.assertFiltersUsable(key, filters);
    const total = await this.count(principal, key, usable);
    const order = orderBy(filters.sort, SORTABLE[key] ?? {}, DEFAULT_ORDER[key as (typeof ATTENDANCE_ANALYTICS_REPORT_KEYS)[number]]);
    const rows = await this.db.execute<Record<string, unknown>>(sql`
      SELECT * FROM (${this.body(key, principal.orgId, usable)}) t ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}
    `);
    const page: AnalyticsPage = { key, total, rows: rows.rows };
    return page;
  }

  cells(page: ReportSourcePage, index: number, columns: readonly ReportColumnSpec[]): ReportCellValue[] {
    const typed = page as AnalyticsPage;
    const row = typed.rows[index];
    if (row === undefined) throw new Error(`No row ${String(index)} on this page.`);
    return columns.map((column) => recordCell(row, column.key));
  }

  private body(key: ReportKey, orgId: string, f: ReportFilters): SQL {
    switch (key) {
      case 'flag-review-log':
        return sql`
          SELECT r.id, r.created_at AS "reviewedAt",
                 COALESCE(NULLIF(trim(concat(ae.first_name, ' ', coalesce(ae.last_name, ''))), ''), u.email) AS "adminName",
                 r.action::text AS action,
                 trim(concat(e.first_name, ' ', coalesce(e.last_name, ''))) AS "employeeName",
                 e.id AS "employeeId", p.attendance_date AS "attendanceDate", p.punch_type::text AS "punchType", r.note
            FROM punch_flag_reviews r
            JOIN punches p ON p.id = r.punch_id
            JOIN employees e ON e.id = p.employee_id
            LEFT JOIN users u ON u.id = r.decided_by
            LEFT JOIN employees ae ON ae.id = u.employee_id
           WHERE r.org_id = ${orgId} ${this.periodClause(f, this.localDate('r.created_at', orgId))} ${this.employeeClause(f, 'e.id')}
        `;
      case 'approvals-turnaround':
        // Time to a decision is the request's creation to its last acted step.
        return sql`
          WITH decided AS (
            SELECT a.type::text AS type, extract(epoch FROM (max(s.acted_at) - a.created_at)) / 3600.0 AS hours
              FROM approval_requests a JOIN approval_steps s ON s.approval_request_id = a.id AND s.acted_at IS NOT NULL
             WHERE a.org_id = ${orgId} AND a.status IN ('APPROVED', 'REJECTED') ${this.periodClause(f, this.localDate('a.created_at', orgId))}
             GROUP BY a.id, a.type, a.created_at
          ),
          pending AS (
            SELECT a.type::text AS type, count(*)::int AS pending,
                   round(max(extract(epoch FROM (now() - a.created_at)) / 3600.0))::int AS oldest
              FROM approval_requests a
             WHERE a.org_id = ${orgId} AND a.status IN ('PENDING', 'ESCALATED')
             GROUP BY a.type
          ),
          types AS (SELECT type FROM decided UNION SELECT type FROM pending)
          SELECT t.type AS id, t.type,
                 COALESCE((SELECT count(*)::int FROM decided d WHERE d.type = t.type), 0) AS decided,
                 (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.hours))::int FROM decided d WHERE d.type = t.type) AS "medianHours",
                 (SELECT round(percentile_cont(0.9) WITHIN GROUP (ORDER BY d.hours))::int FROM decided d WHERE d.type = t.type) AS "p90Hours",
                 COALESCE((SELECT p.pending FROM pending p WHERE p.type = t.type), 0) AS pending,
                 (SELECT p.oldest FROM pending p WHERE p.type = t.type) AS "oldestPendingHours"
            FROM types t
        `;
      case 'early-arrival-leaderboard':
        return sql`
          WITH latest AS (
            SELECT DISTINCT ON (employee_id) employee_id, early_streak
              FROM attendance_days WHERE org_id = ${orgId} ORDER BY employee_id, date DESC
          )
          SELECT e.id AS "employeeId", trim(concat(e.first_name, ' ', coalesce(e.last_name, ''))) AS "employeeName",
                 dep.name AS department,
                 COALESCE(l.early_streak, 0) AS "currentStreak",
                 count(d.id) FILTER (WHERE d.early_arrival)::int AS "earlyDays",
                 round(avg(d.early_arrival_minutes) FILTER (WHERE d.early_arrival))::int AS "avgEarlyMinutes"
            FROM employees e
            LEFT JOIN departments dep ON dep.id = e.department_id
            LEFT JOIN latest l ON l.employee_id = e.id
            LEFT JOIN attendance_days d ON d.employee_id = e.id ${this.periodAnd(f, 'd.date')}
           WHERE e.org_id = ${orgId} AND e.deleted_at IS NULL AND e.status = 'ACTIVE' ${this.departmentClause(f, 'e.department_id')}
           GROUP BY e.id, e.first_name, e.last_name, dep.name, l.early_streak
          HAVING COALESCE(l.early_streak, 0) > 0 OR count(d.id) FILTER (WHERE d.early_arrival) > 0
        `;
      case 'on-time-rate':
        return sql`
          SELECT COALESCE(dep.id::text, 'none') AS id, dep.id AS "departmentId", COALESCE(dep.name, 'No department') AS department,
                 count(d.id)::int AS "workedDays",
                 count(d.id) FILTER (WHERE 'late' = ANY(d.flags))::int AS "lateDays",
                 round((count(d.id) - count(d.id) FILTER (WHERE 'late' = ANY(d.flags))) * 100.0 / NULLIF(count(d.id), 0), 1)::text AS "onTimePct"
            FROM attendance_days d
            JOIN employees e ON e.id = d.employee_id
            LEFT JOIN departments dep ON dep.id = e.department_id
           WHERE d.org_id = ${orgId} AND d.status IN ('PRESENT', 'HALF_DAY') ${this.periodClause(f, 'd.date')}
           GROUP BY dep.id, dep.name
        `;
      default:
        throw new Error(`AttendanceAnalyticsReportSource does not serve "${key}".`);
    }
  }

  private periodClause(f: ReportFilters, column: string): SQL {
    const parts: SQL[] = [];
    if (f.from !== undefined) parts.push(sql`${sql.raw(column)} >= ${f.from}::date`);
    if (f.to !== undefined) parts.push(sql`${sql.raw(column)} <= ${f.to}::date`);
    return parts.length === 0 ? sql`` : sql` AND ${sql.join(parts, sql` AND `)}`;
  }

  /**
   * An instant as the organisation's own calendar day. A review at 00:30 in
   * Mumbai is yesterday in UTC, and a period filter that used the server's
   * day would lose it; the org id is a literal here because the column
   * fragment is raw SQL.
   */
  private localDate(column: string, orgId: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(orgId)) throw new Error('Organisation id is not a UUID.');
    return `(${column} AT TIME ZONE (SELECT timezone FROM organizations WHERE id = '${orgId}'))::date`;
  }

  /** The same period, as an ON-clause tail (no leading WHERE semantics needed). */
  private periodAnd(f: ReportFilters, column: string): SQL {
    return this.periodClause(f, column);
  }

  private employeeClause(f: ReportFilters, column: string): SQL {
    return f.employeeId === undefined ? sql`` : sql` AND ${sql.raw(column)} = ${f.employeeId}`;
  }

  private departmentClause(f: ReportFilters, column: string): SQL {
    return f.departmentId === undefined ? sql`` : sql` AND ${sql.raw(column)} = ${f.departmentId}`;
  }

  private requireHolder(principal: Principal): void {
    if (!hasPermission(principal, PERMISSIONS.ATTENDANCE_VIEW_ALL)) {
      throw AppError.forbidden('This report needs attendance.view.all.');
    }
  }
}
