import { z } from 'zod';

import { ATTENDANCE_STATUSES, PUNCH_TYPES } from './enums.js';

/**
 * The export tray's contract — the piece of the removed reports module that
 * survives it, because the employee data export (REQ-M-05, a platform
 * compliance obligation, not a report) rides the same `export_jobs` rows,
 * the same Downloads tray, and the same 7-day retention.
 *
 * `reportKey` on a job summary is a plain string here on purpose: the report
 * catalogue is gone, and the tray renders whatever the row says it was.
 */

export const EXPORT_FORMATS = ['CSV', 'XLSX'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const AVAILABLE_EXPORT_FORMATS = ['XLSX', 'CSV'] as const satisfies readonly ExportFormat[];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  CSV: 'CSV',
  XLSX: 'Excel',
};

export const EXPORT_FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  CSV: 'csv',
  XLSX: 'xlsx',
};

export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Preparing',
  DONE: 'Ready',
  FAILED: 'Failed',
};

/** REQ-J-03's rule outlives its report: files expire after 7 days. */
export const EXPORT_RETENTION_DAYS = 7;

/**
 * The filter snapshot stored on an `export_jobs` row. The shape predates
 * the reports module's removal and stored rows still carry it, so the
 * schema keeps every historical field — the two sales enums that died with
 * the module are inlined rather than resurrected.
 */
export const reportFilterSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  flags: z.string().max(200).optional(),
  punchType: z.enum(PUNCH_TYPES).optional(),
  partyId: z.uuid().optional(),
  groupBy: z.enum(['party', 'item', 'itemGroup', 'month']).optional(),
  voucherType: z.string().trim().min(1).max(60).optional(),
  ledgerName: z.string().trim().min(1).max(120).optional(),
  itemName: z.string().trim().min(1).max(120).optional(),
});

export type ReportFilters = z.infer<typeof reportFilterSchema>;

export interface ExportJobSummary {
  readonly id: string;
  readonly reportKey: string;
  readonly reportLabel: string;
  readonly status: ExportStatus;
  readonly format: ExportFormat;
  readonly filename: string;
  /** 0 to 100. Meaningful while RUNNING; 100 once DONE. */
  readonly progress: number;
  readonly rowCount: number | null;
  /** Set only on FAILED, and safe to render: it never carries a stack trace. */
  readonly error: string | null;
  readonly filters: ReportFilters;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The retention window. Null before the file exists. */
  readonly expiresAt: string | null;
  /** False once the file has expired or been purged, even while status is DONE. */
  readonly downloadable: boolean;
}

export interface ExportDownload {
  readonly url: string;
  readonly expiresInSeconds: number;
  readonly filename: string;
}

/** `employee-data-2026-08-13-1423.xlsx`. Stable, sortable, no spaces. */
export function exportFileName(reportKey: string, generatedAt: Date, format: ExportFormat): string {
  const stamp = generatedAt
    .toISOString()
    .replace(/[:T]/gu, '-')
    .slice(0, 16)
    .replace(/-(\d{2})-(\d{2})$/u, '-$1$2');
  return `${reportKey}-${stamp}.${EXPORT_FORMAT_EXTENSIONS[format]}`;
}
