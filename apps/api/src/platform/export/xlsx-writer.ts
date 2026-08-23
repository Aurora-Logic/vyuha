import ExcelJS from 'exceljs';

import {
  EXPORT_FORMAT_EXTENSIONS,
  type ReportCellValue,
  type ReportColumnSpec,
} from '@vyuha/shared';

import {
  formatCell,
  type CellContext,
  type ReportSheetMeta,
  type ReportWriter,
} from './report-cell.js';

/**
 * REQ-J-03's real Excel file: "frozen header, filters applied, column widths
 * set, org name and filter criteria in a header block, generated-at timestamp".
 *
 * All five of those are things a CSV cannot carry, which is why the writer
 * interface has always declared `supportsSheetFormatting` and why CSV answers
 * false. This is the implementation that answers true.
 *
 * Rows are streamed into the sheet as they arrive rather than gathered first --
 * `ExportService` already walks the report in pages precisely so a large export
 * never holds every row at once, and buffering here would undo that. The
 * workbook itself is still built in memory, which is the honest limit of this
 * approach and the reason `MAX_EXPORT_ROWS` exists above it.
 */

/** Character width when a column declares none. */
const DEFAULT_COLUMN_WIDTH = 16;

/** Excel refuses a column wider than this, and a sheet with one is unreadable. */
const MAX_COLUMN_WIDTH = 60;

/** Narrower than this and the header text is hidden behind the next column. */
const MIN_COLUMN_WIDTH = 8;

/**
 * A blank row between the header block and the table.
 *
 * The autofilter and the freeze both key off the header row's index, so the
 * block's height is computed rather than assumed -- a filter caption added
 * later moves the table down, and a hardcoded row number would freeze the
 * wrong line and put the filter on a caption.
 */
const BLANK_ROWS_AFTER_BLOCK = 1;

export class XlsxReportWriter implements ReportWriter {
  readonly format = 'XLSX' as const;
  readonly mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  readonly extension = EXPORT_FORMAT_EXTENSIONS.XLSX;
  readonly supportsSheetFormatting = true;

  private readonly workbook = new ExcelJS.Workbook();
  private sheet: ExcelJS.Worksheet | null = null;
  private columns: readonly ReportColumnSpec[] = [];
  private context: CellContext = { timezone: 'UTC', dateFormat: 'dd-MM-yyyy' };
  private headerRowNumber = 1;

  begin(meta: ReportSheetMeta, columns: readonly ReportColumnSpec[]): void {
    this.columns = columns;
    this.context = { timezone: meta.timezone, dateFormat: meta.dateFormat };

    this.workbook.creator = meta.orgName;
    this.workbook.created = meta.generatedAt;

    /*
     * The sheet is named for the report rather than "Sheet1", because a
     * workbook someone keeps for a year is identified by its tab. Excel
     * forbids the characters square-bracket, asterisk, slash, backslash,
     * question mark and colon in a sheet name, and caps it at 31 characters.
     * It refuses to open the file rather than complaining about the name, so
     * both rules are enforced here instead of trusted.
     */
    const safeName = meta.reportLabel.replace(/[[\]*/\\?:]/gu, ' ').slice(0, 31).trim();
    this.sheet = this.workbook.addWorksheet(safeName.length > 0 ? safeName : 'Report');

    // REQ-J-03's header block: whose data it is, what it is, what was asked
    // for, when it was produced, and how much of it there is.
    this.addBlockRow(meta.orgName, null, { bold: true, size: 14 });
    this.addBlockRow(meta.reportLabel, null, { bold: true });
    for (const caption of meta.captions) {
      this.addBlockRow(caption.label, caption.value);
    }
    this.addBlockRow(
      'Generated',
      `${formatCell(meta.generatedAt.toISOString().slice(0, 10), 'date', this.context)} ${formatCell(
        meta.generatedAt.toISOString(),
        'instant',
        this.context,
      )} ${meta.timezone}`,
    );
    this.addBlockRow('Rows', String(meta.rowCount));

    for (let i = 0; i < BLANK_ROWS_AFTER_BLOCK; i += 1) this.sheet.addRow([]);

    const header = this.sheet.addRow(columns.map((column) => column.header));
    this.headerRowNumber = header.number;
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };
    /*
     * A filled header rather than a border. Borders on a wide sheet turn into
     * a grid the eye has to parse; a single fill reads as one band and
     * survives Excel's own table styles being applied on top.
     */
    for (let index = 1; index <= columns.length; index += 1) {
      header.getCell(index).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
    }

    /*
     * Widths from each column's own hint, which the shell already uses for the
     * on-screen table, so the file and the screen agree about what is wide.
     *
     * `getColumn(n)` rather than iterating `sheet.columns`, which is derived
     * from the widest row written so far. Iterating works here only because the
     * header row above is already the full width; move this loop up one line,
     * above `addRow`, and it would silently set widths on the two columns the
     * header block occupies and leave the rest at Excel's default. Addressing
     * the columns directly does not depend on that ordering.
     */
    for (const [index, column] of columns.entries()) {
      const declared = column.width ?? DEFAULT_COLUMN_WIDTH;
      this.sheet.getColumn(index + 1).width = Math.min(
        Math.max(declared, MIN_COLUMN_WIDTH),
        MAX_COLUMN_WIDTH,
      );
    }

    // Frozen at the header, so scrolling row 4000 still says which column is
    // which. `xSplit: 0` keeps the horizontal scroll free.
    this.sheet.views = [
      {
        state: 'frozen',
        xSplit: 0,
        ySplit: this.headerRowNumber,
        topLeftCell: `A${String(this.headerRowNumber + 1)}`,
      },
    ];

    /*
     * REQ-J-03's "filters applied": the autofilter Excel puts on a header row,
     * so somebody handed the file can narrow it to one department without
     * asking for a new export.
     *
     * Anchored to the header row and the last column rather than to the whole
     * used range -- a filter that includes the header block above would offer
     * the org name as a filterable value of the first column.
     */
    if (columns.length > 0) {
      this.sheet.autoFilter = {
        from: { row: this.headerRowNumber, column: 1 },
        to: { row: this.headerRowNumber, column: columns.length },
      };
    }
  }

  writeRow(cells: readonly ReportCellValue[]): void {
    const sheet = this.sheet;
    if (sheet === null) throw new Error('writeRow called before begin.');

    const row = sheet.addRow([]);
    for (const [index, column] of this.columns.entries()) {
      const value = cells[index] ?? null;
      const cell = row.getCell(index + 1);

      /*
       * A real number for a numeric column, so the reader can sum a column of
       * late minutes without retyping it. Everything else is text in exactly
       * the form the CSV writer produces, so the two files say the same thing
       * about the same row.
       *
       * `duration` is deliberately not numeric: it means minutes and reads as
       * HH:mm, and a bare 90 in a column headed "Worked" would be read as
       * hours by whoever opens it.
       */
      if (column.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
        cell.value = value;
        continue;
      }

      /*
       * Money is a number with a currency format on the cell, never a string
       * with a symbol in front of it -- a string cell is not summable, and a
       * total is the whole reason a finance team opens the file. It arrives
       * as a decimal string because the projection columns are numeric in
       * Postgres, so it is parsed here rather than trusted to be a number.
       *
       * The format carries no symbol on purpose: the export context knows the
       * organisation's timezone and date format but not its currency, and the
       * wrong symbol on every cell is worse than none. The screen is where the
       * symbol belongs.
       */
      if (column.type === 'money') {
        const amount = typeof value === 'number' ? value : Number(value);
        if (value !== null && value !== '' && Number.isFinite(amount)) {
          cell.value = amount;
          cell.numFmt = '#,##0.00';
          continue;
        }
      }

      const text = formatCell(value, column.type, this.context);
      /*
       * Assigned as a string, never through a formula field, so a punch reason
       * beginning "=" is stored as text and Excel shows it rather than
       * evaluating it. This is the xlsx half of the CSV-injection guard in
       * `csvCell` -- and it needs no apostrophe, because an apostrophe in a
       * shared string is a literal character here and would be visible in the
       * cell. `report-writer.test.ts` asserts the cell type, not the display.
       */
      cell.value = text.length > 0 ? text : null;
    }
  }

  async finish(): Promise<Buffer> {
    const written = await this.workbook.xlsx.writeBuffer();
    return Buffer.from(written);
  }

  /** One `label: value` line of the header block, or a lone title. */
  private addBlockRow(
    label: string,
    value: string | null,
    font?: { bold?: boolean; size?: number },
  ): void {
    const sheet = this.sheet;
    if (sheet === null) throw new Error('addBlockRow called before the sheet exists.');
    const row = sheet.addRow(value === null ? [label] : [label, value]);
    if (font) row.getCell(1).font = font;
    else row.getCell(1).font = { bold: true };
  }
}
