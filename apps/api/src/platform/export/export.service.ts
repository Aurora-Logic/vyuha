import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_EXPORT_ROWS,
  PERMISSIONS,
  REPORT_DEFINITIONS,
  describeFilters,
  exportFileName,
  isReportKey,
  reportFilterSchema,
  exportCompareSchema,
  reportRowJoinKey,
  resolveColumns,
  type ExportDownload,
  type ExportFormat,
  type ExportJobSummary,
  type ExportRequest,
  type ExportStatus,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportFilters,
  type ReportKey,
} from '@vyuha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { DEFAULT_RETENTION_POLICY, RETENTION_SETTINGS, retentionPolicySchema } from '../settings/settings.catalogue.js';
import { WorkspacePolicyReader } from '../settings/workspace-policy.reader.js';
import { AuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, describeError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { exportJobs, files } from '../db/schema/index.js';
import { ScopedRepository, type OrgContext } from '../db/scoped-repository.js';
import { FileService } from '../files/file.service.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { orgContextOf, hasPermission, type Principal } from '../rbac/principal.js';
import { PrincipalService } from '../rbac/principal.service.js';
import { ExportContextRepository } from './export-context.repository.js';
import { formatCalendarDate, writerFor } from './report-writer.js';
import { ReportSourceRegistry, type ReportSource } from './report-source.registry.js';

/**
 * The export lifecycle (REQ-J-03, REQ-J-06).
 *
 * Requesting an export is a write that returns immediately; producing the file
 * is a job. The row in `export_jobs` is the only thing the two share, which is
 * what lets the tray tell the truth about a job whose worker is on another
 * machine, and what lets a retry resume without a second request.
 *
 * What a report *is* comes from `ReportSourceRegistry` (REQ-P-02): the module
 * that owns the rows registered a source, and this service pages it, writes
 * the file and runs the tray without ever importing the module.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** How many rows one round trip pulls while an export is being written. */
export const EXPORT_BATCH_ROWS = 1_000;

/**
 * What was asked for, as stored on the job row.
 *
 * Read back through a schema rather than cast: this is jsonb from a table,
 * which is a boundary, and a row written by an older release must not be able
 * to put `undefined` where a column key is expected.
 */
const requestSnapshotSchema = z.object({
  filters: reportFilterSchema,
  columns: z.array(z.string()).default([]),
  sort: z.string().optional(),
  compare: exportCompareSchema.optional(),
});

type RequestSnapshot = z.infer<typeof requestSnapshotSchema>;

interface ExportJobRow {
  readonly id: string;
  readonly orgId: string;
  readonly requestedBy: string;
  readonly reportKey: string;
  readonly filters: unknown;
  readonly status: ExportStatus;
  readonly format: string;
  readonly filename: string | null;
  readonly progress: number;
  readonly fileId: string | null;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

/** Joined so the tray can say "expired" rather than offering a dead link. */
interface ExportJobWithFile extends ExportJobRow {
  readonly fileExpiresAt: Date | null;
  readonly filePurgedAt: Date | null;
}

export interface ExportRunResult {
  readonly outcome: 'completed' | 'refused' | 'skipped';
  readonly rows: number;
  readonly reason: string | null;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly sources: ReportSourceRegistry,
    private readonly filesService: FileService,
    private readonly jobs: JobRunner,
    private readonly principals: PrincipalService,
    private readonly auditContext: AuditContext,
    private readonly policies: WorkspacePolicyReader,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- requesting

  async request(principal: Principal, input: ExportRequest): Promise<ExportJobSummary> {
    // Checked here as well as in the job, and deliberately: a period the report
    // cannot answer for is a 400 on the button press, not a queued job that
    // fails five times with backoff before anyone is told why.
    if (input.compare !== undefined && !REPORT_DEFINITIONS[input.reportKey].filters.includes('period')) {
      // A comparison is two periods of the same query. Where the report has
      // no period the second one is the first, and the file would carry a
      // column of zero deltas that reads as "nothing changed".
      throw AppError.validation('This report has no period, so there is nothing to compare it against.');
    }
    // The same principle for permissions: the catalogue is each source's own
    // visibility verdict, so a report the requester may not view -- the
    // margin proxy without reports.margin.view -- refuses at the button,
    // rather than queueing a job whose forbidden is retried through the
    // whole backoff schedule before the tray admits what was true at the
    // start. The job still re-checks at run time, because permissions can
    // be lost between the click and the worker.
    if (!this.sources.catalogue(principal).some((definition) => definition.key === input.reportKey)) {
      throw AppError.forbidden('You do not hold the permission this report needs.');
    }
    const filters = this.sources.usableFilters(input.reportKey, input.filters);
    const requestedAt = new Date();
    const filename = exportFileName(input.reportKey, requestedAt, input.format);
    const snapshot: RequestSnapshot = {
      // The narrowed filters, not the requested ones: the daily muster collapses
      // a range to its last day, and the header block must state the period the
      // rows actually cover.
      filters,
      columns: resolveColumns(input.reportKey, input.columns).map((column) => column.key),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.compare === undefined ? {} : { compare: input.compare }),
    };

    const repository = this.repository(orgContextOf(principal));
    const created = await repository.insert({
      requestedBy: principal.userId,
      reportKey: input.reportKey,
      filters: snapshot,
      status: 'QUEUED',
      format: input.format,
      filename,
      progress: 0,
    });

    await this.jobs.enqueue(
      'generate-report-export',
      {
        orgId: principal.orgId,
        exportJobId: created.id,
        requestedAt: requestedAt.toISOString(),
      },
      // The row id doubles as the queue id, so a client that retried the POST
      // cannot produce two jobs for one row. A hyphen, not a colon: BullMQ
      // reserves the colon for its own key namespacing and rejects a custom id
      // containing one.
      { jobId: `export-${created.id}` },
    );

    // REQ-J-06: who, what, filters, when. The interceptor writes the row; this
    // is the enrichment that makes it answer the question.
    this.auditContext.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'report.export.requested',
      entityType: 'export_job',
      entityId: created.id,
      after: {
        reportKey: input.reportKey,
        format: input.format,
        filters,
        columns: snapshot.columns,
        sort: snapshot.sort ?? REPORT_DEFINITIONS[input.reportKey].defaultSort,
      },
    });

    return this.toSummary({ ...toRow(created), fileExpiresAt: null, filePurgedAt: null });
  }

  // ------------------------------------------------------------------ tray

  /**
   * The Downloads tray, newest first.
   *
   * Only the caller's own exports. A file produced under one person's data
   * scope may hold rows another person is not permitted to see, so "who
   * requested it" is the access rule, not a convenience -- and it is enforced
   * again by `FileService`, which refuses a signed URL to anyone who is
   * neither the uploader nor a holder of `report.export`.
   */
  async listForRequester(principal: Principal, limit: number): Promise<ExportJobSummary[]> {
    const rows = await this.db
      .select(EXPORT_JOB_COLUMNS)
      .from(exportJobs)
      .leftJoin(files, eq(files.id, exportJobs.fileId))
      .where(
        and(
          eq(exportJobs.orgId, principal.orgId),
          isNull(exportJobs.deletedAt),
          eq(exportJobs.requestedBy, principal.userId),
        ),
      )
      .orderBy(desc(exportJobs.createdAt))
      .limit(limit);

    return rows.map((row) => this.toSummary(row));
  }

  async findOne(principal: Principal, id: string): Promise<ExportJobSummary> {
    const row = await this.loadForRequester(principal, id);
    return this.toSummary(row);
  }

  async download(principal: Principal, id: string): Promise<ExportDownload> {
    const row = await this.loadForRequester(principal, id);

    if (row.status !== 'DONE' || row.fileId === null) {
      throw AppError.conflict('That export is not ready to download yet.', {
        status: row.status,
      });
    }

    // NFR-09 and §15: the link is issued by `FileService` after its own
    // permission check, and expires. Nothing here hands out a storage key.
    const signed = await this.filesService.signedUrlFor(principal, row.fileId);
    return {
      url: signed.url,
      expiresInSeconds: signed.expiresInSeconds,
      filename: row.filename ?? `${row.reportKey}.csv`,
    };
  }

  // --------------------------------------------------------------- the job

  /**
   * Produces the file. Called only by the job handler.
   *
   * Three outcomes, and the difference matters to the caller. `completed` is
   * the file existing. `refused` is a decision -- the requester lost the
   * permission, or the result is too large -- which is recorded on the row and
   * must not be retried, so this method returns normally. Anything else throws
   * and BullMQ applies the backoff, because a MinIO that is down at 09:00 is
   * usually up at 09:01.
   */
  async run(orgId: string, exportJobId: string, attempt: number): Promise<ExportRunResult> {
    const row = await this.loadRaw(orgId, exportJobId);
    if (row === null) {
      // The row was removed between enqueue and run. Nothing to produce, and
      // nothing broken; failing the job would only fill the failed set.
      return { outcome: 'skipped', rows: 0, reason: 'The export request no longer exists.' };
    }
    if (row.status === 'DONE') {
      return { outcome: 'skipped', rows: row.rowCount ?? 0, reason: 'Already produced.' };
    }
    if (!isReportKey(row.reportKey)) {
      return this.refuse(row, `This build does not know the report "${row.reportKey}".`);
    }

    // Refused rather than thrown: a job for a report whose module stopped
    // registering it must not retry five times into the same absence.
    const source = this.sources.sourceFor(row.reportKey);
    if (source === null) {
      return this.refuse(row, `This build has no rows for the report "${row.reportKey}".`);
    }

    const snapshot = requestSnapshotSchema.safeParse(row.filters);
    if (!snapshot.success) {
      return this.refuse(row, 'The saved filters for this export could not be read.');
    }

    await this.markRunning(row.id, attempt);

    const principal = await this.requesterPrincipal(orgId, row.requestedBy, row.id);
    if (principal === null) {
      return this.refuse(row, 'The person who requested this export can no longer export reports.');
    }

    try {
      const produced = await this.produce(principal, row, row.reportKey, source, snapshot.data);
      return produced;
    } catch (error: unknown) {
      // Recorded on the row so the tray stops showing a spinner, then rethrown
      // so BullMQ retries. A later attempt sets it back to RUNNING.
      await this.db
        .update(exportJobs)
        .set({
          status: 'FAILED',
          error: `Attempt ${String(attempt)} failed: ${describeError(error)}`.slice(0, 500),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exportJobs.id, row.id));
      throw error;
    }
  }

  private async produce(
    principal: Principal,
    row: ExportJobRow,
    reportKey: ReportKey,
    source: ReportSource,
    snapshot: RequestSnapshot,
  ): Promise<ExportRunResult> {
    const total = await source.count(principal, reportKey, snapshot.filters);
    if (total > MAX_EXPORT_ROWS) {
      return this.refuse(
        row,
        `That period holds ${String(total)} rows, over the ${String(MAX_EXPORT_ROWS)} an export may contain. Narrow the filters.`,
      );
    }

    const repository = new ExportContextRepository(this.db, orgContextOf(principal));
    const [profile, labels] = await Promise.all([
      repository.orgProfile(),
      repository.filterLabels(snapshot.filters),
    ]);

    const columns = resolveColumns(reportKey, snapshot.columns);
    // Comparison deltas ride beside the column the screen showed them on
    // (data-analyst skill §3: comparison state flows into exports). The
    // whole comparison period is read into a map first, keyed the same way
    // the screen joins rows, so file and screen agree row for row.
    const compare = snapshot.compare;
    const compareColumn =
      compare === undefined ? undefined : columns.find((column) => column.key === compare.columnKey);
    const previousByKey = new Map<string, number>();
    if (compare !== undefined && compareColumn !== undefined) {
      const previousFilters = source.assertFiltersUsable(reportKey, {
        ...snapshot.filters,
        from: compare.from,
        to: compare.to,
      });
      const previousTotal = Math.min(
        await source.count(principal, reportKey, previousFilters),
        MAX_EXPORT_ROWS,
      );
      for (let offset = 0; offset < previousTotal; offset += EXPORT_BATCH_ROWS) {
        const page = await source.page(principal, reportKey, previousFilters, EXPORT_BATCH_ROWS, offset);
        if (page.rows.length === 0) break;
        for (let index = 0; index < page.rows.length; index += 1) {
          const raw = page.rows[index];
          if (typeof raw !== 'object' || raw === null) continue;
          const key = reportRowJoinKey(reportKey, raw as Record<string, unknown>);
          if (key === null || previousByKey.has(key)) continue;
          const [cell] = source.cells(page, index, [compareColumn]);
          previousByKey.set(key, numberOfCell(cell ?? null));
        }
      }
    }
    const writtenColumns: ReportColumnSpec[] =
      compare !== undefined && compareColumn !== undefined
        ? [
            ...columns,
            { key: 'comparePrevious', header: `${compareColumn.header} (${compare.label})`, type: compareColumn.type },
            { key: 'compareChange', header: 'Change', type: 'text' },
          ]
        : [...columns];

    const format = toFormat(row.format);
    const writer = writerFor(format);
    const generatedAt = new Date();

    writer.begin(
      {
        orgName: profile.name,
        reportLabel: REPORT_DEFINITIONS[reportKey].label,
        // REQ-L-01: the organisation's date format, so the period caption and
        // the generated-at line below it are not written two different ways.
        captions: describeFilters(snapshot.filters, labels, (iso) =>
          formatCalendarDate(iso, profile.dateFormat),
        ),
        generatedAt,
        timezone: profile.timezone,
        dateFormat: profile.dateFormat,
        rowCount: total,
      },
      writtenColumns,
    );

    let written = 0;
    let reportedProgress = 0;

    for (let offset = 0; offset < total; offset += EXPORT_BATCH_ROWS) {
      const page = await source.page(
        principal,
        reportKey,
        { ...snapshot.filters, sort: snapshot.sort },
        EXPORT_BATCH_ROWS,
        offset,
      );
      const length = page.rows.length;
      // A page shorter than asked for while `offset < total` means rows were
      // deleted underneath the walk. Stopping is right: the header already
      // states a count, and looping on an empty page would never terminate.
      if (length === 0) break;

      for (let index = 0; index < length; index += 1) {
        const cells = source.cells(page, index, columns);
        if (compare !== undefined && compareColumn !== undefined) {
          const raw = page.rows[index];
          const key =
            typeof raw === 'object' && raw !== null
              ? reportRowJoinKey(reportKey, raw as Record<string, unknown>)
              : null;
          const previous = key === null ? undefined : previousByKey.get(key);
          const current = numberOfCell(
            cells[columns.findIndex((column) => column.key === compareColumn.key)] ?? null,
          );
          writer.writeRow([...cells, previous ?? null, describeChange(current, previous)]);
        } else {
          writer.writeRow(cells);
        }
        written += 1;
      }

      // Capped at 99 so the bar reaching the end means the file exists, not
      // that the last row was formatted.
      const next = Math.min(99, Math.floor((written / Math.max(total, 1)) * 100));
      if (next > reportedProgress) {
        reportedProgress = next;
        await this.setProgress(row.id, next);
      }
    }

    const bytes = await writer.finish();
    const retention = await this.policies.read(row.orgId, retentionPolicySchema, RETENTION_SETTINGS, DEFAULT_RETENTION_POLICY);
    const stored = await this.filesService.storeDocument({
      orgId: row.orgId,
      createdBy: row.requestedBy,
      purpose: 'EXPORT',
      bytes,
      mime: writer.mime,
      extension: writer.extension,
      // REQ-J-03's seven days. The existing purge job reads this column, so
      // retention needs nothing of its own here.
      expiresAt: new Date(Date.now() + retention.exportsDays * MILLISECONDS_PER_DAY),
    });

    const finishedAt = new Date();
    await this.db
      .update(exportJobs)
      .set({
        status: 'DONE',
        fileId: stored.id,
        rowCount: written,
        progress: 100,
        error: null,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(exportJobs.id, row.id));

    // REQ-J-06. Written directly rather than through `AuditContext`: a job has
    // no request to enrich, and the completed export -- with its row count and
    // the file it produced -- is the entry an auditor actually wants.
    await this.audit.write({
      orgId: row.orgId,
      actorUserId: row.requestedBy,
      action: 'report.export.completed',
      entityType: 'export_job',
      entityId: row.id,
      after: {
        reportKey,
        format,
        rows: written,
        bytes: stored.bytes,
        fileId: stored.id,
        columns: columns.map((column) => column.key),
        filters: snapshot.filters,
        // REQ-J-03 asks for a frozen header and column widths. A CSV carries
        // neither, and the trail says so rather than implying they were done.
        sheetFormatting: writer.supportsSheetFormatting,
      },
    });

    this.logger.log({
      msg: 'Report export produced',
      exportJobId: row.id,
      reportKey,
      rows: written,
      bytes: stored.bytes,
    });

    return { outcome: 'completed', rows: written, reason: null };
  }

  // ------------------------------------------------------------- internals

  private repository(ctx: OrgContext): ScopedRepository<typeof exportJobs> {
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
          // Another person's export answers as missing rather than forbidden,
          // as everywhere else: a 403 would confirm the id names something real.
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

  private async setProgress(id: string, progress: number): Promise<void> {
    await this.db
      .update(exportJobs)
      .set({ progress, updatedAt: new Date() })
      .where(eq(exportJobs.id, id));
  }

  /**
   * A decision, not a fault: written to the row, returned normally so the job
   * is not retried into producing the same refusal five times.
   */
  private async refuse(row: ExportJobRow, reason: string): Promise<ExportRunResult> {
    const now = new Date();
    await this.db
      .update(exportJobs)
      .set({ status: 'FAILED', error: reason, progress: 0, finishedAt: now, updatedAt: now })
      .where(eq(exportJobs.id, row.id));

    await this.audit.write({
      orgId: row.orgId,
      actorUserId: row.requestedBy,
      action: 'report.export.refused',
      entityType: 'export_job',
      entityId: row.id,
      after: { reportKey: row.reportKey, reason },
    });

    return { outcome: 'refused', rows: 0, reason };
  }

  /**
   * The requester, as a `Principal`, resolved now rather than snapshotted when
   * the export was requested.
   *
   * `sessionId` is the export job id. There is no session here -- the request
   * that started this may have ended -- and the field is only read by code
   * that logs it, so naming the job is more useful than an empty string and
   * more honest than reusing a session that is no longer in play.
   */
  private async requesterPrincipal(
    orgId: string,
    userId: string,
    exportJobId: string,
  ): Promise<Principal | null> {
    const repository = new ExportContextRepository(this.db, { orgId, actorUserId: userId });
    const requester = await repository.findRequester(userId);
    if (requester === null || requester.status !== 'ACTIVE') return null;

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

    // The endpoint checked this when the button was pressed. It is checked
    // again here because the two are minutes apart and a revocation in between
    // must win.
    return hasPermission(principal, PERMISSIONS.REPORT_EXPORT) ? principal : null;
  }

  private toSummary(row: ExportJobWithFile): ExportJobSummary {
    const reportKey = row.reportKey;
    const label = isReportKey(reportKey) ? REPORT_DEFINITIONS[reportKey].label : reportKey;
    const expired =
      row.filePurgedAt !== null ||
      (row.fileExpiresAt !== null && row.fileExpiresAt.getTime() <= Date.now());

    const parsedFilters = requestSnapshotSchema.safeParse(row.filters);
    const filters: ReportFilters = parsedFilters.success ? parsedFilters.data.filters : {};

    return {
      id: row.id,
      reportKey,
      reportLabel: label,
      status: row.status,
      format: toFormat(row.format),
      filename: row.filename ?? `${reportKey}.csv`,
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
  format: exportJobs.format,
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

/**
 * The column is text with a check constraint, so the database guarantees one
 * of two values. Anything else is a row written by a future release against an
 * older binary, and reading it as CSV is wrong in a way a reader would notice.
 */
function toFormat(value: string): ExportFormat {
  if (value === 'CSV' || value === 'XLSX') return value;
  throw new Error(`Export row carries an unknown format "${value}".`);
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
    format: row.format,
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

/** The one number a delta is computed from; a cell that is not one reads as zero, like the screen. */
function numberOfCell(cell: ReportCellValue): number {
  if (typeof cell === 'number') return cell;
  if (typeof cell === 'string') return Number(cell) || 0;
  return 0;
}

/** The screen's delta rules (data-analyst skill §3): never a percentage of a zero base. */
function describeChange(current: number, previous: number | undefined): string {
  if (previous === undefined || previous === 0) return current === 0 ? '' : 'new';
  const absolute = current - previous;
  const pct = Math.round((absolute / Math.abs(previous)) * 1000) / 10;
  return `${absolute > 0 ? '+' : ''}${String(Math.round(absolute * 100) / 100)} (${String(pct)}%)`;
}
