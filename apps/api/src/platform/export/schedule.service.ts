import { Injectable, Logger } from '@nestjs/common';
import {
  PERMISSIONS,
  isReportKey,
  isScheduleDue,
  resolveColumns,
  scheduleWindow,
  type ExportFormat,
  type ReportKey,
  type ReportSchedule,
  type ReportScheduleInput,
  type ScheduleCadence,
} from '@vyuha/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { employees, exportJobs, reportSchedules, users } from '../db/schema/index.js';
import { employeeNameSql } from '../people/employee-name.js';
import { hasPermission, type Principal } from '../rbac/principal.js';
import { PrincipalService } from '../rbac/principal.service.js';
import { ExportContextRepository } from './export-context.repository.js';
import { ExportService } from './export.service.js';
import { ReportSourceRegistry } from './report-source.registry.js';

/**
 * REQ-J-05: a saved report configuration produced on a timer.
 *
 * The requirement says the file is emailed. There is no mail transport in this
 * deployment, so a run lands in the Downloads tray instead -- the same job, the
 * same file, the same seven-day retention, the same signed URL. Only the thing
 * that starts it differs, and `packages/shared/src/reports.ts` carries the
 * reasoning beside the contract.
 *
 * The sweep runs every fifteen minutes and asks each organisation what time it
 * is *there* (NFR-05). A schedule set for 06:00 means 06:00 in Nashik, not on
 * whichever machine the worker happens to be.
 */

/** Nothing about a schedule is worth retrying past this; the next sweep is in 15 minutes. */
const MAX_RUNS_PER_SWEEP = 200;

/*
 * There is deliberately no per-organisation cap any more.
 *
 * There was one, and it was worse than the problem: ranking every active
 * schedule by creation date and keeping the first 25 made the 26th an
 * organisation ever created permanently invisible, due or not. Fairness is
 * ordering, not a second limit -- the sweep now serves every organisation's
 * oldest-unrun schedule before any organisation's second, so no tenant can
 * take the budget and none is cut out of it.
 */

export interface ScheduleSweepOutcome {
  readonly considered: number;
  readonly started: number;
  readonly skipped: number;
}

interface LocalClock {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
  readonly dayOfMonth: number;
}

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly exports: ExportService,
    private readonly sources: ReportSourceRegistry,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
    private readonly auditContext: AuditContext,
  ) {}

  // ------------------------------------------------------------------ writes

  async create(principal: Principal, input: ReportScheduleInput): Promise<ReportSchedule> {
    // The same refusal the export endpoint gives, at the point somebody can
    // still fix it: a report that cannot answer for this filter set would
    // otherwise produce a schedule that fails silently every morning.
    this.sources.usableFilters(input.reportKey, {
      ...input.filters,
      ...scheduleWindow(input.cadence, this.todayIso()),
    });

    const columns = resolveColumns(input.reportKey, input.columns).map((column) => column.key);

    const inserted = await this.db
      .insert(reportSchedules)
      .values({
        orgId: principal.orgId,
        ownerUserId: principal.userId,
        reportKey: input.reportKey,
        name: input.name,
        filters: input.filters,
        columns,
        sort: input.sort ?? null,
        format: input.format,
        cadence: input.cadence,
        hour: input.hour,
        minute: input.minute,
        weekday: input.weekday ?? null,
        dayOfMonth: input.dayOfMonth ?? null,
        isActive: input.isActive,
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning({ id: reportSchedules.id });

    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('The schedule insert returned no row.');

    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'report.schedule.created',
      entityType: 'report_schedule',
      entityId: id,
      after: { reportKey: input.reportKey, name: input.name, cadence: input.cadence },
    });

    const created = await this.find(principal, id);
    if (created === null) throw new Error('The schedule vanished between insert and read.');
    return created;
  }

  /** Pause, resume, or rename. The report and its filters are not editable -- delete and recreate. */
  async setActive(principal: Principal, id: string, isActive: boolean): Promise<ReportSchedule> {
    const existing = await this.find(principal, id);
    if (existing === null) throw AppError.notFound('That schedule does not exist.');
    this.assertOwnerOrAdmin(principal, existing);

    await this.db
      .update(reportSchedules)
      .set({ isActive, updatedBy: principal.userId, updatedAt: new Date() })
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, principal.orgId)));

    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: isActive ? 'report.schedule.resumed' : 'report.schedule.paused',
      entityType: 'report_schedule',
      entityId: id,
      before: { isActive: existing.isActive },
      after: { isActive },
    });

    const updated = await this.find(principal, id);
    if (updated === null) throw new Error('The schedule vanished between update and read.');
    return updated;
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const existing = await this.find(principal, id);
    if (existing === null) throw AppError.notFound('That schedule does not exist.');
    this.assertOwnerOrAdmin(principal, existing);

    // Soft, like everything else (REQ-M-04). Files already produced keep their
    // own retention and are not touched: deleting the timer must not delete the
    // reports somebody has been collecting from it.
    await this.db
      .update(reportSchedules)
      .set({ deletedAt: new Date(), updatedBy: principal.userId })
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, principal.orgId)));

    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'report.schedule.deleted',
      entityType: 'report_schedule',
      entityId: id,
      before: { name: existing.name, reportKey: existing.reportKey },
    });
  }

  // ------------------------------------------------------------------- reads

  async list(principal: Principal): Promise<ReportSchedule[]> {
    const rows = await this.selectSchedules(
      and(
        eq(reportSchedules.orgId, principal.orgId),
        isNull(reportSchedules.deletedAt),
        // A schedule is personal: it delivers to one tray, and that tray is the
        // owner's. An administrator sees every one of them, because a timer
        // nobody can find is a timer nobody can stop.
        this.canSeeEveryone(principal) ? undefined : eq(reportSchedules.ownerUserId, principal.userId),
      ),
    );
    return rows;
  }

  async find(principal: Principal, id: string): Promise<ReportSchedule | null> {
    const rows = await this.selectSchedules(
      and(
        eq(reportSchedules.id, id),
        eq(reportSchedules.orgId, principal.orgId),
        isNull(reportSchedules.deletedAt),
      ),
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (!this.canSeeEveryone(principal) && row.owner.id !== principal.userId) return null;
    return row;
  }

  // ------------------------------------------------------------------- sweep

  /**
   * Every schedule that has come due, across every organisation.
   *
   * Called by the `run-report-schedules` job on a fifteen-minute cron. It
   * enqueues exports rather than producing files: an export is already a job
   * with progress, retry and a tray row, and doing the work here would mean a
   * second implementation of all of it that the tray could not see.
   */
  async runDue(now: Date): Promise<ScheduleSweepOutcome> {
    const rows = await this.db.execute<{
      id: string;
      org_id: string;
      owner_user_id: string;
      report_key: string;
      name: string;
      filters: unknown;
      columns: unknown;
      sort: string | null;
      format: string;
      cadence: ScheduleCadence;
      hour: number;
      minute: number;
      weekday: number | null;
      day_of_month: number | null;
      is_active: boolean;
      last_run_on: string | null;
      timezone: string;
      local_date: string;
      local_hour: number;
      local_minute: number;
      local_weekday: number;
      local_dom: number;
    }>(sql`
      SELECT s.id, s.org_id, s.owner_user_id, s.report_key, s.name, s.filters, s.columns,
             s.sort, s.format, s.cadence, s.hour, s.minute, s.weekday, s.day_of_month,
             s.is_active, s.last_run_on::text AS last_run_on,
             o.timezone,
             (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone)::date::text AS local_date,
             EXTRACT(HOUR   FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int AS local_hour,
             EXTRACT(MINUTE FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int AS local_minute,
             EXTRACT(ISODOW FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int AS local_weekday,
             EXTRACT(DAY    FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int AS local_dom
        FROM report_schedules s
        JOIN organizations o ON o.id = s.org_id
       WHERE s.is_active
         AND s.deleted_at IS NULL
         /*
          * A soft-deleted organisation's schedules are not merely pointless,
          * they are corrosive: report_schedules.org_id is ON DELETE restrict
          * so orgs are only ever soft-deleted and their schedules are never
          * switched off, orgProfile() then throws, and the job retries with
          * backoff every fifteen minutes for ever -- consuming budget that
          * belongs to live tenants.
          */
         AND o.deleted_at IS NULL
         /*
          * Due-ness, decided here rather than in JavaScript afterwards.
          *
          * isScheduleDue still runs below and is still the authority -- this
          * is the same rule pushed down so that an undue schedule costs nothing
          * against the budget. With the filter in JavaScript, 250 never-due
          * schedules in one tenant consumed the whole limit and a second
          * tenant's daily report was never *considered*, let alone late. That
          * was reproducible: one org with the lowest id starves every org
          * onboarded after it, silently, for ever.
          */
         AND s.last_run_on IS DISTINCT FROM
             (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone)::date
         AND (s.hour * 60 + s.minute) <=
             EXTRACT(HOUR   FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int * 60
           + EXTRACT(MINUTE FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int
         AND (s.cadence <> 'WEEKLY' OR s.weekday =
             EXTRACT(ISODOW FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int)
         AND (s.cadence <> 'MONTHLY' OR s.day_of_month =
             EXTRACT(DAY   FROM (${now.toISOString()}::timestamptz AT TIME ZONE o.timezone))::int)
         /*
          * And the budget is per organisation, not global. One tenant filling
          * its own quota is that tenant's problem; one tenant filling every
          * other tenant's is an outage they cannot see or fix.
          */
       /*
        * Fair ordering, then the caps.
        *
        * The first attempt at this ranked every *active* schedule by
        * created_at and kept the first 25 -- so the 26th an organisation ever
        * created became invisible to every sweep for ever, due or not, which
        * was worse than the starvation it set out to fix: under the old global
        * cap those rows at least ran. Two things make that impossible now.
        * The ranking is applied to the due rows only, because everything above
        * has already filtered to them. And it orders by last_run_on with nulls
        * first, which rotates: a schedule pushed out of one sweep has an older
        * last run than the ones that displaced it, so it leads the next.
        *
        * The outer ORDER BY is by rank before organisation, so every
        * organisation's first due schedule is served before any organisation's
        * second. Ordering by org_id -- as this did -- meant the lowest id won
        * the global budget outright, and organisation ids are uuidv7, so that
        * was the first tenant onboarded, permanently.
        */
       ORDER BY row_number() OVER (
                  PARTITION BY s.org_id
                  ORDER BY s.last_run_on ASC NULLS FIRST, s.created_at
                ),
                s.org_id
       LIMIT ${MAX_RUNS_PER_SWEEP}
    `);

    let started = 0;
    let skipped = 0;

    for (const row of rows.rows) {
      const local: LocalClock = {
        date: row.local_date,
        hour: row.local_hour,
        minute: row.local_minute,
        weekday: row.local_weekday,
        dayOfMonth: row.local_dom,
      };

      const due = isScheduleDue(
        {
          cadence: row.cadence,
          hour: row.hour,
          minute: row.minute,
          weekday: row.weekday,
          dayOfMonth: row.day_of_month,
          isActive: row.is_active,
          lastRunOn: row.last_run_on,
        },
        local,
      );
      if (!due) continue;

      /*
       * Claimed before the work, not after.
       *
       * The conditional update is the lock: two workers sweeping the same
       * instant both see the schedule as due, and exactly one of them changes
       * a row. Marking it afterwards would let both enqueue an export, and the
       * owner would find two identical files with no way to tell which run
       * produced which.
       */
      const claimed = await this.db
        .update(reportSchedules)
        .set({ lastRunOn: local.date, updatedAt: new Date() })
        .where(
          and(
            eq(reportSchedules.id, row.id),
            isNull(reportSchedules.deletedAt),
            // `IS DISTINCT FROM` rather than `<>`: the column is null before
            // the first run, and null <> 'date' is null, which is not true, so
            // the very first run of every schedule would never claim.
            sql`${reportSchedules.lastRunOn} IS DISTINCT FROM ${local.date}::date`,
          ),
        )
        .returning({ id: reportSchedules.id });

      if (claimed.length === 0) {
        skipped += 1;
        continue;
      }

      const outcome = await this.startRun(row, local);
      if (outcome) started += 1;
      else skipped += 1;
    }

    return { considered: rows.rows.length, started, skipped };
  }

  // ----------------------------------------------------------------- private

  /** Turns one due schedule into a queued export. False when it could not be started. */
  private async startRun(
    row: {
      id: string;
      org_id: string;
      owner_user_id: string;
      report_key: string;
      name: string;
      filters: unknown;
      columns: unknown;
      sort: string | null;
      format: string;
      cadence: ScheduleCadence;
    },
    local: LocalClock,
  ): Promise<boolean> {
    const principal = await this.ownerPrincipal(row.org_id, row.owner_user_id, row.id);
    if (principal === null) {
      /*
       * The owner can no longer export. Recorded rather than swallowed, and
       * the schedule is left claimed for today so it does not retry every
       * fifteen minutes against a permission that is not coming back.
       *
       * Not paused automatically: a permission removed by mistake is restored,
       * and a schedule that switched itself off would stay off long after the
       * mistake was fixed, with nothing on screen saying why.
       */
      await this.audit.write({
        orgId: row.org_id,
        actorUserId: null,
        action: 'report.schedule.refused',
        entityType: 'report_schedule',
        entityId: row.id,
        after: { reason: 'The owner no longer holds the report export permission.' },
      });
      this.logger.warn(
        `Schedule ${row.id} skipped: owner ${row.owner_user_id} cannot export reports.`,
      );
      return false;
    }

    if (!this.hasSource(row.report_key)) {
      // The day is already claimed, so without a recorded refusal this run
      // would simply vanish — the owner's tray stays quiet and the screen
      // keeps showing the last good run. Same treatment as a lost
      // permission: audited, not merely logged.
      await this.audit.write({
        orgId: row.org_id,
        actorUserId: null,
        action: 'report.schedule.refused',
        entityType: 'report_schedule',
        entityId: row.id,
        after: { reason: `This build has no rows for the report "${row.report_key}".` },
      });
      this.logger.warn(`Schedule ${row.id} names report "${row.report_key}", which no longer exists.`);
      return false;
    }

    const window = scheduleWindow(row.cadence, local.date);
    const columns = Array.isArray(row.columns) ? (row.columns as string[]) : [];
    const filters = typeof row.filters === 'object' && row.filters !== null ? row.filters : {};

    try {
      const job = await this.exports.request(principal, {
        reportKey: row.report_key,
        filters: { ...(filters as Record<string, unknown>), ...window },
        columns,
        ...(row.sort === null ? {} : { sort: row.sort }),
        format: row.format as ExportFormat,
      });

      await this.db
        .update(reportSchedules)
        .set({ lastExportJobId: job.id })
        .where(eq(reportSchedules.id, row.id));

      await this.audit.write({
        orgId: row.org_id,
        actorUserId: row.owner_user_id,
        action: 'report.schedule.ran',
        entityType: 'report_schedule',
        entityId: row.id,
        // The full REQ-J-06 snapshot rides here: request() records its own
        // entry through the request-scoped context, which a worker does not
        // have, so for scheduled exports this row is the requested-side
        // record an auditor diffs against report.export.completed.
        after: {
          exportJobId: job.id,
          from: window.from,
          to: window.to,
          name: row.name,
          reportKey: row.report_key,
          filters,
          columns,
          format: row.format,
        },
      });
      return true;
    } catch (error: unknown) {
      // A refused export -- a period the report cannot answer for, a range over
      // the cap -- is this schedule's problem and not the sweep's. Rethrowing
      // would abandon every schedule after it in the same organisation.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Schedule ${row.id} could not start an export: ${message}`);
      await this.audit.write({
        orgId: row.org_id,
        actorUserId: row.owner_user_id,
        action: 'report.schedule.refused',
        entityType: 'report_schedule',
        entityId: row.id,
        after: { reason: message },
      });
      return false;
    }
  }

  /**
   * The owner as a `Principal`, resolved now rather than snapshotted when the
   * schedule was created.
   *
   * A schedule outlives the session that created it by design, so the export
   * permission is re-read on every run. Somebody who has moved off reporting
   * duties stops producing files the next morning, without anyone remembering
   * that their schedules exist.
   */
  private async ownerPrincipal(
    orgId: string,
    userId: string,
    scheduleId: string,
  ): Promise<Principal | null> {
    const repository = new ExportContextRepository(this.db, { orgId, actorUserId: userId });
    const owner = await repository.findRequester(userId);
    if (owner === null || owner.status !== 'ACTIVE') return null;

    const grants = await this.principals.loadGrants(userId, orgId);
    const principal: Principal = {
      userId,
      orgId,
      employeeId: owner.employeeId,
      email: owner.email,
      status: owner.status,
      // No session; naming the schedule is more useful in a log line than an
      // empty string and more honest than reusing one that has ended.
      sessionId: scheduleId,
      roles: grants.roles,
      permissions: grants.permissions,
    };

    return hasPermission(principal, PERMISSIONS.REPORT_EXPORT) ? principal : null;
  }

  private canSeeEveryone(principal: Principal): boolean {
    return hasPermission(principal, PERMISSIONS.SETTINGS_MANAGE);
  }

  private assertOwnerOrAdmin(principal: Principal, schedule: ReportSchedule): void {
    if (schedule.owner.id === principal.userId) return;
    if (this.canSeeEveryone(principal)) return;
    throw AppError.forbidden('A schedule can only be changed by the person it belongs to.');
  }

  private todayIso(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async selectSchedules(where: ReturnType<typeof and>): Promise<ReportSchedule[]> {
    const rows = await this.db
      .select({
        id: reportSchedules.id,
        reportKey: reportSchedules.reportKey,
        name: reportSchedules.name,
        filters: reportSchedules.filters,
        columns: reportSchedules.columns,
        sort: reportSchedules.sort,
        format: reportSchedules.format,
        cadence: reportSchedules.cadence,
        hour: reportSchedules.hour,
        minute: reportSchedules.minute,
        weekday: reportSchedules.weekday,
        dayOfMonth: reportSchedules.dayOfMonth,
        isActive: reportSchedules.isActive,
        ownerId: reportSchedules.ownerUserId,
        ownerName: sql<string | null>`coalesce(${employeeNameSql(
          employees.firstName,
          employees.lastName,
        )}, ${users.email})`,
        lastRunOn: sql<string | null>`${reportSchedules.lastRunOn}::text`,
        lastExportJobId: reportSchedules.lastExportJobId,
        lastRunStatus: exportJobs.status,
        createdAt: reportSchedules.createdAt,
      })
      .from(reportSchedules)
      .innerJoin(users, eq(users.id, reportSchedules.ownerUserId))
      .leftJoin(employees, eq(employees.id, users.employeeId))
      .leftJoin(exportJobs, eq(exportJobs.id, reportSchedules.lastExportJobId))
      .where(where)
      .orderBy(asc(reportSchedules.createdAt));

    return rows.map((row) => ({
      id: row.id,
      reportKey: row.reportKey as ReportSchedule['reportKey'],
      name: row.name,
      filters: (row.filters ?? {}),
      columns: Array.isArray(row.columns) ? (row.columns as string[]) : [],
      sort: row.sort,
      format: row.format as ExportFormat,
      cadence: row.cadence,
      hour: row.hour,
      minute: row.minute,
      weekday: row.weekday,
      dayOfMonth: row.dayOfMonth,
      isActive: row.isActive,
      owner: { id: row.ownerId, name: row.ownerName ?? 'Unknown' },
      lastRunOn: row.lastRunOn,
      lastExportJobId: row.lastExportJobId,
      lastRunStatus: (row.lastRunStatus) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }
  /**
   * Known to the shared contract *and* registered by a module. The first half
   * narrows the string; the second is what actually matters — a key whose
   * module stopped registering it names a report this build cannot produce,
   * whatever the contract says.
   */
  private hasSource(key: string): key is ReportKey {
    return isReportKey(key) && this.sources.sourceFor(key) !== null;
  }
}
