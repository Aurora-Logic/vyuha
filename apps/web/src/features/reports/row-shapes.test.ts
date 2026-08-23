import { REPORT_DEFINITIONS, type ReportKey } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { toRowViews } from './types';

/**
 * Every report must have a row shape.
 *
 * `toRowViews` looks its shape up in a partial record and throws when there is
 * none, and `api.ts` turns that throw into the screen's error state -- so a
 * report added to `REPORT_DEFINITIONS` without a shape here compiles, ships,
 * and fails only when someone opens it. `ageing` did exactly that: the report
 * existed on the API and returned rows, and every screen reading it showed an
 * error instead. This test is the compile-time check the partial record cannot
 * give us.
 */
describe('report row shapes', () => {
  const keys = Object.keys(REPORT_DEFINITIONS) as ReportKey[];

  it('covers every report in REPORT_DEFINITIONS', () => {
    const missing = keys.filter((key) => {
      try {
        toRowViews(key, []);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  it('fills the payment analysis verdict, which is derived rather than sent', () => {
    // "Pays on time" is computed from the slippage by `paymentAnalysisCell`;
    // it is not a column the API sends. Routed through the generic record
    // shape, the cell looked up a key that was not there and the column was
    // blank on every screen -- while the exported file, which runs the same
    // cell function on the server, had it filled in.
    const row = {
      partyId: 'p1',
      partyName: 'Asha Traders',
      creditDays: 30,
      avgDaysToPay: 41,
      slippage: 11,
      billsPaid: 4,
      billsOpen: 1,
      oldestOpenDays: 62,
      asOf: '2026-08-23T00:00:00.000Z',
    };
    const [late] = toRowViews('payment-analysis', [row]);
    expect(late?.cells.onTime).toBe('LATE');
    expect(late?.status).toBe('LATE');

    const [onTime] = toRowViews('payment-analysis', [{ ...row, slippage: -2 }]);
    expect(onTime?.cells.onTime).toBe('ON TIME');

    // Nothing settled yet is not a verdict, and must not read as one.
    const [unknown] = toRowViews('payment-analysis', [{ ...row, slippage: null, avgDaysToPay: null, billsPaid: 0 }]);
    expect(unknown?.cells.onTime).toBe('NOT YET KNOWN');
  });
});
