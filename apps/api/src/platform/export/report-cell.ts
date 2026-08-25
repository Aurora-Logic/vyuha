import {
  type ExportFormat,
  type FilterCaption,
  type ReportCellValue,
  type ReportColumnSpec,
  type ReportColumnType,
} from '@vyuha/shared';

/**
 * What a report cell is, and what every writer has to be handed.
 *
 * Split out of `report-writer.ts` when the second writer arrived. Both the CSV
 * and the XLSX writer format the same value the same way -- a half-hour
 * timezone, an org date format, minutes as HH:mm -- and neither of them owns
 * those rules. Left in the CSV file, the spreadsheet writer would have had to
 * import from it, which is a cycle in the direction of the thing that is not
 * the shared part.
 */

export interface ReportSheetMeta {
  /** REQ-J-03's header block. */
  readonly orgName: string;
  readonly reportLabel: string;
  readonly captions: readonly FilterCaption[];
  readonly generatedAt: Date;
  /** NFR-05: instants are stored in UTC and rendered in the org timezone. */
  readonly timezone: string;
  /** REQ-L-01's organisation date format. */
  readonly dateFormat: string;
  readonly rowCount: number;
}

export interface ReportWriter {
  readonly format: ExportFormat;
  readonly mime: string;
  readonly extension: string;
  /** REQ-J-03's frozen header and column widths. False for CSV. */
  readonly supportsSheetFormatting: boolean;
  begin(meta: ReportSheetMeta, columns: readonly ReportColumnSpec[]): void;
  writeRow(cells: readonly ReportCellValue[]): void;
  /*
   * Async because an xlsx file is a zip archive, and the library that builds
   * one writes it through a stream. CSV could return synchronously and returns
   * a resolved promise instead, so the one caller has a single shape to await
   * and cannot be correct for one format and wrong for the other.
   */
  finish(): Promise<Buffer>;
}

// ------------------------------------------------------------- cell rendering

const TWO_DIGITS = 2;

function pad(value: number): string {
  return String(value).padStart(TWO_DIGITS, '0');
}

/**
 * `HH:mm` or `HH:mm:ss` on the organisation's wall clock.
 *
 * `Intl.DateTimeFormat` rather than arithmetic on the offset: India is +05:30
 * and half-hour offsets are exactly where hand-rolled conversion goes wrong,
 * and a location that observes daylight saving would break the arithmetic
 * version twice a year in a file nobody re-reads.
 */
export function formatInstant(iso: string, timezone: string, withSeconds: boolean): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
    hour12: false,
  }).formatToParts(parsed);

  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  const base = `${at('hour')}:${at('minute')}`;
  return withSeconds ? `${base}:${at('second')}` : base;
}

/*
 * Hand-rolled rather than date-fns: it is not an api dependency, and five
 * fixed formats do not justify adding one for twelve English abbreviations.
 */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A `YYYY-MM-DD` calendar date in the organisation's format (REQ-L-01).
 *
 * The five patterns are the five the org setting offers, and anything else
 * falls back to the stored form. The alternative -- pulling in a formatting
 * library on the server for one column type -- is a dependency.
 */
export function formatCalendarDate(value: string, dateFormat: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return value;
  const [, year = '', month = '', day = ''] = match;
  if (dateFormat === 'dd-MM-yyyy') return `${day}-${month}-${year}`;
  if (dateFormat === 'dd/MM/yyyy') return `${day}/${month}/${year}`;
  if (dateFormat === 'yyyy-MM-dd') return value;
  if (dateFormat === 'MM/dd/yyyy') return `${month}/${day}/${year}`;
  if (dateFormat === 'dd MMM yyyy') {
    const monthName = MONTH_ABBREVIATIONS[Number(month) - 1];
    // A month outside 01-12 is not a calendar date; keep the stored form.
    return monthName === undefined ? value : `${day} ${monthName} ${year}`;
  }
  return value;
}

/** Minutes as `HH:mm`. Zero is empty: a weekly off did not work zero hours. */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  return `${pad(Math.floor(minutes / 60))}:${pad(Math.round(minutes % 60))}`;
}

export interface CellContext {
  readonly timezone: string;
  readonly dateFormat: string;
}

/**
 * One cell as text.
 *
 * Semicolons between flags rather than commas: the value is quoted either way,
 * but a reader scanning a `flags` cell in a spreadsheet should not have to
 * work out which commas are separators and which belong to the file format.
 */
export function formatCell(
  value: ReportCellValue,
  type: ReportColumnType,
  context: CellContext,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join('; ');

  if (typeof value === 'number') {
    return type === 'duration' ? formatDurationMinutes(value) : String(value);
  }

  const text = String(value);
  if (text.length === 0) return '';

  switch (type) {
    case 'date':
      return formatCalendarDate(text, context.dateFormat);
    case 'time':
      return formatInstant(text, context.timezone, false);
    case 'instant':
      return formatInstant(text, context.timezone, true);
    default:
      return text;
  }
}
