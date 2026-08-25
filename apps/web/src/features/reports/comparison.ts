import type { ReportKey } from '@vyuha/shared';

import type { CompareMode } from '@/lib/period-compare';

import type { ReportRowView } from './types';

/**
 * The honesty layer between a report and its previous period.
 *
 * Three lies this module exists to prevent, each shipped once:
 *
 * 1. Rows were joined to their predecessors by raw id. Month-keyed rows
 *    carry the month as the id, and '2025-08' never equals '2026-08' -- so
 *    "vs same period last FY" rendered a year that actually happened as a
 *    column of "new" with green arrows. Date-keyed ids are now shifted onto
 *    the current period's calendar before the join, and the one comparison
 *    that cannot be aligned (an arbitrary "previous period" against month
 *    rows) is refused rather than faked.
 * 2. Every delta wore up = green. For a report measuring a cost -- interest
 *    lost, days late, money overdue -- an increase is bad, and the table
 *    painted it as good news. Direction and goodness are separate facts.
 * 3. "to date" was appended to every caption, including completed months --
 *    telling the reader a finished comparison was clipped when it was not.
 */

const MONTH_ID = /^\d{4}-\d{2}$/u;
const DATE_ID = /^\d{4}-\d{2}-\d{2}$/u;

export type RowShape = 'month' | 'date' | 'entity';

/** What the rows are keyed by, judged over all of them: one stray id means entity. */
export function rowShapeOf(rows: readonly ReportRowView[]): RowShape {
  if (rows.length === 0) return 'entity';
  if (rows.every((row) => MONTH_ID.test(row.id))) return 'month';
  if (rows.every((row) => DATE_ID.test(row.id))) return 'date';
  return 'entity';
}

/**
 * Whether this comparison can be joined honestly for rows of this shape.
 * Entity rows join by identity under either mode. Time-keyed rows align
 * exactly under "last FY" (shift twelve months); an arbitrary "previous
 * period" has no calendar mapping onto month rows, and a join that cannot
 * be stated cannot be shown.
 */
export function comparisonJoinable(mode: CompareMode, shape: RowShape): boolean {
  if (mode === 'off') return false;
  if (shape === 'entity') return true;
  return mode === 'lastYear';
}

function shiftMonthId(id: string, months: number): string {
  const [year, month] = id.split('-').map(Number);
  if (year === undefined || month === undefined) return id;
  const index = year * 12 + (month - 1) + months;
  return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
}

function shiftDateId(id: string, months: number): string {
  const [year, month, day] = id.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return id;
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  // Clamp to the target month's last day, the same rule period-compare
  // applies to ranges: 29 Feb shifted lands on 28 Feb, not 1 Mar.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${String(targetYear)}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/**
 * The previous-period lookup: given the comparison rows, a function from a
 * current row to its predecessor. Null when the mode cannot be joined for
 * this row shape -- the caller shows no comparison rather than a wrong one.
 */
export function previousRowLookup(
  mode: CompareMode,
  currentRows: readonly ReportRowView[],
  previousRows: readonly ReportRowView[],
): ((row: ReportRowView) => ReportRowView | undefined) | null {
  const shape = rowShapeOf(currentRows);
  if (!comparisonJoinable(mode, shape)) return null;
  if (shape === 'entity') {
    const byId = new Map(previousRows.map((row) => [row.id, row]));
    return (row) => byId.get(row.id);
  }
  // Time-keyed under lastYear: the predecessor's id, moved forward twelve
  // months, is the current id it answers for.
  const shifted = new Map(
    previousRows.map((row) => [
      shape === 'month' ? shiftMonthId(row.id, 12) : shiftDateId(row.id, 12),
      row,
    ]),
  );
  return (row) => shifted.get(row.id);
}

/**
 * Reports where the measured number is a cost or a risk: money not
 * collected, days past terms, stock nobody buys. Down is the good
 * direction. Everything else keeps up = good, and a report absent from
 * this set that should be in it shows one wrong colour -- which is why the
 * set lives here, named, rather than as a guess at each render site.
 */
const DOWN_IS_GOOD: ReadonlySet<ReportKey> = new Set<ReportKey>([
  'ageing',
  'broken-promises',
  'credit-breaches',
  'customer-lapse',
  'dead-stock',
  'late-arrivals',
  'low-stock',
  'missing-punch',
  'negative-stock',
  'party-interest-cost',
  'payment-analysis',
  'pending-dispatch',
  'requirement-ageing',
  'return-rate-by-customer',
  'stock-ageing',
  'stock-interest-cost',
]);

export type DeltaTone = 'good' | 'bad' | 'neutral';

/** Direction and goodness are separate facts; this is where they meet. */
export function deltaTone(reportKey: ReportKey, direction: 'up' | 'down' | 'flat'): DeltaTone {
  if (direction === 'flat') return 'neutral';
  const downIsGood = DOWN_IS_GOOD.has(reportKey);
  return (direction === 'up') !== downIsGood ? 'good' : 'bad';
}

/**
 * ", to date" belongs on a caption only while the current period is still
 * running -- its end on or past today. A completed month compared against
 * its full predecessor is not clipped, and saying so misleads.
 */
export function isToDate(currentTo: string, today: string): boolean {
  return currentTo >= today;
}
