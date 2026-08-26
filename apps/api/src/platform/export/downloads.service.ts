import { Injectable } from '@nestjs/common';
import {
  reportFilterSchema,
  type ExportDownload,
  type ExportFormat,
  type ExportJobSummary,
  type ExportStatus,
  type ReportFilters,
} from '@vyuha/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/errors.js';
import { InjectDatabase, type Database } from '../db/db.provider.js';
import { exportJobs, files } from '../db/schema/index.js';
import { FileService } from '../files/file.service.js';
import type { Principal } from '../rbac/principal.js';

/**
 * The Downloads tray, without the reports module that once filled it.
 *
 * The reports module was removed (owner, 26 Aug 2026); what survives is the
 * lifecycle its one remaining producer needs -- the employee data export
 * (REQ-M-05), which writes `export_jobs` rows through its own service and
 * lands its files here. The row is the whole contract: the tray tells the
 * truth about a job whose worker is on another machine by reading nothing
 * else.
 *
 * Only the caller's own exports, everywhere. A file produced under one
 * person's data scope may hold rows another person is not permitted to see,
 * so "who requested it" is the access rule -- and it is enforced again by
 * `FileService`, which signs URLs after its own check.
 */

/** The snapshot stored on a row; read through a schema because jsonb is a boundary. */
const requestSnapshotSchema = z.object({
  filters: reportFilterSchema,
  columns: z.array(z.string()).default([]),
  sort: z.string().optional(),
});

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

/** What the removed catalogue used to answer; the tray's one remaining producer. */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
  'employee-data': 'Employee data',
};

@Injectable()
export class DownloadsService {
  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly filesService: FileService,
  ) {}

  /** The Downloads tray, newest first, the caller's own exports only. */
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

  private toSummary(row: ExportJobWithFile): ExportJobSummary {
    const expired =
      row.filePurgedAt !== null ||
      (row.fileExpiresAt !== null && row.fileExpiresAt.getTime() <= Date.now());

    const parsedFilters = requestSnapshotSchema.safeParse(row.filters);
    const filters: ReportFilters = parsedFilters.success ? parsedFilters.data.filters : {};

    return {
      id: row.id,
      reportKey: row.reportKey,
      // Rows written before the reports module was removed keep their key;
      // the label falls back to it rather than pretending to know.
      reportLabel: KNOWN_LABELS[row.reportKey] ?? row.reportKey,
      status: row.status,
      format: toFormat(row.format),
      filename: row.filename ?? `${row.reportKey}.csv`,
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

const EXPORT_JOB_COLUMNS = {
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
