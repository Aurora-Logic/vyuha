import type { DashboardKpiMetric, DashboardTile, PageMeta, ReportFilters, ReportKey } from '@vyuha/shared';

import { formatCount, formatMoney, formatMoneyShort } from '@/lib/format';

import { quietRevenue, sumColumn } from './dashboard-v2.series';
import type { ReportRowView } from './types';

/**
 * The six headline figures as a registry (owner, 25 Aug 2026), so a KPI can
 * sit on any board the way a chart tile does: the stored tile names a metric,
 * and everything else about it -- which report feeds it, how the figure is
 * summed, what the tap opens -- lives here, in code, where it can change
 * without touching what anyone stored.
 *
 * Every compute mirrors the overview page's own arithmetic, including its
 * hard-won rule about totals: a figure for the whole report reads the total
 * the server sums over every row, and the page sum remains the fallback for
 * a response that predates it. Two hundred rows under a caption naming every
 * debtor there is stated a number belonging to nobody.
 */

export interface KpiReading {
  readonly value: string;
  readonly note: string;
}

export interface KpiMetricSpec {
  readonly metric: DashboardKpiMetric;
  readonly label: string;
  readonly reportKey: ReportKey;
  readonly params: ReportFilters;
  readonly compute: (rows: readonly ReportRowView[], meta: PageMeta) => KpiReading;
  /** What a tap on the figure opens; the period joins at drill time. */
  readonly drillQuery: Readonly<Record<string, string>>;
  /** The one emphasis a figure may carry; see KpiTileProps.tone. */
  readonly tone?: 'warning';
  /**
   * A second report whose rows join the first in computeCombined. Interest
   * lost is the one figure that is honestly two reports -- the receivables
   * leak and the stock leak are the same rupee cost in two places -- and the
   * spec's tile names the split.
   */
  readonly secondary?: { readonly reportKey: ReportKey; readonly params: ReportFilters };
  readonly computeCombined?: (
    primary: { readonly rows: readonly ReportRowView[]; readonly meta: PageMeta },
    secondary: { readonly rows: readonly ReportRowView[]; readonly meta: PageMeta },
  ) => KpiReading;
}

function stated(meta: PageMeta, key: string, fallback: number): number {
  const total = meta.totals?.[key];
  return total === undefined ? fallback : Number(total);
}

export const DASHBOARD_KPIS: Record<DashboardKpiMetric, KpiMetricSpec> = {
  'interest-lost': {
    metric: 'interest-lost',
    label: 'Interest lost this period',
    reportKey: 'party-interest-cost',
    params: {},
    // The single-report fallback states the receivables half honestly if the
    // strip ever renders without the stock reading.
    compute: (rows, meta) => ({
      value: formatMoney(stated(meta, 'interestLoss', sumColumn(rows, 'interestLoss'))),
      note: 'Receivables interest on overdue balances',
    }),
    secondary: { reportKey: 'stock-interest-cost', params: {} },
    computeCombined: (primary, secondary) => {
      const receivables = stated(primary.meta, 'interestLoss', sumColumn(primary.rows, 'interestLoss'));
      const stock = stated(secondary.meta, 'interest', sumColumn(secondary.rows, 'interest'));
      return {
        value: formatMoney(receivables + stock),
        note: `${formatMoneyShort(receivables)} receivables + ${formatMoneyShort(stock)} stock`,
      };
    },
    drillQuery: { report: 'party-interest-cost' },
    tone: 'warning',
  },
  'invoiced-period': {
    metric: 'invoiced-period',
    label: 'Invoiced this period',
    reportKey: 'sales-analysis',
    params: { groupBy: 'month' },
    compute: (rows) => ({
      value: formatMoney(sumColumn(rows, 'value')),
      note: `Across ${String(rows.length)} month${rows.length === 1 ? '' : 's'}`,
    }),
    drillQuery: { report: 'sales-analysis', groupBy: 'month' },
  },
  'receivables-exposure': {
    metric: 'receivables-exposure',
    label: 'Receivables exposure',
    reportKey: 'credit-cycle',
    params: {},
    compute: (rows, meta) => ({
      value: formatMoney(stated(meta, 'exposure', sumColumn(rows, 'exposure'))),
      note: `${formatCount(meta.total)} debtors, from the credit cycle`,
    }),
    drillQuery: { report: 'credit-cycle' },
  },
  'credit-breaches': {
    metric: 'credit-breaches',
    label: 'Over the credit limit',
    reportKey: 'credit-breaches',
    params: {},
    compute: (_rows, meta) => ({
      value: formatCount(meta.total),
      note: 'Parties past their limit right now',
    }),
    drillQuery: { report: 'credit-breaches' },
  },
  'revenue-going-quiet': {
    metric: 'revenue-going-quiet',
    label: 'Revenue going quiet',
    reportKey: 'customer-lapse',
    params: {},
    compute: (rows, meta) => ({
      value: formatMoney(stated(meta, 'revenue12m', quietRevenue(rows))),
      note: 'Last twelve months from lapsed and at-risk customers',
    }),
    drillQuery: { report: 'customer-lapse' },
  },
  'dead-stock-value': {
    metric: 'dead-stock-value',
    label: 'Dead stock value',
    reportKey: 'dead-stock',
    params: {},
    compute: (rows, meta) => ({
      value: formatMoney(stated(meta, 'valueLocked', sumColumn(rows, 'valueLocked'))),
      note: `${formatCount(meta.total)} items with no sale in ninety days`,
    }),
    drillQuery: { report: 'dead-stock' },
  },
  'below-reorder': {
    metric: 'below-reorder',
    label: 'Below reorder level',
    reportKey: 'low-stock',
    params: {},
    compute: (_rows, meta) => ({
      value: formatCount(meta.total),
      note: 'Items at or under reorder, net of open purchase orders',
    }),
    drillQuery: { report: 'low-stock' },
  },
};

/** A metric as the tile a preset or the customise sheet stores. */
export function kpiTileOf(metric: DashboardKpiMetric): DashboardTile {
  const spec = DASHBOARD_KPIS[metric];
  return { reportKey: spec.reportKey, kind: 'kpi', metric, form: 'auto', wide: false, filters: spec.params };
}
