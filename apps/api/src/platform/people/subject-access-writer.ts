/**
 * REQ-M-05's file format: one CSV holding many sections.
 *
 * A subject access export is not a report. A report is one grid of one shape;
 * everything the system holds about one person is fifteen shapes -- identity as
 * a list of facts, attendance as a wide grid, an audit trail as a long one --
 * and forcing them into one column set would either lose columns or produce a
 * grid that is mostly empty. Sections, each with its own header row and a blank
 * line between, is what a spreadsheet reader can actually work with, and it is
 * what `export_jobs.format = 'CSV'` allows: the column carries a check
 * constraint of `('CSV', 'XLSX')`, so a JSON document could not be recorded on
 * the row the Downloads tray reads.
 *
 * The quoting rules below are duplicated from `modules/attendance/reports/
 * report-writer.ts` rather than shared. `platform/` may not import `modules/`
 * (technical design §1, enforced by `moduleBoundaries` in the ESLint config),
 * and moving the primitive into `@vyuha/shared` would mean editing the report
 * writer to consume it. That is the right eventual home for it; until both
 * sides can be changed together, two copies that agree beats one import that
 * inverts the dependency graph.
 */

/**
 * Inlined from the removed reports module's `report-cell.ts` -- the five
 * patterns are the five the org setting offers, and anything else falls
 * back to the stored form. Twelve English abbreviations do not justify a
 * formatting dependency.
 */
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function formatCalendarDate(value: string, dateFormat: string): string {
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

/**
 * The shapes `formatSubjectCell` renders deliberately. It accepts `unknown`
 * rather than this union because the value arrives from a database driver,
 * which decides the runtime type -- so the formatter has to cope with a shape
 * nobody listed rather than fail the whole export over one cell.
 */
export type SubjectCellValue = string | number | boolean | Date | null | undefined | object;

export interface SubjectAccessMeta {
  readonly orgName: string;
  /** Who the file is about, as a person would name them. */
  readonly subjectLabel: string;
  /** Who asked for it. REQ-M-05 exports are themselves accountable. */
  readonly requestedByLabel: string;
  readonly generatedAt: Date;
  /** NFR-05: instants are stored in UTC and rendered on the org's wall clock. */
  readonly timezone: string;
  /** REQ-L-01's organisation date format. */
  readonly dateFormat: string;
}

export interface SubjectAccessColumn {
  readonly key: string;
  readonly header: string;
}

/*
 * Re-exported because this writer's tests pin the calendar formats. The
 * definition itself was a byte-identical copy of the one in
 * `platform/export/report-cell.ts` until the format list grew; one list of
 * month names beats two that can drift.
 */
export { formatCalendarDate };

/**
 * An instant on the organisation's wall clock, date and time.
 *
 * `Intl.DateTimeFormat` rather than arithmetic on a UTC offset: India is +05:30
 * and half-hour offsets are exactly where hand-rolled conversion goes wrong.
 */
export function formatInstant(value: Date, timezone: string, dateFormat: string): string {
  if (Number.isNaN(value.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value);

  const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const iso = `${at('year')}-${at('month')}-${at('day')}`;
  // en-GB renders midnight as "24" in some engines; the calendar day is already
  // correct, so only the hour needs bringing back into range.
  const hour = at('hour') === '24' ? '00' : at('hour');
  return `${formatCalendarDate(iso, dateFormat)} ${hour}:${at('minute')}:${at('second')}`;
}

/**
 * A Postgres timestamp as the driver spells it: `2026-08-12 10:38:06.891372+00`.
 *
 * It arrives as a string rather than a `Date` because Drizzle installs its own
 * type parsers on the node-postgres client and keeps timestamps textual so it
 * can map them itself -- which applies to a raw `db.execute` too. Caught in a
 * produced file, not by reading: the first export rendered every instant as a
 * raw UTC string beside calendar dates that had been converted, so one file
 * carried two timezones and neither said which.
 */
const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/u;

/** `+00` and `+0530` are legal offsets that `Date` will not parse. */
function normaliseOffset(offset: string | undefined): string {
  if (offset === undefined) return 'Z';
  if (offset === 'Z') return 'Z';
  if (offset.length === 3) return `${offset}:00`;
  if (offset.length === 5) return `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return offset;
}

function parsePostgresTimestamp(value: string): Date | null {
  const match = PG_TIMESTAMP.exec(value);
  if (match === null) return null;
  const [, date = '', time = '', offset] = match;
  const parsed = new Date(`${date}T${time}${normaliseOffset(offset)}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * One value as text.
 *
 * `jsonb` columns are stringified rather than flattened: an audit diff is the
 * most useful thing in the file for the person it is about, and inventing a
 * column per key it might contain would produce a different grid per row.
 */
export function formatSubjectCell(value: unknown, timezone: string, dateFormat: string): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatInstant(value, timezone, dateFormat);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return formatCalendarDate(value, dateFormat);
    const instant = parsePostgresTimestamp(value);
    // Anything that looks like a timestamp but will not parse is left exactly
    // as it came: losing a value is worse than printing an awkward one.
    return instant === null ? value : formatInstant(instant, timezone, dateFormat);
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatSubjectCell(item, timezone, dateFormat)).join('; ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  // Only a symbol or a function reaches here, and no database column produces
  // either. Empty beats throwing: one unrecognised cell is worth far less than
  // the rest of a compliance file.
  return '';
}

/**
 * RFC 4180 quoting, plus the neutralisation the RFC does not cover.
 *
 * A cell beginning `=`, `+`, `-` or `@` is executed as a formula when the file
 * is opened in Excel or Sheets, and a subject access export is dense with free
 * text somebody typed -- punch reasons, leave reasons, decision reasons.
 * Security §15 lists this under data leakage in exports.
 */
export function csvCell(value: string): string {
  const neutralised = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  if (!/[",\n\r]/u.test(neutralised)) return neutralised;
  return `"${neutralised.replaceAll('"', '""')}"`;
}

/** Excel needs CRLF and a BOM to read UTF-8 without mangling non-ASCII names. */
const LINE_END = '\r\n';
const UTF8_BOM = '\uFEFF';

export class SubjectAccessCsvWriter {
  readonly mime = 'text/csv; charset=utf-8';
  readonly extension = 'csv';

  private readonly lines: string[] = [];
  private timezone = 'UTC';
  private dateFormat = 'dd-MM-yyyy';
  private rows = 0;

  /** Every data row written, across every section. Recorded on the job row. */
  get rowCount(): number {
    return this.rows;
  }

  begin(meta: SubjectAccessMeta): void {
    this.timezone = meta.timezone;
    this.dateFormat = meta.dateFormat;

    this.lines.push(csvCell(meta.orgName));
    this.lines.push(csvCell('Employee data export'));
    this.pair('Subject', meta.subjectLabel);
    this.pair('Requested by', meta.requestedByLabel);
    this.pair(
      'Generated',
      `${formatInstant(meta.generatedAt, meta.timezone, meta.dateFormat)} ${meta.timezone}`,
    );
  }

  /** A section of labelled facts -- identity, employment. Two columns, no grid. */
  facts(title: string, entries: readonly (readonly [string, unknown])[]): void {
    this.heading(title);
    if (entries.length === 0) {
      this.lines.push(csvCell('No data held.'));
      return;
    }
    for (const [label, value] of entries) {
      this.pair(label, formatSubjectCell(value, this.timezone, this.dateFormat));
      this.rows += 1;
    }
  }

  /**
   * A section of rows.
   *
   * An empty section still prints its heading and says so. "No punches are
   * held for this person" and "the punches section was left out of this build"
   * are different answers, and a reader of a compliance export needs the first
   * one stated rather than inferred from an absence.
   */
  table(
    title: string,
    columns: readonly SubjectAccessColumn[],
    rows: readonly (readonly unknown[])[],
    note?: string,
  ): void {
    this.heading(title);
    if (note !== undefined) this.lines.push(csvCell(note));
    if (rows.length === 0) {
      this.lines.push(csvCell('No data held.'));
      return;
    }

    this.lines.push(columns.map((column) => csvCell(column.header)).join(','));
    for (const row of rows) {
      this.lines.push(
        columns
          .map((_column, index) =>
            csvCell(formatSubjectCell(row[index] ?? null, this.timezone, this.dateFormat)),
          )
          .join(','),
      );
      this.rows += 1;
    }
  }

  /**
   * A section that exists but was not filled in, and why.
   *
   * The distinction this preserves is the same one `table` makes between "no
   * data held" and an absent heading, one step further out: a section withheld
   * because the requester lacks the permission governing it is neither empty
   * nor missing, and a compliance file that simply omitted it would be claiming
   * completeness it does not have. The heading stays so the reader can see
   * there is more, and ask somebody who holds the key.
   */
  note(title: string, reason: string): void {
    this.heading(title);
    this.lines.push(csvCell(reason));
  }

  finish(): Buffer {
    return Buffer.from(UTF8_BOM + this.lines.join(LINE_END) + LINE_END, 'utf8');
  }

  private heading(title: string): void {
    this.lines.push('');
    this.lines.push(csvCell(`[ ${title} ]`));
  }

  private pair(label: string, value: string): void {
    this.lines.push(`${csvCell(label)},${csvCell(value)}`);
  }
}
