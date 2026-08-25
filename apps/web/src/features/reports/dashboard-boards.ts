import { DASHBOARD_KPI_METRICS, isDashboardKey, type DashboardKey, type DashboardLayout } from '@vyuha/shared';

import { kpiTileOf } from './dashboard-kpis';

/**
 * The shipped boards, as code (owner, 25 Aug 2026).
 *
 * Layouts are data, presets are code: the server stores only a person's own
 * arrangement, so these constants are what a board shows until someone saves
 * one — and what it goes back to when they reset, because a reset is a delete
 * rather than a write of a default that would then go stale.
 *
 * Nearly every tile says `form: 'auto'` on purpose. The chart engine already
 * resolves the honest form for each report — a month-shaped category draws a
 * line, a ranking draws bars, the named overrides draw their own — and a
 * preset that repeated those answers would stop tracking them the day a
 * report learned a better chart. A form is pinned only where the preset wants
 * something the resolver would not choose: the fill rate as radial gauges,
 * because "how much of the whole happened" reads as a dial, not a ranking.
 *
 * The overview board has no preset: its default is the bespoke page.
 */

export const SALES_PRESET: DashboardLayout = {
  tiles: [
    // The board opens on its headline figure; the charts argue the detail.
    kpiTileOf('invoiced-period'),
    // Two cuts of the same report need their own names, or the board shows
    // "Sales analysis" twice and the reader cannot tell which is which.
    { reportKey: 'sales-analysis', label: 'Invoiced by month', kind: 'chart', form: 'auto', wide: true, filters: { groupBy: 'month' } },
    { reportKey: 'sales-analysis', label: 'Revenue by customer', kind: 'chart', form: 'auto', wide: false, filters: { groupBy: 'party' } },
    { reportKey: 'aov-trend', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'order-pipeline', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'order-fill-rate', kind: 'chart', form: 'radials', wide: false, filters: {} },
    { reportKey: 'dispatch-performance', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'new-vs-repeat', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'return-rate-by-customer', kind: 'chart', form: 'auto', wide: false, filters: {} },
  ],
};

export const FINANCE_PRESET: DashboardLayout = {
  tiles: [
    kpiTileOf('receivables-exposure'),
    kpiTileOf('credit-breaches'),
    { reportKey: 'ageing', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'credit-cycle', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'payment-analysis', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'broken-promises', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'promised-vs-collected', kind: 'chart', form: 'auto', wide: false, filters: {} },
    // The Pareto carries a curve and a bar series; half a row squeezes its
    // axis labels into a smear, so it takes the full one.
    { reportKey: 'customer-concentration', kind: 'chart', form: 'auto', wide: true, filters: {} },
    { reportKey: 'credit-breaches', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'gst-summary', kind: 'chart', form: 'auto', wide: false, filters: {} },
    // D-22: what the receivables actually cost, and the cycle that costs it.
    // Pinned rather than auto: the ranking of interest loss and the
    // three-day-series line are this board's point, and they must survive the
    // report's own default form learning a different answer. The cycle line
    // carries three series, so like the Pareto it takes the full row.
    { reportKey: 'party-interest-cost', kind: 'chart', form: 'hbar', wide: false, filters: {} },
    { reportKey: 'cash-cycle', kind: 'chart', form: 'line', wide: true, filters: {} },
  ],
};

/**
 * The overview stores no preset -- its default render is the bespoke page --
 * but its customise sheet must not start from nothing: a person who opened
 * the sheet and saved would silently lose the six headline figures the page
 * had been showing them. The sheet seeds from this instead, so customising
 * begins with the figures on the board and dropping one is a visible act.
 */
export const OVERVIEW_SEED: DashboardLayout = {
  tiles: DASHBOARD_KPI_METRICS.map(kpiTileOf),
};

/**
 * `?board=` to a board and back. Overview is the default and stays out of the
 * URL, so the address people have bookmarked keeps meaning what it meant.
 */
export function boardFromParam(value: string | null): DashboardKey {
  return value !== null && isDashboardKey(value) ? value : 'overview';
}

export function boardToParam(board: DashboardKey): string | null {
  return board === 'overview' ? null : board;
}
