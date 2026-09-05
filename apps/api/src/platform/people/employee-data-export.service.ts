import { Injectable, Logger } from '@nestjs/common';
import {
  EXPORT_RETENTION_DAYS,
  PERMISSIONS,
  employeeDisplayName,
  reportFilterSchema,
  type ExportJobSummary,
  type ExportStatus,
  type ReportFilters,
} from '@vyuha/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { exportJobs, files, users } from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';
import { FileService } from '../files/file.service.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { orgContextOf, hasPermission, type Principal } from '../rbac/principal.js';
import { PrincipalService } from '../rbac/principal.service.js';
import {
  EmployeeDataExportRepository,
  SUBJECT_PROFILE_SECTION,
  SUBJECT_SECTIONS,
  SUBJECT_SECTION_ROW_CAP,
  type SubjectIds,
} from './employee-data-export.repository.js';
import { SubjectAccessCsvWriter } from './subject-access-writer.js';

/**
 * REQ-M-05: "Export of all data held about one employee, on request."
 *
 * A background job rather than a response, for the reasons REQ-J-03 gives for
 * report exports and one more of its own. The work spans fifteen tables and is
 * unbounded by anything the caller controls -- a twenty-year employee's audit
 * trail is not a request-path workload -- and the artefact has to be retained,
 * expire, and be re-downloadable, which is a row and a file rather than a
 * stream. Reusing `export_jobs` means the Downloads tray, the seven-day
 * retention sweep and the signed-URL access check all apply without a second
 * delivery route being invented for one requirement.
 *
 * The export is itself an auditable event (REQ-M-01). Three entries are
 * written against the *subject's* employee record, not the requester's, so
 * REQ-M-02's per-record history answers "who has walked out with this person's
 * file" on the screen where somebody would think to ask.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What was asked for, as stored on the job row.
 *
 * Shaped so `ExportService`'s reader parses it too: the Downloads tray renders
 * every row in `export_jobs` through that one summariser, and a snapshot it
 * cannot read would show the tray a filterless job. Read back through a schema
 * rather than cast -- this is jsonb from a table, which is a boundary.
 */
const requestSnapshotSchema = z.object({
  filters: reportFilterSchema,
  columns: z.array(z.string()).default([]),
  subject: z
    .object({
      employeeId: z.string(),
      employeeCode: z.string(),
      name: z.string(),
    })
    .optional(),
});

type RequestSnapshot = z.infer<typeof requestSnapshotSchema>;

/**
 * The key the row carries, and what separates these jobs from report exports
 * in a table both write to.
 *
 * It is also what the Downloads tray prints as the title: that screen renders
 * every `export_jobs` row through `ExportService.toSummary`, which falls back
 * to the raw key for anything that is not a report. So the key is spelled to
 * read as a name rather than as an identifier somebody has to decode. This
 * service's own summary is better -- it names the subject -- but the tray is in
 * the reports module and cannot be taught about this one from here.
 */
export const EMPLOYEE_DATA_EXPORT_KEY = 'employee-data-export';

interface ExportJobRow {
  readonly id: string;
  readonly orgId: string;
  readonly requestedBy: string;
  readonly reportKey: string;
  readonly filters: unknown;
  readonly status: ExportStatus;
  readonly filename: string | null;
  readonly progress: number;
  readonly fileId: string | null;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

interface ExportJobWithFile extends ExportJobRow {
  readonly fileExpiresAt: Date | null;
  readonly filePurgedAt: Date | null;
}

export interface EmployeeDataExportRunResult {
  readonly outcome: 'completed' | 'refused' | 'skipped';
  readonly rows: number;
  readonly reason: string | null;
}

@Injectable()
export class EmployeeDataExportService {
  private readonly logger = new Logger(EmployeeDataExportService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly filesService: FileService,
    private readonly jobs: JobRunner,
    private readonly principals: PrincipalService,
    private readonly auditContext: AuditContext,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- requesting

  async request(principal: Principal, employeeId: string): Promise<ExportJobSummary> {
    const repository = this.repository(orgContextOf(principal));
    const subject = await repository.findSubject(employeeId);
    // A subject outside this organisation reads as missing rather than
    // forbidden, as everywhere else: a 403 would confirm the id names a person.
    if (subject === null) throw AppError.notFound('Employee', employeeId);

    const name = employeeDisplayName(subject.firstName, subject.lastName);
    const requestedAt = new Date();
    const snapshot: RequestSnapshot = {
      filters: { employeeId: subject.employeeId },
      columns: [],
      subject: { employeeId: subject.employeeId, employeeCode: subject.employeeCode, name },
    };

    const created = await this.jobRows(orgContextOf(principal)).insert({
      requestedBy: principal.userId,
      reportKey: EMPLOYEE_DATA_EXPORT_KEY,
      filters: snapshot,
      status: 'QUEUED',
      format: 'CSV',
      filename: `employee-data-${subject.employeeCode}-${isoDate(requestedAt)}.csv`,
      progress: 0,
    });

    await this.jobs.enqueue(
      'export-employee-data',
      {
        orgId: principal.orgId,
        exportJobId: created.id,
        requestedAt: requestedAt.toISOString(),
      },
      // The row id doubles as the queue id, so a client that retried the POST
      // cannot produce two jobs for one row. A hyphen, not a colon: BullMQ
      // reserves the colon for its own key namespacing.
      { jobId: `employee-data-${created.id}` },
    );

    // REQ-M-05 with REQ-M-01: who asked, and about whom. Recorded against the
    // subject's employee record so the per-record history shows it.
    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'employee.data_export.requested',
      entityType: 'employee',
      entityId: subject.employeeId,
      after: {
        exportJobId: created.id,
        subjectEmployeeId: subject.employeeId,
        subjectEmployeeCode: subject.employeeCode,
      },
    });

    return this.toSummary({ ...toRow(created), fileExpiresAt: null, filePurgedAt: null });
  }

  /**
   * One job, for polling while it runs.
   *
   * Restricted to the requester for the same reason the report tray is: the
   * file holds one person's whole record, and "who asked for it" is the access
   * rule rather than a convenience.
   */
  async findOne(principal: Principal, id: string): Promise<ExportJobSummary> {
    return this.toSummary(await this.loadForRequester(principal, id));
  }

  // --------------------------------------------------------------- the job

  /**
   * Produces the file. Called only by the job handler.
   *
   * `refused` is a decision -- the requester lost the permission, the subject
   * is gone -- recorded on the row and returned normally so BullMQ does not
   * retry it into the same refusal five times. Anything else throws and the
   * backoff applies.
   */
  async run(
    orgId: string,
    exportJobId: string,
    attempt: number,
  ): Promise<EmployeeDataExportRunResult> {
    const row = await this.loadRaw(orgId, exportJobId);
    if (row === null) {
      return { outcome: 'skipped', rows: 0, reason: 'The export request no longer exists.' };
    }
    if (row.status === 'DONE') {
      return { outcome: 'skipped', rows: row.rowCount ?? 0, reason: 'Already produced.' };
    }

    const snapshot = requestSnapshotSchema.safeParse(row.filters);
    const employeeId = snapshot.success ? snapshot.data.filters.employeeId : undefined;
    if (employeeId === undefined) {
      return this.refuse(row, null, 'The saved request for this export could not be read.');
    }

    await this.markRunning(row.id, attempt);

    const principal = await this.requesterPrincipal(orgId, row.requestedBy, row.id);
    if (principal === null) {
      return this.refuse(
        row,
        employeeId,
        'The person who requested this export can no longer manage employees.',
      );
    }

    try {
      return await this.produce(principal, row, employeeId);
    } catch (error: unknown) {
      // Recorded on the row so the tray stops showing a spinner, then rethrown
      // so BullMQ retries. A later attempt sets it back to RUNNING.
      const now = new Date();
      await this.db
        .update(exportJobs)
        .set({
          status: 'FAILED',
          error: `Attempt ${String(attempt)} failed: ${describeError(error)}`.slice(0, 500),
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(exportJobs.id, row.id));
      throw error;
    }
  }

  private async produce(
    principal: Principal,
    row: ExportJobRow,
    employeeId: string,
  ): Promise<EmployeeDataExportRunResult> {
    const repository = this.repository(orgContextOf(principal));
    const subject = await repository.findSubject(employeeId);
    if (subject === null) {
      return this.refuse(row, employeeId, 'That employee record no longer exists.');
    }

    const [profile, requesterEmail] = await Promise.all([
      repository.orgProfile(),
      repository.findRequesterEmail(row.requestedBy),
    ]);

    const ids: SubjectIds = {
      orgId: row.orgId,
      employeeId: subject.employeeId,
      userId: subject.userId,
    };
    const name = employeeDisplayName(subject.firstName, subject.lastName);

    const writer = new SubjectAccessCsvWriter();
    writer.begin({
      orgName: profile.name,
      subjectLabel: `${name} (${subject.employeeCode})`,
      requestedByLabel: requesterEmail ?? row.requestedBy,
      generatedAt: new Date(),
      timezone: profile.timezone,
      dateFormat: profile.dateFormat,
    });

    /*
     * Identity and employment first, as labelled facts: one row of many columns
     * reads as a wall of headers, and this is the section a person opens the
     * file to check.
     *
     * Gated like every other section rather than assumed. It renders here,
     * outside the loop, which is precisely how the sign-in account fields it
     * used to carry escaped the check -- they are their own section now, and
     * this asks the same question the loop does so the arrangement cannot rot
     * back.
     */
    if (!SUBJECT_PROFILE_SECTION.requires.some((key) => hasPermission(principal, key))) {
      return this.refuse(row, employeeId, 'You do not hold the permission that reads an employee record.');
    }
    const profileRows = await repository.rowsFor(SUBJECT_PROFILE_SECTION, ids);
    const facts = profileRows.rows[0] ?? [];
    writer.facts(
      SUBJECT_PROFILE_SECTION.title,
      SUBJECT_PROFILE_SECTION.columns.map(
        (column, index) => [column.header, facts[index] ?? null] as const,
      ),
    );

    const included: string[] = [];
    const withheld: string[] = [];
    for (const section of SUBJECT_SECTIONS) {
      /*
       * The route's `employee.manage` opens the endpoint; this decides what the
       * file may contain.
       *
       * Half these sections hold data owned by another permission family --
       * punch coordinates by `attendance.view.all`, the audit trail by
       * `audit.view`, leave by `leave.approve.all` -- and without this the
       * export was a way around all of them. The seeded HR role holds
       * `employee.manage` and not `audit.view`, so this is reachable with no
       * unusual configuration at all.
       */
      if (
        section.requires !== undefined &&
        !section.requires.some((key) => hasPermission(principal, key))
      ) {
        // Named, not silently dropped. A compliance file is read once, by
        // somebody who cannot tell an omitted section from an empty one, and
        // "everything we hold" has to be true or say where it is not.
        writer.note(
          section.title,
          'Not included: your account does not hold the permission that governs this data.',
        );
        withheld.push(section.key);
        continue;
      }

      const { rows, truncated } = await repository.rowsFor(section, ids);
      writer.table(
        section.title,
        section.columns,
        rows,
        truncated
          ? `Only the first ${String(SUBJECT_SECTION_ROW_CAP)} rows are shown. Ask for the rest separately.`
          : undefined,
      );
      if (rows.length > 0) included.push(section.key);
    }

    const stored = await this.filesService.storeDocument({
      orgId: row.orgId,
      createdBy: row.requestedBy,
      purpose: 'EXPORT',
      bytes: writer.finish(),
      mime: writer.mime,
      extension: writer.extension,
      // The same seven days REQ-J-03 gives a report export, swept by the
      // existing purge job. A file holding one person's whole record has even
      // less business sitting in object storage indefinitely.
      expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * MILLISECONDS_PER_DAY),
    });

    const finishedAt = new Date();
    try {
      await this.db
        .update(exportJobs)
        .set({
          status: 'DONE',
          fileId: stored.id,
          rowCount: writer.rowCount,
          progress: 100,
          error: null,
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(eq(exportJobs.id, row.id));
    } catch (error) {
      await this.filesService.discardUnreferenced(row.orgId, [stored.id]);
      throw error;
    }

    // Written directly rather than through `AuditContext`: a job has no request
    // to enrich, and the completed export -- with what it contained and the
    // file it produced -- is the entry an auditor actually wants.
    await this.audit.write({
      orgId: row.orgId,
      actorUserId: row.requestedBy,
      action: 'employee.data_export.completed',
      entityType: 'employee',
      entityId: subject.employeeId,
      after: {
        exportJobId: row.id,
        subjectEmployeeCode: subject.employeeCode,
        rows: writer.rowCount,
        bytes: stored.bytes,
        fileId: stored.id,
        sections: included,
      },
    });

    this.logger.log({
      msg: 'Employee data export produced',
      exportJobId: row.id,
      subjectEmployeeId: subject.employeeId,
      rows: writer.rowCount,
      bytes: stored.bytes,
    });

    return { outcome: 'completed', rows: writer.rowCount, reason: null };
  }

  // ------------------------------------------------------------- internals

  private repository(ctx: OrgContext): EmployeeDataExportRepository {
    return new EmployeeDataExportRepository(this.db, ctx);
  }

  private jobRows(ctx: OrgContext): ScopedRepository<typeof exportJobs> {
    return new ScopedRepository(this.db, exportJobs, ctx);
  }

  private async loadForRequester(principal: Principal, id: string): Promise<ExportJobWithFile> {
    const rows = await this.db
      .select(EXPORT_JOB_COLUMNS)
      .from(exportJobs)
      .leftJoin(files, eq(files.id, exportJobs.fileId))
      .where(
        and(
          eq(exportJobs.orgId, principal.orgId),
          isNull(exportJobs.deletedAt),
          eq(exportJobs.id, id),
          eq(exportJobs.reportKey, EMPLOYEE_DATA_EXPORT_KEY),
          eq(exportJobs.requestedBy, principal.userId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Export', id);
    return row;
  }

  private async loadRaw(orgId: string, id: string): Promise<ExportJobRow | null> {
    const rows = await this.db
      .select(EXPORT_JOB_BASE_COLUMNS)
      .from(exportJobs)
      .where(and(eq(exportJobs.orgId, orgId), eq(exportJobs.id, id), isNull(exportJobs.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async markRunning(id: string, attempt: number): Promise<void> {
    const now = new Date();
    await this.db
      .update(exportJobs)
      .set({
        status: 'RUNNING',
        // Kept from the first attempt, so "how long has this been going" is
        // answerable across a retry.
        ...(attempt > 1 ? {} : { startedAt: now }),
        progress: 0,
        error: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(exportJobs.id, id));
  }

  private async refuse(
    row: ExportJobRow,
    subjectEmployeeId: string | null,
    reason: string,
  ): Promise<EmployeeDataExportRunResult> {
    const now = new Date();
    await this.db
      .update(exportJobs)
      .set({ status: 'FAILED', error: reason, progress: 0, finishedAt: now, updatedAt: now })
      .where(eq(exportJobs.id, row.id));

    await this.audit.write({
      orgId: row.orgId,
      actorUserId: row.requestedBy,
      action: 'employee.data_export.refused',
      entityType: 'employee',
      entityId: subjectEmployeeId,
      after: { exportJobId: row.id, reason },
    });

    return { outcome: 'refused', rows: 0, reason };
  }

  /**
   * The requester, as a `Principal`, resolved now rather than snapshotted when
   * the export was requested.
   *
   * The endpoint checked `employee.manage` when the button was pressed. It is
   * checked again here because the two are minutes apart, and an export of
   * somebody's entire record is exactly the artefact a person about to lose
   * their access would race for.
   *
   * `sessionId` is the export job id: there is no session here, and naming the
   * job is more useful than an empty string and more honest than reusing a
   * session that may have ended.
   */
  private async requesterPrincipal(
    orgId: string,
    userId: string,
    exportJobId: string,
  ): Promise<Principal | null> {
    const rows = await this.db
      .select({
        email: users.email,
        status: users.status,
        employeeId: users.employeeId,
      })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);

    const requester = rows[0];
    if (requester === undefined || requester.status !== 'ACTIVE') return null;

    const grants = await this.principals.loadGrants(userId, orgId);
    const principal: Principal = {
      userId,
      orgId,
      employeeId: requester.employeeId,
      email: requester.email,
      status: requester.status,
      sessionId: exportJobId,
      roles: grants.roles,
      permissions: grants.permissions,
    };

    return hasPermission(principal, PERMISSIONS.EMPLOYEE_MANAGE) ? principal : null;
  }

  private toSummary(row: ExportJobWithFile): ExportJobSummary {
    const expired =
      row.filePurgedAt !== null ||
      (row.fileExpiresAt !== null && row.fileExpiresAt.getTime() <= Date.now());

    const parsed = requestSnapshotSchema.safeParse(row.filters);
    const filters: ReportFilters = parsed.success ? parsed.data.filters : {};
    const label = parsed.success && parsed.data.subject
      ? `Employee data export: ${parsed.data.subject.name}`
      : 'Employee data export';

    return {
      id: row.id,
      reportKey: row.reportKey,
      reportLabel: label,
      status: row.status,
      format: 'CSV',
      filename: row.filename ?? `${EMPLOYEE_DATA_EXPORT_KEY}.csv`,
      progress: row.status === 'DONE' ? 100 : row.progress,
      rowCount: row.rowCount,
      error: row.error,
      filters,
      requestedAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      expiresAt: row.fileExpiresAt?.toISOString() ?? null,
      downloadable: row.status === 'DONE' && row.fileId !== null && !expired,
    };
  }
}

const EXPORT_JOB_BASE_COLUMNS = {
  id: exportJobs.id,
  orgId: exportJobs.orgId,
  requestedBy: exportJobs.requestedBy,
  reportKey: exportJobs.reportKey,
  filters: exportJobs.filters,
  status: exportJobs.status,
  filename: exportJobs.filename,
  progress: exportJobs.progress,
  fileId: exportJobs.fileId,
  rowCount: exportJobs.rowCount,
  error: exportJobs.error,
  startedAt: exportJobs.startedAt,
  finishedAt: exportJobs.finishedAt,
  createdAt: exportJobs.createdAt,
} as const;

const EXPORT_JOB_COLUMNS = {
  ...EXPORT_JOB_BASE_COLUMNS,
  fileExpiresAt: files.expiresAt,
  filePurgedAt: files.purgedAt,
} as const;

/** `YYYY-MM-DD` for the filename. Never the ISO instant (NFR-05). */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Widen the inserted row to the shape the summary reads. */
function toRow(row: typeof exportJobs.$inferSelect): ExportJobRow {
  return {
    id: row.id,
    orgId: row.orgId,
    requestedBy: row.requestedBy,
    reportKey: row.reportKey,
    filters: row.filters,
    status: row.status,
    filename: row.filename,
    progress: row.progress,
    fileId: row.fileId,
    rowCount: row.rowCount,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}
