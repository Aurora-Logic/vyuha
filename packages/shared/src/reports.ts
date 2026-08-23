import { z } from 'zod';

import { ATTENDANCE_STATUSES, PUNCH_TYPES } from './enums.js';
import type { NamedRef } from './people.js';
import { pageQuerySchema } from './pagination.js';

/**
 * Report definitions and export requests (REQ-J-01 to REQ-J-06).
 *
 * One shell serves every report (REQ-J-01), so the shell's vocabulary --
 * filters, columns, sort, saved views -- is defined once, here, and both ends
 * read the same definition. A screen cannot offer a column the exporter does
 * not know how to write, and the exporter cannot invent one the screen never
 * showed, because there is only one list.
 *
 * Every report REQ-J-01 names is defined here except REQ-J-04's payroll
 * handoff, which the client has dropped: it is not built and it is not stubbed,
 * because a report key that answers with an empty table is indistinguishable
 * from one whose period is quiet. Adding a report is a `REPORT_DEFINITIONS`
 * entry plus a row source; the exporter, the download tray and the filter bar
 * learn nothing new.
 */

// ------------------------------------------------------------------- reports

export const REPORT_KEYS = [
  'attendance-register',
  'daily-muster',
  'monthly-muster',
  'late-arrivals',
  'early-exits',
  'absenteeism',
  'missing-punch',
  'overtime',
  'leave-balance',
  'leave-ledger',
  'leave-availed',
  'punch-audit',
  'headcount',
  // Phase 6c (REQ-S-05): the Tally module's first report. Listed with the
  // rest so ReportKey stays one union; grouped separately below.
  'voucher-reconciliation',
  'customer-statement',
  'credit-cycle',
  'ageing',
  'payment-analysis',
  'sales-analysis',
  'pending-dispatch',
  'low-stock',
  // 14 Tier 1: the projection mirrors and the first analysis (REQ-AE-01, REQ-AG-02).
  'day-book',
  'customer-lapse',
  // 14 Tier 1, the rest (D-46): mirrors, analyses and exceptions from the projection.
  'ledger-extract',
  'stock-summary',
  'negative-stock',
  'stale-projections',
  'duplicate-masters',
  'duplicate-clusters',
  // 15 Area AJ: the two reports collections exists for.
  'promised-vs-collected',
  'broken-promises',
  // Owner, 22 Aug 2026: Pareto — how few of them make up half of it.
  'item-revenue-concentration',
  'item-quantity-concentration',
  'vendor-spend-concentration',
  'receivables-concentration',
  // 15 REQ-AK-10: what comes back, by item, by customer, and by reason.
  'return-rate-by-item',
  'return-rate-by-customer',
  'returns-by-reason',
  'customer-item-matrix',
  'purchase-rhythm',
  'price-variance',
  'item-velocity',
  'dead-stock',
  'movement-analysis',
  'vendor-item-history',
  'vendor-price-comparison',
  'credit-breaches',
  'stock-ageing',
  // The approved catalogue (P-02, 21 Aug): concentration, pipeline, dispatch, fill, new-vs-repeat, requirement ageing.
  'customer-concentration',
  'order-pipeline',
  'dispatch-performance',
  'order-fill-rate',
  'order-fulfilment',
  'new-vs-repeat',
  'requirement-ageing',
  // Owner, 22 Aug 2026: the second analytics set, each named by the decision it changes.
  'flag-review-log',
  'approvals-turnaround',
  'early-arrival-leaderboard',
  'on-time-rate',
  'aov-trend',
  'partial-shipments',
  'vendor-lead-time',
  'stock-out-frequency',
  'margin-proxy',
  'sales-heatmap',
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

/** The keys the Tally module's source claims; everything else is attendance's. */
export const TALLY_REPORT_KEYS = ['voucher-reconciliation', 'customer-statement', 'credit-cycle', 'ageing', 'payment-analysis', 'sales-analysis', 'low-stock', 'day-book', 'customer-lapse'] as const satisfies readonly ReportKey[];
/** 14 Tier 1 (D-46), served by the analytics source; the same receivables gate as the Tally set. */
export const ANALYTICS_REPORT_KEYS = [
  // Owner, 22 Aug 2026: the Pareto family — how few make up half. The
  // customer-revenue case is `customer-concentration`, which already existed
  // and gained the band rather than being duplicated.
  'item-revenue-concentration',
  'item-quantity-concentration',
  'vendor-spend-concentration',
  'receivables-concentration',
  'ledger-extract',
  'stock-summary',
  'negative-stock',
  'stale-projections',
  'duplicate-masters',
  'duplicate-clusters',
  'customer-item-matrix',
  'purchase-rhythm',
  'price-variance',
  'item-velocity',
  'dead-stock',
  'movement-analysis',
  'vendor-item-history',
  'vendor-price-comparison',
  'credit-breaches',
  'stock-ageing',
  'customer-concentration',
  'order-pipeline',
  'dispatch-performance',
  'order-fill-rate',
  'order-fulfilment',
  'new-vs-repeat',
  'requirement-ageing',
  'aov-trend',
  'partial-shipments',
  'vendor-lead-time',
  'stock-out-frequency',
  'margin-proxy',
  'sales-heatmap',
] as const satisfies readonly ReportKey[];
/**
 * Owner, 22 Aug 2026: attendance's own analytics - reviews, approvals, early
 * arrivals, punctuality - served by the attendance module's analytics source
 * and gated on the org-wide attendance key rather than on receivables.
 */
export const ATTENDANCE_ANALYTICS_REPORT_KEYS = [
  'flag-review-log',
  'approvals-turnaround',
  'early-arrival-leaderboard',
  'on-time-rate',
] as const satisfies readonly ReportKey[];
/** The sales module's reports (12 REQ-AA-30). */
export const SALES_REPORT_KEYS = ['pending-dispatch'] as const satisfies readonly ReportKey[];

/** 15 REQ-AJ-08/09: promised against collected, and the promises nothing came against. */
export const COLLECTIONS_REPORT_KEYS = ['promised-vs-collected', 'broken-promises'] as const satisfies readonly ReportKey[];

/** 15 REQ-AK-10: the return rate, read three ways. Feeds REQ-AG-21. */
export const RETURNS_REPORT_KEYS = ['return-rate-by-item', 'return-rate-by-customer', 'returns-by-reason'] as const satisfies readonly ReportKey[];

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

/**
 * How a value is rendered and aligned. The exporter uses it to decide a
 * column's width and whether the cell is text; the table uses it to decide
 * alignment and numerals (PRD §6.3).
 */
export const REPORT_COLUMN_TYPES = [
  'text',
  'code',
  'date',
  /** A wall-clock time to the minute, e.g. a scheduled shift boundary. */
  'time',
  /** A recorded moment, to the second. An audit line needs the seconds. */
  'instant',
  'duration',
  'number',
  /** A money amount, shown grouped with the workspace's currency symbol (₹15,87,620.00); exported as the raw number. */
  'money',
  'status',
  'flags',
] as const;

export type ReportColumnType = (typeof REPORT_COLUMN_TYPES)[number];

export interface ReportColumnSpec {
  readonly key: string;
  readonly header: string;
  readonly type: ReportColumnType;
  /**
   * Hidden below 1280px unless the reader turns it on (PRD §6.5: "non-essential
   * columns hidden via the column chooser default").
   */
  readonly secondary?: boolean;
  /** Off until the reader asks for it in the F12 chooser. */
  readonly defaultHidden?: boolean;
  /** Present when the server can order by this column. */
  readonly sortField?: string;
  /** Character width hint for the exported sheet (REQ-J-03, column widths). */
  readonly width?: number;
}

export const REPORT_CATEGORIES = ['Attendance', 'Leave', 'Approvals', 'Books', 'Receivables', 'Customers', 'Inventory', 'Vendors', 'Fulfilment', 'Exceptions'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface ReportDefinition {
  readonly key: ReportKey;
  readonly label: string;
  /** REQ-AD-02: the catalogue's grouping; the sidebar of the Reports module lists these. */
  readonly category: ReportCategory;
  readonly description: string;
  readonly columns: readonly ReportColumnSpec[];
  readonly defaultSort: string;
  /** Filters this report understands; the shell hides the rest. */
  readonly filters: readonly ReportFilterName[];
  /**
   * Filters without which the report has no answer — a customer statement
   * is for one party. The shell asks before it fetches, rather than fetching
   * a 400 and rendering it as an error.
   */
  readonly requiredFilters?: readonly ReportFilterName[];
  /**
   * The period is one calendar date rather than a range.
   *
   * REQ-J-01's daily muster is "one row per employee **for a date**". The shell
   * renders a single-date picker for such a report and sends `from` equal to
   * `to`; the server reads `to` and would answer for that one day regardless,
   * so a hand-written URL asking for a range cannot produce a muster that
   * silently spans one.
   */
  readonly singleDate?: boolean;
  /**
   * The period must lie inside one calendar month.
   *
   * The muster grid's columns are days 1 to 31. A range crossing a month
   * boundary would put two different dates in the same column, so the server
   * refuses it rather than adding them together.
   */
  readonly singleMonth?: boolean;
}

export const REPORT_FILTER_NAMES = [
  'period',
  'employeeId',
  'departmentId',
  'locationId',
  'status',
  'flags',
  'punchType',
  /** Phase 6d: the receivables reports are about a party (REQ-Y-01, Y-03). */
  'partyId',
  /** Phase 6d: REQ-Y-05's dimension — by party, item, item group or month. */
  'groupBy',
  /** 14 REQ-AE-01: the day book narrows to one voucher type, typed as Tally names it. */
  'voucherType',
  /** 14 REQ-AE-02: the ledger extract is for one ledger, named as Tally names it. */
  'ledgerName',
  /** 14: the item analyses narrow to one item by name. */
  'itemName',
] as const;

export type ReportFilterName = (typeof REPORT_FILTER_NAMES)[number];

/**
 * REQ-E-01's register, one row per employee per day. The column set is the
 * `attendance_days` read model and nothing else -- notably no paid/unpaid
 * leave split and no LOP, which are REQ-J-04's payroll columns and are
 * unsigned-off (docs OPEN-QUESTIONS item 6).
 */
const ATTENDANCE_REGISTER_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
  { key: 'shiftName', header: 'Shift', type: 'text', width: 16 },
  { key: 'scheduledIn', header: 'Scheduled in', type: 'time', secondary: true, width: 13 },
  { key: 'scheduledOut', header: 'Scheduled out', type: 'time', secondary: true, width: 13 },
  { key: 'firstInAt', header: 'In', type: 'time', width: 8 },
  { key: 'lastOutAt', header: 'Out', type: 'time', width: 8 },
  { key: 'workedMinutes', header: 'Worked', type: 'duration', sortField: 'workedMinutes', width: 10 },
  { key: 'breakMinutes', header: 'Break', type: 'duration', secondary: true, width: 10 },
  { key: 'otMinutes', header: 'Overtime', type: 'duration', width: 10 },
  { key: 'lateMinutes', header: 'Late by', type: 'duration', secondary: true, width: 10 },
  { key: 'earlyExitMinutes', header: 'Early by', type: 'duration', secondary: true, width: 10 },
  { key: 'status', header: 'Status', type: 'status', sortField: 'status', width: 14 },
  { key: 'flags', header: 'Flags', type: 'flags', width: 22 },
  { key: 'isManualOverride', header: 'Overridden', type: 'text', defaultHidden: true, width: 12 },
  { key: 'locked', header: 'Locked', type: 'text', defaultHidden: true, width: 10 },
];

/** REQ-J-01's Punch Audit: "raw punch log with photo thumbnails, location, device, flags". */
const PUNCH_AUDIT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'attendanceDate', header: 'Date', type: 'date', sortField: 'attendanceDate', width: 12 },
  { key: 'serverTime', header: 'Recorded at', type: 'instant', sortField: 'serverTime', width: 12 },
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
  { key: 'type', header: 'Direction', type: 'text', width: 10 },
  { key: 'source', header: 'Source', type: 'text', width: 14 },
  { key: 'clientTime', header: 'Device time', type: 'instant', secondary: true, width: 12 },
  { key: 'clockSkewSeconds', header: 'Clock skew', type: 'number', secondary: true, width: 12 },
  { key: 'syncDelaySeconds', header: 'Sync delay', type: 'number', secondary: true, width: 12 },
  { key: 'location', header: 'Location', type: 'text', width: 22 },
  { key: 'gpsAccuracyM', header: 'Accuracy', type: 'number', secondary: true, width: 10 },
  {
    key: 'distanceFromGeofenceM',
    header: 'From office',
    type: 'number',
    secondary: true,
    width: 12,
  },
  { key: 'halfDay', header: 'Half day', type: 'text', defaultHidden: true, width: 12 },
  { key: 'reason', header: 'Reason', type: 'text', width: 30 },
  { key: 'flags', header: 'Flags', type: 'flags', width: 26 },
];

/**
 * REQ-J-01's daily muster: "one row per employee for a date".
 *
 * The same rows as the register -- there is one `attendance_days` row per
 * employee per date and a second query over it would be a second answer to the
 * same question -- arranged for the sheet a supervisor prints in the morning:
 * ordered by employee code, with the date in the header block rather than
 * repeated down a column.
 */
const DAILY_MUSTER_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
  { key: 'shiftName', header: 'Shift', type: 'text', width: 16 },
  { key: 'scheduledIn', header: 'Scheduled in', type: 'time', secondary: true, width: 13 },
  { key: 'scheduledOut', header: 'Scheduled out', type: 'time', secondary: true, width: 13 },
  { key: 'firstInAt', header: 'In', type: 'time', width: 8 },
  { key: 'lastOutAt', header: 'Out', type: 'time', width: 8 },
  { key: 'workedMinutes', header: 'Worked', type: 'duration', sortField: 'workedMinutes', width: 10 },
  { key: 'breakMinutes', header: 'Break', type: 'duration', secondary: true, width: 10 },
  { key: 'otMinutes', header: 'Overtime', type: 'duration', width: 10 },
  { key: 'lateMinutes', header: 'Late by', type: 'duration', secondary: true, width: 10 },
  { key: 'earlyExitMinutes', header: 'Early by', type: 'duration', secondary: true, width: 10 },
  { key: 'status', header: 'Status', type: 'status', sortField: 'status', width: 14 },
  { key: 'flags', header: 'Flags', type: 'flags', width: 22 },
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', defaultHidden: true, width: 12 },
];

// ------------------------------------------------------------- muster grid

/** Days 1 to 31, as the column keys the grid's cells are addressed by. */
export const MUSTER_GRID_DAYS = 31;

/** `d01` … `d31`. Zero-padded so the definition order is the calendar order. */
export function musterDayKey(day: number): string {
  return `d${String(day).padStart(2, '0')}`;
}

/**
 * REQ-J-01's "status codes" for the grid.
 *
 * A rendering of `attendance_days.status` and nothing more -- no status is
 * invented and none is merged, so a cell reading `A` is a row that says ABSENT.
 * Two letters where one would collide, because a muster read at arm's length is
 * read by shape.
 */
export const MUSTER_STATUS_CODES: Record<string, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  ON_LEAVE: 'L',
  HALF_DAY: 'HD',
  HOLIDAY: 'H',
  WEEKLY_OFF: 'WO',
  ON_DUTY: 'OD',
  PENDING: '?',
};

const MUSTER_GRID_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 26 },
  { key: 'departmentName', header: 'Department', type: 'text', secondary: true, width: 18 },
  ...Array.from({ length: MUSTER_GRID_DAYS }, (_, index) => ({
    key: musterDayKey(index + 1),
    header: String(index + 1),
    type: 'text' as const,
    width: 4,
  })),
  // REQ-J-01's "totals block". Columns rather than a trailing band of rows:
  // the exporter writes one header and one row shape, and a totals row inside
  // the data would be summed again by whoever opens the sheet.
  { key: 'presentDays', header: 'Present', type: 'number', sortField: 'presentDays', width: 9 },
  { key: 'absentDays', header: 'Absent', type: 'number', sortField: 'absentDays', width: 9 },
  { key: 'leaveDays', header: 'Leave', type: 'number', width: 9 },
  { key: 'halfDays', header: 'Half day', type: 'number', secondary: true, width: 9 },
  { key: 'onDutyDays', header: 'On duty', type: 'number', secondary: true, width: 9 },
  { key: 'weeklyOffDays', header: 'Weekly off', type: 'number', secondary: true, width: 11 },
  { key: 'holidayDays', header: 'Holiday', type: 'number', secondary: true, width: 9 },
  { key: 'workedMinutes', header: 'Worked', type: 'duration', sortField: 'workedMinutes', width: 10 },
  { key: 'otMinutes', header: 'Overtime', type: 'duration', width: 10 },
  { key: 'lateDays', header: 'Late days', type: 'number', width: 10 },
];

// ------------------------------------------------------- exception summaries

/**
 * Late arrivals, early exits and overtime are one query with one measure
 * swapped, so they are one column shape with the headers renamed.
 *
 * Keeping them as three definitions rather than one report with a mode is what
 * REQ-N-02's Ctrl+G expects: a Tally user switches to "Late arrivals", not to
 * "Exceptions" and then to a dropdown inside it.
 */
function exceptionColumns(labels: {
  occurrences: string;
  total: string;
  average: string;
  worst: string;
}): readonly ReportColumnSpec[] {
  return [
    { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
    { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
    { key: 'departmentName', header: 'Department', type: 'text', width: 18 },
    { key: 'locationName', header: 'Location', type: 'text', secondary: true, width: 16 },
    { key: 'occurrences', header: labels.occurrences, type: 'number', sortField: 'occurrences', width: 10 },
    { key: 'totalMinutes', header: labels.total, type: 'duration', sortField: 'totalMinutes', width: 12 },
    { key: 'averageMinutes', header: labels.average, type: 'duration', width: 12 },
    { key: 'worstMinutes', header: labels.worst, type: 'duration', sortField: 'worstMinutes', width: 12 },
    { key: 'firstDate', header: 'First', type: 'date', secondary: true, width: 12 },
    { key: 'lastDate', header: 'Last', type: 'date', secondary: true, width: 12 },
  ];
}

const ABSENTEEISM_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
  { key: 'departmentName', header: 'Department', type: 'text', width: 18 },
  { key: 'locationName', header: 'Location', type: 'text', secondary: true, width: 16 },
  { key: 'scheduledDays', header: 'Scheduled', type: 'number', width: 11 },
  { key: 'presentDays', header: 'Present', type: 'number', width: 9 },
  { key: 'leaveDays', header: 'On leave', type: 'number', secondary: true, width: 10 },
  { key: 'absentDays', header: 'Absent', type: 'number', sortField: 'absentDays', width: 9 },
  {
    key: 'absencePercent',
    header: 'Absent %',
    type: 'number',
    sortField: 'absencePercent',
    width: 10,
  },
];

const MISSING_PUNCH_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 26 },
  { key: 'departmentName', header: 'Department', type: 'text', secondary: true, width: 18 },
  { key: 'shiftName', header: 'Shift', type: 'text', secondary: true, width: 16 },
  // "Punched", not "In" and "Out": these are the raw punch times, and on a day
  // whose correction has been approved they differ from the register's, which
  // folds the adjustment in. Two columns with the same header and different
  // rules is how a reader ends up believing the two screens contradict.
  { key: 'punchedInAt', header: 'Punched in', type: 'time', width: 11 },
  { key: 'punchedOutAt', header: 'Punched out', type: 'time', width: 11 },
  { key: 'status', header: 'Status', type: 'status', sortField: 'status', width: 14 },
  { key: 'flags', header: 'Flags', type: 'flags', secondary: true, width: 22 },
  // REQ-J-01: "days flagged missing_punch, **and their regularization status**".
  // Null is the answer for a day nobody has raised a correction for, and it
  // renders as the empty dash rather than as "none", which would read as a
  // decision somebody made.
  { key: 'regularizationStatus', header: 'Correction', type: 'status', width: 14 },
  { key: 'regularizationKind', header: 'Kind', type: 'text', secondary: true, width: 14 },
  { key: 'regularizationDecidedAt', header: 'Decided', type: 'instant', secondary: true, width: 12 },
  { key: 'regularizationReason', header: 'Reason', type: 'text', defaultHidden: true, width: 30 },
];

// -------------------------------------------------------------------- leave

const LEAVE_BALANCE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 26 },
  { key: 'departmentName', header: 'Department', type: 'text', secondary: true, width: 18 },
  { key: 'leaveTypeCode', header: 'Type', type: 'code', sortField: 'leaveTypeCode', width: 10 },
  { key: 'leaveTypeName', header: 'Leave type', type: 'text', width: 20 },
  { key: 'leaveYear', header: 'Leave year', type: 'number', secondary: true, width: 11 },
  { key: 'opening', header: 'Opening', type: 'number', secondary: true, width: 10 },
  { key: 'accrued', header: 'Accrued', type: 'number', width: 10 },
  { key: 'availed', header: 'Availed', type: 'number', sortField: 'availed', width: 10 },
  { key: 'adjusted', header: 'Adjusted', type: 'number', secondary: true, width: 10 },
  { key: 'carriedForward', header: 'Carried forward', type: 'number', secondary: true, width: 15 },
  { key: 'closing', header: 'Balance', type: 'number', sortField: 'closing', width: 10 },
];

const LEAVE_LEDGER_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'postedAt', header: 'Posted', type: 'instant', sortField: 'postedAt', width: 14 },
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 26 },
  { key: 'leaveTypeCode', header: 'Type', type: 'code', width: 10 },
  { key: 'leaveTypeName', header: 'Leave type', type: 'text', secondary: true, width: 20 },
  { key: 'leaveYear', header: 'Leave year', type: 'number', secondary: true, width: 11 },
  { key: 'movementType', header: 'Movement', type: 'status', sortField: 'movementType', width: 16 },
  { key: 'days', header: 'Days', type: 'number', sortField: 'days', width: 8 },
  { key: 'referenceType', header: 'Caused by', type: 'text', secondary: true, width: 16 },
  { key: 'periodKey', header: 'Period', type: 'text', defaultHidden: true, width: 12 },
  { key: 'note', header: 'Note', type: 'text', width: 30 },
];

const LEAVE_AVAILED_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'employeeCode', header: 'Code', type: 'code', sortField: 'employeeCode', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 26 },
  { key: 'departmentName', header: 'Department', type: 'text', secondary: true, width: 18 },
  { key: 'leaveTypeCode', header: 'Type', type: 'code', sortField: 'leaveTypeCode', width: 10 },
  { key: 'leaveTypeName', header: 'Leave type', type: 'text', width: 20 },
  { key: 'isPaid', header: 'Paid', type: 'text', secondary: true, width: 8 },
  { key: 'requests', header: 'Requests', type: 'number', width: 10 },
  { key: 'days', header: 'Days', type: 'number', sortField: 'days', width: 8 },
  { key: 'firstDate', header: 'First', type: 'date', width: 12 },
  { key: 'lastDate', header: 'Last', type: 'date', width: 12 },
];

const HEADCOUNT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'opening', header: 'Opening', type: 'number', width: 10 },
  { key: 'joiners', header: 'Joiners', type: 'number', sortField: 'joiners', width: 10 },
  { key: 'leavers', header: 'Leavers', type: 'number', sortField: 'leavers', width: 10 },
  { key: 'closing', header: 'Closing', type: 'number', sortField: 'closing', width: 10 },
];

/** The four filters every report over people understands. */
const PEOPLE_FILTERS: readonly ReportFilterName[] = [
  'period',
  'employeeId',
  'departmentId',
  'locationId',
];

/**
 * REQ-S-05: one row per voucher type per month. `total` is the sum of
 * `vouchers.amount` — a held figure summed for reconciliation only, shown as
 * exact decimal text; nothing downstream computes on it.
 */
const VOUCHER_RECONCILIATION_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'voucherType', header: 'Voucher type', type: 'text', sortField: 'voucherType', width: 18 },
  { key: 'count', header: 'Vouchers', type: 'number', width: 10 },
  { key: 'cancelled', header: 'Cancelled', type: 'number', secondary: true, width: 10 },
  { key: 'total', header: 'Total value', type: 'money', width: 16 },
  { key: 'lastPulledAt', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * REQ-Y-05's dimensions. Salesperson is not among them: Tally's voucher does
 * not carry one, and a dimension the projection cannot answer would be a
 * column of blanks presented as a choice.
 */
export const SALES_ANALYSIS_DIMENSIONS = ['party', 'item', 'itemGroup', 'month'] as const;
export type SalesAnalysisDimension = (typeof SALES_ANALYSIS_DIMENSIONS)[number];
export const SALES_ANALYSIS_DIMENSION_LABELS: Record<SalesAnalysisDimension, string> = {
  party: 'By party',
  item: 'By item',
  itemGroup: 'By item group',
  month: 'By month',
};

/**
 * REQ-Y-01: every voucher for one party in the period, with a running
 * balance that starts from what came before the period. Debit and credit
 * follow the voucher type (Sales and Debit Note debit the customer; Receipt
 * and Credit Note credit them); a type outside that table shows its amount
 * unclassified and leaves the balance alone — an honest blank beats a
 * guessed sign.
 */
const CUSTOMER_STATEMENT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'voucherType', header: 'Type', type: 'text', width: 14 },
  { key: 'voucherNumber', header: 'Number', type: 'code', width: 16 },
  { key: 'narration', header: 'Narration', type: 'text', secondary: true, width: 30 },
  { key: 'debit', header: 'Debit', type: 'money', width: 14 },
  { key: 'credit', header: 'Credit', type: 'money', width: 14 },
  { key: 'unclassified', header: 'Unclassified', type: 'text', secondary: true, width: 14 },
  { key: 'balance', header: 'Balance', type: 'money', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * REQ-Y-03: credit limit and days against exposure. Exposure is the party's
 * balance from every voucher this projection holds (debits less credits).
 * "Actual overdue" is deliberately absent until bill-wise allocations
 * arrive (P6b): without them, which invoice a receipt settled is a guess.
 */
/**
 * REQ-Y-02. One row per open bill, not per party -- that is the whole point.
 * A party's net balance ages from nothing; a bill has a date, so its age is
 * arithmetic. The bucket is a column rather than four columns of money because
 * a bill sits in exactly one, and four columns with three blanks is a crosstab
 * pretending to be a list.
 */
const AGEING_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Party', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'billName', header: 'Bill', type: 'code', width: 16 },
  { key: 'billDate', header: 'Bill date', type: 'date', sortField: 'billDate', width: 12 },
  { key: 'dueDate', header: 'Due', type: 'date', secondary: true, width: 12 },
  { key: 'ageDays', header: 'Age (days)', type: 'number', sortField: 'ageDays', width: 10 },
  { key: 'bucket', header: 'Bucket', type: 'status', width: 12 },
  { key: 'outstanding', header: 'Outstanding', type: 'money', sortField: 'outstanding', width: 14 },
  { key: 'overdue', header: 'Overdue', type: 'status', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * REQ-Y-04. What a party actually does, against what they agreed to.
 *
 * `avgDaysToPay` is observed from settlements that name the bill they settle,
 * which is why this report could not exist before `bill_allocations`: without
 * the link, "days to pay" could only be inferred from the order receipts
 * happened to arrive in, and a customer paying March's bill in July would look
 * like a customer paying June's on time.
 *
 * The requirement says so itself -- with one financial year it is noise -- so
 * `billsPaid` is on the row. A three-bill average is a number, not a finding.
 */
const PAYMENT_ANALYSIS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Party', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'creditDays', header: 'Agreed days', type: 'number', width: 12 },
  { key: 'avgDaysToPay', header: 'Actual days', type: 'number', sortField: 'avgDaysToPay', width: 12 },
  { key: 'slippage', header: 'Slippage', type: 'number', sortField: 'slippage', width: 10 },
  { key: 'billsPaid', header: 'Bills settled', type: 'number', secondary: true, width: 12 },
  { key: 'billsOpen', header: 'Still open', type: 'number', secondary: true, width: 10 },
  { key: 'oldestOpenDays', header: 'Oldest open', type: 'number', width: 12 },
  { key: 'onTime', header: 'Pays on time', type: 'status', width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

const CREDIT_CYCLE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Party', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'creditLimit', header: 'Credit limit', type: 'money', width: 14 },
  { key: 'creditDays', header: 'Credit days', type: 'number', width: 10 },
  { key: 'exposure', header: 'Exposure', type: 'money', sortField: 'exposure', width: 14 },
  { key: 'headroom', header: 'Headroom', type: 'money', width: 14 },
  { key: 'overLimit', header: 'Over limit', type: 'status', width: 10 },
  { key: 'lastInvoiceDate', header: 'Last invoice', type: 'date', secondary: true, width: 12 },
  { key: 'lastReceiptDate', header: 'Last receipt', type: 'date', secondary: true, width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * REQ-Y-05: sales value by the chosen dimension, from the inventory lines of
 * Sales vouchers that were not cancelled. Value only — margin needs a cost
 * the projection holds only as a "held figure" that Tally may or may not
 * maintain, and a margin computed on a stale cost is a wrong number that
 * looks right.
 */
const SALES_ANALYSIS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'label', header: 'Group', type: 'text', sortField: 'label', width: 28 },
  { key: 'vouchers', header: 'Invoices', type: 'number', width: 10 },
  { key: 'quantity', header: 'Quantity', type: 'text', secondary: true, width: 12 },
  { key: 'value', header: 'Value', type: 'money', sortField: 'value', width: 16 },
  { key: 'share', header: 'Share', type: 'text', secondary: true, width: 8 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 12 REQ-AA-30: every open order with a balance, by party, by age, by item. */
const PENDING_DISPATCH_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'orderNumber', header: 'Order', type: 'code', sortField: 'orderNumber', width: 12 },
  { key: 'customerName', header: 'Party', type: 'text', sortField: 'customerName', width: 26 },
  { key: 'orderDate', header: 'Order date', type: 'date', sortField: 'orderDate', width: 12 },
  { key: 'ageDays', header: 'Age (days)', type: 'number', sortField: 'ageDays', width: 10 },
  { key: 'item', header: 'Item', type: 'text', width: 26 },
  { key: 'ordered', header: 'Ordered', type: 'text', width: 10 },
  { key: 'packed', header: 'Packed', type: 'text', secondary: true, width: 10 },
  { key: 'invoiced', header: 'Invoiced', type: 'money', secondary: true, width: 10 },
  { key: 'dispatched', header: 'Dispatched', type: 'text', width: 10 },
  { key: 'balance', header: 'Balance', type: 'text', width: 10 },
  { key: 'fulfilment', header: 'Stage', type: 'status', width: 16 },
];

/** 13 REQ-AC-06: at or below reorder level, with committed, available, open PO and the shortfall. */
const LOW_STOCK_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'closing', header: 'Closing (Tally)', type: 'money', width: 12 },
  { key: 'committed', header: 'Committed', type: 'text', width: 12 },
  { key: 'available', header: 'Available', type: 'text', sortField: 'available', width: 12 },
  { key: 'reorderLevel', header: 'Reorder level', type: 'text', width: 12 },
  { key: 'openPo', header: 'On order', type: 'text', width: 12 },
  { key: 'shortfall', header: 'Shortfall', type: 'money', sortField: 'shortfall', width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * 14 REQ-AE-01: every voucher for a period — the workhorse mirror. Vyuha
 * computes nothing; it lists what Tally already said, filterable by type
 * and party, each row stamped with the sync it is as of (REQ-AD-06).
 */
const DAY_BOOK_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'voucherType', header: 'Type', type: 'text', sortField: 'voucherType', width: 16 },
  { key: 'voucherNumber', header: 'Number', type: 'code', width: 12 },
  { key: 'partyName', header: 'Party', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'amount', header: 'Amount', type: 'money', sortField: 'amount', width: 16 },
  { key: 'narration', header: 'Narration', type: 'text', secondary: true, width: 36 },
  { key: 'cancelled', header: 'State', type: 'status', secondary: true, width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * 14 REQ-AG-02: customers who bought regularly and then stopped. The
 * expected gap is each customer's own median gap between sales vouchers
 * (D-36 in `14`): a monthly buyer and an annual buyer lapse at different
 * speeds. Lapsed past twice the median, at risk past once; ranked by the
 * last twelve months' revenue — what the silence is costing.
 */
const CUSTOMER_LAPSE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'state', header: 'State', type: 'status', width: 10 },
  { key: 'lastSaleDate', header: 'Last sale', type: 'date', sortField: 'lastSaleDate', width: 12 },
  { key: 'daysSince', header: 'Days since', type: 'number', sortField: 'daysSince', width: 10 },
  { key: 'medianGapDays', header: 'Usual gap', type: 'number', width: 10 },
  { key: 'expectedBy', header: 'Expected by', type: 'date', secondary: true, width: 12 },
  { key: 'sales12m', header: 'Sales (12m)', type: 'number', secondary: true, width: 10 },
  { key: 'revenue12m', header: 'Revenue (12m)', type: 'money', sortField: 'revenue12m', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AE-02: one ledger's transactions with a running balance, opening from what came before. */
const LEDGER_EXTRACT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'voucherType', header: 'Type', type: 'text', width: 14 },
  { key: 'voucherNumber', header: 'Number', type: 'code', width: 12 },
  { key: 'partyName', header: 'Party', type: 'text', secondary: true, width: 24 },
  { key: 'debit', header: 'Debit', type: 'money', width: 14 },
  { key: 'credit', header: 'Credit', type: 'money', width: 14 },
  { key: 'balance', header: 'Balance', type: 'money', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AF-01: closing per item, extended with Vyuha's committed and available (REQ-AC-03, AC-04). */
const STOCK_SUMMARY_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'group', header: 'Group', type: 'text', secondary: true, width: 18 },
  { key: 'unit', header: 'Unit', type: 'text', secondary: true, width: 8 },
  { key: 'closingQty', header: 'Closing', type: 'text', sortField: 'closingQty', width: 12 },
  { key: 'committedQty', header: 'Committed', type: 'text', width: 12 },
  { key: 'availableQty', header: 'Available', type: 'text', width: 12 },
  { key: 'costRate', header: 'Cost rate', type: 'money', secondary: true, width: 12 },
  { key: 'value', header: 'Value at cost', type: 'money', sortField: 'value', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AF-07 / AH-01: billed what was never received. The ideal state is empty. */
const NEGATIVE_STOCK_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 30 },
  { key: 'group', header: 'Group', type: 'text', secondary: true, width: 18 },
  { key: 'closingQty', header: 'Closing', type: 'text', sortField: 'closingQty', width: 12 },
  { key: 'unit', header: 'Unit', type: 'text', width: 8 },
  { key: 'lastPulledAt', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AH-11: a company whose projection has quietly stopped being the truth. */
const STALE_PROJECTIONS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'companyName', header: 'Company', type: 'text', width: 28 },
  { key: 'connectionState', header: 'Connection', type: 'status', width: 12 },
  { key: 'lastPulledAt', header: 'Last pull', type: 'instant', width: 20 },
  { key: 'hoursStale', header: 'Hours stale', type: 'number', sortField: 'hoursStale', width: 10 },
];

/** 14 REQ-AH-12: near-matching master names. Vyuha flags; the accountant merges in Tally. */
/** 15 REQ-AO-15: open clusters by entity type and confidence band, and the outstanding behind the party ones. */
const PROMISED_VS_COLLECTED_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'collectorName', header: 'Collector', type: 'text', sortField: 'collectorName', width: 20 },
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'promises', header: 'Promises', type: 'number', width: 10 },
  { key: 'promised', header: 'Promised', type: 'number', sortField: 'promised', width: 14 },
  { key: 'received', header: 'Received', type: 'money', width: 14 },
  { key: 'keptPct', header: 'Kept %', type: 'number', width: 10 },
  { key: 'kept', header: 'Kept', type: 'number', width: 8, secondary: true },
  { key: 'partlyKept', header: 'Partly', type: 'number', width: 8, secondary: true },
  { key: 'broken', header: 'Broken', type: 'number', width: 8 },
  { key: 'open', header: 'Open', type: 'number', width: 8, secondary: true },
];

const BROKEN_PROMISES_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'promisedDate', header: 'Promised for', type: 'date', width: 14 },
  { key: 'daysLate', header: 'Days late', type: 'number', sortField: 'daysLate', width: 10 },
  { key: 'amount', header: 'Promised', type: 'money', width: 14 },
  { key: 'received', header: 'Received', type: 'money', width: 14 },
  { key: 'shortfall', header: 'Shortfall', type: 'number', sortField: 'shortfall', width: 14 },
  { key: 'collectorName', header: 'Collector', type: 'text', width: 20, secondary: true },
  { key: 'takenByName', header: 'Taken by', type: 'text', width: 20, secondary: true },
  { key: 'bills', header: 'Against bills', type: 'text', width: 24, secondary: true },
];

/**
 * Every Pareto reads the same way, so they share one shape: the rank, the
 * thing, what it is worth, its own share, and the running total that answers
 * "how far down the list is half of it".
 */
const PARETO_COLUMNS: readonly ReportColumnSpec[] = [
  // Rank is the only sortable field, and deliberately: the running column is
  // only true in rank order, so offering "sort by name" would offer a table
  // whose cumulative per cent wanders up and down the page.
  { key: 'rank', header: 'Rank', type: 'number', sortField: 'rank', width: 6 },
  { key: 'name', header: 'Name', type: 'text', width: 34 },
  { key: 'value', header: 'Value', type: 'text', width: 16 },
  { key: 'sharePct', header: 'Share', type: 'text', width: 10 },
  { key: 'cumulativePct', header: 'Cumulative', type: 'text', width: 12 },
  { key: 'band', header: 'Band', type: 'status', width: 14 },
];

const RETURN_RATE_ITEM_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'itemName', header: 'Item', type: 'text', sortField: 'itemName', width: 30 },
  { key: 'returnedQty', header: 'Returned', type: 'number', sortField: 'returnedQty', width: 12 },
  { key: 'soldQty', header: 'Sold', type: 'number', width: 12 },
  { key: 'ratePct', header: 'Return rate %', type: 'number', sortField: 'ratePct', width: 14 },
  { key: 'returns', header: 'Receipts', type: 'number', width: 10 },
  { key: 'scrappedQty', header: 'Scrapped', type: 'number', width: 12, secondary: true },
  { key: 'topReason', header: 'Commonest reason', type: 'text', width: 24 },
  { key: 'lastReturnedOn', header: 'Last returned', type: 'date', width: 14, secondary: true },
];

const RETURN_RATE_CUSTOMER_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 30 },
  { key: 'returnedQty', header: 'Returned', type: 'number', sortField: 'returnedQty', width: 12 },
  { key: 'soldQty', header: 'Sold', type: 'number', width: 12 },
  { key: 'ratePct', header: 'Return rate %', type: 'number', sortField: 'ratePct', width: 14 },
  { key: 'returns', header: 'Receipts', type: 'number', width: 10 },
  { key: 'awaitingCredit', header: 'Awaiting credit note', type: 'number', width: 18 },
  { key: 'topReason', header: 'Commonest reason', type: 'text', width: 24 },
  { key: 'lastReturnedOn', header: 'Last returned', type: 'date', width: 14, secondary: true },
];

const RETURNS_BY_REASON_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'reason', header: 'Reason', type: 'text', sortField: 'reason', width: 26 },
  { key: 'lines', header: 'Lines', type: 'number', sortField: 'lines', width: 10 },
  { key: 'returns', header: 'Receipts', type: 'number', width: 10 },
  { key: 'quantity', header: 'Quantity', type: 'number', sortField: 'quantity', width: 12 },
  { key: 'sharePct', header: 'Share of lines %', type: 'number', width: 16 },
  { key: 'scrapLines', header: 'Scrapped lines', type: 'number', width: 14 },
  { key: 'damagedLines', header: 'Arrived damaged', type: 'number', width: 16, secondary: true },
  { key: 'topItem', header: 'Commonest item', type: 'text', width: 26, secondary: true },
];

const DUPLICATE_CLUSTERS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'kind', header: 'Master', type: 'text', width: 12 },
  { key: 'band', header: 'Confidence', type: 'text', sortField: 'band', width: 16 },
  { key: 'clusters', header: 'Open clusters', type: 'number', sortField: 'clusters', width: 12 },
  { key: 'records', header: 'Records', type: 'number', width: 10 },
  { key: 'sentToTally', header: 'Sent to Tally', type: 'number', width: 12, secondary: true },
  { key: 'outstanding', header: 'Outstanding behind them', type: 'money', sortField: 'outstanding', width: 18 },
];

const DUPLICATE_MASTERS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'kind', header: 'Master', type: 'text', width: 10 },
  { key: 'nameA', header: 'Name', type: 'text', sortField: 'nameA', width: 30 },
  { key: 'nameB', header: 'Looks like', type: 'text', width: 30 },
  { key: 'reason', header: 'Why flagged', type: 'text', secondary: true, width: 24 },
];

/** 14 REQ-AG-01/AG-12: who buys what — the matrix as drillable rows, party-first or item-first by sort. */
const CUSTOMER_ITEM_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 26 },
  { key: 'invoices', header: 'Invoices', type: 'number', width: 10 },
  { key: 'quantity', header: 'Quantity', type: 'text', width: 12 },
  { key: 'value', header: 'Value', type: 'money', sortField: 'value', width: 14 },
  { key: 'lastDate', header: 'Last sale', type: 'date', sortField: 'lastDate', width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-03: how often each customer buys, and whether the rhythm is slowing. */
const PURCHASE_RHYTHM_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'sales12m', header: 'Sales (12m)', type: 'number', sortField: 'sales12m', width: 10 },
  { key: 'perMonth', header: 'Per month', type: 'text', width: 10 },
  { key: 'medianGapDays', header: 'Usual gap', type: 'number', width: 10 },
  { key: 'lastGapDays', header: 'Last gap', type: 'number', secondary: true, width: 10 },
  { key: 'daysSince', header: 'Days since', type: 'number', sortField: 'daysSince', width: 10 },
  { key: 'trend', header: 'Trend', type: 'status', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-04: the same item at different rates, ranked by the spread. */
const PRICE_VARIANCE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 26 },
  { key: 'buyers', header: 'Buyers', type: 'number', width: 8 },
  { key: 'minRate', header: 'Lowest', type: 'money', width: 12 },
  { key: 'minParty', header: 'Who pays least', type: 'text', secondary: true, width: 22 },
  { key: 'maxRate', header: 'Highest', type: 'money', width: 12 },
  { key: 'maxParty', header: 'Who pays most', type: 'text', secondary: true, width: 22 },
  { key: 'avgRate', header: 'Average', type: 'money', secondary: true, width: 12 },
  { key: 'spreadPct', header: 'Spread', type: 'text', sortField: 'spreadPct', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-13/AG-14: units per month, the trend, and the cover in days that makes it actionable. */
const ITEM_VELOCITY_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'monthly12', header: 'Per month (12m)', type: 'text', sortField: 'monthly12', width: 14 },
  { key: 'monthly3', header: 'Per month (3m)', type: 'text', width: 14 },
  { key: 'trend', header: 'Trend', type: 'status', width: 10 },
  { key: 'closingQty', header: 'Closing', type: 'text', secondary: true, width: 12 },
  { key: 'coverDays', header: 'Cover (days)', type: 'number', sortField: 'coverDays', width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-15: stock that stopped moving, ranked by the money locked up. */
const DEAD_STOCK_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'lastSaleDate', header: 'Last sale', type: 'date', sortField: 'lastSaleDate', width: 12 },
  { key: 'daysIdle', header: 'Days idle', type: 'number', sortField: 'daysIdle', width: 10 },
  { key: 'closingQty', header: 'Closing', type: 'text', width: 12 },
  { key: 'valueLocked', header: 'Value locked', type: 'money', sortField: 'valueLocked', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-16: inward and outward per item per month. */
const MOVEMENT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'inwardQty', header: 'Inward', type: 'text', width: 12 },
  { key: 'outwardQty', header: 'Outward', type: 'text', width: 12 },
  { key: 'netQty', header: 'Net', type: 'text', width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-23: what was bought from whom, with the rate's direction. */
const VENDOR_ITEM_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'vendorName', header: 'Vendor', type: 'text', sortField: 'vendorName', width: 24 },
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 26 },
  { key: 'purchases', header: 'Purchases', type: 'number', width: 10 },
  { key: 'quantity', header: 'Quantity', type: 'text', secondary: true, width: 12 },
  { key: 'lastRate', header: 'Last rate', type: 'money', width: 12 },
  { key: 'avgRate', header: 'Avg rate', type: 'money', secondary: true, width: 12 },
  { key: 'lastDate', header: 'Last bought', type: 'date', sortField: 'lastDate', width: 12 },
  { key: 'rateTrend', header: 'Rate', type: 'status', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AG-27: the same item across vendors — the report that pays for itself on the first PO. */
const VENDOR_PRICE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'vendors', header: 'Vendors', type: 'number', width: 8 },
  { key: 'bestRate', header: 'Best last rate', type: 'money', width: 14 },
  { key: 'bestVendor', header: 'From', type: 'text', width: 22 },
  { key: 'worstRate', header: 'Highest last rate', type: 'money', secondary: true, width: 14 },
  { key: 'worstVendor', header: 'From', type: 'text', secondary: true, width: 22 },
  { key: 'spreadPct', header: 'Spread', type: 'text', sortField: 'spreadPct', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AH-04: over the limit now, and how it was released before. */
const CREDIT_BREACHES_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Party', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'creditLimit', header: 'Limit', type: 'money', width: 14 },
  { key: 'exposure', header: 'Exposure', type: 'money', sortField: 'exposure', width: 14 },
  { key: 'overBy', header: 'Over by', type: 'text', sortField: 'overBy', width: 14 },
  { key: 'releases90d', header: 'Releases (90d)', type: 'number', secondary: true, width: 12 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** 14 REQ-AF-03/AG-37: closing stock bucketed by inward age (FIFO-assumed, D-46), valued at cost. */
const STOCK_AGEING_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'closingQty', header: 'Closing', type: 'text', width: 12 },
  { key: 'bucket0', header: '0–30d', type: 'text', width: 10 },
  { key: 'bucket31', header: '31–60d', type: 'text', width: 10 },
  { key: 'bucket61', header: '61–90d', type: 'text', width: 10 },
  { key: 'bucket90', header: '90d+', type: 'text', width: 10 },
  { key: 'valueLocked', header: 'Value at cost', type: 'money', sortField: 'valueLocked', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** How dependent the business is on its biggest buyers. */
const CONCENTRATION_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'rank', header: 'Rank', type: 'number', width: 6 },
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'revenue', header: 'Revenue', type: 'money', sortField: 'revenue', width: 16 },
  { key: 'sharePct', header: 'Share', type: 'text', width: 10 },
  { key: 'cumulativePct', header: 'Cumulative', type: 'text', width: 10 },
  // Which third of the curve this row is in, computed where the running total
  // is rather than in the reader's head.
  { key: 'band', header: 'Band', type: 'status', width: 14 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** Where working days leak: every open order and how long it has sat. */
const ORDER_PIPELINE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'number', header: 'Order', type: 'code', sortField: 'number', width: 12 },
  { key: 'customerName', header: 'Customer', type: 'text', sortField: 'customerName', width: 26 },
  { key: 'stage', header: 'Stage', type: 'status', width: 14 },
  { key: 'orderDate', header: 'Ordered', type: 'date', sortField: 'orderDate', width: 12 },
  { key: 'ageDays', header: 'Age (days)', type: 'number', sortField: 'ageDays', width: 10 },
  { key: 'balanceQty', header: 'Balance qty', type: 'text', width: 12 },
  { key: 'value', header: 'Value', type: 'money', sortField: 'value', secondary: true, width: 14 },
];

/** Promise-keeping: how long each dispatch took from the order. */
const DISPATCH_PERFORMANCE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'number', header: 'Dispatch', type: 'code', width: 12 },
  { key: 'orderNumber', header: 'Order', type: 'code', secondary: true, width: 12 },
  { key: 'customerName', header: 'Customer', type: 'text', sortField: 'customerName', width: 24 },
  { key: 'mode', header: 'Mode', type: 'status', width: 12 },
  { key: 'dispatchedOn', header: 'Dispatched', type: 'date', sortField: 'dispatchedOn', width: 12 },
  { key: 'leadDays', header: 'Days from order', type: 'number', sortField: 'leadDays', width: 12 },
  { key: 'quantity', header: 'Quantity', type: 'text', secondary: true, width: 10 },
];

/** Who is being short-supplied, and how often. */
const ORDER_FILL_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 26 },
  { key: 'orders', header: 'Orders', type: 'number', width: 8 },
  { key: 'orderedQty', header: 'Ordered', type: 'text', width: 12 },
  { key: 'dispatchedQty', header: 'Dispatched', type: 'text', width: 12 },
  { key: 'fillPct', header: 'Fill rate', type: 'text', sortField: 'fillPct', width: 10 },
  { key: 'shortClosed', header: 'Short-closed', type: 'number', secondary: true, width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/**
 * D-48 / P-33: one row per order line, and where that line has got to.
 *
 * `order-fill-rate` answers the same question one level up -- which customer
 * is being short-supplied -- and the screens carry the per-line state. What
 * neither of them does is leave the building: this is the grain somebody
 * takes into a meeting about one order.
 */
const ORDER_FULFILMENT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'number', header: 'Order', type: 'text', sortField: 'number', width: 12 },
  { key: 'date', header: 'Date', type: 'date', sortField: 'date', width: 12 },
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 24 },
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 26 },
  { key: 'orderedQty', header: 'Ordered', type: 'text', width: 10 },
  { key: 'pickedQty', header: 'Picked', type: 'text', width: 10 },
  { key: 'packedQty', header: 'Packed', type: 'text', width: 10 },
  { key: 'invoicedQty', header: 'Invoiced', type: 'text', width: 10 },
  { key: 'dispatchedQty', header: 'Dispatched', type: 'text', width: 10 },
  { key: 'balanceQty', header: 'Still to go', type: 'text', sortField: 'balanceQty', width: 10 },
  { key: 'state', header: 'Where it sits', type: 'text', sortField: 'state', width: 18 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** Is growth coming from new names or the same ones. */
const NEW_REPEAT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'newParties', header: 'First-time buyers', type: 'number', width: 12 },
  { key: 'newRevenue', header: 'New revenue', type: 'money', width: 14 },
  { key: 'repeatRevenue', header: 'Repeat revenue', type: 'money', width: 14 },
  { key: 'newSharePct', header: 'New share', type: 'text', secondary: true, width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

/** Reorder pressure: how long shortages wait for a PO. */
const REQUIREMENT_AGEING_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 26 },
  { key: 'openQty', header: 'Open qty', type: 'text', width: 12 },
  { key: 'source', header: 'Source', type: 'status', width: 10 },
  { key: 'orderNumber', header: 'For order', type: 'code', secondary: true, width: 12 },
  { key: 'ageDays', header: 'Waiting (days)', type: 'number', sortField: 'ageDays', width: 12 },
];

// ------------------------------------------ the second analytics set (22 Aug 2026)

const FLAG_REVIEW_LOG_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'reviewedAt', header: 'Reviewed', type: 'instant', sortField: 'reviewedAt', width: 20 },
  { key: 'adminName', header: 'By', type: 'text', sortField: 'adminName', width: 22 },
  { key: 'action', header: 'Action', type: 'text', width: 14 },
  { key: 'employeeName', header: 'Employee', type: 'text', sortField: 'employeeName', width: 24 },
  { key: 'attendanceDate', header: 'Day', type: 'date', width: 12 },
  { key: 'punchType', header: 'Punch', type: 'text', width: 8 },
  { key: 'note', header: 'Note', type: 'text', secondary: true, width: 40 },
];

const APPROVALS_TURNAROUND_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'type', header: 'Request type', type: 'text', sortField: 'type', width: 20 },
  { key: 'decided', header: 'Decided', type: 'number', sortField: 'decided', width: 10 },
  { key: 'medianHours', header: 'Median hours', type: 'number', sortField: 'medianHours', width: 12 },
  { key: 'p90Hours', header: 'p90 hours', type: 'number', width: 12 },
  { key: 'pending', header: 'Pending', type: 'number', width: 10 },
  { key: 'oldestPendingHours', header: 'Oldest pending (h)', type: 'number', sortField: 'oldestPendingHours', width: 14 },
];

const EARLY_LEADERBOARD_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'employeeName', header: 'Employee', type: 'text', sortField: 'employeeName', width: 24 },
  { key: 'department', header: 'Department', type: 'text', secondary: true, width: 18 },
  { key: 'currentStreak', header: 'Streak', type: 'number', sortField: 'currentStreak', width: 10 },
  { key: 'earlyDays', header: 'Early days', type: 'number', sortField: 'earlyDays', width: 10 },
  { key: 'avgEarlyMinutes', header: 'Avg minutes early', type: 'number', width: 14 },
];

const ON_TIME_RATE_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'department', header: 'Department', type: 'text', sortField: 'department', width: 24 },
  { key: 'workedDays', header: 'Worked days', type: 'number', sortField: 'workedDays', width: 12 },
  { key: 'lateDays', header: 'Late days', type: 'number', width: 10 },
  { key: 'onTimePct', header: 'On time', type: 'text', sortField: 'onTimePct', width: 10 },
];

const AOV_TREND_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'invoices', header: 'Invoices', type: 'number', width: 10 },
  { key: 'revenue', header: 'Revenue', type: 'money', width: 16 },
  { key: 'aov', header: 'Average order value', type: 'money', sortField: 'aov', width: 16 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

const PARTIAL_SHIPMENTS_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'ordersDispatched', header: 'Orders dispatched', type: 'number', width: 12 },
  { key: 'partialOrders', header: 'Partial', type: 'number', width: 10 },
  { key: 'partialPct', header: 'Partial share', type: 'text', sortField: 'partialPct', width: 12 },
];

const VENDOR_LEAD_TIME_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Vendor', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'ordersReceived', header: 'POs received', type: 'number', width: 12 },
  { key: 'medianDays', header: 'Median days', type: 'number', sortField: 'medianDays', width: 12 },
  { key: 'p90Days', header: 'p90 days', type: 'number', width: 10 },
  { key: 'promisedDays', header: 'Promised', type: 'number', width: 10 },
];

const STOCK_OUT_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'shortages', header: 'Shortages', type: 'number', sortField: 'shortages', width: 10 },
  { key: 'quantity', header: 'Quantity short', type: 'text', width: 14 },
];

const MARGIN_PROXY_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'item', header: 'Item', type: 'text', sortField: 'item', width: 28 },
  { key: 'quantity', header: 'Quantity', type: 'text', width: 12 },
  { key: 'revenue', header: 'Revenue', type: 'money', sortField: 'revenue', width: 16 },
  { key: 'cost', header: 'Cost (held)', type: 'money', width: 16 },
  { key: 'margin', header: 'Margin proxy', type: 'money', sortField: 'margin', width: 16 },
  { key: 'marginPct', header: 'Margin %', type: 'text', sortField: 'marginPct', width: 10 },
  { key: 'asOf', header: 'As of', type: 'instant', secondary: true, width: 20 },
];

const SALES_HEATMAP_COLUMNS: readonly ReportColumnSpec[] = [
  { key: 'partyName', header: 'Customer', type: 'text', sortField: 'partyName', width: 28 },
  { key: 'month', header: 'Month', type: 'text', sortField: 'month', width: 10 },
  { key: 'value', header: 'Value', type: 'money', sortField: 'value', width: 16 },
];

export const REPORT_DEFINITIONS: Record<ReportKey, ReportDefinition> = {
  'attendance-register': {
    key: 'attendance-register',
    category: 'Attendance',
    label: 'Attendance register',
    description: 'One row per employee per day: shift, in, out, hours, status and flags.',
    columns: ATTENDANCE_REGISTER_COLUMNS,
    defaultSort: '-date,employeeCode',
    filters: ['period', 'employeeId', 'departmentId', 'locationId', 'status', 'flags'],
  },
  'daily-muster': {
    key: 'daily-muster',
    category: 'Attendance',
    label: 'Daily muster',
    description: 'One row per employee for a single date: shift, in, out, hours, status and flags.',
    columns: DAILY_MUSTER_COLUMNS,
    defaultSort: 'employeeCode',
    filters: ['period', 'employeeId', 'departmentId', 'locationId', 'status', 'flags'],
    singleDate: true,
  },
  'monthly-muster': {
    key: 'monthly-muster',
    category: 'Attendance',
    label: 'Monthly muster grid',
    description: 'Employees against the days of one month, with a totals block.',
    columns: MUSTER_GRID_COLUMNS,
    defaultSort: 'employeeCode',
    filters: PEOPLE_FILTERS,
    singleMonth: true,
  },
  'late-arrivals': {
    key: 'late-arrivals',
    category: 'Attendance',
    label: 'Late arrivals',
    description: 'Days recorded late, with the minutes, gathered per employee.',
    columns: exceptionColumns({
      occurrences: 'Late days',
      total: 'Total late',
      average: 'Average late',
      worst: 'Worst late',
    }),
    defaultSort: '-totalMinutes',
    filters: PEOPLE_FILTERS,
  },
  'early-exits': {
    key: 'early-exits',
    category: 'Attendance',
    label: 'Early exits',
    description: 'Days that ended early, with the minutes, gathered per employee.',
    columns: exceptionColumns({
      occurrences: 'Early exits',
      total: 'Total early',
      average: 'Average early',
      worst: 'Worst early',
    }),
    defaultSort: '-totalMinutes',
    filters: PEOPLE_FILTERS,
  },
  absenteeism: {
    key: 'absenteeism',
    category: 'Attendance',
    label: 'Absenteeism',
    description: 'Absent days and the share of scheduled days they are, by employee and month.',
    columns: ABSENTEEISM_COLUMNS,
    defaultSort: '-absencePercent',
    filters: PEOPLE_FILTERS,
  },
  'missing-punch': {
    key: 'missing-punch',
    category: 'Attendance',
    label: 'Missing punch',
    description: 'Days flagged for a missing punch, and where their correction stands.',
    columns: MISSING_PUNCH_COLUMNS,
    defaultSort: '-date,employeeCode',
    filters: PEOPLE_FILTERS,
  },
  overtime: {
    key: 'overtime',
    category: 'Attendance',
    label: 'Overtime',
    description: 'Overtime minutes by employee for the period. Minutes only, never money.',
    columns: exceptionColumns({
      occurrences: 'OT days',
      total: 'Total overtime',
      average: 'Average per day',
      worst: 'Longest day',
    }),
    defaultSort: '-totalMinutes',
    filters: PEOPLE_FILTERS,
  },
  'leave-balance': {
    key: 'leave-balance',
    category: 'Leave',
    label: 'Leave balance',
    description: 'Balances by employee and leave type for the leave year the period falls in.',
    columns: LEAVE_BALANCE_COLUMNS,
    defaultSort: 'employeeCode,leaveTypeCode',
    filters: PEOPLE_FILTERS,
  },
  'leave-ledger': {
    key: 'leave-ledger',
    category: 'Leave',
    label: 'Leave ledger',
    description: 'Every leave movement posted in the period. Filter to one employee for a history.',
    columns: LEAVE_LEDGER_COLUMNS,
    defaultSort: '-postedAt',
    filters: PEOPLE_FILTERS,
  },
  'leave-availed': {
    key: 'leave-availed',
    category: 'Leave',
    label: 'Leave availed',
    description: 'Approved leave days falling inside the period, by employee and type.',
    columns: LEAVE_AVAILED_COLUMNS,
    defaultSort: '-days',
    filters: PEOPLE_FILTERS,
  },
  'punch-audit': {
    key: 'punch-audit',
    category: 'Attendance',
    label: 'Punch audit',
    description: 'The raw punch log with photo, location, device and flags.',
    columns: PUNCH_AUDIT_COLUMNS,
    defaultSort: '-serverTime',
    filters: ['period', 'employeeId', 'departmentId', 'locationId', 'punchType'],
  },
  headcount: {
    key: 'headcount',
    category: 'Attendance',
    label: 'Headcount',
    description: 'Opening headcount, joiners, leavers and closing headcount by month.',
    columns: HEADCOUNT_COLUMNS,
    defaultSort: 'month',
    filters: ['departmentId', 'locationId', 'period'],
  },
  'voucher-reconciliation': {
    key: 'voucher-reconciliation',
    category: 'Books',
    label: 'Voucher reconciliation',
    description:
      'Voucher count and total value per voucher type per month, from the Tally projection — compare against Tally’s own Day Book totals before signing off a backfill.',
    columns: VOUCHER_RECONCILIATION_COLUMNS,
    defaultSort: 'month',
    filters: ['period'],
  },
  'customer-statement': {
    key: 'customer-statement',
    category: 'Receivables',
    label: 'Customer statement',
    description:
      'Every voucher for one party in the period with a running balance, opening from what came before. Choose a party to begin.',
    columns: CUSTOMER_STATEMENT_COLUMNS,
    defaultSort: 'date',
    filters: ['partyId', 'period'],
    requiredFilters: ['partyId'],
  },
  'credit-cycle': {
    key: 'credit-cycle',
    category: 'Receivables',
    label: 'Credit cycle',
    description:
      'Credit limit and credit days per party against current exposure. Overdue by bill waits for bill-wise allocations.',
    columns: CREDIT_CYCLE_COLUMNS,
    defaultSort: '-exposure',
    filters: ['partyId'],
  },
  ageing: {
    key: 'ageing',
    category: 'Receivables',
    label: 'Ageing',
    description:
      'Every open bill, its age and its bucket. Buckets are 0-30, 31-60, 61-90 and over 90 days from the bill date.',
    columns: AGEING_COLUMNS,
    defaultSort: '-ageDays',
    filters: ['partyId'],
  },
  'payment-analysis': {
    key: 'payment-analysis',
    category: 'Receivables',
    label: 'Payment analysis',
    description:
      'Average days to pay against agreed credit days, per party, from settlements that name the bill they settle.',
    columns: PAYMENT_ANALYSIS_COLUMNS,
    defaultSort: '-slippage',
    filters: ['partyId'],
  },
  'sales-analysis': {
    key: 'sales-analysis',
    category: 'Customers',
    label: 'Sales analysis',
    description: 'Sales value by party, item, item group or month, from invoiced inventory lines.',
    columns: SALES_ANALYSIS_COLUMNS,
    defaultSort: '-value',
    filters: ['groupBy', 'period', 'partyId'],
  },
  'pending-dispatch': {
    key: 'pending-dispatch',
    category: 'Fulfilment',
    label: 'Pending dispatch',
    description: 'Every open sales order line with a balance still to dispatch — by party, by age, by item.',
    columns: PENDING_DISPATCH_COLUMNS,
    defaultSort: '-ageDays',
    filters: ['partyId'],
  },
  'low-stock': {
    key: 'low-stock',
    category: 'Inventory',
    label: 'Low stock',
    description: 'Items at or below their reorder level: Tally closing, committed to open orders, available, on order, and the shortfall.',
    columns: LOW_STOCK_COLUMNS,
    defaultSort: '-shortfall',
    filters: [],
  },
  'day-book': {
    key: 'day-book',
    category: 'Books',
    label: 'Day book',
    description: 'Every voucher for the period, from the Tally projection — filter by type or party; Vyuha computes nothing.',
    columns: DAY_BOOK_COLUMNS,
    defaultSort: '-date',
    filters: ['period', 'voucherType', 'partyId'],
  },
  'customer-lapse': {
    key: 'customer-lapse',
    category: 'Customers',
    label: 'Customer lapse',
    description: 'Customers who bought regularly and then stopped — measured against each customer’s own usual gap, ranked by the revenue at risk.',
    columns: CUSTOMER_LAPSE_COLUMNS,
    defaultSort: '-revenue12m',
    filters: [],
  },
  'ledger-extract': {
    key: 'ledger-extract',
    category: 'Books',
    label: 'Ledger extract',
    description: 'Every line for one ledger with a running balance, opening from what came before. Type the ledger as Tally names it.',
    columns: LEDGER_EXTRACT_COLUMNS,
    defaultSort: 'date',
    filters: ['ledgerName', 'period'],
    requiredFilters: ['ledgerName'],
  },
  'stock-summary': {
    key: 'stock-summary',
    category: 'Inventory',
    label: 'Stock summary',
    description: 'Closing, committed and available per item, valued at the held cost.',
    columns: STOCK_SUMMARY_COLUMNS,
    defaultSort: '-value',
    filters: ['itemName'],
  },
  'negative-stock': {
    key: 'negative-stock',
    category: 'Inventory',
    label: 'Negative stock',
    description: 'Items showing a negative closing in Tally — something was billed that was never received. The ideal state is empty.',
    columns: NEGATIVE_STOCK_COLUMNS,
    defaultSort: 'closingQty',
    filters: [],
  },
  'stale-projections': {
    key: 'stale-projections',
    category: 'Exceptions',
    label: 'Stale projections',
    description: 'Companies whose last successful pull is older than a day — the figures under every other report.',
    columns: STALE_PROJECTIONS_COLUMNS,
    defaultSort: '-hoursStale',
    filters: [],
  },
  'promised-vs-collected': {
    key: 'promised-vs-collected',
    category: 'Receivables',
    label: 'Promised against collected',
    description: 'Every promise to pay in the period beside what actually arrived against the named bills. A promise is never marked kept by hand: the receipts Tally sends decide it.',
    columns: PROMISED_VS_COLLECTED_COLUMNS,
    defaultSort: '-promised',
    filters: ['period', 'partyId', 'employeeId'],
  },
  'broken-promises': {
    key: 'broken-promises',
    category: 'Exceptions',
    label: 'Broken promises',
    description: 'Promises past their date with nothing, or not enough, received against the bills they named. Ranked by what is short. A broken promise flags the credit check; it never blocks an order.',
    columns: BROKEN_PROMISES_COLUMNS,
    defaultSort: '-shortfall',
    filters: ['period', 'partyId', 'employeeId'],
  },
  'item-revenue-concentration': {
    key: 'item-revenue-concentration',
    category: 'Inventory',
    label: 'Item revenue concentration (Pareto)',
    description: 'Which items earn the money. The tail is the catalogue you are carrying stock for and being paid little to hold; the head is what must never be out of stock.',
    columns: PARETO_COLUMNS,
    defaultSort: 'rank',
    filters: ['period', 'itemName'],
  },
  'item-quantity-concentration': {
    key: 'item-quantity-concentration',
    category: 'Inventory',
    label: 'Item volume concentration (Pareto)',
    description: 'Which items move, by quantity rather than value — the pickers\' list, not the accountant\'s. An item high here and low on the revenue Pareto is cheap and busy: it belongs near the packing bench.',
    columns: PARETO_COLUMNS,
    defaultSort: 'rank',
    filters: ['period', 'itemName'],
  },
  'vendor-spend-concentration': {
    key: 'vendor-spend-concentration',
    category: 'Vendors',
    label: 'Vendor spend concentration (Pareto)',
    description: 'Where the purchase money goes. Read as exposure rather than as performance: a vendor holding half the spend is half the supply chain, and the running column says how few of them that is.',
    columns: PARETO_COLUMNS,
    defaultSort: 'rank',
    filters: ['period'],
  },
  'receivables-concentration': {
    key: 'receivables-concentration',
    category: 'Receivables',
    label: 'Receivables concentration (Pareto)',
    description: 'Who is holding the money. The head of this list is where a day of collection effort is worth most; it is deliberately not the same list as revenue concentration, and the difference between the two is worth a look.',
    columns: PARETO_COLUMNS,
    defaultSort: 'rank',
    filters: [],
  },
  'return-rate-by-item': {
    key: 'return-rate-by-item',
    category: 'Inventory',
    label: 'Return rate by item',
    description: 'What came back against what went out, item by item, with the commonest reason beside it. The sold figure is what Tally billed in the period, so an item sold outside Vyuha still counts.',
    columns: RETURN_RATE_ITEM_COLUMNS,
    defaultSort: '-returnedQty',
    filters: ['period', 'itemName'],
  },
  'return-rate-by-customer': {
    key: 'return-rate-by-customer',
    category: 'Customers',
    label: 'Return rate by customer',
    description: 'Which customers send goods back, how much, and how much of it is still waiting on a credit note from Tally.',
    columns: RETURN_RATE_CUSTOMER_COLUMNS,
    defaultSort: '-returnedQty',
    filters: ['period', 'partyId'],
  },
  'returns-by-reason': {
    key: 'returns-by-reason',
    category: 'Exceptions',
    label: 'Returns by reason',
    description: 'Why goods come back, ranked. Damage in transit is a packing or carrier problem; wrong item is a picking one; quality rejection is neither.',
    columns: RETURNS_BY_REASON_COLUMNS,
    defaultSort: '-lines',
    filters: ['period', 'partyId', 'itemName'],
  },
  'duplicate-clusters': {
    key: 'duplicate-clusters',
    category: 'Exceptions',
    label: 'Duplicate clusters',
    description: 'Likely duplicate parties and items the detector found after the last pull, by confidence band, with the receivables sitting behind the party clusters. Vyuha flags; the merge happens in Tally.',
    columns: DUPLICATE_CLUSTERS_COLUMNS,
    defaultSort: 'outstanding',
    filters: [],
  },
  'duplicate-masters': {
    key: 'duplicate-masters',
    category: 'Exceptions',
    label: 'Duplicate masters',
    description: 'Party and item names that collapse to the same thing once case, spaces and punctuation are ignored. Vyuha flags; the merge happens in Tally.',
    columns: DUPLICATE_MASTERS_COLUMNS,
    defaultSort: 'nameA',
    filters: [],
  },
  'customer-item-matrix': {
    key: 'customer-item-matrix',
    category: 'Customers',
    label: 'Customer × product',
    description: 'What each customer buys — quantity, value, last sale — one row per customer and item; sort by item to read it the other way.',
    columns: CUSTOMER_ITEM_COLUMNS,
    defaultSort: '-value',
    filters: ['period', 'partyId', 'itemName'],
  },
  'purchase-rhythm': {
    key: 'purchase-rhythm',
    category: 'Customers',
    label: 'Purchase rhythm',
    description: 'Orders per month, the usual gap, the last gap and days since — who to call, before the lapse report has to say so.',
    columns: PURCHASE_RHYTHM_COLUMNS,
    defaultSort: '-daysSince',
    filters: [],
  },
  'price-variance': {
    key: 'price-variance',
    category: 'Customers',
    label: 'Customer price variance',
    description: 'The same item sold at different rates, ranked by the spread — answers "why is this customer paying more" before the customer asks.',
    columns: PRICE_VARIANCE_COLUMNS,
    defaultSort: '-spreadPct',
    filters: ['period', 'itemName'],
  },
  'item-velocity': {
    key: 'item-velocity',
    category: 'Inventory',
    label: 'Item velocity',
    description: 'Units per month over twelve months against the last three, and the stock cover in days that makes the figure actionable.',
    columns: ITEM_VELOCITY_COLUMNS,
    defaultSort: '-monthly12',
    filters: ['itemName'],
  },
  'dead-stock': {
    key: 'dead-stock',
    category: 'Inventory',
    label: 'Dead and slow stock',
    description: 'No sale in ninety days, ranked by the money locked up rather than the quantity.',
    columns: DEAD_STOCK_COLUMNS,
    defaultSort: '-valueLocked',
    filters: ['itemName'],
  },
  'movement-analysis': {
    key: 'movement-analysis',
    category: 'Inventory',
    label: 'Movement analysis',
    description: 'Inward and outward per item per month, from purchase and sales lines.',
    columns: MOVEMENT_COLUMNS,
    defaultSort: '-month',
    filters: ['period', 'itemName'],
  },
  'vendor-item-history': {
    key: 'vendor-item-history',
    category: 'Vendors',
    label: 'Vendor × item history',
    description: 'What was bought from whom — quantity, last and average rate, and which way the rate is moving.',
    columns: VENDOR_ITEM_COLUMNS,
    defaultSort: '-lastDate',
    filters: ['period', 'partyId', 'itemName'],
  },
  'vendor-price-comparison': {
    key: 'vendor-price-comparison',
    category: 'Vendors',
    label: 'Vendor price comparison',
    description: 'The same item across vendors, best and highest last rate with the spread — read it before raising the PO.',
    columns: VENDOR_PRICE_COLUMNS,
    defaultSort: '-spreadPct',
    filters: ['itemName'],
  },
  'credit-breaches': {
    key: 'credit-breaches',
    category: 'Receivables',
    label: 'Credit breaches',
    description: 'Parties over their credit limit now, with how often the block was released in the last ninety days.',
    columns: CREDIT_BREACHES_COLUMNS,
    defaultSort: '-overBy',
    filters: [],
  },
  'customer-concentration': {
    key: 'customer-concentration',
    category: 'Customers',
    label: 'Customer concentration',
    description: 'How much of the period’s revenue the biggest customers carry — share and cumulative share, ranked.',
    columns: CONCENTRATION_COLUMNS,
    defaultSort: '-revenue',
    filters: ['period'],
  },
  'order-pipeline': {
    key: 'order-pipeline',
    category: 'Fulfilment',
    label: 'Order pipeline',
    description: 'Every open sales order by stage — to pack, awaiting invoice, to dispatch — and how long it has sat there.',
    columns: ORDER_PIPELINE_COLUMNS,
    defaultSort: '-ageDays',
    filters: ['partyId'],
  },
  'dispatch-performance': {
    key: 'dispatch-performance',
    category: 'Fulfilment',
    label: 'Dispatch performance',
    description: 'Days from order to each dispatch, local against outstation — the slowest first.',
    columns: DISPATCH_PERFORMANCE_COLUMNS,
    defaultSort: '-leadDays',
    filters: ['period', 'partyId'],
  },
  'order-fill-rate': {
    key: 'order-fill-rate',
    category: 'Customers',
    label: 'Order fill rate',
    description: 'Ordered against dispatched per customer — who is being short-supplied, worst first.',
    columns: ORDER_FILL_COLUMNS,
    defaultSort: 'fillPct',
    filters: ['period'],
  },
  'order-fulfilment': {
    key: 'order-fulfilment',
    category: 'Customers',
    label: 'Order fulfilment by line',
    description: 'Every confirmed order line and where it has got to — ordered, picked, packed, invoiced, dispatched, and what is still to go.',
    columns: ORDER_FULFILMENT_COLUMNS,
    defaultSort: '-date',
    filters: ['period', 'partyId'],
  },
  'new-vs-repeat': {
    key: 'new-vs-repeat',
    category: 'Customers',
    label: 'New vs repeat revenue',
    description: 'Each month’s invoicing split between first-time buyers and returning ones.',
    columns: NEW_REPEAT_COLUMNS,
    defaultSort: '-month',
    filters: ['period'],
  },
  'requirement-ageing': {
    key: 'requirement-ageing',
    category: 'Vendors',
    label: 'Requirement ageing',
    description: 'Open shortages and reorders, and how long each has waited for a purchase order.',
    columns: REQUIREMENT_AGEING_COLUMNS,
    defaultSort: '-ageDays',
    filters: [],
  },
  'flag-review-log': {
    key: 'flag-review-log',
    category: 'Approvals',
    label: 'Flag review log',
    description: 'Every action an admin took on a flagged punch — accepted, kept, half day, note — with who, whom and why. Decides whether reviews are even-handed.',
    columns: FLAG_REVIEW_LOG_COLUMNS,
    defaultSort: '-reviewedAt',
    filters: ['period', 'employeeId'],
  },
  'approvals-turnaround': {
    key: 'approvals-turnaround',
    category: 'Approvals',
    label: 'Approvals turnaround',
    description: 'Per request type: how many were decided in the period, the median and p90 hours to a decision, and the oldest still pending. Decides who is sitting on requests.',
    columns: APPROVALS_TURNAROUND_COLUMNS,
    defaultSort: '-oldestPendingHours',
    filters: ['period'],
  },
  'early-arrival-leaderboard': {
    key: 'early-arrival-leaderboard',
    category: 'Attendance',
    label: 'Early-arrival leaderboard',
    description: 'Who keeps beating the shift: the current streak, early days in the period and how early on average. Decides who to recognise.',
    columns: EARLY_LEADERBOARD_COLUMNS,
    defaultSort: '-currentStreak',
    filters: ['period', 'departmentId'],
  },
  'on-time-rate': {
    key: 'on-time-rate',
    category: 'Attendance',
    label: 'On-time rate by department',
    description: 'Worked days that were not late, as a share, per department. Decides where lateness clusters.',
    columns: ON_TIME_RATE_COLUMNS,
    defaultSort: 'onTimePct',
    filters: ['period'],
  },
  'aov-trend': {
    key: 'aov-trend',
    category: 'Customers',
    label: 'Average order value',
    description: 'Revenue per sales invoice, month by month, from the projection. Decides whether pricing or basket size is drifting; compare against last FY.',
    columns: AOV_TREND_COLUMNS,
    defaultSort: 'month',
    filters: ['period'],
  },
  'partial-shipments': {
    key: 'partial-shipments',
    category: 'Fulfilment',
    label: 'Partial shipments by customer',
    description: 'Confirmed orders that needed two or more dispatches, or a short-close, as a share of the orders dispatched at all. Decides whose orders keep going out in pieces.',
    columns: PARTIAL_SHIPMENTS_COLUMNS,
    defaultSort: '-partialPct',
    filters: ['period', 'partyId'],
  },
  'vendor-lead-time': {
    key: 'vendor-lead-time',
    category: 'Vendors',
    label: 'Vendor lead time',
    description: 'Days from the purchase order’s date to its first receipt, median and p90 per vendor, beside the lead time the vendor promised. Decides which promises to stop believing.',
    columns: VENDOR_LEAD_TIME_COLUMNS,
    defaultSort: '-medianDays',
    filters: ['period', 'partyId'],
  },
  'stock-out-frequency': {
    key: 'stock-out-frequency',
    category: 'Inventory',
    label: 'Stock-out frequency',
    description: 'Requirements raised from a shortage, per item per month. Decides which items keep running dry.',
    columns: STOCK_OUT_COLUMNS,
    defaultSort: '-shortages',
    filters: ['period', 'itemName'],
  },
  'margin-proxy': {
    key: 'margin-proxy',
    category: 'Customers',
    label: 'Gross margin proxy',
    description: 'Per item: revenue against the cost held in the projection, and the margin that leaves. A proxy — the held cost is a weighted average, not the lot’s own. Decides what to stop discounting.',
    columns: MARGIN_PROXY_COLUMNS,
    defaultSort: '-margin',
    filters: ['period', 'itemName'],
  },
  'sales-heatmap': {
    key: 'sales-heatmap',
    category: 'Customers',
    label: 'Sales heatmap',
    description: 'Every customer against every month of the period, shaded by value. Decides who went quiet when, at a glance.',
    columns: SALES_HEATMAP_COLUMNS,
    defaultSort: 'partyName',
    filters: ['period'],
  },
  'stock-ageing': {
    key: 'stock-ageing',
    category: 'Inventory',
    label: 'Stock ageing',
    description: 'Closing stock bucketed by how long it has been held, FIFO-assumed from purchase inwards, valued at cost.',
    columns: STOCK_AGEING_COLUMNS,
    defaultSort: '-valueLocked',
    filters: ['itemName'],
  },
};

/**
 * The attendance module's reports. Named as a group so another module's
 * definitions can join `ALL_REPORTS` without the attendance source claiming
 * their keys: each module's source claims its own group, and the registry's
 * duplicate refusal stays a safety net instead of becoming a planned boot
 * failure. The Tally group is the first such joiner.
 */
export const ATTENDANCE_REPORTS: readonly ReportDefinition[] = REPORT_KEYS.filter(
  (key) =>
    !(TALLY_REPORT_KEYS as readonly string[]).includes(key) &&
    !(SALES_REPORT_KEYS as readonly string[]).includes(key) &&
    !(COLLECTIONS_REPORT_KEYS as readonly string[]).includes(key) &&
    !(RETURNS_REPORT_KEYS as readonly string[]).includes(key) &&
    !(ANALYTICS_REPORT_KEYS as readonly string[]).includes(key) &&
    !(ATTENDANCE_ANALYTICS_REPORT_KEYS as readonly string[]).includes(key),
).map((key) => REPORT_DEFINITIONS[key]);

export const ATTENDANCE_ANALYTICS_REPORTS: readonly ReportDefinition[] = ATTENDANCE_ANALYTICS_REPORT_KEYS.map(
  (key) => REPORT_DEFINITIONS[key],
);

export const SALES_REPORTS: readonly ReportDefinition[] = SALES_REPORT_KEYS.map((key) => REPORT_DEFINITIONS[key]);

export const COLLECTIONS_REPORTS: readonly ReportDefinition[] = COLLECTIONS_REPORT_KEYS.map((key) => REPORT_DEFINITIONS[key]);

export const RETURNS_REPORTS: readonly ReportDefinition[] = RETURNS_REPORT_KEYS.map((key) => REPORT_DEFINITIONS[key]);

/** The Tally module's reports (Phase 6c onward). */
export const TALLY_REPORTS: readonly ReportDefinition[] = TALLY_REPORT_KEYS.map(
  (key) => REPORT_DEFINITIONS[key],
);

export const ANALYTICS_REPORTS: readonly ReportDefinition[] = ANALYTICS_REPORT_KEYS.map(
  (key) => REPORT_DEFINITIONS[key],
);

/** Every module's reports. Grows by concatenation as modules add groups. */
export const ALL_REPORTS: readonly ReportDefinition[] = [...ATTENDANCE_REPORTS, ...ATTENDANCE_ANALYTICS_REPORTS, ...TALLY_REPORTS, ...SALES_REPORTS, ...COLLECTIONS_REPORTS, ...RETURNS_REPORTS, ...ANALYTICS_REPORTS];

/** The columns a report shows before anyone touches the F12 chooser. */
export function defaultVisibleColumns(reportKey: ReportKey): string[] {
  return REPORT_DEFINITIONS[reportKey].columns
    .filter((column) => column.defaultHidden !== true)
    .map((column) => column.key);
}

/**
 * The chosen columns, in the report's own order, with anything unknown
 * dropped.
 *
 * Ordering by the definition rather than by the request is deliberate: a saved
 * view written against an older column set must not be able to reorder a sheet
 * that payroll or an auditor reads positionally, and an unknown key is a stale
 * bookmark rather than a reason to refuse.
 *
 * An empty or absent selection means the default set. A request that resolves
 * to nothing at all would produce a file with a header row and no columns.
 */
export function resolveColumns(
  reportKey: ReportKey,
  chosen: readonly string[] | undefined,
): ReportColumnSpec[] {
  const all = REPORT_DEFINITIONS[reportKey].columns;
  if (chosen === undefined || chosen.length === 0) {
    return all.filter((column) => column.defaultHidden !== true);
  }
  const wanted = new Set(chosen);
  const resolved = all.filter((column) => wanted.has(column.key));
  return resolved.length === 0 ? all.filter((column) => column.defaultHidden !== true) : resolved;
}

/** Sort fields the server will honour for a report; anything else is dropped. */
export function sortableFields(reportKey: ReportKey): string[] {
  const fields: string[] = [];
  for (const column of REPORT_DEFINITIONS[reportKey].columns) {
    if (column.sortField !== undefined) fields.push(column.sortField);
  }
  return fields;
}

// ------------------------------------------------------------------- filters

/**
 * The REQ-J-01 filter bar, as a query. Every field is optional here because
 * this is also the shape a saved view stores; the export request narrows it.
 */
export const reportFilterSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  employeeId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  /** Comma-separated `ATTENDANCE_FLAGS`; a row matching any of them is kept. */
  flags: z.string().max(200).optional(),
  punchType: z.enum(PUNCH_TYPES).optional(),
  partyId: z.uuid().optional(),
  groupBy: z.enum(SALES_ANALYSIS_DIMENSIONS).optional(),
  voucherType: z.string().trim().min(1).max(60).optional(),
  ledgerName: z.string().trim().min(1).max(120).optional(),
  itemName: z.string().trim().min(1).max(120).optional(),
});

export type ReportFilters = z.infer<typeof reportFilterSchema>;

/**
 * NFR-03 sizes the export job at "a full month for 500 employees". A year is
 * the outer bound this refuses past -- not because the query cannot do it, but
 * because an unbounded range is almost always a filter someone forgot to set,
 * and the honest answer is to say so rather than to spend ten minutes on it.
 */
export const MAX_EXPORT_RANGE_DAYS = 366;

/** Beyond this the job fails with an ask to narrow, before it writes anything. */
export const MAX_EXPORT_ROWS = 100_000;

/** REQ-J-03: "a 7-day retention", honoured through `files.expires_at`. */
export const EXPORT_RETENTION_DAYS = 7;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive day count, or null when either end is not a calendar date. */
export function rangeLengthInDays(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.floor((end - start) / MILLISECONDS_PER_DAY) + 1;
}

/**
 * An export always names its period. A screen may browse unbounded, but a file
 * that lands in somebody's downloads has to say what it covers, and the header
 * block in REQ-J-03 has nothing to print otherwise.
 */
export const exportFilterSchema = reportFilterSchema
  .extend({ from: z.iso.date(), to: z.iso.date() })
  .superRefine((value, ctx) => {
    const days = rangeLengthInDays(value.from, value.to);
    if (days === null || days < 1) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the start date' });
      return;
    }
    if (days > MAX_EXPORT_RANGE_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `a period may cover at most ${String(MAX_EXPORT_RANGE_DAYS)} days`,
      });
    }
  });

export type ExportFilters = z.infer<typeof exportFilterSchema>;

/** The row query behind the shell: filters, paging and sort in one object. */
export const reportRowQuerySchema = pageQuerySchema.extend({
  ...reportFilterSchema.shape,
  sort: z.string().max(200).optional(),
});

export type ReportRowQuery = z.infer<typeof reportRowQuerySchema>;

/**
 * The filter block printed at the top of an exported file (REQ-J-03) and
 * beside the toolbar on screen. Labels are resolved by the caller because only
 * it knows an employee's name for an id.
 */
export interface FilterCaption {
  readonly label: string;
  readonly value: string;
}

export function describeFilters(
  filters: ReportFilters,
  names: Readonly<Record<string, string>> = {},
  /**
   * How a calendar date is written (REQ-L-01).
   *
   * Passed in rather than assumed, because the format is an organisation
   * setting and this module has no way to read one. Identity by default, which
   * is what a caller with no opinion gets -- but every caller that puts these
   * captions in front of a person has an opinion, and a header block reading
   * "Period 2026-08-01 to 2026-08-31" directly above "Generated 15-08-2026" is
   * two date formats in four lines of the same file.
   */
  formatDate: (iso: string) => string = (iso) => iso,
): FilterCaption[] {
  const captions: FilterCaption[] = [];
  const named = (id: string): string => names[id] ?? id;

  if (filters.from !== undefined && filters.from === filters.to) {
    // The daily muster's period is one day. "02-03-2026 to 02-03-2026" is true
    // and reads as a mistake, at the top of a file somebody prints.
    captions.push({ label: 'Date', value: formatDate(filters.from) });
  } else if (filters.from !== undefined || filters.to !== undefined) {
    captions.push({
      label: 'Period',
      value: `${filters.from === undefined ? 'any' : formatDate(filters.from)} to ${
        filters.to === undefined ? 'any' : formatDate(filters.to)
      }`,
    });
  }
  if (filters.employeeId !== undefined) {
    captions.push({ label: 'Employee', value: named(filters.employeeId) });
  }
  if (filters.departmentId !== undefined) {
    captions.push({ label: 'Department', value: named(filters.departmentId) });
  }
  if (filters.locationId !== undefined) {
    captions.push({ label: 'Location', value: named(filters.locationId) });
  }
  // The Tally-side filters. A customer statement cannot be requested without
  // a party and a ledger extract cannot be requested without a ledger, so a
  // file of either used to print "Filters: none" and then several hundred
  // rows that named nobody -- a statement with no name on it is not evidence
  // of anything.
  if (filters.partyId !== undefined) {
    captions.push({ label: 'Party', value: named(filters.partyId) });
  }
  if (filters.ledgerName !== undefined) {
    captions.push({ label: 'Ledger', value: filters.ledgerName });
  }
  if (filters.itemName !== undefined) {
    captions.push({ label: 'Item', value: filters.itemName });
  }
  if (filters.voucherType !== undefined) {
    captions.push({ label: 'Voucher type', value: filters.voucherType });
  }
  if (filters.groupBy !== undefined) {
    captions.push({ label: 'Grouped by', value: SALES_ANALYSIS_DIMENSION_LABELS[filters.groupBy] });
  }
  if (filters.status !== undefined) captions.push({ label: 'Status', value: filters.status });
  if (filters.flags !== undefined && filters.flags.length > 0) {
    captions.push({ label: 'Flags', value: filters.flags });
  }
  if (filters.punchType !== undefined) {
    captions.push({ label: 'Direction', value: filters.punchType });
  }

  // Never an empty block: "everything" is a fact about the file worth stating.
  if (captions.length === 0) captions.push({ label: 'Filters', value: 'none' });
  return captions;
}

// -------------------------------------------------------------------- export

/**
 * XLSX is the requirement (REQ-J-03) and is not yet buildable: no spreadsheet
 * library is a dependency of the API, and CLAUDE.md §6 forbids adding one
 * without asking. CSV is written through the same writer interface, so the
 * second entry here becomes real by adding a writer and a dependency -- not by
 * reworking the job, the tray, or this contract.
 */
export const EXPORT_FORMATS = ['CSV', 'XLSX'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * What the API will actually produce today.
 *
 * Both formats now have a writer. This list stays separate from
 * `EXPORT_FORMATS` because it is the one the request schema validates against:
 * a format may be named in the contract long before anything can write it, and
 * accepting a request for one that cannot be written produces a job that fails
 * after the user has walked away.
 */
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


// ------------------------------------------------------- cross-period joins

/**
 * How a row is matched to its twin in a comparison period, per report.
 * Mirrors the id extractors in the web's row shapes
 * (`features/reports/types.ts`) — the screen's delta columns and an exported
 * file's must join the same rows or the two will disagree. `join` composes
 * the fields; `first` takes the first present one. Reports not listed join
 * on their `id` field, which for voucher-grain reports means a different
 * period never matches — correctly, since those rows have no twin.
 */
const ROW_JOIN_KEYS: Partial<Record<ReportKey, { fields: readonly string[]; mode: 'join' | 'first' }>> = {
  'voucher-reconciliation': { fields: ['month', 'voucherType'], mode: 'join' },
  'credit-cycle': { fields: ['partyId'], mode: 'first' },
  'sales-analysis': { fields: ['key', 'label'], mode: 'first' },
  'day-book': { fields: ['voucherId'], mode: 'first' },
  'customer-lapse': { fields: ['partyId'], mode: 'first' },
  'low-stock': { fields: ['stockItemId'], mode: 'first' },
  'stock-summary': { fields: ['stockItemId'], mode: 'first' },
  'negative-stock': { fields: ['stockItemId'], mode: 'first' },
  'stale-projections': { fields: ['connectionId'], mode: 'first' },
  'purchase-rhythm': { fields: ['partyId'], mode: 'first' },
  'item-velocity': { fields: ['stockItemId'], mode: 'first' },
  'dead-stock': { fields: ['stockItemId'], mode: 'first' },
  'credit-breaches': { fields: ['partyId'], mode: 'first' },
  'stock-ageing': { fields: ['stockItemId'], mode: 'first' },
  'customer-concentration': { fields: ['partyId'], mode: 'first' },
  'order-fill-rate': { fields: ['partyId'], mode: 'first' },
  'new-vs-repeat': { fields: ['month'], mode: 'first' },
  'approvals-turnaround': { fields: ['type'], mode: 'first' },
  'early-arrival-leaderboard': { fields: ['employeeId'], mode: 'first' },
  'on-time-rate': { fields: ['departmentId'], mode: 'first' },
  'aov-trend': { fields: ['month'], mode: 'first' },
  'partial-shipments': { fields: ['partyId'], mode: 'first' },
  'vendor-lead-time': { fields: ['partyId'], mode: 'first' },
  'stock-out-frequency': { fields: ['stockItemId', 'month'], mode: 'join' },
  'margin-proxy': { fields: ['stockItemId'], mode: 'first' },
  'sales-heatmap': { fields: ['partyId', 'month'], mode: 'join' },
};

function joinKeyPart(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

export function reportRowJoinKey(reportKey: ReportKey, row: Record<string, unknown>): string | null {
  const spec = ROW_JOIN_KEYS[reportKey] ?? { fields: ['id'], mode: 'first' as const };
  if (spec.mode === 'join') {
    const parts = spec.fields.map((field) => joinKeyPart(row[field]));
    return parts.every((part): part is string => part !== null) ? parts.join(':') : null;
  }
  for (const field of spec.fields) {
    const part = joinKeyPart(row[field]);
    if (part !== null) return part;
  }
  return null;
}

/**
 * Comparison state flowing into a file (data-analyst skill §3). The client
 * sends the comparison range it is already showing — computed with the same
 * FY-aware arithmetic as the screen — plus the column the deltas ride on and
 * the header label, so the file and the screen cannot disagree about either.
 */
export const exportCompareSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  columnKey: z.string().max(64),
  label: z.string().max(40),
});
export type ExportCompare = z.infer<typeof exportCompareSchema>;

export const exportRequestSchema = z.object({
  reportKey: z.enum(REPORT_KEYS),
  filters: exportFilterSchema,
  /** Column keys to include. Unknown ones are dropped, not refused. */
  columns: z.array(z.string().max(64)).max(64).optional(),
  sort: z.string().max(200).optional(),
  format: z.enum(AVAILABLE_EXPORT_FORMATS).default('CSV'),
  compare: exportCompareSchema.optional(),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

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
  /** REQ-J-03's retention. Null before the file exists. */
  readonly expiresAt: string | null;
  /** False once the file has expired or been purged, even while status is DONE. */
  readonly downloadable: boolean;
}

export interface ExportDownload {
  readonly url: string;
  readonly expiresInSeconds: number;
  readonly filename: string;
}

/** `attendance-register-2026-08-13-1423.csv`. Stable, sortable, no spaces. */
export function exportFileName(
  reportKey: string,
  generatedAt: Date,
  format: ExportFormat,
): string {
  const stamp = generatedAt
    .toISOString()
    .replace(/[:T]/gu, '-')
    .slice(0, 16)
    .replace(/-(\d{2})-(\d{2})$/u, '-$1$2');
  return `${reportKey}-${stamp}.${EXPORT_FORMAT_EXTENSIONS[format]}`;
}

// --------------------------------------------------------------- saved views

export const SAVED_VIEW_NAME_MAX = 60;

export const savedViewConfigSchema = z.object({
  filters: reportFilterSchema.default({}),
  columns: z.array(z.string().max(64)).max(64).default([]),
  sort: z.string().max(200).optional(),
});

export type SavedViewConfig = z.infer<typeof savedViewConfigSchema>;

export const savedViewInputSchema = z.object({
  reportKey: z.enum(REPORT_KEYS),
  name: z.string().trim().min(1).max(SAVED_VIEW_NAME_MAX),
  config: savedViewConfigSchema,
  /** REQ-J-01 saved views are personal by default; sharing is opt-in. */
  isShared: z.boolean().default(false),
});

export type SavedViewInput = z.infer<typeof savedViewInputSchema>;

export const savedViewQuerySchema = z.object({
  reportKey: z.enum(REPORT_KEYS),
});

export type SavedViewQuery = z.infer<typeof savedViewQuerySchema>;

export interface SavedView {
  readonly id: string;
  readonly reportKey: string;
  readonly name: string;
  readonly config: SavedViewConfig;
  readonly isShared: boolean;
  /** False when it belongs to somebody else and was shared with the caller. */
  readonly isOwn: boolean;
  readonly createdAt: string;
}

// ----------------------------------------------------------------- row access

/**
 * One cell, before anybody decides how to write it.
 *
 * The extractors below answer "what is in this column" and stop there. The
 * table renders a duration as `8h 12m` and the sheet writes it as `08:12`, and
 * both are right -- but only if they are reading the same value out of the
 * same row. Returning a formatted string here is how the screen and the file
 * start disagreeing about what a column contains.
 */
export type ReportCellValue = string | number | boolean | null | readonly string[];

/**
 * The register's cells, from the `GET /attendance/days` read model.
 *
 * Structurally typed rather than importing `AttendanceDaySummary`: the
 * extractor needs the fields it names and nothing else, and stating that keeps
 * a report from silently depending on the whole day contract.
 */
export interface AttendanceRegisterSource {
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly date: string;
  readonly status: string;
  readonly shift: { readonly name: string } | null;
  readonly scheduledIn: string | null;
  readonly scheduledOut: string | null;
  readonly firstInAt: string | null;
  readonly lastOutAt: string | null;
  readonly workedMinutes: number;
  readonly breakMinutes: number;
  /** Optional for the reason `AttendanceDaySummary.otMinutes` is: a viewer who
   * may not see overtime is sent a row without the key at all. Reports are
   * gated on `report.view`, which no self-only account holds, so in practice
   * the register always has it -- but the extractor must not assume a field
   * the source type no longer guarantees. */
  readonly otMinutes?: number;
  readonly lateMinutes: number;
  readonly earlyExitMinutes: number;
  readonly flags: readonly string[];
  readonly isManualOverride: boolean;
  readonly locked: boolean;
}

export function attendanceRegisterCell(
  row: AttendanceRegisterSource,
  key: string,
): ReportCellValue {
  switch (key) {
    case 'date':
      return row.date;
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'shiftName':
      return row.shift?.name ?? null;
    case 'scheduledIn':
      return row.scheduledIn;
    case 'scheduledOut':
      return row.scheduledOut;
    case 'firstInAt':
      return row.firstInAt;
    case 'lastOutAt':
      return row.lastOutAt;
    case 'workedMinutes':
      return row.workedMinutes;
    case 'breakMinutes':
      return row.breakMinutes;
    case 'otMinutes':
      // Null, not zero: a withheld overtime figure renders as the empty-value
      // dash, the same as any column with nothing in it. Zero would read as
      // "worked no overtime", which is a claim this row is not making.
      return row.otMinutes ?? null;
    case 'lateMinutes':
      return row.lateMinutes;
    case 'earlyExitMinutes':
      return row.earlyExitMinutes;
    case 'status':
      return row.status;
    case 'flags':
      return row.flags;
    case 'isManualOverride':
      return row.isManualOverride;
    case 'locked':
      return row.locked;
    default:
      // A column key with no extractor is a definition and an extractor that
      // have drifted. Null renders as the empty-value dash rather than as
      // `undefined` in a payroll-adjacent file.
      return null;
  }
}

/** The punch audit's cells, from the `GET /punches` read model. */
export interface PunchAuditSource {
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly attendanceDate: string;
  readonly type: string;
  readonly serverTime: string;
  readonly clientTime: string | null;
  readonly clockSkewSeconds: number | null;
  readonly syncDelaySeconds: number | null;
  readonly source: string;
  readonly location: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracyM: number | null;
    readonly distanceFromGeofenceM: number | null;
  } | null;
  readonly isHalfDayMarked: boolean;
  readonly halfDayPart: string | null;
  readonly reason: string | null;
  readonly flags: readonly string[];
}

/** Five decimal places is about a metre; more is false precision from a phone. */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function punchAuditCell(row: PunchAuditSource, key: string): ReportCellValue {
  switch (key) {
    case 'attendanceDate':
      return row.attendanceDate;
    case 'serverTime':
      return row.serverTime;
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'type':
      return row.type;
    case 'source':
      return row.source;
    case 'clientTime':
      return row.clientTime;
    case 'clockSkewSeconds':
      return row.clockSkewSeconds;
    case 'syncDelaySeconds':
      return row.syncDelaySeconds;
    case 'location':
      return row.location === null
        ? null
        : formatCoordinates(row.location.latitude, row.location.longitude);
    case 'gpsAccuracyM':
      return row.location?.accuracyM ?? null;
    case 'distanceFromGeofenceM':
      return row.location?.distanceFromGeofenceM ?? null;
    case 'halfDay':
      return row.isHalfDayMarked ? (row.halfDayPart ?? 'yes') : null;
    case 'reason':
      return row.reason;
    case 'flags':
      return row.flags;
    default:
      return null;
  }
}

// ------------------------------------------------- derived report row sources

/**
 * Every row below is produced by a query written for its report, so unlike the
 * register and the audit -- which are the muster and the punch feed's own read
 * models -- these shapes exist only here. That is the point: a report that
 * aggregates has no other consumer, and giving it a shape of its own is what
 * stops somebody reaching for it as though it were the record.
 *
 * `id` on each is a row key, not a record id. A grouped row is not an entity
 * and has no id of its own; the table needs something stable to key on and the
 * server composes one from the group.
 */

/** REQ-J-01's monthly grid: one employee, the days of one month, and totals. */
export interface MusterGridSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  /** `d01` … `d31` to a `MUSTER_STATUS_CODES` value, or absent for no such day. */
  readonly days: Readonly<Record<string, string | null>>;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly leaveDays: number;
  readonly halfDays: number;
  readonly onDutyDays: number;
  readonly weeklyOffDays: number;
  readonly holidayDays: number;
  readonly workedMinutes: number;
  readonly otMinutes: number;
  readonly lateDays: number;
}

const MUSTER_DAY_KEY = /^d(0[1-9]|[12]\d|3[01])$/u;

export function musterGridCell(row: MusterGridSource, key: string): ReportCellValue {
  if (MUSTER_DAY_KEY.test(key)) return row.days[key] ?? null;

  switch (key) {
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'presentDays':
      return row.presentDays;
    case 'absentDays':
      return row.absentDays;
    case 'leaveDays':
      return row.leaveDays;
    case 'halfDays':
      return row.halfDays;
    case 'onDutyDays':
      return row.onDutyDays;
    case 'weeklyOffDays':
      return row.weeklyOffDays;
    case 'holidayDays':
      return row.holidayDays;
    case 'workedMinutes':
      return row.workedMinutes;
    case 'otMinutes':
      return row.otMinutes;
    case 'lateDays':
      return row.lateDays;
    default:
      return null;
  }
}

/**
 * Late arrivals, early exits and overtime.
 *
 * One shape for three reports because it is one question -- how often, how
 * much, how bad -- asked of three columns of `attendance_days`. The measure is
 * named by the report's own headers, so nothing here has to know which one it
 * is holding.
 */
export interface AttendanceExceptionSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  readonly locationName: string | null;
  /** Days on which the measure was non-zero. */
  readonly occurrences: number;
  readonly totalMinutes: number;
  readonly averageMinutes: number;
  readonly worstMinutes: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
}

export function attendanceExceptionCell(
  row: AttendanceExceptionSource,
  key: string,
): ReportCellValue {
  switch (key) {
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'locationName':
      return row.locationName;
    case 'occurrences':
      return row.occurrences;
    case 'totalMinutes':
      return row.totalMinutes;
    case 'averageMinutes':
      return row.averageMinutes;
    case 'worstMinutes':
      return row.worstMinutes;
    case 'firstDate':
      return row.firstDate;
    case 'lastDate':
      return row.lastDate;
    default:
      return null;
  }
}

/** REQ-J-01's absenteeism: "absent days and percentage by employee, department, month". */
export interface AbsenteeismSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  readonly locationName: string | null;
  /** `YYYY-MM`. */
  readonly month: string;
  /** Days the person was expected: every day that is not a weekly off or holiday. */
  readonly scheduledDays: number;
  readonly presentDays: number;
  readonly leaveDays: number;
  readonly absentDays: number;
  /** Absent days over scheduled days, to one decimal. A share, not a rate. */
  readonly absencePercent: number;
}

export function absenteeismCell(row: AbsenteeismSource, key: string): ReportCellValue {
  switch (key) {
    case 'month':
      return row.month;
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'locationName':
      return row.locationName;
    case 'scheduledDays':
      return row.scheduledDays;
    case 'presentDays':
      return row.presentDays;
    case 'leaveDays':
      return row.leaveDays;
    case 'absentDays':
      return row.absentDays;
    case 'absencePercent':
      return row.absencePercent;
    default:
      return null;
  }
}

/** REQ-J-01's missing punch: the flagged day, and where its correction stands. */
export interface MissingPunchSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  readonly date: string;
  readonly status: string;
  readonly shiftName: string | null;
  /** The punches as recorded, before any approved correction (REQ-F-03). */
  readonly punchedInAt: string | null;
  readonly punchedOutAt: string | null;
  readonly flags: readonly string[];
  /** Null when nobody has raised one -- not "NONE", which would read as a decision. */
  readonly regularizationStatus: string | null;
  readonly regularizationKind: string | null;
  readonly regularizationDecidedAt: string | null;
  readonly regularizationReason: string | null;
}

export function missingPunchCell(row: MissingPunchSource, key: string): ReportCellValue {
  switch (key) {
    case 'date':
      return row.date;
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'shiftName':
      return row.shiftName;
    case 'punchedInAt':
      return row.punchedInAt;
    case 'punchedOutAt':
      return row.punchedOutAt;
    case 'status':
      return row.status;
    case 'flags':
      return row.flags;
    case 'regularizationStatus':
      return row.regularizationStatus;
    case 'regularizationKind':
      return row.regularizationKind;
    case 'regularizationDecidedAt':
      return row.regularizationDecidedAt;
    case 'regularizationReason':
      return row.regularizationReason;
    default:
      return null;
  }
}

/** REQ-J-01's leave balance: `leave_balances`, which is the ledger's own cache. */
export interface LeaveBalanceSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
  readonly leaveYear: number;
  readonly opening: number;
  readonly accrued: number;
  readonly availed: number;
  readonly adjusted: number;
  readonly carriedForward: number;
  readonly closing: number;
}

export function leaveBalanceCell(row: LeaveBalanceSource, key: string): ReportCellValue {
  switch (key) {
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'leaveTypeCode':
      return row.leaveTypeCode;
    case 'leaveTypeName':
      return row.leaveTypeName;
    case 'leaveYear':
      return row.leaveYear;
    case 'opening':
      return row.opening;
    case 'accrued':
      return row.accrued;
    case 'availed':
      return row.availed;
    case 'adjusted':
      return row.adjusted;
    case 'carriedForward':
      return row.carriedForward;
    case 'closing':
      return row.closing;
    default:
      return null;
  }
}

/** REQ-J-01's leave ledger: `leave_ledger`, which REQ-G-03 makes append-only. */
export interface LeaveLedgerSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
  readonly leaveYear: number;
  readonly postedAt: string;
  readonly movementType: string;
  /** Signed, as stored: an AVAILED movement is negative. */
  readonly days: number;
  readonly referenceType: string | null;
  readonly periodKey: string | null;
  readonly note: string | null;
}

export function leaveLedgerCell(row: LeaveLedgerSource, key: string): ReportCellValue {
  switch (key) {
    case 'postedAt':
      return row.postedAt;
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'leaveTypeCode':
      return row.leaveTypeCode;
    case 'leaveTypeName':
      return row.leaveTypeName;
    case 'leaveYear':
      return row.leaveYear;
    case 'movementType':
      return row.movementType;
    case 'days':
      return row.days;
    case 'referenceType':
      return row.referenceType;
    case 'periodKey':
      return row.periodKey;
    case 'note':
      return row.note;
    default:
      return null;
  }
}

/** REQ-J-01's leave availed: approved leave *days* that fall inside the period. */
export interface LeaveAvailedSource {
  readonly id: string;
  readonly employee: { readonly name: string };
  readonly employeeCode: string;
  readonly departmentName: string | null;
  readonly leaveTypeCode: string;
  readonly leaveTypeName: string;
  readonly isPaid: boolean;
  readonly requests: number;
  readonly days: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
}

export function leaveAvailedCell(row: LeaveAvailedSource, key: string): ReportCellValue {
  switch (key) {
    case 'employeeCode':
      return row.employeeCode;
    case 'employeeName':
      return row.employee.name;
    case 'departmentName':
      return row.departmentName;
    case 'leaveTypeCode':
      return row.leaveTypeCode;
    case 'leaveTypeName':
      return row.leaveTypeName;
    case 'isPaid':
      return row.isPaid;
    case 'requests':
      return row.requests;
    case 'days':
      return row.days;
    case 'firstDate':
      return row.firstDate;
    case 'lastDate':
      return row.lastDate;
    default:
      return null;
  }
}

/**
 * REQ-J-01's headcount: "active headcount, joiners, leavers by month".
 *
 * Every figure comes from `date_of_joining` and `date_of_leaving`, which are
 * the only two dates the employee record actually holds. `employees.status` is
 * a current fact with no history behind it, so it is not read here -- a person
 * marked inactive today would otherwise rewrite what March's headcount was.
 */
export interface HeadcountSource {
  readonly id: string;
  /** `YYYY-MM`. */
  readonly month: string;
  readonly opening: number;
  readonly joiners: number;
  readonly leavers: number;
  readonly closing: number;
}

/** One reconciliation row as the source produces it (Phase 6c, REQ-S-05). */
export interface VoucherReconciliationSource {
  readonly month: string;
  readonly voucherType: string;
  readonly count: number;
  readonly cancelled: number;
  /** Exact decimal text — summed once for reconciliation, never computed on again. */
  readonly total: string;
  readonly lastPulledAt: string;
}

export function voucherReconciliationCell(row: VoucherReconciliationSource, key: string): ReportCellValue {
  switch (key) {
    case 'month':
      return row.month;
    case 'voucherType':
      return row.voucherType;
    case 'count':
      return row.count;
    case 'cancelled':
      return row.cancelled;
    case 'total':
      return row.total;
    case 'lastPulledAt':
      return row.lastPulledAt;
    default:
      return null;
  }
}

/** One statement line (Phase 6d, REQ-Y-01). Money as exact decimal text. */
export interface CustomerStatementSource {
  readonly id: string;
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly narration: string | null;
  readonly debit: string | null;
  readonly credit: string | null;
  readonly unclassified: string | null;
  readonly balance: string;
  readonly asOf: string | null;
}

export function customerStatementCell(row: CustomerStatementSource, key: string): ReportCellValue {
  switch (key) {
    case 'date':
      return row.date;
    case 'voucherType':
      return row.voucherType;
    case 'voucherNumber':
      return row.voucherNumber;
    case 'narration':
      return row.narration;
    case 'debit':
      return row.debit;
    case 'credit':
      return row.credit;
    case 'unclassified':
      return row.unclassified;
    case 'balance':
      return row.balance;
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

/** One party's credit position (Phase 6d, REQ-Y-03). */
export interface CreditCycleSource {
  readonly partyId: string;
  readonly partyName: string;
  readonly creditLimit: string | null;
  readonly creditDays: number | null;
  readonly exposure: string;
  readonly headroom: string | null;
  readonly overLimit: boolean;
  readonly lastInvoiceDate: string | null;
  readonly lastReceiptDate: string | null;
  readonly asOf: string | null;
}

/** One open bill (Phase 6d, REQ-Y-02). */
export interface AgeingSource {
  readonly partyId: string | null;
  readonly partyName: string;
  readonly billName: string;
  readonly billDate: string | null;
  readonly dueDate: string | null;
  readonly ageDays: number;
  readonly bucket: string;
  readonly outstanding: string;
  readonly overdue: boolean;
  readonly asOf: string | null;
}

export function ageingCell(row: AgeingSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName':
      return row.partyName;
    case 'billName':
      return row.billName;
    case 'billDate':
      return row.billDate;
    case 'dueDate':
      return row.dueDate;
    case 'ageDays':
      return row.ageDays;
    case 'bucket':
      return row.bucket;
    case 'outstanding':
      return row.outstanding;
    case 'overdue':
      return row.overdue ? 'OVERDUE' : 'WITHIN TERMS';
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

/** One party's payment behaviour (Phase 6d, REQ-Y-04). */
export interface PaymentAnalysisSource {
  readonly partyId: string;
  readonly partyName: string;
  readonly creditDays: number | null;
  /** Null when nothing has been settled yet; the screen says so rather than showing 0. */
  readonly avgDaysToPay: number | null;
  /** Actual minus agreed. Positive is late. Null when either side is unknown. */
  readonly slippage: number | null;
  readonly billsPaid: number;
  readonly billsOpen: number;
  readonly oldestOpenDays: number | null;
  readonly asOf: string | null;
}

export function paymentAnalysisCell(row: PaymentAnalysisSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName':
      return row.partyName;
    case 'creditDays':
      return row.creditDays;
    case 'avgDaysToPay':
      return row.avgDaysToPay;
    case 'slippage':
      return row.slippage;
    case 'billsPaid':
      return row.billsPaid;
    case 'billsOpen':
      return row.billsOpen;
    case 'oldestOpenDays':
      return row.oldestOpenDays;
    case 'onTime':
      // Unknown is not "on time". A party with nothing settled has not
      // demonstrated anything, and saying ON TIME would be a claim the data
      // does not support.
      if (row.slippage === null) return 'NOT YET KNOWN';
      return row.slippage <= 0 ? 'ON TIME' : 'LATE';
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

export function creditCycleCell(row: CreditCycleSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName':
      return row.partyName;
    case 'creditLimit':
      return row.creditLimit;
    case 'creditDays':
      return row.creditDays;
    case 'exposure':
      return row.exposure;
    case 'headroom':
      return row.headroom;
    case 'overLimit':
      return row.overLimit ? 'OVER_LIMIT' : 'WITHIN_LIMIT';
    case 'lastInvoiceDate':
      return row.lastInvoiceDate;
    case 'lastReceiptDate':
      return row.lastReceiptDate;
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

/** One group of sales (Phase 6d, REQ-Y-05). */
export interface SalesAnalysisSource {
  readonly key: string;
  readonly label: string;
  readonly vouchers: number;
  readonly quantity: string | null;
  readonly value: string;
  /** Percentage of the period's total, one decimal, as text. */
  readonly share: string;
  readonly asOf: string | null;
}

export function salesAnalysisCell(row: SalesAnalysisSource, key: string): ReportCellValue {
  switch (key) {
    case 'label':
      return row.label;
    case 'vouchers':
      return row.vouchers;
    case 'quantity':
      return row.quantity;
    case 'value':
      return row.value;
    case 'share':
      return row.share;
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

export interface PromisedVsCollectedSource {
  readonly id: string;
  readonly collectorId: string | null;
  readonly collectorName: string | null;
  readonly partyId: string;
  readonly partyName: string;
  readonly promises: number;
  readonly promised: string;
  readonly received: string;
  readonly keptPct: number;
  readonly kept: number;
  readonly partlyKept: number;
  readonly broken: number;
  readonly open: number;
}

export function promisedVsCollectedCell(row: PromisedVsCollectedSource, key: string): ReportCellValue {
  switch (key) {
    case 'collectorName': return row.collectorName ?? 'Unassigned';
    case 'partyName': return row.partyName;
    case 'promises': return row.promises;
    case 'promised': return row.promised;
    case 'received': return row.received;
    case 'keptPct': return row.keptPct;
    case 'kept': return row.kept;
    case 'partlyKept': return row.partlyKept;
    case 'broken': return row.broken;
    case 'open': return row.open;
    default: return null;
  }
}

export interface BrokenPromiseSource {
  readonly id: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly collectorName: string | null;
  readonly amount: string;
  readonly received: string;
  readonly shortfall: string;
  readonly promisedDate: string;
  readonly daysLate: number;
  readonly takenByName: string | null;
  readonly bills: string | null;
}

export function brokenPromiseCell(row: BrokenPromiseSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName': return row.partyName;
    case 'promisedDate': return row.promisedDate;
    case 'daysLate': return row.daysLate;
    case 'amount': return row.amount;
    case 'received': return row.received;
    case 'shortfall': return row.shortfall;
    case 'collectorName': return row.collectorName ?? 'Unassigned';
    case 'takenByName': return row.takenByName;
    case 'bills': return row.bills;
    default: return null;
  }
}

/**
 * One row of any Pareto. `band` is computed where the running total is, not
 * in the reader's head: a row is in the half when everything above it came
 * to less than half.
 */
export interface ParetoSource {
  readonly id: string;
  readonly rank: number;
  readonly name: string;
  readonly value: string;
  readonly sharePct: number;
  readonly cumulativePct: number;
  readonly band: string;
}

export function paretoCell(row: ParetoSource, key: string): ReportCellValue {
  switch (key) {
    case 'rank': return row.rank;
    case 'name': return row.name;
    case 'value': return row.value;
    case 'sharePct': return row.sharePct;
    case 'cumulativePct': return row.cumulativePct;
    case 'band': return row.band;
    default: return null;
  }
}

/** The three groups every Pareto sorts its rows into. */
export const PARETO_BANDS = ['Top 50%', 'Next 30%', 'Tail'] as const;
export type ParetoBand = (typeof PARETO_BANDS)[number];

/** 15 REQ-AK-10: one row per item, per customer, per reason. */
export interface ReturnRateItemSource {
  readonly id: string;
  readonly itemName: string;
  readonly returnedQty: string;
  readonly soldQty: string;
  readonly ratePct: number | null;
  readonly returns: number;
  readonly scrappedQty: string;
  readonly topReason: string;
  readonly lastReturnedOn: string;
}

export function returnRateItemCell(row: ReturnRateItemSource, key: string): ReportCellValue {
  switch (key) {
    case 'itemName': return row.itemName;
    case 'returnedQty': return row.returnedQty;
    case 'soldQty': return row.soldQty;
    case 'ratePct': return row.ratePct;
    case 'returns': return row.returns;
    case 'scrappedQty': return row.scrappedQty;
    case 'topReason': return row.topReason;
    case 'lastReturnedOn': return row.lastReturnedOn;
    default: return null;
  }
}

export interface ReturnRateCustomerSource {
  readonly id: string;
  readonly partyId: string | null;
  readonly partyName: string;
  readonly returnedQty: string;
  readonly soldQty: string;
  readonly ratePct: number | null;
  readonly returns: number;
  readonly awaitingCredit: number;
  readonly topReason: string;
  readonly lastReturnedOn: string;
}

export function returnRateCustomerCell(row: ReturnRateCustomerSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName': return row.partyName;
    case 'returnedQty': return row.returnedQty;
    case 'soldQty': return row.soldQty;
    case 'ratePct': return row.ratePct;
    case 'returns': return row.returns;
    case 'awaitingCredit': return row.awaitingCredit;
    case 'topReason': return row.topReason;
    case 'lastReturnedOn': return row.lastReturnedOn;
    default: return null;
  }
}

export interface ReturnsByReasonSource {
  readonly id: string;
  readonly reason: string;
  readonly lines: number;
  readonly returns: number;
  readonly quantity: string;
  readonly sharePct: number;
  readonly scrapLines: number;
  readonly damagedLines: number;
  readonly topItem: string;
}

export function returnsByReasonCell(row: ReturnsByReasonSource, key: string): ReportCellValue {
  switch (key) {
    case 'reason': return row.reason;
    case 'lines': return row.lines;
    case 'returns': return row.returns;
    case 'quantity': return row.quantity;
    case 'sharePct': return row.sharePct;
    case 'scrapLines': return row.scrapLines;
    case 'damagedLines': return row.damagedLines;
    case 'topItem': return row.topItem;
    default: return null;
  }
}

export interface PendingDispatchSource {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerName: string;
  readonly orderDate: string;
  readonly ageDays: number;
  readonly item: string;
  readonly ordered: string;
  readonly packed: string;
  readonly invoiced: string;
  readonly dispatched: string;
  readonly balance: string;
  readonly fulfilment: string;
}

export function pendingDispatchCell(row: PendingDispatchSource, key: string): ReportCellValue {
  switch (key) {
    case 'orderNumber': return row.orderNumber;
    case 'customerName': return row.customerName;
    case 'orderDate': return row.orderDate;
    case 'ageDays': return row.ageDays;
    case 'item': return row.item;
    case 'ordered': return row.ordered;
    case 'packed': return row.packed;
    case 'invoiced': return row.invoiced;
    case 'dispatched': return row.dispatched;
    case 'balance': return row.balance;
    case 'fulfilment': return row.fulfilment.toUpperCase();
    default: return null;
  }
}

export interface LowStockSource {
  readonly stockItemId: string;
  readonly item: string;
  readonly closing: string | null;
  readonly committed: string;
  readonly available: string | null;
  readonly reorderLevel: string;
  readonly openPo: string;
  readonly shortfall: string;
  readonly asOf: string | null;
}

export function lowStockCell(row: LowStockSource, key: string): ReportCellValue {
  switch (key) {
    case 'item': return row.item;
    case 'closing': return row.closing;
    case 'committed': return row.committed;
    case 'available': return row.available;
    case 'reorderLevel': return row.reorderLevel;
    case 'openPo': return row.openPo;
    case 'shortfall': return row.shortfall;
    case 'asOf': return row.asOf;
    default: return null;
  }
}

export function headcountCell(row: HeadcountSource, key: string): ReportCellValue {
  switch (key) {
    case 'month':
      return row.month;
    case 'opening':
      return row.opening;
    case 'joiners':
      return row.joiners;
    case 'leavers':
      return row.leavers;
    case 'closing':
      return row.closing;
    default:
      return null;
  }
}

// ---------------------------------------------------------- scheduled exports

/**
 * REQ-J-05, delivered to the Downloads tray rather than to an inbox.
 *
 * The requirement as written says "emailed daily/weekly/monthly to a list of
 * recipients". This product has no mail transport -- it was removed, because
 * the pilot has no mail server and REQ-B-03's invitation link is handed over by
 * the administrator instead. A schedule therefore produces exactly what the
 * Export button produces, on a timer, into the same tray with the same seven
 * day retention and the same signed download. Nothing about the file differs;
 * only what started it.
 *
 * That substitution is deliberate and is the whole of the deviation. A schedule
 * that emailed would need a transport, a recipient list, a bounce path and a
 * decision about sending employee data to an address nobody in the product has
 * verified. Landing it in the tray needs none of those, and the person who
 * wanted the report still finds it waiting for them.
 */
export const SCHEDULE_CADENCES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];

export const SCHEDULE_CADENCE_LABELS: Record<ScheduleCadence, string> = {
  DAILY: 'Every day',
  WEEKLY: 'Every week',
  MONTHLY: 'Every month',
};

/**
 * The latest day of the month a schedule may name.
 *
 * 28 rather than 31, because a monthly schedule set to the 30th would not run
 * in February at all and a schedule set to the 31st would skip five months a
 * year -- silently, which is the worst way for a report to be missing. Anyone
 * wanting the last day of the month wants the month that just ended, and that
 * is what the 1st already gives them.
 */
export const MAX_SCHEDULE_DAY_OF_MONTH = 28;

export const SCHEDULE_NAME_MAX = 80;

/** ISO-8601 weekdays, so 1 is Monday and 7 is Sunday. */
export const SCHEDULE_WEEKDAY_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

export const reportScheduleInputSchema = z
  .object({
    reportKey: z.enum(REPORT_KEYS),
    name: z.string().trim().min(1).max(SCHEDULE_NAME_MAX),
    /**
     * No `from` or `to`. The period a run covers is derived from the cadence --
     * see `scheduleWindow` -- because a stored range would export the same
     * fortnight of August for ever, and would look like it was working.
     */
    filters: reportFilterSchema.omit({ from: true, to: true }).default({}),
    columns: z.array(z.string().max(64)).max(64).default([]),
    sort: z.string().max(200).optional(),
    format: z.enum(AVAILABLE_EXPORT_FORMATS).default('XLSX'),
    cadence: z.enum(SCHEDULE_CADENCES),
    /** On the organisation's wall clock (NFR-05), never the server's. */
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59).default(0),
    /** Weekly only. ISO weekday, 1 = Monday. */
    weekday: z.number().int().min(1).max(7).optional(),
    /** Monthly only. */
    dayOfMonth: z.number().int().min(1).max(MAX_SCHEDULE_DAY_OF_MONTH).optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    // Checked here rather than left to the runner, so a schedule that could
    // never fire is refused at the point somebody can still fix it.
    if (value.cadence === 'WEEKLY' && value.weekday === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['weekday'],
        message: 'A weekly schedule needs the day of the week it runs on.',
      });
    }
    if (value.cadence === 'MONTHLY' && value.dayOfMonth === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dayOfMonth'],
        message: 'A monthly schedule needs the day of the month it runs on.',
      });
    }
  });

export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

export interface ReportSchedule {
  readonly id: string;
  readonly reportKey: ReportKey;
  readonly name: string;
  readonly filters: ReportFilters;
  readonly columns: readonly string[];
  readonly sort: string | null;
  readonly format: ExportFormat;
  readonly cadence: ScheduleCadence;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number | null;
  readonly dayOfMonth: number | null;
  readonly isActive: boolean;
  readonly owner: NamedRef;
  /** The organisation-local date it last produced a file for. */
  readonly lastRunOn: string | null;
  readonly lastExportJobId: string | null;
  /** Null when the last run failed, so the list can say so without a join. */
  readonly lastRunStatus: ExportStatus | null;
  readonly createdAt: string;
}

/**
 * When a schedule next fires, said in words, for the list and the form.
 *
 * Built from the same fields the runner reads, so the sentence on screen cannot
 * describe a different schedule from the one that will run.
 */
export function describeSchedule(schedule: {
  cadence: ScheduleCadence;
  hour: number;
  minute: number;
  weekday?: number | null;
  dayOfMonth?: number | null;
}): string {
  const clock = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  switch (schedule.cadence) {
    case 'DAILY':
      return `Every day at ${clock}`;
    case 'WEEKLY':
      return `Every ${SCHEDULE_WEEKDAY_LABELS[schedule.weekday ?? 1] ?? 'Monday'} at ${clock}`;
    case 'MONTHLY': {
      const day = schedule.dayOfMonth ?? 1;
      return `On day ${String(day)} of each month at ${clock}`;
    }
    default:
      return `At ${clock}`;
  }
}

/**
 * The period one run covers, derived from the cadence and never stored.
 *
 * Every window ends *yesterday*. A schedule that ran at 06:00 and included
 * today would export a few hours of punches and call it a day's report, which
 * is worse than not running: the number looks real. Ending on the last complete
 * day means a daily report is yesterday, a weekly one is the seven days up to
 * yesterday, and a monthly one is the calendar month that has finished.
 *
 * `today` is the organisation-local date the run happens on, as `YYYY-MM-DD`.
 */
export function scheduleWindow(
  cadence: ScheduleCadence,
  today: string,
): { from: string; to: string } {
  const [year = 0, month = 1, day = 1] = today.split('-').map(Number);
  // UTC arithmetic on a date-only value, which has no timezone of its own. The
  // caller has already resolved "what day is it there".
  const cursor = new Date(Date.UTC(year, month - 1, day));
  const iso = (date: Date): string => date.toISOString().slice(0, 10);

  const yesterday = new Date(cursor);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  switch (cadence) {
    case 'DAILY':
      return { from: iso(yesterday), to: iso(yesterday) };
    case 'WEEKLY': {
      const start = new Date(yesterday);
      start.setUTCDate(start.getUTCDate() - 6);
      return { from: iso(start), to: iso(yesterday) };
    }
    case 'MONTHLY': {
      // The month that contains yesterday, which on the 1st is the month that
      // has just ended -- the case a monthly schedule exists for.
      const start = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
      const end = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, 0));
      return { from: iso(start), to: iso(end) };
    }
    default:
      return { from: iso(yesterday), to: iso(yesterday) };
  }
}

/**
 * Whether a schedule is due on this organisation-local date and time.
 *
 * `lastRunOn` is the idempotency key and it is a date, not an instant: the
 * sweep runs every fifteen minutes, so without it a schedule set for 06:00
 * would fire again at 06:15, 06:30 and every sweep after it until midnight.
 */
export function isScheduleDue(
  schedule: {
    cadence: ScheduleCadence;
    hour: number;
    minute: number;
    weekday?: number | null;
    dayOfMonth?: number | null;
    isActive: boolean;
    lastRunOn?: string | null;
  },
  local: { date: string; hour: number; minute: number; weekday: number; dayOfMonth: number },
): boolean {
  if (!schedule.isActive) return false;
  if (schedule.lastRunOn === local.date) return false;

  if (schedule.cadence === 'WEEKLY' && schedule.weekday !== local.weekday) return false;
  if (schedule.cadence === 'MONTHLY' && schedule.dayOfMonth !== local.dayOfMonth) return false;

  // At or after the appointed minute. A sweep that missed the exact slot --
  // the server was down, the sweep was slow -- still runs, late, rather than
  // skipping the day silently.
  const due = schedule.hour * 60 + schedule.minute;
  return local.hour * 60 + local.minute >= due;
}

/** 14 REQ-AE-01: one voucher, as Tally said it. */
export interface DayBookSource {
  readonly voucherId: string;
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly partyName: string | null;
  readonly amount: string;
  readonly narration: string | null;
  readonly cancelled: boolean;
  readonly asOf: string | null;
}

export function dayBookCell(row: DayBookSource, key: string): ReportCellValue {
  switch (key) {
    case 'date':
      return row.date;
    case 'voucherType':
      return row.voucherType;
    case 'voucherNumber':
      return row.voucherNumber;
    case 'partyName':
      return row.partyName;
    case 'amount':
      return row.amount;
    case 'narration':
      return row.narration;
    case 'cancelled':
      return row.cancelled ? 'CANCELLED' : 'POSTED';
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

/** 14 REQ-AG-02: one customer measured against their own buying rhythm. */
export interface CustomerLapseSource {
  readonly partyId: string;
  readonly partyName: string;
  /** 'LAPSED' past twice the median gap, 'AT_RISK' past once, else 'ON_RHYTHM'. */
  readonly state: 'LAPSED' | 'AT_RISK' | 'ON_RHYTHM';
  readonly lastSaleDate: string;
  readonly daysSince: number;
  readonly medianGapDays: number;
  readonly expectedBy: string;
  readonly sales12m: number;
  readonly revenue12m: string;
  readonly asOf: string | null;
}

export function customerLapseCell(row: CustomerLapseSource, key: string): ReportCellValue {
  switch (key) {
    case 'partyName':
      return row.partyName;
    case 'state':
      return row.state;
    case 'lastSaleDate':
      return row.lastSaleDate;
    case 'daysSince':
      return row.daysSince;
    case 'medianGapDays':
      return row.medianGapDays;
    case 'expectedBy':
      return row.expectedBy;
    case 'sales12m':
      return row.sales12m;
    case 'revenue12m':
      return row.revenue12m;
    case 'asOf':
      return row.asOf;
    default:
      return null;
  }
}

/**
 * The Tier 1 analytics rows (D-46) are flat records whose keys are their
 * column keys, so one cell reader serves all fifteen shapes — a bespoke
 * switch per report would restate each interface a second time.
 */
export function recordCell(row: Record<string, unknown>, key: string): ReportCellValue {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  // A Date from the driver, most likely; anything else has no honest cell.
  return value instanceof Date ? value.toISOString() : null;
}

export interface LedgerExtractSource extends Record<string, unknown> {
  readonly id: string;
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly partyName: string | null;
  readonly debit: string | null;
  readonly credit: string | null;
  readonly balance: string;
  readonly asOf: string | null;
}

export interface StockSummarySource extends Record<string, unknown> {
  readonly stockItemId: string;
  readonly item: string;
  readonly group: string | null;
  readonly unit: string | null;
  readonly closingQty: string | null;
  readonly committedQty: string;
  readonly availableQty: string | null;
  readonly costRate: string | null;
  readonly value: string | null;
  readonly asOf: string | null;
}

export interface NegativeStockSource extends Record<string, unknown> {
  readonly stockItemId: string;
  readonly item: string;
  readonly group: string | null;
  readonly closingQty: string;
  readonly unit: string | null;
  readonly lastPulledAt: string | null;
}

export interface StaleProjectionSource extends Record<string, unknown> {
  readonly connectionId: string;
  readonly companyName: string;
  readonly connectionState: string;
  readonly lastPulledAt: string | null;
  readonly hoursStale: number | null;
}

export interface DuplicateMasterSource extends Record<string, unknown> {
  readonly id: string;
  readonly kind: 'Party' | 'Item';
  readonly nameA: string;
  readonly nameB: string;
  readonly reason: string;
}

export interface CustomerItemSource extends Record<string, unknown> {
  readonly id: string;
  readonly partyId: string | null;
  readonly partyName: string;
  readonly stockItemId: string | null;
  readonly item: string;
  readonly invoices: number;
  readonly quantity: string | null;
  readonly value: string;
  readonly lastDate: string;
  readonly asOf: string | null;
}

export interface PurchaseRhythmSource extends Record<string, unknown> {
  readonly partyId: string;
  readonly partyName: string;
  readonly sales12m: number;
  readonly perMonth: string;
  readonly medianGapDays: number;
  readonly lastGapDays: number | null;
  readonly daysSince: number;
  readonly trend: 'SLOWING' | 'STEADY' | 'QUICKENING';
  readonly asOf: string | null;
}

export interface PriceVarianceSource extends Record<string, unknown> {
  readonly id: string;
  readonly item: string;
  readonly buyers: number;
  readonly minRate: string;
  readonly minParty: string | null;
  readonly maxRate: string;
  readonly maxParty: string | null;
  readonly avgRate: string;
  readonly spreadPct: string;
  readonly asOf: string | null;
}

export interface ItemVelocitySource extends Record<string, unknown> {
  readonly stockItemId: string | null;
  readonly item: string;
  readonly monthly12: string;
  readonly monthly3: string;
  readonly trend: 'RISING' | 'STEADY' | 'FALLING';
  readonly closingQty: string | null;
  readonly coverDays: number | null;
  readonly asOf: string | null;
}

export interface DeadStockSource extends Record<string, unknown> {
  readonly stockItemId: string;
  readonly item: string;
  readonly lastSaleDate: string | null;
  readonly daysIdle: number | null;
  readonly closingQty: string | null;
  readonly valueLocked: string | null;
  readonly asOf: string | null;
}

export interface MovementSource extends Record<string, unknown> {
  readonly id: string;
  readonly month: string;
  readonly item: string;
  readonly inwardQty: string;
  readonly outwardQty: string;
  readonly netQty: string;
  readonly asOf: string | null;
}

export interface VendorItemSource extends Record<string, unknown> {
  readonly id: string;
  readonly vendorName: string;
  readonly partyId: string | null;
  readonly item: string;
  readonly purchases: number;
  readonly quantity: string | null;
  readonly lastRate: string;
  readonly avgRate: string;
  readonly lastDate: string;
  readonly rateTrend: 'RISING' | 'STEADY' | 'FALLING';
  readonly asOf: string | null;
}

export interface VendorPriceSource extends Record<string, unknown> {
  readonly id: string;
  readonly item: string;
  readonly vendors: number;
  readonly bestRate: string;
  readonly bestVendor: string | null;
  readonly worstRate: string;
  readonly worstVendor: string | null;
  readonly spreadPct: string;
  readonly asOf: string | null;
}

export interface CreditBreachSource extends Record<string, unknown> {
  readonly partyId: string;
  readonly partyName: string;
  readonly creditLimit: string | null;
  readonly exposure: string;
  readonly overBy: string;
  readonly releases90d: number;
  readonly asOf: string | null;
}

export interface StockAgeingSource extends Record<string, unknown> {
  readonly stockItemId: string;
  readonly item: string;
  readonly closingQty: string;
  readonly bucket0: string;
  readonly bucket31: string;
  readonly bucket61: string;
  readonly bucket90: string;
  readonly valueLocked: string | null;
  readonly asOf: string | null;
}
