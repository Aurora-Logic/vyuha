import type { InterestDayBasis } from '@vyuha/shared';

import { epochDay, isoOfEpochDay } from '../../platform/receivables/bill-series.js';

/**
 * The one formula of D-22, as pure functions: interest for a period is the
 * SUM of the daily closing balance series times the annual rate over the day
 * basis — never invoice-date arithmetic. Everything here is deterministic
 * over its inputs so the hand-worked examples in `interest-math.test.ts` can
 * pin exact numbers; nothing reads a clock, a database or a setting.
 *
 * The receivable side — the open-bill ledger and the party daily series —
 * lives in `platform/receivables/bill-series.ts`, because the CFO module
 * reads the same books and modules may not import each other. What remains
 * here is the pricing and the stock series, which are interest's alone.
 *
 * Rounding: none. Sums are carried at full precision and the callers round
 * at display (the snapshot writer stores the daily balances at the paisa,
 * which is the grain of the ledger itself, not a display rounding).
 */

/** A party override beats the org rate; that is the whole precedence. */
export function resolveAnnualRatePct(orgRatePct: number, overridePct: number | null): number {
  return overridePct ?? orgRatePct;
}

/**
 * SUM(daily closing balance) x annual_rate / day_basis. The sum is in
 * rupee-days; the result is rupees, unrounded.
 */
export function interestOnRupeeDays(
  sumOfDailyClosings: number,
  annualRatePct: number,
  dayBasis: InterestDayBasis,
): number {
  return (sumOfDailyClosings * annualRatePct) / 100 / dayBasis;
}

// ------------------------------------------------------------------- stock

export interface StockEvent {
  readonly date: string;
  readonly kind: 'inward' | 'outward';
  /** Positive units. */
  readonly quantity: number;
  /** Inward only: the purchase rate per unit (purchase cost basis, D-22 rule 3). */
  readonly rate?: number;
  /** Inward only: the vendor's credit days for this layer's funding clock. */
  readonly creditDays?: number;
}

export interface StockDay {
  readonly date: string;
  readonly quantity: number;
  readonly closingValue: number;
  readonly fundedValue: number;
}

interface StockLayer {
  readonly day: number;
  readonly creditDays: number;
  remaining: number;
}

/**
 * The daily stock series for one item. Closing value is quantity on hand at
 * the running weighted-average purchase rate. Funded value implements the
 * D-22 clock: each day's funded value is the value of stock whose age since
 * its inward exceeds that inward's vendor credit days — until then the
 * vendor's money is holding the shelf, not ours. Layers age individually
 * and outward movement consumes the oldest layer first, so a fresh delivery
 * cannot reset the clock on old stock; returns to vendor are outward events
 * on the return's own date and reduce the series from there forward.
 */
export function buildStockDailySeries(input: {
  readonly seriesStart: string;
  readonly to: string;
  readonly events: readonly StockEvent[];
}): StockDay[] {
  const startDay = epochDay(input.seriesStart);
  const endDay = epochDay(input.to);
  if (endDay < startDay) return [];

  const eventsByDay = new Map<number, StockEvent[]>();
  for (const event of input.events) {
    const day = epochDay(event.date);
    const list = eventsByDay.get(day) ?? [];
    list.push(event);
    eventsByDay.set(day, list);
  }

  const layers: StockLayer[] = [];
  let quantity = 0;
  let value = 0;

  const series: StockDay[] = [];
  for (let day = startDay; day <= endDay; day += 1) {
    for (const event of eventsByDay.get(day) ?? []) {
      if (event.kind === 'inward') {
        quantity += event.quantity;
        value += event.quantity * (event.rate ?? 0);
        layers.push({ day, creditDays: event.creditDays ?? 0, remaining: event.quantity });
      } else {
        const rate = quantity > 0 ? value / quantity : 0;
        quantity -= event.quantity;
        value -= event.quantity * rate;
        let toConsume = event.quantity;
        for (const layer of layers) {
          if (toConsume <= 0) break;
          const consumed = Math.min(layer.remaining, toConsume);
          layer.remaining -= consumed;
          toConsume -= consumed;
        }
      }
    }

    const wavgRate = quantity > 0 ? value / quantity : 0;
    let fundedQty = 0;
    for (const layer of layers) {
      if (layer.remaining <= 0) continue;
      if (day - layer.day > layer.creditDays) fundedQty += layer.remaining;
    }
    series.push({
      date: isoOfEpochDay(day),
      quantity,
      closingValue: quantity * wavgRate,
      fundedValue: fundedQty * wavgRate,
    });
  }
  return series;
}

/**
 * Non-moving (D-22): zero outward movement for the threshold. An item whose
 * last outward was exactly N days ago has had N movement-free days and is
 * flagged; one at N-1 is not. Null means no outward in the whole series,
 * which is the most non-moving an item can be.
 */
export function isNonMoving(daysSinceOutward: number | null, thresholdDays: number): boolean {
  return daysSinceOutward === null || daysSinceOutward >= thresholdDays;
}
