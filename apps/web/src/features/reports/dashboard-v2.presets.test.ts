import { describe, expect, it } from 'vitest';

import { periodParams } from './period';
import { asApiDate, DASHBOARD_PRESETS, defaultRange } from './dashboard-v2.presets';

describe('dashboard period presets', () => {
  it('offers every window without a gap in the list', () => {
    expect(DASHBOARD_PRESETS.map((p) => p.label)).toEqual([
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
      'This month',
      'Last month',
      'This quarter',
      'Last quarter',
      'This FY',
      'Last 12 months',
    ]);
  });

  it('never returns a range that ends before it starts', () => {
    for (const preset of DASHBOARD_PRESETS) {
      const { from, to } = preset.range();
      expect(from, preset.label).toBeInstanceOf(Date);
      expect(to, preset.label).toBeInstanceOf(Date);
      expect(from?.getTime() ?? 0, preset.label).toBeLessThanOrEqual(to?.getTime() ?? 0);
    }
  });

  it('starts the financial year in April, not January', () => {
    const fy = DASHBOARD_PRESETS.find((p) => p.label === 'This FY');
    expect(fy?.range().from?.getMonth()).toBe(3);
  });

  it('opens on twelve months', () => {
    const { from, to } = defaultRange();
    const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    expect(months).toBe(11);
    expect(from.getDate()).toBe(1);
  });

  it('writes a local date, not a UTC one', () => {
    // 1 April at 00:30 local is still 1 April; toISOString would say 31 March
    // for anyone west of Greenwich.
    expect(asApiDate(new Date(2026, 3, 1, 0, 30))).toBe('2026-04-01');
  });
});

describe('the period a drill-through carries (audit 23)', () => {
  /**
   * Every drill-through from the dashboard dropped the period, so a reader who
   * clicked a figure for one quarter landed on a report showing its own
   * default range -- the number they had just been looking at was not on the
   * screen they arrived at, and nothing said the dates had changed.
   */
  const quarter = { from: new Date(2026, 3, 1), to: new Date(2026, 5, 30) };

  it('hands a range report the range it was looking at', () => {
    expect(periodParams('sales-analysis', quarter)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  });

  it('bends the range into what a single-month report can answer', () => {
    // A month-only report handed a quarter shows the server refusing the
    // period, which reads as the report being broken. The end of the
    // selection keeps the most recent thing they were looking at.
    const params = periodParams('monthly-muster', quarter);
    expect(params.from).toBe('2026-06-01');
    expect(params.to).toBe('2026-06-30');
  });

  it('bends it to a single day for a report that answers for one', () => {
    expect(periodParams('daily-muster', quarter)).toEqual({ from: '2026-06-30', to: '2026-06-30' });
  });

  it('carries nothing when there is nothing to carry', () => {
    expect(periodParams('sales-analysis', {})).toEqual({});
  });
});
