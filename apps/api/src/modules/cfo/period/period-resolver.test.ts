import { describe, expect, it } from 'vitest';

import {
  cagr,
  fyQuarterStart,
  fyStart,
  matchWorkingDays,
  resolveComparison,
  resolveCurrent,
  resolvePeriod,
  runRate,
  sameDayLastYear,
} from './period-resolver.js';

/**
 * B2's mandatory behaviours, with hand-computed fixtures (brief 0.8: a wrong
 * formula that looks plausible is the worst failure mode in this module).
 * Every date below was worked out on paper first.
 */

describe('financial year boundaries (1 April)', () => {
  it('puts 31 March and 1 April in different years', () => {
    expect(fyStart('2026-03-31')).toBe('2025-04-01');
    expect(fyStart('2026-04-01')).toBe('2026-04-01');
  });

  it('quarters run Apr, Jul, Oct, Jan', () => {
    expect(fyQuarterStart('2026-05-15')).toBe('2026-04-01');
    expect(fyQuarterStart('2026-08-26')).toBe('2026-07-01');
    expect(fyQuarterStart('2026-12-31')).toBe('2026-10-01');
    expect(fyQuarterStart('2027-02-01')).toBe('2027-01-01');
  });

  it('YTD on 26 Aug runs from 1 April; last-year YTD matches the same elapsed days', () => {
    const period = resolvePeriod('YTD', '2026-08-26', 'same-ly');
    expect(period.current).toEqual({ from: '2026-04-01', to: '2026-08-26' });
    expect(period.comparison).toEqual({ from: '2025-04-01', to: '2025-08-26' });
  });
});

describe('elapsed-day matching (the one-line honesty rule)', () => {
  it('MTD on the 9th compares against days 1-9 of last month, never the full month', () => {
    const period = resolvePeriod('MTD', '2026-08-09', 'previous');
    expect(period.current).toEqual({ from: '2026-08-01', to: '2026-08-09' });
    expect(period.comparison).toEqual({ from: '2026-07-01', to: '2026-07-09' });
    expect(period.elapsedDaysMatched).toBe(9);
    expect(period.caption).toBe('Day 9 of 31 — comparing against 2026-07-01 to 2026-07-09.');
  });

  it('MTD on 31 March against February clamps to the shorter month', () => {
    const period = resolvePeriod('MTD', '2026-03-31', 'previous');
    // February 2026 has 28 days; the anchor clamps to its end.
    expect(period.comparison).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('QTD previous-quarter comparison matches elapsed days across the FY boundary', () => {
    // 20 April: 20 days into Q1. Prior quarter is Jan-Mar; match its first 20 days.
    const period = resolvePeriod('QTD', '2026-04-20', 'previous');
    expect(period.current).toEqual({ from: '2026-04-01', to: '2026-04-20' });
    expect(period.comparison).toEqual({ from: '2026-01-01', to: '2026-01-20' });
  });
});

describe('leap years', () => {
  it('maps 29 Feb to 28 Feb the year before, and nothing else moves', () => {
    expect(sameDayLastYear('2028-02-29')).toBe('2027-02-28');
    expect(sameDayLastYear('2028-03-01')).toBe('2027-03-01');
  });

  it('R365 spanning a leap day still spans exactly 365 days', () => {
    const range = resolveCurrent('R365', '2028-03-01');
    expect(range).toEqual({ from: '2027-03-03', to: '2028-03-01' });
  });
});

describe('working-day matching', () => {
  it('trims the comparison to the same count of working days', () => {
    // Current week has one holiday; comparison window must stop after the
    // same number of working days, not the same number of calendar days.
    const nonWorking = new Set(['2026-08-04', '2026-07-05']);
    const { comparison, workingDays } = matchWorkingDays(
      { from: '2026-08-03', to: '2026-08-07' },
      { from: '2026-07-01', to: '2026-07-31' },
      nonWorking,
    );
    expect(workingDays).toBe(4);
    expect(comparison).toEqual({ from: '2026-07-01', to: '2026-07-04' });
  });

  it('takes the whole comparison when it runs out of days', () => {
    const { comparison } = matchWorkingDays(
      { from: '2026-08-01', to: '2026-08-10' },
      { from: '2026-07-30', to: '2026-07-31' },
      new Set(),
    );
    expect(comparison).toEqual({ from: '2026-07-30', to: '2026-07-31' });
  });
});

describe('comparison axes', () => {
  it('two-years steps the window back twice for base-effect reading', () => {
    const { comparison } = resolveComparison('MTD', { from: '2026-08-01', to: '2026-08-09' }, 'two-years');
    expect(comparison).toEqual({ from: '2024-08-01', to: '2024-08-09' });
  });

  it('rolling-3 on MTD is days 1-N of the three prior months', () => {
    const { comparisonSet } = resolveComparison('MTD', { from: '2026-08-01', to: '2026-08-09' }, 'rolling-3');
    expect(comparisonSet).toEqual([
      { from: '2026-07-01', to: '2026-07-09' },
      { from: '2026-06-01', to: '2026-06-09' },
      { from: '2026-05-01', to: '2026-05-09' },
    ]);
  });

  it('none yields no comparison and an honest caption', () => {
    const period = resolvePeriod('MTD', '2026-08-09', 'none');
    expect(period.comparison).toBeNull();
    expect(period.caption).toBe('Day 9 of 31.');
  });
});

describe('rolling windows and tokens', () => {
  it('R30 is exactly thirty days ending today', () => {
    const range = resolveCurrent('R30', '2026-08-26');
    expect(range).toEqual({ from: '2026-07-28', to: '2026-08-26' });
  });

  it('LY_FULL is the whole prior financial year', () => {
    const range = resolveCurrent('LY_FULL', '2026-08-26');
    expect(range).toEqual({ from: '2025-04-01', to: '2026-03-31' });
  });

  it('CUSTOM without a range refuses rather than guessing', () => {
    expect(() => resolveCurrent('CUSTOM', '2026-08-26')).toThrow('CUSTOM period needs an explicit range.');
  });
});

describe('run rate and CAGR', () => {
  it('projects linearly with a band, never a bare point', () => {
    const { projected, low, high } = runRate(90_000, 9, 30);
    expect(projected).toBe(300_000);
    expect(low).toBe(195_000);
    expect(high).toBe(405_000);
  });

  it('a completed period projects itself', () => {
    expect(runRate(100, 30, 30)).toEqual({ projected: 100, low: 100, high: 100 });
  });

  it('CAGR needs three years and a positive base', () => {
    expect(cagr(100, 200, 2)).toBeNull();
    expect(cagr(0, 200, 3)).toBeNull();
    const three = cagr(100, 133.1, 3);
    expect(three).not.toBeNull();
    expect((three ?? 0) * 100).toBeCloseTo(10, 5);
  });
});
