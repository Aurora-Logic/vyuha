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
});

describe('formDraws', () => {
  it('refuses a heatmap over month-less rows and accepts the shapes that fit', () => {
    const spec = resolveChartForm('ageing', REPORT_DEFINITIONS.ageing, AGEING_ROWS);
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect(formDraws({ ...spec, form: 'heatmap' }, REPORT_DEFINITIONS.ageing, AGEING_ROWS)).toBe(false);
    expect(formDraws(spec, REPORT_DEFINITIONS.ageing, AGEING_ROWS)).toBe(true);
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
