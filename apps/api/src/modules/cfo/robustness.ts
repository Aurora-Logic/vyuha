/**
 * Part Q1.1 and Q1.2 (brief: "not optional refinements... before any metric
 * ships, not retrofitted"). Pure functions the metric engine routes every
 * figure through, so "+840% on a base of six thousand rupees" cannot happen
 * anywhere, rather than being fixed screen by screen.
 */

export const MIN_TREND_PERIODS = 6;
export const MIN_ORDERS_FOR_GAP = 5;
export const MIN_LINES_FOR_PRICE_BAND = 8;
export const OUTLIER_MAD_MULTIPLE = 3;

/** How a change may be spoken of. Never a bare percentage (B2). */
export type DeltaReading =
  | { kind: 'pct'; deltaAbs: number; deltaPct: number }
  | { kind: 'abs-only'; deltaAbs: number; reason: 'base-below-floor' }
  | { kind: 'new'; deltaAbs: number }
  | { kind: 'none'; reason: 'no-data' };

/**
 * Q1.1: a percentage only on a base worth dividing by. Below the materiality
 * floor the ₹ change stands alone; a zero base is "New", never infinity.
 */
export function readDelta(current: number, base: number, materialityFloor: number): DeltaReading {
  if (current === 0 && base === 0) return { kind: 'none', reason: 'no-data' };
  if (base === 0) return { kind: 'new', deltaAbs: current };
  if (Math.abs(base) < materialityFloor) {
    return { kind: 'abs-only', deltaAbs: current - base, reason: 'base-below-floor' };
  }
  return { kind: 'pct', deltaAbs: current - base, deltaPct: ((current - base) / Math.abs(base)) * 100 };
}

/** Q1.1: a trend line needs six periods; below that, points only, no arrow. */
export function trendAllowed(periodCount: number): boolean {
  return periodCount >= MIN_TREND_PERIODS;
}

/** Q1.1: an order-gap claim needs five completed orders, else "Insufficient history". */
export function orderGapAllowed(orderCount: number): boolean {
  return orderCount >= MIN_ORDERS_FOR_GAP;
}

/** Q1.1: a price band needs eight transactions, else the raw prices. */
export function priceBandAllowed(lineCount: number): boolean {
  return lineCount >= MIN_LINES_FOR_PRICE_BAND;
}

/** Q1.1: a zero denominator is null with a reason, never 0, NaN or a blank. */
export function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Q1.2: median as the default average, exact for even counts. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

/** Median absolute deviation, the outlier yardstick Q1.2 names. */
export function mad(values: readonly number[]): number | null {
  const centre = median(values);
  if (centre === null) return null;
  return median(values.map((v) => Math.abs(v - centre)));
}

/**
 * Q1.2: flag, never silently exclude. True where a value sits beyond three
 * MADs from the median; a spread of zero flags nothing, because in a run of
 * identical values there is no scale to be outside of.
 */
export function outlierFlags(values: readonly number[]): boolean[] {
  const centre = median(values);
  const spread = mad(values);
  if (centre === null || spread === null || spread === 0) return values.map(() => false);
  return values.map((v) => Math.abs(v - centre) > OUTLIER_MAD_MULTIPLE * spread);
}

/**
 * Q1.2: winsorise price analysis at P5 and P95 before banding, so one
 * wrongly-keyed rate does not widen every SKU's spread. Linear-interpolated
 * percentiles, the same convention spreadsheets use.
 */
export function winsorise(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const pos = (sorted.length - 1) * p;
    const low = Math.floor(pos);
    const high = Math.ceil(pos);
    const lowV = sorted[low] ?? 0;
    const highV = sorted[high] ?? 0;
    return lowV + (highV - lowV) * (pos - low);
  };
  const p5 = at(0.05);
  const p95 = at(0.95);
  return values.map((v) => Math.min(Math.max(v, p5), p95));
}
