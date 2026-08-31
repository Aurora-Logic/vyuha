import { describe, expect, it } from 'vitest';

import {
  mad,
  median,
  orderGapAllowed,
  outlierFlags,
  priceBandAllowed,
  readDelta,
  safeRatio,
  trendAllowed,
  winsorise,
} from './robustness.js';

/**
 * Q1.1 and Q1.2 on hand-computed fixtures. The brief's own cautionary tale
 * is the first case: "+840% growth" on a base of six thousand rupees.
 */
describe('readDelta (Q1.1)', () => {
  it('refuses the +840% story on a base below the floor', () => {
    const reading = readDelta(56_400, 6_000, 25_000);
    expect(reading).toEqual({ kind: 'abs-only', deltaAbs: 50_400, reason: 'base-below-floor' });
  });

  it('speaks a percentage on a real base, with the absolute beside it', () => {
    expect(readDelta(120_000, 100_000, 25_000)).toEqual({ kind: 'pct', deltaAbs: 20_000, deltaPct: 20 });
  });

  it('a zero base is New, never a percentage and never infinity', () => {
    expect(readDelta(80_000, 0, 25_000)).toEqual({ kind: 'new', deltaAbs: 80_000 });
  });

  it('nothing against nothing is nothing', () => {
    expect(readDelta(0, 0, 25_000)).toEqual({ kind: 'none', reason: 'no-data' });
  });
});

describe('minimum samples (Q1.1)', () => {
  it('holds the named floors', () => {
    expect(trendAllowed(5)).toBe(false);
    expect(trendAllowed(6)).toBe(true);
    expect(orderGapAllowed(4)).toBe(false);
    expect(orderGapAllowed(5)).toBe(true);
    expect(priceBandAllowed(7)).toBe(false);
    expect(priceBandAllowed(8)).toBe(true);
  });

  it('a zero denominator is null, never 0 or NaN', () => {
    expect(safeRatio(10, 0)).toBeNull();
    expect(safeRatio(10, 4)).toBe(2.5);
  });
});

describe('outliers (Q1.2)', () => {
  it('median is exact on even and odd counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('flags the project order without excluding it', () => {
    // Nine ordinary invoices and one 40-lakh project order.
    const values = [10_000, 12_000, 9_500, 11_000, 10_500, 9_800, 11_500, 10_200, 9_900, 4_000_000];
    const flags = outlierFlags(values);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(flags[9]).toBe(true);
    expect(mad(values)).not.toBe(0);
  });

  it('a run of identical values flags nothing', () => {
    expect(outlierFlags([5, 5, 5, 5]).some(Boolean)).toBe(false);
  });

  it('winsorises at P5 and P95, ends pulled in, middle untouched', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    const capped = winsorise(values);
    // P95 by linear interpolation over ten values: 9 + 0.55 x (1000 - 9).
    expect(capped[9]).toBeCloseTo(554.05, 2);
    expect(capped[4]).toBe(5);
    expect(Math.min(...capped)).toBeCloseTo(1.45, 10);
  });
});
