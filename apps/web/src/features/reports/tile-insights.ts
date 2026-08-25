import type { PageMeta, ReportFilters, ReportKey } from '@vyuha/shared';

import {
  ageingByBucket,
  concentration,
  creditHeadroom,
  fillRate,
  monthlyInvoiced,
  newVsRepeat,
  paymentSlippage,
  pendingByAge,
  revenueAndBasket,
  revenueAtRisk,
  stockAgeing,
  topCustomers,
} from './dashboard-v2.series';
import type { ReportRowView } from './types';

/**
 * The sentence under a dashboard tile, computed by the same tested series
 * builders the old bespoke overview used -- an insight is a claim the rows
 * prove, with named thresholds, never composed in JSX (data-analyst skill
 * §6). A report with no entry here shows no sentence, which is the honest
 * default: silence, not vibes.
 *
 * `thisMonth` is a parameter rather than a clock read so the sentences stay
 * deterministic under test; `meta` is what lets a sentence refuse to claim
 * the whole period off a capped page.
 */
export function tileInsight(
  reportKey: ReportKey,
  filters: ReportFilters,
  rows: readonly ReportRowView[],
  meta: PageMeta,
  thisMonth: string,
): string | null {
  const truncated = meta.total > rows.length;
  switch (reportKey) {
    case 'sales-analysis':
      return filters.groupBy === 'party'
        ? topCustomers(rows, 5, truncated).insight
        : monthlyInvoiced(rows, thisMonth).insight;
    case 'aov-trend':
      return revenueAndBasket(rows, thisMonth).insight;
    case 'ageing':
      return ageingByBucket(rows).insight;
    case 'payment-analysis':
      return paymentSlippage(rows).insight;
    case 'customer-concentration':
      return concentration(rows).insight;
    case 'customer-lapse':
      return revenueAtRisk(rows).insight;
    case 'new-vs-repeat':
      return newVsRepeat(rows).insight;
    case 'order-fill-rate':
      return fillRate(rows).insight;
    case 'pending-dispatch':
      return pendingByAge(rows).insight;
    case 'stock-ageing':
      return stockAgeing(rows).insight;
    case 'credit-cycle':
      return creditHeadroom(rows).insight;
    default:
      return null;
  }
}
