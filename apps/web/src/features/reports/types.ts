import { z } from 'zod';

import {
  EXPORT_FORMATS,
  EXPORT_STATUSES,
  REPORT_CATEGORIES,
  REPORT_COLUMN_TYPES,
  REPORT_DEFINITIONS,
  REPORT_FILTER_NAMES,
  REPORT_KEYS,
  SCHEDULE_CADENCES,
  absenteeismCell,
  attendanceExceptionCell,
  attendanceRegisterCell,
  headcountCell,
  creditCycleCell,
  paymentAnalysisCell,
  customerLapseCell,
  customerStatementCell,
  lowStockCell,
  pendingDispatchCell,
  dayBookCell,
  recordCell,
  salesAnalysisCell,
  voucherReconciliationCell,
  leaveAvailedCell,
  leaveBalanceCell,
  leaveLedgerCell,
  missingPunchCell,
  musterGridCell,
  punchAuditCell,
  reportFilterSchema,
  savedViewConfigSchema,
  type AttendanceDaySummary,
  type ExportJobSummary,
  type PunchRecord,
  type ReportCellValue,
  type ReportDefinition,
  type ReportKey,
  type ReportSchedule,
  type SavedView,
} from '@vyuha/shared';

/**
 * What the report endpoints actually send, parsed rather than asserted.
 *
 * The screen is generic over a report definition it received from the server,
 * which makes a shape mismatch particularly unpleasant: a missing `columns`
 * array would not throw, it would render a table with no columns and look like
 * a report with no data. Parsing turns that into the error state.
 */

const namedRefSchema = z.object({ id: z.string(), name: z.string() });

export const reportColumnSchema = z.object({
  key: z.string(),
  header: z.string(),
  type: z.enum(REPORT_COLUMN_TYPES),
  secondary: z.boolean().optional(),
  defaultHidden: z.boolean().optional(),
  sortField: z.string().optional(),
  width: z.number().optional(),
});

export const reportDefinitionSchema = z.object({
  key: z.enum(REPORT_KEYS),
  label: z.string(),
  category: z.enum(REPORT_CATEGORIES),
  description: z.string(),
  columns: z.array(reportColumnSchema).min(1),
  defaultSort: z.string(),
  filters: z.array(z.enum(REPORT_FILTER_NAMES)),
  requiredFilters: z.array(z.enum(REPORT_FILTER_NAMES)).optional(),
}) satisfies z.ZodType<ReportDefinition>;

export const reportCatalogueSchema = z.object({
  data: z.array(reportDefinitionSchema).min(1),
});

const pageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

/**
 * The attendance register row is the muster row (`AttendanceDaySummary`), and
 * the punch audit row is the punch feed row (`PunchRecord`). Deliberately the
 * same contracts the other screens read: a report is a different arrangement
 * of the same data, not a different truth about it.
 */
export const attendanceRegisterRowSchema = z.object({
  id: z.string(),
  employee: namedRefSchema,
  employeeCode: z.string(),
  date: z.string(),
  status: z.string(),
  shift: namedRefSchema.nullable(),
  scheduledIn: z.string().nullable(),
  scheduledOut: z.string().nullable(),
  firstInAt: z.string().nullable(),
  lastOutAt: z.string().nullable(),
  workedMinutes: z.number(),
  breakMinutes: z.number(),
  // Optional to stay identical to `AttendanceDaySummary`, which the assertion
  // at the foot of this file enforces. The server withholds `otMinutes` from a
  // viewer who may see only their own attendance; a report needs `report.view`,
  // which no such account holds, so the register is expected to carry it -- but
  // "expected to" is not a shape a parser may require.
  otMinutes: z.number().optional(),
  lateMinutes: z.number(),
  earlyExitMinutes: z.number(),
  flags: z.array(z.string()).readonly(),
  isManualOverride: z.boolean(),
  locked: z.boolean(),
});

export type AttendanceRegisterRow = z.infer<typeof attendanceRegisterRowSchema>;

export const punchAuditRowSchema = z.object({
  id: z.string(),
  employee: namedRefSchema,
  employeeCode: z.string(),
  attendanceDate: z.string(),
  type: z.string(),
  serverTime: z.string(),
  clientTime: z.string().nullable(),
  clockSkewSeconds: z.number().nullable(),
  syncDelaySeconds: z.number().nullable(),
  source: z.string(),
  photo: z.object({ fileId: z.string(), thumbnailFileId: z.string() }).nullable(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracyM: z.number().nullable(),
      distanceFromGeofenceM: z.number().nullable(),
    })
    .nullable(),
  isHalfDayMarked: z.boolean(),
  halfDayPart: z.string().nullable(),
  reason: z.string().nullable(),
  flags: z.array(z.string()).readonly(),
});

export type PunchAuditRow = z.infer<typeof punchAuditRowSchema>;

export const attendanceRegisterPageSchema = z.object({
  data: z.array(attendanceRegisterRowSchema),
  meta: pageMetaSchema,
});

export const punchAuditPageSchema = z.object({
  data: z.array(punchAuditRowSchema),
  meta: pageMetaSchema,
});

export const savedViewSchema = z.object({
  id: z.string(),
  reportKey: z.string(),
  name: z.string(),
  config: savedViewConfigSchema,
  isShared: z.boolean(),
  isOwn: z.boolean(),
  createdAt: z.string(),
}) satisfies z.ZodType<SavedView>;

export const savedViewListSchema = z.array(savedViewSchema);

export const exportJobSchema = z.object({
  id: z.string(),
  reportKey: z.string(),
  reportLabel: z.string(),
  status: z.enum(EXPORT_STATUSES),
  format: z.enum(EXPORT_FORMATS),
  filename: z.string(),
  progress: z.number(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  filters: reportFilterSchema,
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  downloadable: z.boolean(),
}) satisfies z.ZodType<ExportJobSummary>;

export const exportJobListSchema = z.object({ data: z.array(exportJobSchema) });

/**
 * REQ-J-05, one scheduled export as the list reads it.
 *
 * Pinned to the shared `ReportSchedule` with `satisfies`, for the reason the
 * attendance day wire row gives: a field the server stops sending is then a
 * compile error here rather than an `undefined` that renders as a blank cell.
 */
export const reportScheduleSchema = z.object({
  id: z.string(),
  reportKey: z.enum(REPORT_KEYS),
  name: z.string(),
  filters: reportFilterSchema,
  columns: z.array(z.string()),
  sort: z.string().nullable(),
  format: z.enum(EXPORT_FORMATS),
  cadence: z.enum(SCHEDULE_CADENCES),
  hour: z.number(),
  minute: z.number(),
  weekday: z.number().nullable(),
  dayOfMonth: z.number().nullable(),
  isActive: z.boolean(),
  owner: z.object({ id: z.string(), name: z.string() }),
  lastRunOn: z.string().nullable(),
  lastExportJobId: z.string().nullable(),
  lastRunStatus: z.enum(EXPORT_STATUSES).nullable(),
  createdAt: z.string(),
}) satisfies z.ZodType<ReportSchedule>;

export const reportScheduleListSchema = z.array(reportScheduleSchema);

export const exportDownloadSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number(),
  filename: z.string(),
});

export const signedPhotoSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.number(),
});

// ------------------------------------------------- the reports that aggregate

/**
 * The rows the derived reports send.
 *
 * Parsed, not asserted, for the reason the two above are: the shell renders
 * whatever columns the definition names, so a field that arrived as `undefined`
 * would draw an empty cell rather than raise anything. `.catchall` is
 * deliberately absent -- an unexpected key is harmless, a missing one is not.
 */
const employeeRefSchema = z.object({ name: z.string() });

export const musterGridRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  days: z.record(z.string(), z.string().nullable()),
  presentDays: z.number(),
  absentDays: z.number(),
  leaveDays: z.number(),
  halfDays: z.number(),
  onDutyDays: z.number(),
  weeklyOffDays: z.number(),
  holidayDays: z.number(),
  workedMinutes: z.number(),
  otMinutes: z.number(),
  lateDays: z.number(),
});

export const attendanceExceptionRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  locationName: z.string().nullable(),
  occurrences: z.number(),
  totalMinutes: z.number(),
  averageMinutes: z.number(),
  worstMinutes: z.number(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
});

export const absenteeismRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  locationName: z.string().nullable(),
  month: z.string(),
  scheduledDays: z.number(),
  presentDays: z.number(),
  leaveDays: z.number(),
  absentDays: z.number(),
  absencePercent: z.number(),
});

export const missingPunchRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  date: z.string(),
  status: z.string(),
  shiftName: z.string().nullable(),
  punchedInAt: z.string().nullable(),
  punchedOutAt: z.string().nullable(),
  flags: z.array(z.string()).readonly(),
  regularizationStatus: z.string().nullable(),
  regularizationKind: z.string().nullable(),
  regularizationDecidedAt: z.string().nullable(),
  regularizationReason: z.string().nullable(),
});

export const leaveBalanceRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  leaveTypeCode: z.string(),
  leaveTypeName: z.string(),
  leaveYear: z.number(),
  opening: z.number(),
  accrued: z.number(),
  availed: z.number(),
  adjusted: z.number(),
  carriedForward: z.number(),
  closing: z.number(),
});

export const leaveLedgerRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  leaveTypeCode: z.string(),
  leaveTypeName: z.string(),
  leaveYear: z.number(),
  postedAt: z.string(),
  movementType: z.string(),
  days: z.number(),
  referenceType: z.string().nullable(),
  periodKey: z.string().nullable(),
  note: z.string().nullable(),
});

export const leaveAvailedRowSchema = z.object({
  id: z.string(),
  employee: employeeRefSchema,
  employeeCode: z.string(),
  departmentName: z.string().nullable(),
  leaveTypeCode: z.string(),
  leaveTypeName: z.string(),
  isPaid: z.boolean(),
  requests: z.number(),
  days: z.number(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
});

export const headcountRowSchema = z.object({
  id: z.string(),
  month: z.string(),
  opening: z.number(),
  joiners: z.number(),
  leavers: z.number(),
  closing: z.number(),
});

export const voucherReconciliationRowSchema = z.object({
  month: z.string(),
  voucherType: z.string(),
  count: z.number(),
  cancelled: z.number(),
  total: z.string(),
  lastPulledAt: z.string(),
});

export type VoucherReconciliationRow = z.infer<typeof voucherReconciliationRowSchema>;

export const customerStatementRowSchema = z.object({
  id: z.string(),
  date: z.string(),
  voucherType: z.string(),
  voucherNumber: z.string(),
  narration: z.string().nullable(),
  debit: z.string().nullable(),
  credit: z.string().nullable(),
  unclassified: z.string().nullable(),
  balance: z.string(),
  asOf: z.string().nullable(),
});
export type CustomerStatementRow = z.infer<typeof customerStatementRowSchema>;

export const dayBookRowSchema = z.object({
  voucherId: z.string(),
  date: z.string(),
  voucherType: z.string(),
  voucherNumber: z.string(),
  partyName: z.string().nullable(),
  amount: z.string(),
  narration: z.string().nullable(),
  cancelled: z.boolean(),
  asOf: z.string().nullable(),
});
export type DayBookRow = z.infer<typeof dayBookRowSchema>;

export const customerLapseRowSchema = z.object({
  partyId: z.string(),
  partyName: z.string(),
  state: z.enum(['LAPSED', 'AT_RISK', 'ON_RHYTHM']),
  lastSaleDate: z.string(),
  daysSince: z.number(),
  medianGapDays: z.number(),
  expectedBy: z.string(),
  sales12m: z.number(),
  revenue12m: z.string(),
  asOf: z.string().nullable(),
});
export type CustomerLapseRow = z.infer<typeof customerLapseRowSchema>;

export const creditCycleRowSchema = z.object({
  partyId: z.string(),
  partyName: z.string(),
  creditLimit: z.string().nullable(),
  creditDays: z.number().nullable(),
  exposure: z.string(),
  headroom: z.string().nullable(),
  overLimit: z.boolean(),
  lastInvoiceDate: z.string().nullable(),
  lastReceiptDate: z.string().nullable(),
  asOf: z.string().nullable(),
});
export type CreditCycleRow = z.infer<typeof creditCycleRowSchema>;

/**
 * The payment-analysis row, declared rather than left to the generic record
 * shape. "Pays on time" is derived from the slippage by `paymentAnalysisCell`
 * and is not a column the API sends, so the generic `recordCell` looked up a
 * key that was not there and the column was blank on every screen -- while the
 * exported file, which goes through that same cell function on the server,
 * had it filled in. The screen and the file now read the row the same way.
 */
export const paymentAnalysisRowSchema = z.object({
  partyId: z.string(),
  partyName: z.string(),
  creditDays: z.number().nullable(),
  avgDaysToPay: z.number().nullable(),
  slippage: z.number().nullable(),
  billsPaid: z.number(),
  billsOpen: z.number(),
  oldestOpenDays: z.number().nullable(),
  asOf: z.string().nullable(),
});
export type PaymentAnalysisRow = z.infer<typeof paymentAnalysisRowSchema>;

export const salesAnalysisRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  vouchers: z.number(),
  quantity: z.string().nullable(),
  value: z.string(),
  share: z.string(),
  asOf: z.string().nullable(),
});
export type SalesAnalysisRow = z.infer<typeof salesAnalysisRowSchema>;

export const pendingDispatchRowSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
  orderDate: z.string(),
  ageDays: z.number(),
  item: z.string(),
  ordered: z.string(),
  packed: z.string(),
  invoiced: z.string(),
  dispatched: z.string(),
  balance: z.string(),
  fulfilment: z.string(),
});
export type PendingDispatchRow = z.infer<typeof pendingDispatchRowSchema>;

export const lowStockRowSchema = z.object({
  stockItemId: z.string(),
  item: z.string(),
  closing: z.string().nullable(),
  committed: z.string(),
  available: z.string().nullable(),
  reorderLevel: z.string(),
  openPo: z.string(),
  shortfall: z.string(),
  asOf: z.string().nullable(),
});
export type LowStockRow = z.infer<typeof lowStockRowSchema>;

// --------------------------------------------------------------- the row view

/**
 * A row as the shell renders it: a key, the two things a phone-sized card
 * shows, and every cell the report's definition names.
 *
 * The cells are extracted once, here, by the same functions in `@vyuha/shared`
 * that the exporter calls -- which is the whole point of the arrangement. The
 * table below this never sees a report-specific row type, so adding a report
 * cannot mean adding a branch to the rendering code, and the screen cannot
 * start reading a field the file does not.
 */
export interface ReportRowView {
  readonly id: string;
  /** Mobile line one (PRD §6.5). */
  readonly primary: string;
  /** Mobile line one, right side. Null for a report with nothing pill-shaped. */
  readonly status: string | null;
  readonly cells: Readonly<Record<string, ReportCellValue>>;
  /** Set only on the punch audit, for REQ-J-02's photo viewer. */
  readonly punch: PunchAuditRow | null;
}

export type MusterGridRow = z.infer<typeof musterGridRowSchema>;
export type AttendanceExceptionRow = z.infer<typeof attendanceExceptionRowSchema>;
export type AbsenteeismRow = z.infer<typeof absenteeismRowSchema>;
export type MissingPunchRow = z.infer<typeof missingPunchRowSchema>;
export type LeaveBalanceRow = z.infer<typeof leaveBalanceRowSchema>;
export type LeaveLedgerRow = z.infer<typeof leaveLedgerRowSchema>;
export type LeaveAvailedRow = z.infer<typeof leaveAvailedRowSchema>;
export type HeadcountRow = z.infer<typeof headcountRowSchema>;

/**
 * How one report's rows become views: the parser, the shared extractor, and the
 * two fields a phone-sized card shows.
 *
 * Generic in the row type and never widened to `unknown`, so `cell` is the
 * extractor that matches `schema` and the compiler says so. `toRowViews`
 * switches on the report key and hands one of these to `build` -- which is why
 * there is not a cast anywhere in this file.
 */
interface RowViewShape<T> {
  readonly schema: z.ZodType<T>;
  readonly cell: (row: T, key: string) => ReportCellValue;
  readonly id: (row: T) => string;
  readonly primary: (row: T) => string;
  readonly status: (row: T) => string | null;
  readonly punch?: (row: T) => PunchAuditRow;
}

const REGISTER_SHAPE: RowViewShape<AttendanceRegisterRow> = {
  schema: attendanceRegisterRowSchema,
  cell: attendanceRegisterCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.status,
};

const PUNCH_SHAPE: RowViewShape<PunchAuditRow> = {
  schema: punchAuditRowSchema,
  cell: punchAuditCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.type,
  punch: (row) => row,
};

const MUSTER_GRID_SHAPE: RowViewShape<MusterGridRow> = {
  schema: musterGridRowSchema,
  cell: musterGridCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: () => null,
};

/** One shape for the three reports that are one query with the measure swapped. */
const EXCEPTION_SHAPE: RowViewShape<AttendanceExceptionRow> = {
  schema: attendanceExceptionRowSchema,
  cell: attendanceExceptionCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: () => null,
};

const ABSENTEEISM_SHAPE: RowViewShape<AbsenteeismRow> = {
  schema: absenteeismRowSchema,
  cell: absenteeismCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.month,
};

const MISSING_PUNCH_SHAPE: RowViewShape<MissingPunchRow> = {
  schema: missingPunchRowSchema,
  cell: missingPunchCell,
  id: (row) => row.id,
  // The correction's state where there is one, because that is what a reader
  // working this list is deciding on; the day's own status otherwise.
  status: (row) => row.regularizationStatus ?? row.status,
  primary: (row) => row.employee.name,
};

const LEAVE_BALANCE_SHAPE: RowViewShape<LeaveBalanceRow> = {
  schema: leaveBalanceRowSchema,
  cell: leaveBalanceCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.leaveTypeCode,
};

const LEAVE_LEDGER_SHAPE: RowViewShape<LeaveLedgerRow> = {
  schema: leaveLedgerRowSchema,
  cell: leaveLedgerCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.movementType,
};

const LEAVE_AVAILED_SHAPE: RowViewShape<LeaveAvailedRow> = {
  schema: leaveAvailedRowSchema,
  cell: leaveAvailedCell,
  id: (row) => row.id,
  primary: (row) => row.employee.name,
  status: (row) => row.leaveTypeCode,
};

const HEADCOUNT_SHAPE: RowViewShape<HeadcountRow> = {
  schema: headcountRowSchema,
  cell: headcountCell,
  id: (row) => row.id,
  primary: (row) => row.month,
  status: () => null,
};

const VOUCHER_RECONCILIATION_SHAPE: RowViewShape<VoucherReconciliationRow> = {
  schema: voucherReconciliationRowSchema,
  cell: voucherReconciliationCell,
  // A grouped row has no id of its own; month and type together are the key.
  id: (row) => `${row.month}:${row.voucherType}`,
  primary: (row) => `${row.month} · ${row.voucherType}`,
  status: () => null,
};

const CUSTOMER_STATEMENT_SHAPE: RowViewShape<CustomerStatementRow> = {
  schema: customerStatementRowSchema,
  cell: customerStatementCell,
  id: (row) => row.id,
  primary: (row) => `${row.voucherType}${row.voucherNumber ? ` ${row.voucherNumber}` : ''}`,
  status: () => null,
};

const CREDIT_CYCLE_SHAPE: RowViewShape<CreditCycleRow> = {
  schema: creditCycleRowSchema,
  cell: creditCycleCell,
  id: (row) => row.partyId,
  primary: (row) => row.partyName,
  status: (row) => (row.overLimit ? 'OVER_LIMIT' : null),
};

const PAYMENT_ANALYSIS_SHAPE: RowViewShape<PaymentAnalysisRow> = {
  schema: paymentAnalysisRowSchema,
  cell: paymentAnalysisCell,
  id: (row) => row.partyId,
  primary: (row) => row.partyName,
  // The same three words the cell renders, so the badge and the column agree.
  status: (row) => (row.slippage === null ? 'NOT YET KNOWN' : row.slippage <= 0 ? 'ON TIME' : 'LATE'),
};

const SALES_ANALYSIS_SHAPE: RowViewShape<SalesAnalysisRow> = {
  schema: salesAnalysisRowSchema,
  cell: salesAnalysisCell,
  id: (row) => row.key || row.label,
  primary: (row) => row.label,
  status: () => null,
};

const PENDING_DISPATCH_SHAPE: RowViewShape<PendingDispatchRow> = {
  schema: pendingDispatchRowSchema,
  cell: pendingDispatchCell,
  id: (row) => row.id,
  primary: (row) => `${row.orderNumber} · ${row.item}`,
  status: (row) => row.fulfilment.toUpperCase(),
};

const DAY_BOOK_SHAPE: RowViewShape<DayBookRow> = {
  schema: dayBookRowSchema,
  cell: dayBookCell,
  id: (row) => row.voucherId,
  primary: (row) => `${row.voucherType}${row.voucherNumber ? ` ${row.voucherNumber}` : ''}`,
  status: (row) => (row.cancelled ? 'CANCELLED' : null),
};

const CUSTOMER_LAPSE_SHAPE: RowViewShape<CustomerLapseRow> = {
  schema: customerLapseRowSchema,
  cell: customerLapseCell,
  id: (row) => row.partyId,
  primary: (row) => row.partyName,
  status: (row) => (row.state === 'ON_RHYTHM' ? null : row.state),
};

const LOW_STOCK_SHAPE: RowViewShape<LowStockRow> = {
  schema: lowStockRowSchema,
  cell: lowStockCell,
  id: (row) => row.stockItemId,
  primary: (row) => row.item,
  status: () => null,
};

/**
 * The Tier 1 analytics rows (D-46) are flat records whose keys are the
 * column keys; one loose shape serves all fifteen, with the id and the
 * mobile-primary named per report. `recordCell` reads any of them.
 */
const analyticsRowSchema = z.record(z.string(), z.unknown());
type AnalyticsRow = z.infer<typeof analyticsRowSchema>;

function analyticsShape(
  idKey: string | readonly string[],
  primaryKey: string,
  statusKey?: string,
): RowViewShape<AnalyticsRow> {
  // Some rows have no single identifying column. An ageing row is one bill of
  // one party and the party repeats down the page, so the party id alone would
  // hand the table duplicate React keys.
  const idKeys = typeof idKey === 'string' ? [idKey] : idKey;
  return {
    schema: analyticsRowSchema,
    cell: recordCell,
    id: (row) => {
      const parts: string[] = [];
      for (const key of idKeys) {
        const value = row[key];
        if (typeof value !== 'string') return JSON.stringify(row);
        parts.push(value);
      }
      return parts.join('|');
    },
    primary: (row) => {
      const value = row[primaryKey];
      return typeof value === 'string' ? value : '';
    },
    status: (row) => (statusKey === undefined ? null : ((row[statusKey] as string | null | undefined) ?? null)),
  };
}

const ANALYTICS_SHAPES: Partial<Record<ReportKey, RowViewShape<AnalyticsRow>>> = {
  'ledger-extract': analyticsShape('id', 'voucherType'),
  'stock-summary': analyticsShape('stockItemId', 'item'),
  'negative-stock': analyticsShape('stockItemId', 'item'),
  'stale-projections': analyticsShape('connectionId', 'companyName', 'connectionState'),
  'duplicate-masters': analyticsShape('id', 'nameA'),
  'customer-item-matrix': analyticsShape('id', 'partyName'),
  'purchase-rhythm': analyticsShape('partyId', 'partyName', 'trend'),
  'price-variance': analyticsShape('id', 'item'),
  'item-velocity': analyticsShape('stockItemId', 'item', 'trend'),
  'dead-stock': analyticsShape('stockItemId', 'item'),
  'movement-analysis': analyticsShape('id', 'item'),
  'vendor-item-history': analyticsShape('id', 'vendorName', 'rateTrend'),
  'vendor-price-comparison': analyticsShape('id', 'item'),
  'credit-breaches': analyticsShape('partyId', 'partyName'),
  'stock-ageing': analyticsShape('stockItemId', 'item'),
  'customer-concentration': analyticsShape('partyId', 'partyName'),
  // Owner, 22 Aug 2026: the Pareto family. The name is the id too — an item
  // name is what the projection groups by, and a party name is unique enough
  // within one organisation to key a table row. `band` is the row's status.
  'item-revenue-concentration': analyticsShape('id', 'name', 'band'),
  'item-quantity-concentration': analyticsShape('id', 'name', 'band'),
  'vendor-spend-concentration': analyticsShape('id', 'name', 'band'),
  'receivables-concentration': analyticsShape('id', 'name', 'band'),
  'order-pipeline': analyticsShape('id', 'number', 'stage'),
  'dispatch-performance': analyticsShape('id', 'number', 'mode'),
  'order-fill-rate': analyticsShape('partyId', 'partyName'),
  // One row is one line of one order, and both parts are needed for a key:
  // an order repeats down the page and so does an item name.
  'order-fulfilment': analyticsShape(['number', 'item'], 'number', 'state'),
  'new-vs-repeat': analyticsShape('month', 'month'),
  'requirement-ageing': analyticsShape('id', 'item', 'source'),
  // Owner, 22 Aug 2026: the second analytics set.
  'flag-review-log': analyticsShape('id', 'employeeName', 'action'),
  'approvals-turnaround': analyticsShape('id', 'type'),
  'early-arrival-leaderboard': analyticsShape('employeeId', 'employeeName'),
  'on-time-rate': analyticsShape('id', 'department'),
  'aov-trend': analyticsShape('month', 'month'),
  'gst-summary': analyticsShape('month', 'month'),
  'partial-shipments': analyticsShape('id', 'partyName'),
  'vendor-lead-time': analyticsShape('id', 'partyName'),
  'stock-out-frequency': analyticsShape('id', 'item'),
  'margin-proxy': analyticsShape('stockItemId', 'item'),
  'sales-heatmap': analyticsShape('id', 'partyName'),
  // Owner, 22 Aug 2026: receivables, collections, returns and the duplicate
  // detector. These eight shipped with a definition and a row source but no
  // shape, so every screen reading them showed the error state instead of the
  // rows the API was returning. `row-shapes.test.ts` now fails on the next one.
  ageing: analyticsShape(['partyId', 'billName'], 'partyName', 'bucket'),
  'promised-vs-collected': analyticsShape('id', 'partyName'),
  'broken-promises': analyticsShape('id', 'partyName'),
  'return-rate-by-item': analyticsShape('id', 'itemName'),
  'return-rate-by-customer': analyticsShape('id', 'partyName'),
  'returns-by-reason': analyticsShape('id', 'reason'),
  'duplicate-clusters': analyticsShape('id', 'kind'),
};

function build<T>(
  shape: RowViewShape<T>,
  reportKey: ReportKey,
  rows: readonly unknown[],
): ReportRowView[] {
  const columns = REPORT_DEFINITIONS[reportKey].columns;
  return rows.map((raw) => {
    const row = shape.schema.parse(raw);
    // Every declared column, not only the visible ones, so turning one on in
    // the F12 chooser redraws from what is already in hand rather than asking
    // the server again for a value it already sent.
    const cells: Record<string, ReportCellValue> = {};
    for (const column of columns) cells[column.key] = shape.cell(row, column.key);
    return {
      id: shape.id(row),
      primary: shape.primary(row),
      status: shape.status(row),
      cells,
      punch: shape.punch === undefined ? null : shape.punch(row),
    };
  });
}

/**
 * One page of any report, as rows the table can render.
 *
 * Throws on a shape it cannot read; `api.ts` turns that into the screen's error
 * state. The switch is exhaustive over `ReportKey` -- adding a report key
 * without a shape here is a compile error, not an empty table.
 */
export function toRowViews(reportKey: ReportKey, rows: readonly unknown[]): ReportRowView[] {
  switch (reportKey) {
    case 'attendance-register':
    case 'daily-muster':
      return build(REGISTER_SHAPE, reportKey, rows);
    case 'punch-audit':
      return build(PUNCH_SHAPE, reportKey, rows);
    case 'monthly-muster':
      return build(MUSTER_GRID_SHAPE, reportKey, rows);
    case 'late-arrivals':
    case 'early-exits':
    case 'overtime':
      return build(EXCEPTION_SHAPE, reportKey, rows);
    case 'absenteeism':
      return build(ABSENTEEISM_SHAPE, reportKey, rows);
    case 'missing-punch':
      return build(MISSING_PUNCH_SHAPE, reportKey, rows);
    case 'leave-balance':
      return build(LEAVE_BALANCE_SHAPE, reportKey, rows);
    case 'leave-ledger':
      return build(LEAVE_LEDGER_SHAPE, reportKey, rows);
    case 'leave-availed':
      return build(LEAVE_AVAILED_SHAPE, reportKey, rows);
    case 'headcount':
      return build(HEADCOUNT_SHAPE, reportKey, rows);
    case 'voucher-reconciliation':
      return build(VOUCHER_RECONCILIATION_SHAPE, reportKey, rows);
    case 'customer-statement':
      return build(CUSTOMER_STATEMENT_SHAPE, reportKey, rows);
    case 'credit-cycle':
      return build(CREDIT_CYCLE_SHAPE, reportKey, rows);
    case 'payment-analysis':
      return build(PAYMENT_ANALYSIS_SHAPE, reportKey, rows);
    case 'sales-analysis':
      return build(SALES_ANALYSIS_SHAPE, reportKey, rows);
    case 'pending-dispatch':
      return build(PENDING_DISPATCH_SHAPE, reportKey, rows);
    case 'low-stock':
      return build(LOW_STOCK_SHAPE, reportKey, rows);
    case 'day-book':
      return build(DAY_BOOK_SHAPE, reportKey, rows);
    case 'customer-lapse':
      return build(CUSTOMER_LAPSE_SHAPE, reportKey, rows);
    default: {
      const shape = ANALYTICS_SHAPES[reportKey];
      if (shape === undefined) throw new Error(`No row shape for "${reportKey}".`);
      return build(shape, reportKey, rows);
    }
  }
}

/** The envelope every report's rows arrive in. The rows themselves are `unknown`
 *  until `toRowViews` parses them against the report's own shape. */
export const reportPageEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  meta: pageMetaSchema,
});

/**
 * The two row contracts are structurally the shared ones. Stated as a type
 * check rather than a comment so a field renamed in `@vyuha/shared` breaks the
 * build here instead of silently parsing to `undefined` at runtime.
 */
type Assert<T extends true> = T;

export type ContractChecks = [
  Assert<AttendanceDaySummary extends AttendanceRegisterRow ? true : false>,
  Assert<PunchRecord extends PunchAuditRow ? true : false>,
];
