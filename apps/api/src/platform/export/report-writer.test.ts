import { REPORT_DEFINITIONS, type ReportColumnSpec } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import {
  CsvReportWriter,
  csvCell,
  formatCalendarDate,
  formatCell,
  formatDurationMinutes,
  formatInstant,
  writerFor,
} from './report-writer.js';

/**
 * The file an export produces, without a database.
 *
 * These are the assertions worth having in a unit test because they are about
 * bytes: a formula that executes when the file is opened, a half-hour timezone
 * that shifts a punch into the previous day, a quote that ends a field early.
 * None of them is visible from an integration test that only checks the job
 * completed.
 */

const IST = 'Asia/Kolkata';

describe('cell formatting', () => {
  it('renders a UTC instant on the organisation wall clock, half-hour offset included', () => {
    // 18:45 UTC is 00:15 the next morning in India. Getting this wrong by
    // treating the offset as whole hours is the classic version of the bug.
    expect(formatInstant('2026-08-12T18:45:30.000Z', IST, false)).toBe('00:15');
    expect(formatInstant('2026-08-12T18:45:30.000Z', IST, true)).toBe('00:15:30');
    expect(formatInstant('2026-08-12T18:45:30.000Z', 'UTC', true)).toBe('18:45:30');
  });

  it('returns empty for an unparseable instant rather than "Invalid Date"', () => {
    expect(formatInstant('not-a-time', IST, false)).toBe('');
  });

  it('writes a calendar date in the organisation format', () => {
    expect(formatCalendarDate('2026-08-12', 'dd-MM-yyyy')).toBe('12-08-2026');
    expect(formatCalendarDate('2026-08-12', 'dd/MM/yyyy')).toBe('12/08/2026');
    // An unknown pattern keeps the unambiguous stored form rather than guessing.
    expect(formatCalendarDate('2026-08-12', 'MMMM do')).toBe('2026-08-12');
    expect(formatCalendarDate('rubbish', 'dd-MM-yyyy')).toBe('rubbish');
  });

  it('writes durations as HH:mm and a zero as nothing', () => {
    expect(formatDurationMinutes(492)).toBe('08:12');
    expect(formatDurationMinutes(59)).toBe('00:59');
    expect(formatDurationMinutes(0)).toBe('');
    expect(formatDurationMinutes(-5)).toBe('');
    expect(formatDurationMinutes(Number.NaN)).toBe('');
  });

  it('renders booleans, arrays and nulls without leaking JavaScript spellings', () => {
    const context = { timezone: IST, dateFormat: 'dd-MM-yyyy' };
    expect(formatCell(true, 'text', context)).toBe('Yes');
    expect(formatCell(false, 'text', context)).toBe('No');
    expect(formatCell(null, 'text', context)).toBe('');
    expect(formatCell(['late', 'missing_punch'], 'flags', context)).toBe('late; missing_punch');
    expect(formatCell([], 'flags', context)).toBe('');
  });
});

describe('CSV quoting', () => {
  it('quotes separators, newlines and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it('neutralises a cell a spreadsheet would execute as a formula', () => {
    // Security §15, data leakage in exports. A punch reason is free text an
    // employee typed, and this one runs a shell command when the file is
    // opened in Excel with legacy DDE enabled.
    expect(csvCell('=cmd|\' /c calc\'!A1')).toBe("'=cmd|' /c calc'!A1");
    expect(csvCell('+1234')).toBe("'+1234");
    expect(csvCell('-1234')).toBe("'-1234");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    // ...and a genuine value that merely starts with a digit is untouched.
    expect(csvCell('1234')).toBe('1234');
  });
});

describe('the CSV writer', () => {
  const columns: ReportColumnSpec[] = [
    { key: 'date', header: 'Date', type: 'date' },
    { key: 'employeeName', header: 'Employee', type: 'text' },
    { key: 'workedMinutes', header: 'Worked', type: 'duration' },
    { key: 'flags', header: 'Flags', type: 'flags' },
  ];

  async function write(): Promise<string> {
    const writer = new CsvReportWriter();
    writer.begin(
      {
        orgName: 'Vyuha Engineering, Pvt',
        reportLabel: REPORT_DEFINITIONS['attendance-register'].label,
        captions: [
          { label: 'Period', value: '2026-08-01 to 2026-08-31' },
          { label: 'Department', value: 'Production' },
        ],
        generatedAt: new Date('2026-08-13T09:30:00.000Z'),
        timezone: IST,
        dateFormat: 'dd-MM-yyyy',
        rowCount: 2,
      },
      columns,
    );
    writer.writeRow(['2026-08-01', 'Asha Menon', 492, ['late']]);
    writer.writeRow(['2026-08-02', 'O\'Brien, Sean', 0, []]);
    return (await writer.finish()).toString('utf8');
  }

  it('opens with the REQ-J-03 header block: org, report, filters, generated, count', async () => {
    const lines = (await write()).split('\r\n');

    // Quoted, because the organisation's own name contains a comma. An
    // unquoted header line would split the name across two cells.
    expect(lines[0]).toBe('﻿"Vyuha Engineering, Pvt"');
    expect(lines[1]).toBe('Attendance register');
    expect(lines[2]).toBe('Period,2026-08-01 to 2026-08-31');
    expect(lines[3]).toBe('Department,Production');
    // 09:30 UTC is 15:00 IST, and the timezone is named so the reader is not
    // left guessing which clock the file was produced on.
    expect(lines[4]).toBe('Generated,13-08-2026 15:00:00 Asia/Kolkata');
    expect(lines[5]).toBe('Rows,2');
    expect(lines[6]).toBe('');
    expect(lines[7]).toBe('Date,Employee,Worked,Flags');
  });

  it('writes the rows with the header block above them, formatted by column type', async () => {
    const lines = (await write()).split('\r\n');
    expect(lines[8]).toBe('01-08-2026,Asha Menon,08:12,late');
    // Zero worked minutes is an empty cell, not "00:00" on a weekly off.
    expect(lines[9]).toBe("02-08-2026,\"O'Brien, Sean\",,");
  });

  it('starts with a BOM so Excel reads the file as UTF-8', async () => {
    expect((await write()).charCodeAt(0)).toBe(0xfeff);
  });

  it('reports honestly that it cannot freeze a header or set column widths', () => {
    // REQ-J-03 asks for both. The writer says it cannot rather than the export
    // silently dropping half the requirement.
    expect(new CsvReportWriter().supportsSheetFormatting).toBe(false);
  });

  it('pads a row that is shorter than the column set instead of shifting cells', async () => {
    const writer = new CsvReportWriter();
    writer.begin(
      {
        orgName: 'Org',
        reportLabel: 'R',
        captions: [],
        generatedAt: new Date('2026-08-13T00:00:00.000Z'),
        timezone: 'UTC',
        dateFormat: 'dd-MM-yyyy',
        rowCount: 1,
      },
      columns,
    );
    writer.writeRow(['2026-08-01']);
    const lines = (await writer.finish()).toString('utf8').split('\r\n');
    expect(lines[lines.length - 2]).toBe('01-08-2026,,,');
  });
});

describe('the writer factory', () => {
  it('produces a CSV writer', () => {
    expect(writerFor('CSV').format).toBe('CSV');
    expect(writerFor('CSV').extension).toBe('csv');
  });

  it('produces an XLSX writer, which is the one that can format a sheet', () => {
    const writer = writerFor('XLSX');
    expect(writer.format).toBe('XLSX');
    expect(writer.extension).toBe('xlsx');
    // The flag REQ-J-03's frozen header and column widths hang off. CSV says
    // false and says so honestly; this is the writer that has to say true.
    expect(writer.supportsSheetFormatting).toBe(true);
    expect(writerFor('CSV').supportsSheetFormatting).toBe(false);
  });
});

describe('money in the CSV', () => {
  /**
   * The other half of the xlsx rule.
   *
   * A symbol or a thousands comma would stop the column being a number to
   * whatever opens the file, and a comma inside a field has to be quoted on
   * top of that. The header names the unit; the cell is the figure.
   */
  it('writes the bare figure, with no symbol and no grouping', async () => {
    const writer = new CsvReportWriter();
    writer.begin(
      {
        orgName: 'G C Communication',
        reportLabel: 'Ageing',
        captions: [],
        generatedAt: new Date('2026-08-13T09:30:00.000Z'),
        timezone: IST,
        dateFormat: 'dd-MM-yyyy',
        rowCount: 1,
      },
      [
        { key: 'partyName', header: 'Party', type: 'text' },
        { key: 'outstanding', header: 'Outstanding', type: 'money' },
      ],
    );
    writer.writeRow(['Nashik Switchgear Traders', '1587620.00']);
    const body = (await writer.finish()).toString('utf8');

    expect(body).toContain('1587620.00');
    expect(body).not.toContain('₹');
    expect(body).not.toContain('15,87,620');
  });
});
