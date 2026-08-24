import type { DateRange } from 'react-day-picker';

import { REPORT_DEFINITIONS, type ReportDefinition, type ReportKey } from '@vyuha/shared';

/**
 * What a report's period is, and how to bend one into it.
 *
 * Its own module rather than a corner of the filter bar because the toolbar and
 * the page both need it -- the bar to choose the instrument, the page to
 * re-anchor the period when the reader switches report -- and because a helper
 * exported beside a component is what breaks fast refresh.
 */

/** From `ReportDefinition.singleDate` / `singleMonth`. */
export type PeriodMode = 'range' | 'date' | 'month';

export function periodModeOf(definition: ReportDefinition | undefined): PeriodMode {
  if (definition?.singleDate === true) return 'date';
  if (definition?.singleMonth === true) return 'month';
  return 'range';
}

/** The whole calendar month a date falls in, as the range the API is sent. */
export function monthRange(date: Date): DateRange {
  return {
    from: new Date(date.getFullYear(), date.getMonth(), 1),
    // Day 0 of the next month, so February and the leap day come from the
    // runtime rather than from a table written here.
    to: new Date(date.getFullYear(), date.getMonth() + 1, 0),
  };
}

/**
 * The period a report can actually answer for.
 *
 * Switching to the daily muster from a month-long register has to land on a
 * date, and switching to the muster grid from a quarter has to land inside one
 * month -- otherwise the first thing the reader sees is the server refusing
 * their period, which reads as the report being broken. Narrowing to the *end*
 * of the selection keeps the most recent thing they were looking at.
 */
export function periodFor(mode: PeriodMode, period: DateRange): DateRange {
  const anchor = period.to ?? period.from ?? new Date();
  if (mode === 'date') return { from: anchor, to: anchor };
  if (mode === 'month') {
    const from = period.from ?? anchor;
    return from.getFullYear() === anchor.getFullYear() && from.getMonth() === anchor.getMonth()
      ? { from, to: period.to ?? anchor }
      : monthRange(anchor);
  }
  return period;
}

/** `YYYY-MM-DD` for an endpoint, from a Date. Never the ISO instant (NFR-05). */
export function toDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

/**
 * The period a link to a report should carry, bent into what that report can
 * answer for.
 *
 * Every drill-through from the dashboard dropped the period: the reader
 * clicked a figure for one quarter and landed on a report showing its own
 * default range, so the number they had just been looking at was not on the
 * screen they arrived at. Bent rather than copied, for the same reason
 * switching report re-anchors: a month-only report given a quarter shows an
 * error, which reads as the report being broken.
 */
export function periodParams(report: ReportKey, period: DateRange): Record<string, string> {
  const fitted = periodFor(periodModeOf(REPORT_DEFINITIONS[report]), period);
  return {
    ...(fitted.from === undefined ? {} : { from: toDateParam(fitted.from) }),
    ...(fitted.to === undefined ? {} : { to: toDateParam(fitted.to) }),
  };
}
