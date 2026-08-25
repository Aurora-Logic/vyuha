import { describe, expect, it } from 'vitest';

import { buildPartyDailySeries, openBillsThrough, type PartyDay } from './bill-series.js';

/**
 * Hand-worked fixtures for the open-bill ledger. The daily-series cases
 * moved here from `interest-math.test.ts` unchanged when the construction
 * was lifted to platform — every expected number predates the move, so a
 * green run proves the lift changed where the arithmetic lives and nothing
 * about what it says.
 */

function day(series: readonly PartyDay[], date: string): PartyDay {
  const found = series.find((entry) => entry.date === date);
  if (found === undefined) throw new Error(`No day ${date} in the series.`);
  return found;
}

function sums(series: readonly PartyDay[]): { within: number; overdue: number; closing: number } {
  return series.reduce(
    (acc, entry) => ({
      within: acc.within + entry.withinCredit,
      overdue: acc.overdue + entry.overdue,
      closing: acc.closing + entry.closing,
    }),
    { within: 0, overdue: 0, closing: 0 },
  );
}

describe('the receivable daily series, voucher-grain', () => {
  const base = { seriesStart: '2026-01-01', to: '2026-01-31', openingBalance: 0, creditDays: 10 };

  it('splits an unpaid bill into 11 within-credit days and 20 overdue days', () => {
    const series = buildPartyDailySeries({
      ...base,
      bills: [{ date: '2026-01-01', amount: 10_000 }],
      settlements: [],
    });
    // Ages 0..10 are within terms (11 days), 11..30 are overdue (20 days).
    expect(day(series, '2026-01-11').withinCredit).toBe(10_000);
    expect(day(series, '2026-01-11').overdue).toBe(0);
    expect(day(series, '2026-01-12').withinCredit).toBe(0);
    expect(day(series, '2026-01-12').overdue).toBe(10_000);
    expect(sums(series)).toEqual({ within: 110_000, overdue: 200_000, closing: 310_000 });
  });

  it('a part payment reduces the series from its own date, never before', () => {
    const series = buildPartyDailySeries({
      ...base,
      bills: [{ date: '2026-01-01', amount: 10_000 }],
      settlements: [{ date: '2026-01-05', amount: 4_000 }],
    });
    expect(day(series, '2026-01-04').closing).toBe(10_000);
    expect(day(series, '2026-01-05').closing).toBe(6_000);
    expect(day(series, '2026-01-31').overdue).toBe(6_000);
  });

  it('a credit note mid-period behaves the same way: forward, not retroactive', () => {
    // A credit note is a settlement event dated its own date; the days the
    // money was genuinely outstanding keep their cost.
    const series = buildPartyDailySeries({
      ...base,
      bills: [{ date: '2026-01-01', amount: 10_000 }],
      settlements: [{ date: '2026-01-20', amount: 10_000 }],
    });
    expect(day(series, '2026-01-19').overdue).toBe(10_000);
    expect(day(series, '2026-01-20').closing).toBe(0);
    // 11 within days plus 8 overdue days (ages 11..18) were still real.
    expect(sums(series)).toEqual({ within: 110_000, overdue: 80_000, closing: 190_000 });
  });

  it('an advance closes negative and rides in overdue as interest gained, never clamped', () => {
    const series = buildPartyDailySeries({
      ...base,
      bills: [{ date: '2026-01-06', amount: 3_000 }],
      settlements: [{ date: '2026-01-03', amount: 5_000 }],
    });
    expect(day(series, '2026-01-02').closing).toBe(0);
    expect(day(series, '2026-01-03')).toMatchObject({ closing: -5_000, withinCredit: 0, overdue: -5_000 });
    // The bill consumes the advance before it ages at all.
    expect(day(series, '2026-01-06')).toMatchObject({ closing: -2_000, withinCredit: 0, overdue: -2_000 });
  });

  it('an opening balance seeds the series start as a bill of that date', () => {
    const series = buildPartyDailySeries({
      seriesStart: '2026-01-01',
      to: '2026-01-10',
      openingBalance: 7_000,
      creditDays: 5,
      bills: [],
      settlements: [],
    });
    expect(day(series, '2026-01-06').withinCredit).toBe(7_000);
    expect(day(series, '2026-01-07').overdue).toBe(7_000);
  });

  it('a Tally bill mark settles the named bill; on-account falls back to FIFO oldest-first', () => {
    const series = buildPartyDailySeries({
      ...base,
      bills: [
        { date: '2026-01-01', amount: 1_000, key: 'B-1' },
        { date: '2026-01-02', amount: 2_000, key: 'B-2' },
      ],
      settlements: [
        { date: '2026-01-03', amount: 1_500, billKey: 'B-2' },
        { date: '2026-01-04', amount: 1_000 },
      ],
    });
    // The mark took B-2 down to 500 while FIFO would have emptied B-1 first;
    // the on-account 1,000 then took B-1, the oldest.
    expect(day(series, '2026-01-03').closing).toBe(1_500);
    expect(day(series, '2026-01-04').closing).toBe(500);
  });
});

describe('the open book at a date', () => {
  it('a partial receipt leaves the bill open for the rest, original amount intact', () => {
    const open = openBillsThrough({
      through: '2026-01-31',
      bills: [{ date: '2026-01-01', amount: 10_000, key: 'V-1' }],
      settlements: [{ date: '2026-01-10', amount: 4_000 }],
    });
    expect(open).toEqual([{ date: '2026-01-01', key: 'V-1', amount: 10_000, outstanding: 6_000 }]);
  });

  it('reads nothing past the date it is asked about', () => {
    const open = openBillsThrough({
      through: '2026-01-05',
      bills: [
        { date: '2026-01-01', amount: 10_000 },
        { date: '2026-01-20', amount: 500 },
      ],
      settlements: [{ date: '2026-01-10', amount: 10_000 }],
    });
    expect(open).toEqual([{ date: '2026-01-01', key: null, amount: 10_000, outstanding: 10_000 }]);
  });

  it('FIFO empties the oldest bill first', () => {
    const open = openBillsThrough({
      through: '2026-01-31',
      bills: [
        { date: '2026-01-01', amount: 1_000, key: 'V-1' },
        { date: '2026-01-05', amount: 2_000, key: 'V-2' },
      ],
      settlements: [{ date: '2026-01-10', amount: 1_500 }],
    });
    expect(open).toEqual([{ date: '2026-01-05', key: 'V-2', amount: 2_000, outstanding: 1_500 }]);
  });

  it('a settled bill is absent, and money past every bill raises none', () => {
    const open = openBillsThrough({
      through: '2026-01-31',
      bills: [{ date: '2026-01-01', amount: 1_000, key: 'V-1' }],
      settlements: [{ date: '2026-01-05', amount: 2_500 }],
    });
    expect(open).toEqual([]);
  });
});
