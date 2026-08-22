import {
  ATTENDANCE_REPORTS,
  MAX_EXPORT_RANGE_DAYS,
  MUSTER_GRID_DAYS,
  REPORT_DEFINITIONS,
  REPORT_KEYS,
  absenteeismCell,
  attendanceExceptionCell,
  attendanceRegisterCell,
  defaultVisibleColumns,
  describeFilters,
  exportFileName,
  exportRequestSchema,
  headcountCell,
  isReportKey,
  leaveAvailedCell,
  leaveBalanceCell,
  leaveLedgerCell,
  missingPunchCell,
  musterDayKey,
  musterGridCell,
  punchAuditCell,
  rangeLengthInDays,
  reportFilterSchema,
  reportRowQuerySchema,
  resolveColumns,
  savedViewInputSchema,
  sortableFields,
  type AbsenteeismSource,
  type AttendanceExceptionSource,
  type AttendanceRegisterSource,
  type HeadcountSource,
  type LeaveAvailedSource,
  type LeaveBalanceSource,
  type LeaveLedgerSource,
  type MissingPunchSource,
  type MusterGridSource,
  type PunchAuditSource,
  type ReportCellValue,
  type ReportKey,
} from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

/**
 * One fully populated row per derived report. Fully populated on purpose: the
 * guard below asserts every column extracts something that is not null, which
 * only means anything if the source has something in every field.
 */
const SAMPLES = {
  musterGrid: {
    id: 'emp-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    days: Object.fromEntries(
      Array.from({ length: MUSTER_GRID_DAYS }, (_, index) => [musterDayKey(index + 1), 'P']),
    ),
    presentDays: 22,
    absentDays: 1,
    leaveDays: 2,
    halfDays: 1,
    onDutyDays: 1,
    weeklyOffDays: 4,
    holidayDays: 1,
    workedMinutes: 10_560,
    otMinutes: 120,
    lateDays: 3,
  } satisfies MusterGridSource,

  exception: {
    id: 'emp-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    locationName: 'Head Office',
    occurrences: 4,
    totalMinutes: 48,
    averageMinutes: 12,
    worstMinutes: 21,
    firstDate: '2026-08-03',
    lastDate: '2026-08-27',
  } satisfies AttendanceExceptionSource,

  absenteeism: {
    id: 'emp-1:2026-08',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    locationName: 'Head Office',
    month: '2026-08',
    scheduledDays: 26,
    presentDays: 22,
    leaveDays: 2,
    absentDays: 2,
    absencePercent: 7.7,
  } satisfies AbsenteeismSource,

  missingPunch: {
    id: 'day-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    date: '2026-08-12',
    status: 'PENDING',
    shiftName: 'General',
    punchedInAt: '2026-08-12T03:34:00.000Z',
    punchedOutAt: '2026-08-12T12:41:00.000Z',
    flags: ['missing_punch'],
    regularizationStatus: 'APPROVED',
    regularizationKind: 'MISSING_OUT',
    regularizationDecidedAt: '2026-08-13T05:00:00.000Z',
    regularizationReason: 'Phone battery died',
  } satisfies MissingPunchSource,

  leaveBalance: {
    id: 'emp-1:type-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    leaveTypeCode: 'CL',
    leaveTypeName: 'Casual leave',
    leaveYear: 2026,
    opening: 2,
    accrued: 6,
    availed: 3,
    adjusted: 1,
    carriedForward: 2,
    closing: 8,
  } satisfies LeaveBalanceSource,

  leaveLedger: {
    id: 'ledger-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    leaveTypeCode: 'CL',
    leaveTypeName: 'Casual leave',
    leaveYear: 2026,
    postedAt: '2026-08-13T05:00:00.000Z',
    movementType: 'AVAILED',
    days: -1.5,
    referenceType: 'leave_request',
    periodKey: '2026-08',
    note: 'Approved leave',
  } satisfies LeaveLedgerSource,

  leaveAvailed: {
    id: 'emp-1:type-1',
    employee: { name: 'Asha Menon' },
    employeeCode: 'E-001',
    departmentName: 'Production',
    leaveTypeCode: 'CL',
    leaveTypeName: 'Casual leave',
    isPaid: true,
    requests: 2,
    days: 2.5,
    firstDate: '2026-08-04',
    lastDate: '2026-08-19',
  } satisfies LeaveAvailedSource,

  headcount: {
    id: '2026-08',
    month: '2026-08',
    opening: 214,
    joiners: 6,
    leavers: 2,
    closing: 218,
  } satisfies HeadcountSource,
} as const;

/**
 * One report's extractor bound to one sample row.
 *
 * Generic, so the extractor and the row it is handed have to match -- which is
 * the whole point of the check below and would be lost the moment either side
 * were widened to `unknown` to make the list homogeneous.
 */
function coverage<T>(
  key: ReportKey,
  cell: (row: T, columnKey: string) => ReportCellValue,
  row: T,
): { key: ReportKey; read: (columnKey: string) => ReportCellValue } {
  return { key, read: (columnKey) => cell(row, columnKey) };
}

/**
 * The report contract, which is shared between the screen and the exporter.
 *
 * Worth testing on its own because the whole design rests on one claim: the
 * cell the table renders and the cell the file writes come from the same
 * function. If these extractors drift from the column definitions, the
 * spreadsheet quietly disagrees with the screen and nothing fails.
 */

describe('the report catalogue', () => {
  it('gives every report a definition and every definition a default sort it can honour', () => {
    for (const key of REPORT_KEYS) {
      const definition = REPORT_DEFINITIONS[key];
      expect(definition.key).toBe(key);
      expect(definition.columns.length).toBeGreaterThan(0);

      const allowed = new Set(sortableFields(key));
      for (const term of definition.defaultSort.split(',')) {
        expect(allowed).toContain(term.replace(/^-/u, ''));
      }
    }
  });

  it('gives every column a unique key', () => {
    for (const key of REPORT_KEYS) {
      const keys = REPORT_DEFINITIONS[key].columns.map((column) => column.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  /**
   * The guard the design actually needs. A column whose key no extractor
   * understands renders as an empty cell everywhere, on screen and in the
   * file, and nothing anywhere reports it.
   */
  it('has an extractor for every column of every report', () => {
    const day: AttendanceRegisterSource = {
      employee: { name: 'Asha Menon' },
      employeeCode: 'E-001',
      date: '2026-08-01',
      status: 'PRESENT',
      shift: { name: 'General' },
      scheduledIn: '2026-08-01T03:30:00.000Z',
      scheduledOut: '2026-08-01T12:30:00.000Z',
      firstInAt: '2026-08-01T03:34:00.000Z',
      lastOutAt: '2026-08-01T12:41:00.000Z',
      workedMinutes: 487,
      breakMinutes: 30,
      otMinutes: 11,
      lateMinutes: 4,
      earlyExitMinutes: 0,
      flags: ['late'],
      isManualOverride: false,
      locked: true,
    };

    for (const column of REPORT_DEFINITIONS['attendance-register'].columns) {
      expect(
        attendanceRegisterCell(day, column.key),
        `no extractor for attendance-register column "${column.key}"`,
      ).not.toBeNull();
    }

    const punch: PunchAuditSource = {
      employee: { name: 'Asha Menon' },
      employeeCode: 'E-001',
      attendanceDate: '2026-08-01',
      type: 'IN',
      serverTime: '2026-08-01T03:34:00.000Z',
      clientTime: '2026-08-01T03:33:58.000Z',
      clockSkewSeconds: 2,
      syncDelaySeconds: 0,
      source: 'MOBILE',
      location: { latitude: 12.9716, longitude: 77.5946, accuracyM: 8, distanceFromGeofenceM: 14 },
      isHalfDayMarked: true,
      halfDayPart: 'FIRST_HALF',
      reason: 'Client site',
      flags: ['outside_geofence'],
    };

    for (const column of REPORT_DEFINITIONS['punch-audit'].columns) {
      expect(
        punchAuditCell(punch, column.key),
        `no extractor for punch-audit column "${column.key}"`,
      ).not.toBeNull();
    }

    // The daily muster reads the register's rows, so it must not name a column
    // the register's extractor has never heard of.
    for (const column of REPORT_DEFINITIONS['daily-muster'].columns) {
      expect(
        attendanceRegisterCell(day, column.key),
        `no extractor for daily-muster column "${column.key}"`,
      ).not.toBeNull();
    }
  });

  /**
   * The same guard for the reports that aggregate, which need it more: their
   * rows exist only for them, so a column key and a query column that drift
   * apart produce an empty column on screen and in the file, and nothing
   * anywhere reports it.
   */
  it('has an extractor for every column of every derived report', () => {
    const cases = [
      coverage('monthly-muster', musterGridCell, SAMPLES.musterGrid),
      coverage('late-arrivals', attendanceExceptionCell, SAMPLES.exception),
      coverage('early-exits', attendanceExceptionCell, SAMPLES.exception),
      coverage('overtime', attendanceExceptionCell, SAMPLES.exception),
      coverage('absenteeism', absenteeismCell, SAMPLES.absenteeism),
      coverage('missing-punch', missingPunchCell, SAMPLES.missingPunch),
      coverage('leave-balance', leaveBalanceCell, SAMPLES.leaveBalance),
      coverage('leave-ledger', leaveLedgerCell, SAMPLES.leaveLedger),
      coverage('leave-availed', leaveAvailedCell, SAMPLES.leaveAvailed),
      coverage('headcount', headcountCell, SAMPLES.headcount),
    ];

    // Every report with a derived row shape is covered, so a report added
    // without a sample here fails rather than going unchecked.
    const covered = new Set<ReportKey>(cases.map((entry) => entry.key));
    const readModelBacked: readonly ReportKey[] = [
      'attendance-register',
      'daily-muster',
      'punch-audit',
    ];
    // Another module's reports carry their own extractors beside their own
    // source (the Tally group's live in `platform/masters`); this file holds
    // attendance's to account.
    for (const key of ATTENDANCE_REPORTS.map((report) => report.key)) {
      if (readModelBacked.includes(key)) continue;
      expect(covered, `report "${key}" has no extractor sample`).toContain(key);
    }

    for (const entry of cases) {
      for (const column of REPORT_DEFINITIONS[entry.key].columns) {
        expect(
          entry.read(column.key),
          `no extractor for ${entry.key} column "${column.key}"`,
        ).not.toBeNull();
      }
    }
  });

  it('reads a muster grid day out of the day map and nothing else', () => {
    expect(musterGridCell(SAMPLES.musterGrid, 'd01')).toBe('P');
    // Not a day key, and not a column: the regex must not swallow it.
    expect(musterGridCell(SAMPLES.musterGrid, 'd32')).toBeNull();
    expect(musterGridCell(SAMPLES.musterGrid, 'd0')).toBeNull();
    expect(musterGridCell({ ...SAMPLES.musterGrid, days: {} }, 'd05')).toBeNull();
  });

  it('leaves a day with no correction empty rather than calling it "none"', () => {
    const raised = missingPunchCell(SAMPLES.missingPunch, 'regularizationStatus');
    expect(raised).toBe('APPROVED');
    expect(
      missingPunchCell(
        { ...SAMPLES.missingPunch, regularizationStatus: null },
        'regularizationStatus',
      ),
    ).toBeNull();
  });

  it('reads a coordinate pair as one cell and an absent location as empty', () => {
    const base: PunchAuditSource = {
      employee: { name: 'A' },
      employeeCode: 'E',
      attendanceDate: '2026-08-01',
      type: 'IN',
      serverTime: '2026-08-01T03:34:00.000Z',
      clientTime: null,
      clockSkewSeconds: null,
      syncDelaySeconds: null,
      source: 'WEB',
      location: null,
      isHalfDayMarked: false,
      halfDayPart: null,
      reason: null,
      flags: [],
    };
    expect(punchAuditCell(base, 'location')).toBeNull();
    expect(punchAuditCell(base, 'gpsAccuracyM')).toBeNull();
    expect(
      punchAuditCell(
        { ...base, location: { latitude: 12.9716, longitude: 77.5946, accuracyM: null, distanceFromGeofenceM: null } },
        'location',
      ),
    ).toBe('12.97160, 77.59460');
  });

  it('drops an unknown key rather than inventing a value', () => {
    const day = { flags: [] } as unknown as AttendanceRegisterSource;
    expect(attendanceRegisterCell(day, 'salary')).toBeNull();
  });
});

describe('column selection', () => {
  it('hides the default-hidden columns until they are asked for', () => {
    const visible = defaultVisibleColumns('attendance-register');
    expect(visible).toContain('status');
    expect(visible).not.toContain('locked');
  });

  it('keeps the report order regardless of the order the request lists', () => {
    // A saved view holding a shuffled list must not be able to reorder a sheet
    // somebody reads positionally.
    const resolved = resolveColumns('attendance-register', ['status', 'date', 'employeeCode']);
    expect(resolved.map((column) => column.key)).toEqual(['date', 'employeeCode', 'status']);
  });

  it('ignores an unknown column instead of refusing the whole export', () => {
    const resolved = resolveColumns('attendance-register', ['date', 'leaveTypeThatDoesNotExist']);
    expect(resolved.map((column) => column.key)).toEqual(['date']);
  });

  it('falls back to the defaults when a selection resolves to nothing', () => {
    // Otherwise a stale saved view produces a file with a header row and no
    // columns, which reads as an export that silently failed.
    expect(resolveColumns('attendance-register', ['nothing-real'])).toEqual(
      resolveColumns('attendance-register', undefined),
    );
    expect(resolveColumns('attendance-register', []).length).toBeGreaterThan(0);
  });
});

describe('the filter caption block', () => {
  it('names the ids it was given labels for and falls back to the id otherwise', () => {
    const captions = describeFilters(
      { from: '2026-08-01', to: '2026-08-31', departmentId: 'dept-1', employeeId: 'emp-9' },
      { 'dept-1': 'Production' },
    );
    expect(captions).toContainEqual({ label: 'Period', value: '2026-08-01 to 2026-08-31' });
    expect(captions).toContainEqual({ label: 'Department', value: 'Production' });
    expect(captions).toContainEqual({ label: 'Employee', value: 'emp-9' });
  });

  it('says "none" rather than printing an empty block', () => {
    expect(describeFilters({})).toEqual([{ label: 'Filters', value: 'none' }]);
  });

  it('names whose statement it is', () => {
    // A customer statement cannot be asked for without a party, so a file
    // that captioned only the period was several hundred rows belonging to
    // nobody in particular.
    const captions = describeFilters({ from: '2026-08-01', to: '2026-08-31', partyId: 'party-7' }, { 'party-7': 'Asha Traders' });
    expect(captions).toContainEqual({ label: 'Party', value: 'Asha Traders' });
    expect(captions).not.toContainEqual({ label: 'Filters', value: 'none' });
  });

  it('captions every Tally-side filter a report can carry', () => {
    const captions = describeFilters({
      partyId: 'party-7',
      ledgerName: 'Sales',
      itemName: 'Cat6 Cable Box',
      voucherType: 'Receipt',
      groupBy: 'itemGroup',
    });
    expect(captions).toEqual([
      { label: 'Party', value: 'party-7' },
      { label: 'Ledger', value: 'Sales' },
      { label: 'Item', value: 'Cat6 Cable Box' },
      { label: 'Voucher type', value: 'Receipt' },
      { label: 'Grouped by', value: 'By item group' },
    ]);
  });

  it('every filter the schema accepts reaches the caption block', () => {
    // The five above were missing for as long as they have existed. Reading
    // the schema's own keys means the next filter added cannot be silently
    // left out of the file people print.
    const everyFilter = {
      from: '2026-08-01',
      to: '2026-08-31',
      employeeId: '01900000-0000-7000-8000-000000000001',
      departmentId: '01900000-0000-7000-8000-000000000002',
      locationId: '01900000-0000-7000-8000-000000000003',
      status: 'PRESENT',
      flags: 'LATE',
      punchType: 'IN',
      partyId: '01900000-0000-7000-8000-000000000004',
      groupBy: 'month',
      voucherType: 'Sales',
      ledgerName: 'Sales',
      itemName: 'Widget',
    } as const;
    const parsed = reportFilterSchema.parse(everyFilter);
    const captions = describeFilters(parsed);
    // `from` and `to` share one caption; every other key earns its own.
    expect(captions).toHaveLength(Object.keys(parsed).length - 1);
  });
});

describe('the export request', () => {
  const valid = {
    reportKey: 'attendance-register',
    filters: { from: '2026-08-01', to: '2026-08-31' },
  };

  it('accepts a bounded period and defaults the format', () => {
    const parsed = exportRequestSchema.parse(valid);
    expect(parsed.format).toBe('CSV');
  });

  it('refuses a period that ends before it starts', () => {
    const result = exportRequestSchema.safeParse({
      ...valid,
      filters: { from: '2026-08-31', to: '2026-08-01' },
    });
    expect(result.success).toBe(false);
  });

  it(`refuses a period longer than ${String(MAX_EXPORT_RANGE_DAYS)} days`, () => {
    expect(
      exportRequestSchema.safeParse({
        ...valid,
        filters: { from: '2020-01-01', to: '2026-01-01' },
      }).success,
    ).toBe(false);
  });

  it('requires a period at all, unlike the on-screen filter', () => {
    expect(exportRequestSchema.safeParse({ ...valid, filters: {} }).success).toBe(false);
    expect(reportRowQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts both formats that have a writer, and refuses anything else', () => {
    // Both are offerable now that `XlsxReportWriter` exists. The rule the two
    // lists encode has not changed: `AVAILABLE_EXPORT_FORMATS` is what a client
    // may ask for, and a format may sit in `EXPORT_FORMATS` long before
    // anything can write it -- accepting one that cannot produces a job that
    // fails after the requester has walked away.
    expect(exportRequestSchema.safeParse({ ...valid, format: 'XLSX' }).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...valid, format: 'CSV' }).success).toBe(true);
    expect(exportRequestSchema.safeParse({ ...valid, format: 'PDF' }).success).toBe(false);
  });

  it('refuses an unknown report', () => {
    expect(exportRequestSchema.safeParse({ ...valid, reportKey: 'payroll-input' }).success).toBe(
      false,
    );
    expect(isReportKey('payroll-input')).toBe(false);
  });
});

describe('period arithmetic', () => {
  it('counts both ends of the range', () => {
    expect(rangeLengthInDays('2026-08-01', '2026-08-01')).toBe(1);
    expect(rangeLengthInDays('2026-08-01', '2026-08-31')).toBe(31);
    // Across a leap day, which a naive month-difference gets wrong.
    expect(rangeLengthInDays('2024-02-28', '2024-03-01')).toBe(3);
  });

  it('returns null for a date it cannot read', () => {
    expect(rangeLengthInDays('not-a-date', '2026-08-31')).toBeNull();
  });
});

describe('the produced filename', () => {
  it('is sortable, has no spaces, and carries the format', () => {
    expect(exportFileName('attendance-register', new Date('2026-08-13T09:30:00.000Z'), 'CSV')).toBe(
      'attendance-register-2026-08-13-0930.csv',
    );
  });
});

describe('a saved view', () => {
  it('defaults its config so an empty view is still usable', () => {
    const parsed = savedViewInputSchema.parse({
      reportKey: 'punch-audit',
      name: '  Last week  ',
      config: {},
    });
    expect(parsed.name).toBe('Last week');
    expect(parsed.isShared).toBe(false);
    expect(parsed.config).toEqual({ filters: {}, columns: [] });
  });

  it('refuses a nameless view', () => {
    expect(
      savedViewInputSchema.safeParse({ reportKey: 'punch-audit', name: '   ', config: {} }).success,
    ).toBe(false);
  });
});
