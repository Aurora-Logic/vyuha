import { describe, expect, it } from 'vitest';

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
