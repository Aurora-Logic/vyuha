/**
 * The period engine (brief B2). Pure functions over date strings — no clock
 * of its own, no database: the caller supplies "today" and, for working-day
 * matching, the set of non-working dates. Everything here is testable with
 * hand-written fixtures, which B2 and 0.8 demand.
 *
 * The financial year runs 1 April – 31 March (B1); Q1 is Apr–Jun. All dates
 * are YYYY-MM-DD strings and all arithmetic is UTC epoch-day maths, so IST
 * midnight boundaries are the caller's concern (the fact tables are already
 * keyed by IST business dates) and leap years cost nothing special.
 */

export const PERIOD_TOKENS = [
  'TODAY',
  'YESTERDAY',
  'WTD',
  'LWTD',
  'MTD',
  'LMTD',
  'LM_FULL',
  'LYMTD',
  'LY_SAME_MONTH',
  'QTD',
  'LQTD',
  'LY_SAME_QTD',
  'YTD',
  'LYTD',
  'LY_FULL',
  'R30',
  'R90',
  'R365',
  'CUSTOM',
] as const;

export type PeriodToken = (typeof PERIOD_TOKENS)[number];

export const COMPARISON_AXES = ['none', 'previous', 'same-ly', 'two-years', 'rolling-3'] as const;

export type ComparisonAxis = (typeof COMPARISON_AXES)[number];

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface ResolvedPeriod {
  readonly token: PeriodToken;
  readonly current: DateRange;
  /** Null when the axis is 'none' (or nothing sensible exists). */
  readonly comparison: DateRange | null;
  /** For rolling-3: the three windows the average is taken over. */
  readonly comparisonSet?: readonly DateRange[];
  /**
   * B2's one-line honesty: how many days of the current period have elapsed
   * and are matched in the comparison. "Day 9 of 31 — comparing against 1–9."
   */
  readonly elapsedDaysMatched: number;
  readonly periodLengthDays: number;
  /** The sentence the picker prints under itself. */
  readonly caption: string;
}

const DAY_MS = 86_400_000;

function toUtc(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return toDay(toUtc(day) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day: string): string {
  const [y = 0, m = 1] = day.split('-').map(Number);
  return toDay(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - DAY_MS);
}

/** Same day last month, clamped to the shorter month's end (31 Mar -> 28/29 Feb). */
function sameDayLastMonth(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevEnd = monthEnd(`${String(prevY)}-${String(prevM).padStart(2, '0')}-01`);
  const clamped = Math.min(d, Number(prevEnd.slice(8, 10)));
  return `${String(prevY)}-${String(prevM).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/**
 * Same date last year; 29 Feb maps to 28 Feb, the only day that needs a rule.
 * Checked by round-trip, not by NaN: Date.parse quietly rolls an invalid
 * 29 Feb forward to 1 March rather than refusing it, which the test caught.
 */
export function sameDayLastYear(day: string): string {
  const candidate = `${String(Number(day.slice(0, 4)) - 1)}${day.slice(4)}`;
  return toDay(toUtc(candidate)) === candidate ? candidate : `${candidate.slice(0, 8)}28`;
}

/** 1 April of the financial year the day belongs to (B1). */
export function fyStart(day: string): string {
  const y = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) >= 4 ? `${String(y)}-04-01` : `${String(y - 1)}-04-01`;
}

/** Quarter start on the FY grid: Apr, Jul, Oct, Jan. */
export function fyQuarterStart(day: string): string {
  const m = Number(day.slice(5, 7));
  const qm = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : m >= 1 && m <= 3 ? 1 : 4;
  const y = Number(day.slice(0, 4));
  return `${String(y)}-${String(qm).padStart(2, '0')}-01`;
}

/** Monday-start week, matching the business week the rest of Vyuha keeps. */
function weekStart(day: string): string {
  const dow = new Date(toUtc(day)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export function resolveCurrent(token: PeriodToken, today: string, custom?: DateRange): DateRange {
  switch (token) {
    case 'TODAY':
      return { from: today, to: today };
    case 'YESTERDAY': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'WTD':
      return { from: weekStart(today), to: today };
    case 'LWTD': {
      const start = addDays(weekStart(today), -7);
      return { from: start, to: addDays(today, -7) };
    }
    case 'MTD':
      return { from: monthStart(today), to: today };
    case 'LMTD': {
      const anchor = sameDayLastMonth(today);
      return { from: monthStart(anchor), to: anchor };
    }
    case 'LM_FULL': {
      const anchor = sameDayLastMonth(today);
      return { from: monthStart(anchor), to: monthEnd(anchor) };
    }
    case 'LYMTD': {
      const anchor = sameDayLastYear(today);
      return { from: monthStart(anchor), to: anchor };
    }
    case 'LY_SAME_MONTH': {
      const anchor = sameDayLastYear(today);
      return { from: monthStart(anchor), to: monthEnd(anchor) };
    }
    case 'QTD':
      return { from: fyQuarterStart(today), to: today };
    case 'LQTD': {
      const start = fyQuarterStart(today);
      const prevQuarterDay = addDays(start, -1);
      const prevStart = fyQuarterStart(prevQuarterDay);
      const elapsed = daysBetween(start, today);
      const to = addDays(prevStart, elapsed - 1);
      return { from: prevStart, to: to <= prevQuarterDay ? to : prevQuarterDay };
    }
    case 'LY_SAME_QTD': {
      const anchor = sameDayLastYear(today);
      return { from: fyQuarterStart(anchor), to: anchor };
    }
    case 'YTD':
      return { from: fyStart(today), to: today };
    case 'LYTD': {
      const anchor = sameDayLastYear(today);
      return { from: fyStart(anchor), to: anchor };
    }
    case 'LY_FULL': {
      const start = fyStart(sameDayLastYear(today));
      return { from: start, to: addDays(fyStart(today), -1) };
    }
    case 'R30':
      return { from: addDays(today, -29), to: today };
    case 'R90':
      return { from: addDays(today, -89), to: today };
    case 'R365':
      return { from: addDays(today, -364), to: today };
    case 'CUSTOM': {
      if (custom === undefined) throw new Error('CUSTOM period needs an explicit range.');
      return custom;
    }
  }
}

/**
 * The comparison window for a current range, matched by ELAPSED DAYS — MTD
 * on the 9th compares against days 1–9 of the prior window, never a full
 * month (B2's mandatory behaviour, and the most common dashboard lie).
 */
export function resolveComparison(
  token: PeriodToken,
  current: DateRange,
  axis: ComparisonAxis,
): { comparison: DateRange | null; comparisonSet?: DateRange[] } {
  if (axis === 'none') return { comparison: null };
  const elapsed = daysBetween(current.from, current.to);

  const shiftYears = (years: number): DateRange => {
    const from = sameDayLastYear(years === 2 ? sameDayLastYear(current.from) : current.from);
    return { from, to: addDays(from, elapsed - 1) };
  };

  switch (axis) {
    case 'previous': {
      // The window of the same length ending the day before this one starts,
      // except calendar tokens, which step to the prior calendar unit.
      if (token === 'MTD') {
        const anchor = sameDayLastMonth(current.to);
        return { comparison: { from: monthStart(anchor), to: anchor } };
      }
      if (token === 'QTD' || token === 'YTD') {
        const prevEnd = addDays(current.from, -1);
        const prevStart = token === 'QTD' ? fyQuarterStart(prevEnd) : fyStart(prevEnd);
        return { comparison: { from: prevStart, to: addDays(prevStart, elapsed - 1) } };
      }
      const to = addDays(current.from, -1);
      return { comparison: { from: addDays(to, -(elapsed - 1)), to } };
    }
    case 'same-ly':
      return { comparison: shiftYears(1) };
    case 'two-years':
      return { comparison: shiftYears(2) };
    case 'rolling-3': {
      // The average of the last three same-shaped windows: for MTD, days 1-N
      // of the three prior months; otherwise the three preceding windows of
      // the same length, back to back.
      const set: DateRange[] = [];
      if (token === 'MTD' || token === 'LMTD') {
        let anchor = current.to;
        for (let i = 0; i < 3; i += 1) {
          anchor = sameDayLastMonth(anchor);
          set.push({ from: monthStart(anchor), to: anchor });
        }
      } else {
        let end = addDays(current.from, -1);
        for (let i = 0; i < 3; i += 1) {
          set.push({ from: addDays(end, -(elapsed - 1)), to: end });
          end = addDays(end, -elapsed);
        }
      }
      return { comparison: set[0] ?? null, comparisonSet: set };
    }
  }
}

/**
 * Working-day matching (B2): with the non-working dates supplied, the
 * comparison is trimmed so both windows hold the same COUNT of working
 * days — a month with two extra Sundays is not a demand signal.
 */
export function matchWorkingDays(
  current: DateRange,
  comparison: DateRange,
  nonWorking: ReadonlySet<string>,
): { comparison: DateRange; workingDays: number } {
  let workingDays = 0;
  for (let d = current.from; d <= current.to; d = addDays(d, 1)) {
    if (!nonWorking.has(d)) workingDays += 1;
  }
  if (workingDays === 0) return { comparison: { from: comparison.from, to: comparison.from }, workingDays };
  // The end is written exactly once, at whichever break fires first: the
  // day the counts match, or the source window running out (taken whole).
  let matched = 0;
  let end = comparison.to;
  let d = comparison.from;
  for (;;) {
    if (!nonWorking.has(d)) {
      matched += 1;
      if (matched === workingDays) {
        end = d;
        break;
      }
    }
    if (d >= comparison.to) break;
    d = addDays(d, 1);
  }
  return { comparison: { from: comparison.from, to: end }, workingDays };
}

export function resolvePeriod(
  token: PeriodToken,
  today: string,
  axis: ComparisonAxis,
  custom?: DateRange,
): ResolvedPeriod {
  const current = resolveCurrent(token, today, custom);
  const { comparison, comparisonSet } = resolveComparison(token, current, axis);
  const elapsed = daysBetween(current.from, current.to);

  const fullLength =
    token === 'MTD'
      ? daysBetween(monthStart(current.to), monthEnd(current.to))
      : token === 'QTD' || token === 'YTD'
        ? daysBetween(current.from, token === 'QTD' ? monthEnd(addDays(fyQuarterStart(current.to), 62)) : addDays(fyStart(addDays(current.to, 366)), -1))
        : elapsed;

  const caption =
    comparison === null
      ? `Day ${String(elapsed)} of ${String(fullLength)}.`
      : `Day ${String(elapsed)} of ${String(fullLength)} — comparing against ${comparison.from} to ${comparison.to}.`;

  return {
    token,
    current,
    comparison,
    ...(comparisonSet !== undefined ? { comparisonSet } : {}),
    elapsedDaysMatched: comparison === null ? elapsed : Math.min(elapsed, daysBetween(comparison.from, comparison.to)),
    periodLengthDays: elapsed,
    caption,
  };
}

/**
 * Run-rate projection for a to-date window (B2): linear, plus a band from
 * the spread of daily takes so it is never printed as a false point.
 */
export function runRate(totalSoFar: number, elapsedDays: number, fullDays: number): { projected: number; low: number; high: number } {
  if (elapsedDays <= 0 || fullDays <= elapsedDays) return { projected: totalSoFar, low: totalSoFar, high: totalSoFar };
  const perDay = totalSoFar / elapsedDays;
  const projected = perDay * fullDays;
  // A modest band: ±half the remaining days' worth of one average day. The
  // seasonality-adjusted band arrives with D7's engine; a wider honest band
  // beats a precise wrong one until then.
  const remaining = fullDays - elapsedDays;
  return { projected, low: projected - (perDay * remaining) / 2, high: projected + (perDay * remaining) / 2 };
}

/** CAGR over 3+ full years (B2); null below three years or on a non-positive base. */
export function cagr(first: number, last: number, years: number): number | null {
  if (years < 3 || first <= 0 || last <= 0) return null;
  return Math.pow(last / first, 1 / years) - 1;
}
