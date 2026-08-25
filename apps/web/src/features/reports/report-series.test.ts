import { REPORT_DEFINITIONS } from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { REPORT_FORM_OVERRIDES, ageingSeries, formDraws, formSeries, genericSeries, heatmapGrid, heatmapStep, lapseSeries, movementSeries, salesAnalysisSeries, shareSeries, velocitySeries, type ChartRow } from './report-series';

/** The builders behind the report charts: thresholds named and proven (vyuha-charts §3, §5). */

function row(cells: Record<string, string | number | null>): ChartRow {
  return { cells };
}

describe('salesAnalysisSeries', () => {
  it('is quiet on empty and on a single bar', () => {
    expect(salesAnalysisSeries([]).points).toEqual([]);
    expect(salesAnalysisSeries([row({ label: 'Asha', value: '100' })]).insight).toBeNull();
  });

  it('names the leader only when it carries at least a fifth', () => {
    const spread = salesAnalysisSeries([row({ label: 'A', value: '19' }), row({ label: 'B', value: '81' })]);
    expect(spread.insight).toContain('B carries 81%');
    const even = salesAnalysisSeries(Array.from({ length: 6 }, (_, i) => row({ label: `C${String(i)}`, value: '10' })));
    expect(even.insight).toBeNull();
  });
});

describe('movementSeries', () => {
  it('says a single month cannot show a direction', () => {
    const one = movementSeries([row({ month: '2026-08', inwardQty: '5', outwardQty: '2' })]);
    expect(one.insight).toContain('Not enough months');
  });

  it('reads the last month as building or draining', () => {
    const built = movementSeries([
      row({ month: '2026-07', inwardQty: '1', outwardQty: '1' }),
      row({ month: '2026-08', inwardQty: '10', outwardQty: '4' }),
    ]);
    expect(built.insight).toContain('built up by 6');
    const drained = movementSeries([
      row({ month: '2026-07', inwardQty: '1', outwardQty: '1' }),
      row({ month: '2026-08', inwardQty: '2', outwardQty: '9' }),
    ]);
    expect(drained.insight).toContain('drained by 7');
  });
});

describe('velocitySeries', () => {
  it('counts quickening and slowing against each item’s own year', () => {
    const series = velocitySeries([
      row({ item: 'Fast', monthly12: '10', monthly3: '20' }),
      row({ item: 'Slow', monthly12: '10', monthly3: '5' }),
      row({ item: 'Steady', monthly12: '10', monthly3: '10' }),
    ]);
    expect(series.insight).toBe('Of the top 3: 1 quickening, 1 slowing against their own year.');
  });

  it('says nothing when every item holds its pace', () => {
    expect(velocitySeries([row({ item: 'A', monthly12: '10', monthly3: '10' })]).insight).toBeNull();
  });
});

describe('ageingSeries', () => {
  it('flags the oldest bucket only from a quarter of the quantity', () => {
    const old = ageingSeries([row({ item: 'A', bucket0: '1', bucket31: '0', bucket61: '0', bucket90: '3', valueLocked: '100' })]);
    expect(old.insight).toContain('75% of the stock shown');
    const young = ageingSeries([row({ item: 'A', bucket0: '9', bucket31: '0', bucket61: '0', bucket90: '1', valueLocked: '100' })]);
    expect(young.insight).toBeNull();
  });
});

describe('lapseSeries', () => {
  it('sums the revenue going quiet and counts the fully lapsed', () => {
    const series = lapseSeries([
      row({ partyName: 'Asha', revenue12m: '60000', state: 'LAPSED' }),
      row({ partyName: 'Behar', revenue12m: '40000', state: 'AT_RISK' }),
      row({ partyName: 'Fine', revenue12m: '99999', state: 'ON_RHYTHM' }),
    ]);
    expect(series.points).toHaveLength(2);
    expect(series.insight).toContain('₹1,00,000');
    expect(series.insight).toContain('1 of these 2');
  });
});

describe('genericSeries', () => {
  const definition = {
    defaultSort: '-amount',
    columns: [
      { key: 'name', header: 'Name', type: 'text' as const },
      { key: 'amount', header: 'Amount', type: 'text' as const },
      { key: 'count', header: 'Count', type: 'number' as const },
      { key: 'asOf', header: 'As of', type: 'instant' as const },
    ],
  };

  it('names the bars from the first text column and sizes them by the sort column first', () => {
    const series = genericSeries(definition, [row({ name: 'A', amount: '100.00', count: 2, asOf: 'x' }), row({ name: 'B', amount: '50.00', count: 1, asOf: 'x' })]);
    expect(series?.categoryLabel).toBe('Name');
    expect(series?.series[0]?.key).toBe('amount');
    expect(series?.points[0]).toMatchObject({ category: 'A', amount: 100 });
  });

  it('carries the category column key and each row id, which is what a chart drill filters by', () => {
    const series = genericSeries(definition, [{ id: 'party-1', cells: { name: 'A', amount: '100.00', count: 2 } }]);
    expect(series?.categoryKey).toBe('name');
    expect(series?.points[0]).toMatchObject({ __rowId: 'party-1' });
  });

  it('refuses a chart where nothing is numeric, and where everything is zero', () => {
    expect(genericSeries({ defaultSort: 'name', columns: [{ key: 'name', header: 'Name', type: 'text' as const }] }, [row({ name: 'A' })])).toBeNull();
    expect(genericSeries(definition, [row({ name: 'A', amount: '0', count: 0 })])).toBeNull();
  });
});

describe('shareSeries', () => {
  it('shares are of everything shown, not of the top five', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ item: `I${String(i)}`, value: '10' }));
    const { points, total } = shareSeries(rows, 'item', 'value');
    expect(total).toBe(100);
    expect(points).toHaveLength(5);
    expect(points[0]?.share).toBe(10);
  });
});

describe('formSeries scatter', () => {
  it('draws one dot per row, names it party and item, and carries the item for the drill', () => {
    const points = formSeries({ form: 'scatter', category: 'partyName', series: ['invoices', 'value'] }, [
      { cells: { partyName: 'Asha Traders', item: 'Cat6 Cable', invoices: 7, value: '4150.50' } },
    ]);
    expect(points).toEqual([
      { category: 'Asha Traders · Cat6 Cable', __item: 'Cat6 Cable', invoices: 7, value: 4150.5 },
    ]);
  });
});

describe('heatmap grid', () => {
  it('lays customers down and months across, sorted, and finds the maximum', () => {
    const points = formSeries({ form: 'heatmap', category: 'partyName', series: ['value'] }, [
      { id: 'p1:2026-08', cells: { partyName: 'Asha', month: '2026-08', value: '400' } },
      { id: 'p1:2026-07', cells: { partyName: 'Asha', month: '2026-07', value: '100' } },
      { id: 'p2:2026-08', cells: { partyName: 'Bala', month: '2026-08', value: '50' } },
    ]);
    const grid = heatmapGrid(points, 'value');
    expect(grid.months).toEqual(['2026-07', '2026-08']);
    expect(grid.rows.map((row) => row.category)).toEqual(['Asha', 'Bala']);
    expect(grid.rows[0]?.cells).toEqual([100, 400]);
    expect(grid.rows[1]?.cells).toEqual([null, 50]);
    expect(grid.max).toBe(400);
  });

  it('shades by share of the maximum, nothing for an empty cell', () => {
    expect(heatmapStep(null, 400)).toBe(0);
    expect(heatmapStep(400, 400)).toBe(5);
    expect(heatmapStep(50, 400)).toBe(1);
    expect(heatmapStep(0, 0)).toBe(0);
  });
});

describe('formSeries radials', () => {
  it('takes five rates at most, in the table\'s order', () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({ id: `d${String(index)}`, cells: { department: `Dept ${String(index)}`, onTimePct: String(90 - index) } }));
    const points = formSeries({ form: 'radials', category: 'department', series: ['onTimePct'] }, rows);
    expect(points).toHaveLength(5);
    expect(points[0]).toMatchObject({ category: 'Dept 0', onTimePct: 90, __rowId: 'd0' });
  });
});

describe('interest report form overrides (D-22)', () => {
  const PARTY_ROWS: ChartRow[] = [
    { id: 'p1', cells: { partyName: 'Asha Traders', effectiveRatePct: 12, plannedCost: '310.50', interestLoss: '1240.00', avgDaysOutstanding: 41, avgOverdueDays: 11, lossPctOfTurnover: 1.2, creditTerms: 'TALLY', settlementRule: 'FIFO oldest-first', asOf: '2026-08-25T00:00:00.000Z' } },
    { id: 'p2', cells: { partyName: 'Behar Metals', effectiveRatePct: 14, plannedCost: '90.00', interestLoss: '820.00', avgDaysOutstanding: 62, avgOverdueDays: 30, lossPctOfTurnover: 2.4, creditTerms: 'CREDIT TERMS MISSING', settlementRule: 'FIFO oldest-first', asOf: '2026-08-25T00:00:00.000Z' } },
  ];
  const STOCK_ROWS: ChartRow[] = [
    { id: 's1', cells: { item: 'Copper Wire 4mm', closingValue: '50000.00', fundedValue: '32000.00', interest: '410.000', daysSinceOutward: 12, nonMoving: 'MOVING', asOf: '2026-08-25T00:00:00.000Z' } },
    { id: 's2', cells: { item: 'MCB 32A', closingValue: '9000.00', fundedValue: '9000.00', interest: '120.000', daysSinceOutward: 120, nonMoving: 'NON-MOVING', asOf: '2026-08-25T00:00:00.000Z' } },
  ];
  const CYCLE_ROWS: ChartRow[] = [
    { id: '2026-07', cells: { month: '2026-07', inventoryDays: 44, receivableDays: 38, payableDays: 25, cashCycleDays: 57, totalInterest: '5100.00', asOf: '2026-08-25T00:00:00.000Z' } },
    { id: '2026-08', cells: { month: '2026-08', inventoryDays: 40, receivableDays: 41, payableDays: 22, cashCycleDays: 59, totalInterest: '5400.00', asOf: '2026-08-25T00:00:00.000Z' } },
  ];
  const CASES = [
    ['party-interest-cost', PARTY_ROWS],
    ['stock-interest-cost', STOCK_ROWS],
    ['cash-cycle', CYCLE_ROWS],
  ] as const;

  it('names only real column keys, so a renamed column cannot leave a silent blank chart', () => {
    for (const [key] of CASES) {
      const spec = REPORT_FORM_OVERRIDES[key];
      expect(spec, key).toBeDefined();
      if (spec === undefined) continue;
      const columns = new Set(REPORT_DEFINITIONS[key].columns.map((column) => column.key));
      expect(columns.has(spec.category), `${key}: ${spec.category}`).toBe(true);
      for (const series of spec.series) expect(columns.has(series), `${key}: ${series}`).toBe(true);
    }
  });

  it('draws over representative rows', () => {
    for (const [key, rows] of CASES) {
      const spec = REPORT_FORM_OVERRIDES[key];
      if (spec === undefined) throw new Error(`No override for "${key}".`);
      expect(formDraws(spec, REPORT_DEFINITIONS[key], rows), key).toBe(true);
    }
  });

  it('walks the cash cycle chronologically with all three day components', () => {
    const spec = REPORT_FORM_OVERRIDES['cash-cycle'];
    if (spec === undefined) throw new Error('No override for "cash-cycle".');
    const points = formSeries(spec, [...CYCLE_ROWS].reverse());
    expect(points.map((point) => point.category)).toEqual(['2026-07', '2026-08']);
    expect(points[0]).toMatchObject({ inventoryDays: 44, receivableDays: 38, payableDays: 25 });
  });
});
