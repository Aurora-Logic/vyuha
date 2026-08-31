/**
 * C4's core measures (brief): DSO three ways, CEI, and ADD — pure functions
 * over figures the snapshot and fact tables supply, so every formula has a
 * hand-computed fixture (0.8: a wrong formula that looks plausible is this
 * module's worst failure mode).
 */

import { safeRatio } from './robustness.js';

export interface MonthSales {
  /** YYYY-MM, most recent first when handed to countback. */
  readonly month: string;
  readonly creditSales: number;
  readonly days: number;
}

/** D03: the simple ratio. Kept for the definition panel; countback leads. */
export function dsoSimple(closingDebtors: number, creditSales: number, periodDays: number): number | null {
  const ratio = safeRatio(closingDebtors, creditSales);
  return ratio === null ? null : ratio * periodDays;
}

/**
 * D04: the countback. Closing debtors are consumed against the most recent
 * months' credit sales until exhausted; whole months contribute their days,
 * the month that exhausts the balance contributes a proportional share.
 * Far more honest than D03 when sales are lumpy — which a distributor's are.
 *
 * Debtors older than every month supplied add the remainder at the oldest
 * month's run rate, so a book that outlives the window still reads as more
 * days, not silently capped.
 */
export function dsoCountback(closingDebtors: number, monthsRecentFirst: readonly MonthSales[]): number | null {
  if (closingDebtors <= 0) return 0;
  if (monthsRecentFirst.length === 0) return null;
  let remaining = closingDebtors;
  let days = 0;
  for (const month of monthsRecentFirst) {
    if (month.creditSales <= 0) continue;
    if (remaining > month.creditSales) {
      days += month.days;
      remaining -= month.creditSales;
    } else {
      days += (remaining / month.creditSales) * month.days;
      return days;
    }
  }
  const oldest = [...monthsRecentFirst].reverse().find((m) => m.creditSales > 0);
  if (oldest === undefined) return null;
  return days + (remaining / oldest.creditSales) * oldest.days;
}

/** D05: countback on the not-yet-due book only. The gap to D04 is collectable inefficiency. */
export function bestPossibleDso(currentDebtors: number, monthsRecentFirst: readonly MonthSales[]): number | null {
  return dsoCountback(currentDebtors, monthsRecentFirst);
}

/** D07: ADD — days late in one number. Null while either side is unknowable. */
export function averageDaysDelinquent(dso: number | null, bestDso: number | null): number | null {
  if (dso === null || bestDso === null) return null;
  return dso - bestDso;
}

/**
 * D06: CEI, out of 100. (Opening AR + credit sales − closing total AR) over
 * (Opening AR + credit sales − closing CURRENT AR). Unaffected by
 * seasonality, unlike DSO, which is why it leads the collection story.
 */
export function collectionEffectivenessIndex(
  openingReceivables: number,
  creditSales: number,
  closingTotal: number,
  closingCurrent: number,
): number | null {
  const collectable = openingReceivables + creditSales - closingCurrent;
  const collected = openingReceivables + creditSales - closingTotal;
  const ratio = safeRatio(collected, collectable);
  return ratio === null ? null : ratio * 100;
}
