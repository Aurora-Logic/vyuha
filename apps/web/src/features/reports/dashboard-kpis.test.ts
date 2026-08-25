import { DASHBOARD_KPI_METRICS, REPORT_DEFINITIONS, type PageMeta } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { DASHBOARD_KPIS, kpiTileOf } from './dashboard-kpis';
import type { ReportRowView } from './types';

/**
 * The headline figures, computed the way the overview page computes them:
 * the server's whole-report total where one is stated, the page sum where
 * the response predates it, and never a figure that belongs to nobody.
 */

function row(cells: Record<string, string | number | boolean | null>): ReportRowView {
  return { id: JSON.stringify(cells), primary: '', status: null, cells, punch: null };
}

function meta(total: number, totals?: Readonly<Record<string, string>>): PageMeta {
  return { page: 1, pageSize: 200, total, ...(totals === undefined ? {} : { totals }) };
}

describe('the metric registry', () => {
  it('covers every declared metric with a real report', () => {
    for (const metric of DASHBOARD_KPI_METRICS) {
      const spec = DASHBOARD_KPIS[metric];
      expect(spec.metric).toBe(metric);
      expect(REPORT_DEFINITIONS[spec.reportKey], metric).toBeDefined();
    }
  });

  it('builds a tile whose reportKey and filters are the registry entry', () => {
    const tile = kpiTileOf('invoiced-period');
    expect(tile).toEqual({
      reportKey: 'sales-analysis',
      kind: 'kpi',
      metric: 'invoiced-period',
      form: 'auto',
      wide: false,
      filters: { groupBy: 'month' },
    });
  });
});

describe('invoiced-period', () => {
  it('sums the value column and counts the months', () => {
    const reading = DASHBOARD_KPIS['invoiced-period'].compute(
      [row({ label: '2026-07', value: '60000' }), row({ label: '2026-08', value: '40000' })],
      meta(2),
    );
    expect(reading.value).toBe('₹1,00,000.00');
    expect(reading.note).toBe('Across 2 months');
  });

  it('says one month in the singular', () => {
    const reading = DASHBOARD_KPIS['invoiced-period'].compute([row({ label: '2026-08', value: '500' })], meta(1));
    expect(reading.note).toBe('Across 1 month');
  });
});

describe('receivables-exposure', () => {
  const rows = [row({ partyName: 'Asha', exposure: '1200' }), row({ partyName: 'Behar', exposure: '800' })];

  it('prefers the whole-report total over the page sum', () => {
    const reading = DASHBOARD_KPIS['receivables-exposure'].compute(rows, meta(240, { exposure: '500000' }));
    expect(reading.value).toBe('₹5,00,000.00');
    expect(reading.note).toBe('240 debtors, from the credit cycle');
  });

  it('falls back to the page sum for a response that predates the total', () => {
    const reading = DASHBOARD_KPIS['receivables-exposure'].compute(rows, meta(2));
    expect(reading.value).toBe('₹2,000.00');
  });
});

describe('credit-breaches and below-reorder', () => {
  it('state the server count, not the page length', () => {
    expect(DASHBOARD_KPIS['credit-breaches'].compute([], meta(7)).value).toBe('7');
    expect(DASHBOARD_KPIS['below-reorder'].compute([], meta(31)).value).toBe('31');
  });
});

describe('revenue-going-quiet', () => {
  it('counts only the customers who have actually gone quiet', () => {
    const reading = DASHBOARD_KPIS['revenue-going-quiet'].compute(
      [
        row({ partyName: 'Asha', state: 'LAPSED', revenue12m: '60000' }),
        row({ partyName: 'Behar', state: 'AT_RISK', revenue12m: '40000' }),
        row({ partyName: 'Fine', state: 'ON_RHYTHM', revenue12m: '99999' }),
      ],
      meta(3),
    );
    expect(reading.value).toBe('₹1,00,000.00');
  });
});

describe('dead-stock-value', () => {
  it('sums the value locked, naming how many items hold it', () => {
    const reading = DASHBOARD_KPIS['dead-stock-value'].compute(
      [row({ item: 'MCB 32A', valueLocked: '1500' }), row({ item: 'MCB 63A', valueLocked: '500' })],
      meta(2),
    );
    expect(reading.value).toBe('₹2,000.00');
    expect(reading.note).toBe('2 items with no sale in ninety days');
  });
});
