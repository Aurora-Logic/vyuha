import { isDashboardKey, type DashboardKey, type DashboardLayout } from '@vyuha/shared';

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
 */

/**
 * The front board. Not a gallery of chart shapes -- its predecessor was
 * literally titled "every chart shape shadcn ships" and read like a
 * showroom -- but the four decisions an owner makes with their morning tea,
 * one glance each:
 *
 *   Is money coming in?      invoiced by month, and from whom.
 *   Is what is owed safe?    the ageing buckets, and who pays late.
 *   Where does risk sit?     concentration, and revenue going quiet.
 *   Is the floor keeping up? order fill, and what is below reorder.
 *
 * The six headline figures open the page; every chart drills to its report
 * with the period riding along, and every tile carries the tested sentence
 * its series proves. Rendered through the same TileGrid as every board, so
 * the overview loads, errs, and customises exactly like the rest.
 */
export const OVERVIEW_PRESET: DashboardLayout = {
  tiles: [
    kpiTileOf('invoiced-period'),
    kpiTileOf('receivables-exposure'),
    kpiTileOf('credit-breaches'),
    kpiTileOf('revenue-going-quiet'),
    kpiTileOf('dead-stock-value'),
    kpiTileOf('below-reorder'),
    // Is money coming in?
    { reportKey: 'sales-analysis', label: 'Invoiced by month', kind: 'chart', form: 'auto', wide: true, filters: { groupBy: 'month' } },
    { reportKey: 'sales-analysis', label: 'Revenue by customer', kind: 'chart', form: 'auto', wide: false, filters: { groupBy: 'party' } },
    // Is what is owed safe?
    { reportKey: 'ageing', kind: 'chart', form: 'auto', wide: false, filters: {} },
    { reportKey: 'payment-analysis', kind: 'chart', form: 'auto', wide: false, filters: {} },
    // Where does the risk sit? The Pareto takes the full row for the
    // reason the finance board gives: half a row smears its axis.
    { reportKey: 'customer-concentration', kind: 'chart', form: 'auto', wide: true, filters: {} },
    { reportKey: 'customer-lapse', kind: 'chart', form: 'auto', wide: false, filters: {} },
    // Is the floor keeping up?
    { reportKey: 'order-fill-rate', kind: 'chart', form: 'radials', wide: false, filters: {} },
  ],
};

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
    kpiTileOf('receivables-interest'),
    kpiTileOf('stock-interest'),
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
 * `?board=` to a board and back. Overview is the default and stays out of the
 * URL, so the address people have bookmarked keeps meaning what it meant.
 */
export function boardFromParam(value: string | null): DashboardKey {
  return value !== null && isDashboardKey(value) ? value : 'overview';
}

export function boardToParam(board: DashboardKey): string | null {
  return board === 'overview' ? null : board;
}
