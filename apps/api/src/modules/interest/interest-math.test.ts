import { describe, expect, it } from 'vitest';

import { buildPartyDailySeries, type PartyDay } from '../../platform/receivables/bill-series.js';
import { buildStockDailySeries, interestOnRupeeDays, isNonMoving, resolveAnnualRatePct, type StockDay } from './interest-math.js';

/**
 * Hand-worked examples for the D-22 formula. Every expected number below was
 * computed on paper from SUM(daily closing) x rate / basis; where a figure
 * cannot be exact in binary floating point the assertion is on the exact
 * rupee-day sums, which are integers, and the pricing is checked separately
 * with basis-divisible inputs.
 *
 * The party daily-series fixtures moved to `bill-series.test.ts` with the
 * ledger they cover; the no-double-counting case stays here because it is
 * the seam between the two series, which only this module reads together.
 */

function day(series: readonly PartyDay[], date: string): PartyDay {
  const found = series.find((entry) => entry.date === date);
  if (found === undefined) throw new Error(`No day ${date} in the series.`);
  return found;
}

function stockDay(series: readonly StockDay[], date: string): StockDay {
  const found = series.find((entry) => entry.date === date);
  if (found === undefined) throw new Error(`No day ${date} in the series.`);
  return found;
}

describe('pricing rupee-days', () => {
  it('divides by the day basis exactly', () => {
    // 365,000 rupee-days at 10% over 365 days is 100 rupees, to the paisa.
    expect(interestOnRupeeDays(365_000, 10, 365)).toBe(100);
    expect(interestOnRupeeDays(36_500, 12, 365)).toBe(12);
  });

  it('360 against 365 is the bank convention difference, nothing else', () => {
    expect(interestOnRupeeDays(36_000, 12, 360)).toBe(12);
    // The same rupee-days on the longer year price lower.
    expect(interestOnRupeeDays(36_000, 12, 365)).toBeLessThan(12);
  });

  it('an override beats the org rate; absent means the org rate', () => {
    expect(resolveAnnualRatePct(12, null)).toBe(12);
    expect(resolveAnnualRatePct(12, 18)).toBe(18);
    expect(resolveAnnualRatePct(12, 0)).toBe(0);
  });
});

describe('the stock daily series, purchase cost basis', () => {
  it('funds a layer only after the vendor credit days pass, valued at the running weighted average', () => {
    const series = buildStockDailySeries({
      seriesStart: '2026-01-01',
      to: '2026-01-20',
      events: [
        { date: '2026-01-01', kind: 'inward', quantity: 10, rate: 100, creditDays: 5 },
        { date: '2026-01-10', kind: 'inward', quantity: 10, rate: 130, creditDays: 5 },
        { date: '2026-01-15', kind: 'outward', quantity: 4 },
      ],
    });
    expect(stockDay(series, '2026-01-01')).toMatchObject({ quantity: 10, closingValue: 1_000, fundedValue: 0 });
    // Age 5 is the last day the vendor's money holds the shelf; age 6 is ours.
    expect(stockDay(series, '2026-01-06').fundedValue).toBe(0);
    expect(stockDay(series, '2026-01-07').fundedValue).toBe(1_000);
    // The second inward moves the weighted average to 115 and is not yet funded.
    expect(stockDay(series, '2026-01-10')).toMatchObject({ quantity: 20, closingValue: 2_300, fundedValue: 1_150 });
    // Outward consumes the oldest layer first: 6 of layer one remain funded.
    expect(stockDay(series, '2026-01-15')).toMatchObject({ quantity: 16, closingValue: 1_840, fundedValue: 690 });
    // From here both layers have outrun their credit days.
    expect(stockDay(series, '2026-01-16').fundedValue).toBe(1_840);
  });

  it('a return to the vendor is an outward on the return date', () => {
    const series = buildStockDailySeries({
      seriesStart: '2026-01-01',
      to: '2026-01-10',
      events: [
        { date: '2026-01-01', kind: 'inward', quantity: 10, rate: 100, creditDays: 0 },
        { date: '2026-01-06', kind: 'outward', quantity: 10 },
      ],
    });
    expect(stockDay(series, '2026-01-05').fundedValue).toBe(1_000);
    expect(stockDay(series, '2026-01-06')).toMatchObject({ quantity: 0, closingValue: 0, fundedValue: 0 });
  });

  it('flags non-moving at exactly N days without outward, and keeps N-1 moving', () => {
    expect(isNonMoving(89, 90)).toBe(false);
    expect(isNonMoving(90, 90)).toBe(true);
    expect(isNonMoving(91, 90)).toBe(true);
    // Never moved out at all is the most non-moving an item can be.
    expect(isNonMoving(null, 90)).toBe(true);
  });
});

describe('no double counting across the two series', () => {
  it('a rupee is in stock, then in receivables — two sequential periods, never both on one day', () => {
    // Goods bought on the 1st, sold on the 5th: the money sits in stock
    // through the 4th and in the customer's account from the 5th.
    const stock = buildStockDailySeries({
      seriesStart: '2026-01-01',
      to: '2026-01-10',
      events: [
        { date: '2026-01-01', kind: 'inward', quantity: 10, rate: 100, creditDays: 0 },
        { date: '2026-01-05', kind: 'outward', quantity: 10 },
      ],
    });
    const receivable = buildPartyDailySeries({
      seriesStart: '2026-01-01',
      to: '2026-01-10',
      openingBalance: 0,
      creditDays: 0,
      bills: [{ date: '2026-01-05', amount: 1_500 }],
      settlements: [],
    });
    for (const entry of stock) {
      const other = day(receivable, entry.date);
      // The same rupee never accrues on both sides of the sale on one day.
      expect(entry.fundedValue > 0 && other.closing > 0).toBe(false);
    }
    expect(stockDay(stock, '2026-01-04').fundedValue).toBe(1_000);
    expect(stockDay(stock, '2026-01-05').fundedValue).toBe(0);
    expect(day(receivable, '2026-01-05').closing).toBe(1_500);
  });
});
