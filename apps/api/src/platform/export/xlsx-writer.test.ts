import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { ReportColumnSpec } from '@vyuha/shared';

import { XlsxReportWriter } from './xlsx-writer.js';

/**
 * REQ-J-03, checked by reading the workbook back rather than by trusting the
 * calls that built it.
 *
 * The requirement names five things -- "frozen header, filters applied, column
 * widths set, org name and filter criteria in a header block, generated-at
 * timestamp" -- and every one of them is a property of the file, not of this
 * code. Asserting that `sheet.views` was assigned proves the assignment
 * happened; parsing the produced bytes proves the file Excel opens has a frozen
 * pane. Only the second one can fail when exceljs changes its mind about how a
 * view is serialised.
 */

const IST = 'Asia/Kolkata';

const columns: readonly ReportColumnSpec[] = [
  { key: 'date', header: 'Date', type: 'date', width: 12 },
  { key: 'employeeName', header: 'Employee', type: 'text', width: 28 },
  { key: 'workedMinutes', header: 'Worked', type: 'duration', width: 10 },
  { key: 'lateMinutes', header: 'Late minutes', type: 'number', width: 14 },
  { key: 'outstanding', header: 'Outstanding', type: 'money', width: 14 },
  { key: 'flags', header: 'Flags', type: 'flags' },
];

/** Builds a one-sheet workbook and hands back the parsed result. */
async function build(
  rows: readonly (readonly unknown[])[] = [
    ['2026-08-01', 'Asha Menon', 492, 15, '1587620.00', ['late']],
    ['2026-08-02', "O'Brien, Sean", 0, 0, '0.00', []],
  ],
): Promise<{ book: ExcelJS.Workbook; sheet: ExcelJS.Worksheet }> {
  const writer = new XlsxReportWriter();
  writer.begin(
    {
      orgName: 'G C Communication, Nashik',
      reportLabel: 'Late Arrivals',
      captions: [
        { label: 'Period', value: '01-08-2026 to 31-08-2026' },
        { label: 'Department', value: 'Finance' },
      ],
      generatedAt: new Date('2026-08-15T09:30:00.000Z'),
      timezone: IST,
      dateFormat: 'dd-MM-yyyy',
      rowCount: rows.length,
    },
    columns,
  );
  for (const row of rows) writer.writeRow(row as never);

  const bytes = await writer.finish();
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = book.worksheets[0];
  if (sheet === undefined) throw new Error('The workbook has no sheet.');
  return { book, sheet };
}

/** The row the column headers are on, found rather than assumed. */
function headerRowNumber(sheet: ExcelJS.Worksheet): number {
  let found = 0;
  sheet.eachRow((row, number) => {
    if (found === 0 && row.getCell(1).text === 'Date') found = number;
  });
  if (found === 0) throw new Error('No header row in the sheet.');
  return found;
}

describe('the Excel workbook an export produces (REQ-J-03)', () => {
  it('is a real xlsx that a spreadsheet can open', async () => {
    // The zip signature. A CSV renamed .xlsx -- the substitution the factory
    // refused to make for months -- fails right here.
    const writer = new XlsxReportWriter();
    writer.begin(
      {
        orgName: 'Org',
        reportLabel: 'R',
        captions: [],
        generatedAt: new Date('2026-08-15T00:00:00.000Z'),
        timezone: 'UTC',
        dateFormat: 'dd-MM-yyyy',
        rowCount: 0,
      },
      columns,
    );
    const bytes = await writer.finish();
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('names the sheet after the report rather than leaving it Sheet1', async () => {
    const { sheet } = await build();
    expect(sheet.name).toBe('Late Arrivals');
  });

  it('opens with the header block: org, report, every filter, generated, count', async () => {
    const { sheet } = await build();
    const lines: string[] = [];
    sheet.eachRow((row, number) => {
      if (number < headerRowNumber(sheet)) {
        lines.push([row.getCell(1).text, row.getCell(2).text].filter(Boolean).join(' | '));
      }
    });

    expect(lines[0]).toBe('G C Communication, Nashik');
    expect(lines[1]).toBe('Late Arrivals');
    expect(lines).toContain('Period | 01-08-2026 to 31-08-2026');
    expect(lines).toContain('Department | Finance');
    // REQ-J-03's generated-at, on the organisation's clock (NFR-05): 09:30 UTC
    // is 15:00 in Asia/Kolkata, and the half-hour offset is where a hand-rolled
    // conversion would land on 14:30.
    expect(lines.some((line) => line.startsWith('Generated | 15-08-2026 15:00:00 Asia/Kolkata'))).toBe(
      true,
    );
    expect(lines).toContain('Rows | 2');
  });

  it('freezes the header row, so row 4000 still says which column is which', async () => {
    const { sheet } = await build();
    const view = sheet.views[0];
    expect(view?.state).toBe('frozen');
    // `views` is typed as a union across the pane modes, and `ySplit` exists
    // only on the frozen one, so this narrows rather than casts -- a cast would
    // keep compiling if the file came back with no frozen pane at all.
    if (view === undefined || view.state !== 'frozen') throw new Error('The pane is not frozen.');
    // Frozen *at* the header, not above it: a ySplit one row short leaves the
    // headers scrolling away, which is the failure this requirement names.
    expect(view.ySplit).toBe(headerRowNumber(sheet));
  });

  /*
   * REQ-J-03's "filters applied".
   *
   * Asserted on the round-tripped value, which is an A1 range string --
   * exceljs accepts the `{from, to}` object it is given and writes a range into
   * the file. Asserting the object we passed in would only prove the assignment
   * ran; this proves what the file says, which is what Excel reads.
   */
  it('puts the autofilter on the header row and nothing above it', async () => {
    const { sheet } = await build();
    const header = headerRowNumber(sheet);
    const lastColumn = String.fromCharCode('A'.charCodeAt(0) + columns.length - 1);
    // Starts at the header, not row 1: a range covering the block would offer
    // the organisation's own name as a filterable value of the Date column.
    expect(sheet.autoFilter).toBe(`A${String(header)}:${lastColumn}${String(header)}`);
  });

  it('gives every column its declared width, and the default to one with none', async () => {
    // The last column declares no width, so 16 here is `DEFAULT_COLUMN_WIDTH`
    // arriving rather than Excel's own default of about 8. That is the part
    // worth asserting: a column with no hint still has to be readable.
    const { sheet } = await build();
    const widths = columns.map((_, index) => sheet.getColumn(index + 1).width);
    expect(widths).toEqual([12, 28, 10, 14, 14, 16]);
  });

  it('writes the rows below the header, formatted by column type', async () => {
    const { sheet } = await build();
    const first = sheet.getRow(headerRowNumber(sheet) + 1);
    expect(first.getCell(1).text).toBe('01-08-2026');
    expect(first.getCell(2).text).toBe('Asha Menon');
    // 492 minutes as HH:mm, the same as the CSV writer produces.
    expect(first.getCell(3).text).toBe('08:12');
    expect(first.getCell(6).text).toBe('late');
  });

  it('writes a numeric column as a number, so a reader can sum it', async () => {
    const { sheet } = await build();
    const cell = sheet.getRow(headerRowNumber(sheet) + 1).getCell(4);
    expect(cell.type).toBe(ExcelJS.ValueType.Number);
    expect(cell.value).toBe(15);
  });

  it('leaves a zero duration empty, because a weekly off did not work zero hours', async () => {
    const { sheet } = await build();
    expect(sheet.getRow(headerRowNumber(sheet) + 2).getCell(3).text).toBe('');
  });

  /**
   * The xlsx half of the CSV-injection guard.
   *
   * A cell beginning `=` is executed when the file is opened, and a punch
   * reason is free text an employee typed. In a workbook the neutralisation is
   * not an apostrophe -- that would be a literal character in the cell -- it is
   * that the value is stored as a string rather than as a formula. This asserts
   * the stored type, which is the thing Excel acts on.
   */
  it('stores a value beginning with = as text, never as a formula', async () => {
    const { sheet } = await build([['2026-08-01', '=1+1', 0, 0, []]]);
    const cell = sheet.getRow(headerRowNumber(sheet) + 1).getCell(2);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.formula).toBeUndefined();
    expect(cell.text).toBe('=1+1');
  });

  it('survives a report label Excel would refuse as a sheet name', async () => {
    const writer = new XlsxReportWriter();
    writer.begin(
      {
        // Every character Excel forbids, plus more than the 31 it allows.
        orgName: 'Org',
        reportLabel: 'Muster [2026]: in/out \\ late? *everything* and then some more',
        captions: [],
        generatedAt: new Date('2026-08-15T00:00:00.000Z'),
        timezone: 'UTC',
        dateFormat: 'dd-MM-yyyy',
        rowCount: 0,
      },
      columns,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await writer.finish()) as unknown as ArrayBuffer);
    const name = book.worksheets[0]?.name ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]*/\\?:]/u);
  });

  it('produces a file with no rows without failing', async () => {
    // An export of a period nobody worked is a legitimate answer, and the
    // header block still has to state the filters that produced nothing.
    const { sheet } = await build([]);
    expect(sheet.getRow(headerRowNumber(sheet) + 1).getCell(1).text).toBe('');
  });

  /**
   * The whole reason a finance team opens the sheet.
   *
   * Money arrives from the projection as a decimal string, and a string cell
   * is not summable -- select the column and Excel offers no total. It is
   * written as a number with a currency format instead, so the figure reads
   * as money and still adds up. The symbol is deliberately absent from the
   * format: the export knows the organisation's timezone and date format but
   * not its currency, and a wrong symbol on every cell is worse than none.
   */
  it('writes a money column as a number a SUM can reach, not as text', async () => {
    const { sheet } = await build();
    const header = headerRowNumber(sheet);
    const cell = sheet.getRow(header + 1).getCell(5);

    expect(typeof cell.value).toBe('number');
    expect(cell.value).toBe(1587620);
    expect(cell.numFmt).toBe('#,##0.00');
  });

  it('leaves a zero amount as a zero rather than an empty cell', async () => {
    const { sheet } = await build();
    const header = headerRowNumber(sheet);
    expect(sheet.getRow(header + 2).getCell(5).value).toBe(0);
  });
});