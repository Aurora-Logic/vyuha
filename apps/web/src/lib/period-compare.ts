/**
 * The comparison framework's arithmetic (data-analyst skill §3): the
 * financial year runs April to March, "same period last year" maps by
 * date shift rather than calendar copy, and a partial period compares
 * like-for-like to date because the shifted range ends where the current
 * one does. Pure date-string functions — 'YYYY-MM-DD' in, the same out —
 * so every rule here is testable without a clock.
 */

export type CompareMode = 'off' | 'previous' | 'lastYear';
export type Granularity = 'month' | 'quarter' | 'year';

export interface DateRangeStrings {
  readonly from: string;
  readonly to: string;
}

function parse(date: string): { y: number; m: number; d: number } {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return { y, m, d };
}

function format(y: number, m: number, d: number): string {
  // Clamp to the month's last day (31 Jan − 1 month → 28/29 Feb, not 3 Mar).
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftMonths(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const zero = y * 12 + (m - 1) + months;
  return format(Math.floor(zero / 12), (((zero % 12) + 12) % 12) + 1, d);
}

function shiftDays(date: string, days: number): string {
  const { y, m, d } = parse(date);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** 1 April of the financial year the date sits in. */
export function fyStart(date: string): string {
  const { y, m } = parse(date);
  return `${String(m >= 4 ? y : y - 1)}-04-01`;
}

/** Start of the FY quarter (AMJ, JAS, OND, JFM) the date sits in. */
export function fyQuarterStart(date: string): string {
  const { y, m } = parse(date);
  const quarterFirstMonth = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : 1;
  return format(y, quarterFirstMonth, 1);
}

/** This month / this FY quarter / this FY, each running to the given day — the partial period as it stands. */
export function periodForGranularity(granularity: Granularity, today: string): DateRangeStrings {
  const { y, m } = parse(today);
  if (granularity === 'month') return { from: format(y, m, 1), to: today };
  if (granularity === 'quarter') return { from: fyQuarterStart(today), to: today };
  return { from: fyStart(today), to: today };
}

/**
 * The range the comparison series reads. `lastYear` shifts both ends back
 * twelve months, so 1–21 Aug compares to 1–21 Aug last year, never to a
 * full month. `previous` steps back by the range's own length in whole
 * days, ending the day before the range starts.
 */
export function comparisonRange(range: DateRangeStrings, mode: Exclude<CompareMode, 'off'>): DateRangeStrings {
  if (mode === 'lastYear') return { from: shiftMonths(range.from, -12), to: shiftMonths(range.to, -12) };
  const span = daysBetween(range.from, range.to);
  const to = shiftDays(range.from, -1);
  return { from: shiftDays(to, -span), to };
}

export interface Delta {
  readonly previous: number;
  readonly absolute: number;
  /** Null when the base is zero: 0→x is "new", 0→0 is nothing, never a percentage. */
  readonly pct: number | null;
  readonly direction: 'up' | 'down' | 'flat';
  /** What the base-zero cases read as; null when pct carries the story. */
  readonly label: 'new' | 'none' | null;
}

export function deltaOf(current: number, previous: number): Delta {
  const absolute = current - previous;
  const direction: Delta['direction'] = absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat';
  if (previous === 0) {
    return { previous, absolute, pct: null, direction, label: current === 0 ? 'none' : 'new' };
  }
  return { previous, absolute, pct: Math.round((absolute / Math.abs(previous)) * 1000) / 10, direction, label: null };
}
