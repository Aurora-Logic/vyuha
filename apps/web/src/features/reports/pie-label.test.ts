import { describe, expect, it } from 'vitest';

import { pieSliceLabel } from './pie-label';

/**
 * The bug this exists to prevent already happened.
 *
 * The donut printed 8943372.46 on a live dashboard, beside a bar chart
 * correctly reading 10L, because `formatter` is honoured on a LabelList and
 * silently ignored on a Pie's `label`. Recharts cannot be rendered in jsdom --
 * it measures its container and jsdom reports zero -- so no test would have
 * caught it inside the SVG. The decision lives outside now, and this is it.
 */
describe('pieSliceLabel', () => {
  it('shortens a rupee figure to something that fits beside a slice', () => {
    // The exact value from the screenshot that started this.
    expect(pieSliceLabel(8943372.46, 0.2)).toBe('89.4L');
    expect(pieSliceLabel(9022706.68, 0.2)).toBe('90.2L');
    expect(pieSliceLabel(3883930.1, 0.1)).toBe('38.8L');
  });

  it('never returns the raw number', () => {
    for (const value of [8943372.46, 9022706.68, 3883930.1, 131499.96]) {
      const label = pieSliceLabel(value, 0.2);
      expect(label).not.toBe(String(value));
      expect(label?.length ?? 0).toBeLessThanOrEqual(6);
    }
  });

  it('leaves a sliver to the legend rather than colliding with its neighbour', () => {
    expect(pieSliceLabel(1000, 0.04)).toBeNull();
    expect(pieSliceLabel(1000, 0.049)).toBeNull();
  });

  it('labels a slice at or above the threshold', () => {
    expect(pieSliceLabel(1000, 0.05)).toBe('1k');
  });

  it('labels a slice whose share is unknown, rather than dropping it', () => {
    // Absent percent is not a small percent. Dropping it would silently hide
    // a slice on any chart that does not supply one.
    expect(pieSliceLabel(250000, undefined)).toBe('2.5L');
  });

  it('says nothing for a value that is not a number', () => {
    expect(pieSliceLabel(undefined, 0.5)).toBeNull();
    expect(pieSliceLabel('8943372.46', 0.5)).toBeNull();
    expect(pieSliceLabel(Number.NaN, 0.5)).toBeNull();
    expect(pieSliceLabel(Number.POSITIVE_INFINITY, 0.5)).toBeNull();
  });
});
