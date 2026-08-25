import { REPORT_DEFINITIONS, dashboardTileSchema } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { healTileForm } from './dashboard-heal';
import { formDraws, resolveChartForm, wearableForms, type ChartRow } from './report-series';

/**
 * The board draws the person's choice where it can and the automatic form
 * where it cannot -- with the substitution named, never silent. The customise
 * sheet asks the same helper, so it stops offering forms a report's columns
 * can never wear, which is how the impossible choice got stored at all.
 */

function row(cells: Record<string, string | number | boolean | null>): ChartRow {
  return { id: 'r1', cells };
}

const AGEING_ROWS = [row({ partyName: 'Asha Traders', billName: 'INV-1', outstanding: '1200.00', ageDays: 12 })];

describe('wearableForms', () => {
  it('never offers a heatmap to a report without months', () => {
    expect(wearableForms(REPORT_DEFINITIONS.ageing)).not.toContain('heatmap');
    expect(wearableForms(REPORT_DEFINITIONS['sales-heatmap'])).toContain('heatmap');
  });

  it('offers pareto only where the running total exists, radials only where a rate does', () => {
    expect(wearableForms(REPORT_DEFINITIONS['customer-concentration'])).toContain('pareto');
    expect(wearableForms(REPORT_DEFINITIONS.ageing)).not.toContain('pareto');
    expect(wearableForms(REPORT_DEFINITIONS['order-fill-rate'])).toContain('radials');
    expect(wearableForms(REPORT_DEFINITIONS['day-book'])).not.toContain('radials');
  });

  it('offers an area only to a time-shaped report', () => {
    expect(wearableForms(REPORT_DEFINITIONS['aov-trend'])).toContain('area');
    expect(wearableForms(REPORT_DEFINITIONS['ledger-extract'])).toContain('area');
    expect(wearableForms(REPORT_DEFINITIONS.ageing)).not.toContain('area');
    expect(wearableForms(REPORT_DEFINITIONS.ageing)).not.toContain('stacked-area');
  });

  it('offers the stacked forms only with two numeric columns to stack', () => {
    expect(wearableForms(REPORT_DEFINITIONS.ageing)).toContain('stacked-bar');
    // Stock ageing's buckets are quantity strings; only the value is numeric.
    expect(wearableForms(REPORT_DEFINITIONS['stock-ageing'])).not.toContain('stacked-bar');
    expect(wearableForms(REPORT_DEFINITIONS['gst-summary'])).toContain('stacked-area');
    expect(wearableForms(REPORT_DEFINITIONS['aov-trend'])).toContain('stacked-area');
  });

  it('offers bars and pie wherever hbar and donut go, and radar to any category with a figure', () => {
    for (const definition of [REPORT_DEFINITIONS.ageing, REPORT_DEFINITIONS['aov-trend']]) {
      const forms = wearableForms(definition);
      expect(forms).toContain('bar');
      expect(forms).toContain('pie');
      expect(forms).toContain('radar');
    }
  });
});

describe('formDraws', () => {
  it('refuses a heatmap over month-less rows and accepts the shapes that fit', () => {
    const spec = resolveChartForm('ageing', REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect(formDraws({ ...spec, form: 'heatmap' }, REPORT_DEFINITIONS.ageing, AGEING_ROWS)).toBe(false);
    expect(formDraws(spec, REPORT_DEFINITIONS.ageing, AGEING_ROWS)).toBe(true);
  });

  it('draws every per-row family over ranked rows, and refuses them over nothing but zeros', () => {
    const spec = resolveChartForm('ageing', REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    for (const form of ['bar', 'stacked-bar', 'radar', 'pie'] as const) {
      expect(formDraws({ ...spec, form }, REPORT_DEFINITIONS.ageing, AGEING_ROWS), form).toBe(true);
    }
    const zeroRows = [row({ partyName: 'Asha Traders', billName: 'INV-1', outstanding: '0', ageDays: 0 })];
    for (const form of ['bar', 'stacked-bar', 'radar'] as const) {
      expect(formDraws({ ...spec, form }, REPORT_DEFINITIONS.ageing, zeroRows), form).toBe(false);
    }
  });

  it('draws the areas over month-shaped rows', () => {
    const aovRows = [
      row({ month: '2026-07', invoices: 3, revenue: '300.00', aov: '100.00' }),
      row({ month: '2026-08', invoices: 2, revenue: '400.00', aov: '200.00' }),
    ];
    const spec = resolveChartForm('aov-trend', REPORT_DEFINITIONS['aov-trend'], aovRows);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect(formDraws({ ...spec, form: 'area' }, REPORT_DEFINITIONS['aov-trend'], aovRows)).toBe(true);
    expect(formDraws({ ...spec, form: 'stacked-area' }, REPORT_DEFINITIONS['aov-trend'], aovRows)).toBe(true);
  });
});

describe('healTileForm', () => {
  const tileOf = (form: string) => dashboardTileSchema.parse({ reportKey: 'ageing', form });

  it('heals an unwearable pinned form back to automatic, and says so', () => {
    const healed = healTileForm(tileOf('heatmap'), REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(healed.form).toBeUndefined();
    expect(healed.footnote).toContain('cannot wear the heatmap chart');
  });

  it('keeps a pinned form the rows can wear, without a footnote', () => {
    const healed = healTileForm(tileOf('donut'), REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(healed.form).toBe('donut');
    expect(healed.footnote).toBeUndefined();
  });

  it('leaves the automatic choice alone', () => {
    const healed = healTileForm(tileOf('auto'), REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(healed).toEqual({ form: undefined, footnote: undefined });
  });
});
