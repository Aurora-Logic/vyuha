import { describe, expect, it } from 'vitest';

import {
  averageDaysDelinquent,
  bestPossibleDso,
  collectionEffectivenessIndex,
  dsoCountback,
  dsoSimple,
} from './receivable-metrics.js';

/**
 * Every figure below was worked out on paper before the code existed (0.8).
 */
describe('DSO countback (D04)', () => {
  const months = [
    { month: '2026-08', creditSales: 300_000, days: 31 },
    { month: '2026-07', creditSales: 250_000, days: 31 },
    { month: '2026-06', creditSales: 200_000, days: 30 },
  ];

  it('consumes recent months whole, the exhausting month proportionally', () => {
    // 400,000 closing: all of August (31d), then 100,000 of July's 250,000
    // = 0.4 x 31 = 12.4 days. Total 43.4.
    expect(dsoCountback(400_000, months)).toBeCloseTo(43.4, 10);
  });

  it('a book smaller than the latest month is a fraction of it', () => {
    expect(dsoCountback(150_000, months)).toBeCloseTo(15.5, 10);
  });

  it('skips a zero-sales month rather than dividing by it', () => {
    const withGap = [
      { month: '2026-08', creditSales: 0, days: 31 },
      { month: '2026-07', creditSales: 250_000, days: 31 },
    ];
    expect(dsoCountback(125_000, withGap)).toBeCloseTo(15.5, 10);
  });

  it('debtors older than the window extend at the oldest month’s rate', () => {
    // 810,000 exhausts all three months (750,000, 92 days) and leaves
    // 60,000 against June's 200,000/30d = 9 more days. 101 in all.
    expect(dsoCountback(810_000, months)).toBeCloseTo(101, 10);
  });

  it('an empty book is zero days; no months is unknowable', () => {
    expect(dsoCountback(0, months)).toBe(0);
    expect(dsoCountback(100, [])).toBeNull();
  });
});

describe('simple DSO (D03) and ADD (D07)', () => {
  it('keeps the textbook ratio for the definition panel', () => {
    expect(dsoSimple(400_000, 300_000, 31)).toBeCloseTo(41.333, 3);
    expect(dsoSimple(400_000, 0, 31)).toBeNull();
  });

  it('ADD is countback minus best possible, and honest about unknowns', () => {
    const months = [{ month: '2026-08', creditSales: 300_000, days: 31 }];
    const dso = dsoCountback(150_000, months);
    const best = bestPossibleDso(90_000, months);
    expect(dso).toBeCloseTo(15.5, 10);
    expect(best).toBeCloseTo(9.3, 10);
    expect(averageDaysDelinquent(dso, best)).toBeCloseTo(6.2, 10);
    expect(averageDaysDelinquent(null, best)).toBeNull();
  });
});

describe('CEI (D06)', () => {
  it('matches the hand-worked collection story', () => {
    // Opened at 3.5L, billed 3L on credit, closed at 4L of which 2.5L is not
    // yet due: collected 2.5L of the 4L that was collectable = 62.5.
    expect(collectionEffectivenessIndex(350_000, 300_000, 400_000, 250_000)).toBeCloseTo(62.5, 10);
  });

  it('a perfect month scores 100', () => {
    // Everything collectable was collected: closing holds only current bills.
    expect(collectionEffectivenessIndex(200_000, 100_000, 80_000, 80_000)).toBeCloseTo(100, 10);
  });

  it('nothing collectable is unknowable, not zero', () => {
    // Opening 0, sales 100, closing current 100: the denominator is zero.
    expect(collectionEffectivenessIndex(0, 100_000, 100_000, 100_000)).toBeNull();
  });
});
