import { describe, expect, it } from 'vitest';

import { REPORT_DEFINITIONS } from '@vyuha/shared';

import { chartKindOf, countToReach, paretoInsight, paretoSeries, resolveChartForm } from './report-series';

/**
 * Owner, 22 Aug 2026: "X out of Y customers make up half the revenue."
 *
 * The sentence is the whole point of a Pareto, so it is computed here from
 * named thresholds and tested, rather than composed in JSX from whatever the
 * chart happens to have (vyuha-charts §3).
 */
const row = (name: string, share: number, cumulative: number) => ({
  id: name,
  cells: { name, sharePct: String(share), cumulativePct: String(cumulative) },
});

describe('the Pareto curve', () => {
  it('reads the running total the report already computed, in the order it ranked', () => {
    const points = paretoSeries([row('Asha', 40, 40), row('Behar', 30, 70), row('Chetan', 30, 100)], 'name');
    expect(points.map((p) => p.category)).toEqual(['Asha', 'Behar', 'Chetan']);
    expect(points.map((p) => p.cumulativePct)).toEqual([40, 70, 100]);
  });

  it('counts the row that crosses the line, not the one after it', () => {
    const points = paretoSeries([row('a', 40, 40), row('b', 30, 70), row('c', 20, 90), row('d', 10, 100)], 'name');
    // 40 is not yet half; 70 is. Two customers make up half.
    expect(countToReach(points, 50)).toBe(2);
    expect(countToReach(points, 80)).toBe(3);
    expect(countToReach(points, 100)).toBe(4);
  });

  it('says so when the page never reaches the target', () => {
    const points = paretoSeries([row('a', 10, 10), row('b', 10, 20), row('c', 10, 30), row('d', 10, 40)], 'name');
    expect(countToReach(points, 50)).toBeNull();
    expect(paretoInsight(points, 'customers', 'revenue')).toBeNull();
  });

  it('writes the sentence the owner asked for', () => {
    const points = paretoSeries(
      [row('a', 30, 30), row('b', 25, 55), row('c', 15, 70), row('d', 12, 82), row('e', 10, 92), row('f', 8, 100)],
      'name',
    );
    expect(paretoInsight(points, 'customers', 'revenue')).toBe('2 of 6 customers make up half the revenue; 4 make up 80%.');
  });

  it('does not claim a concentration from a handful of rows', () => {
    const points = paretoSeries([row('a', 60, 60), row('b', 40, 100)], 'name');
    // Arithmetically "1 of 2 make up half"; practically it says nothing.
    expect(paretoInsight(points, 'items', 'revenue')).toBeNull();
  });

  it('drops the second clause when half and most are the same row', () => {
    const points = paretoSeries([row('a', 85, 85), row('b', 5, 90), row('c', 5, 95), row('d', 5, 100)], 'name');
    expect(paretoInsight(points, 'vendors', 'spend')).toBe('1 of 4 vendors make up half the spend.');
  });
});

/**
 * Owner, 22 Aug: "charts and table both".
 *
 * The toggle only offers a chart when `chartKindOf` says the report can draw
 * one, and it consults `genericSeries` rather than the form overrides — so a
 * report can carry a perfectly good `pareto` override and still show no chart
 * at all. That is not something to reason about; it is something to assert.
 */
describe('every Pareto can draw a chart as well as a table', () => {
  const KEYS = [
    'customer-concentration',
    'item-revenue-concentration',
    'item-quantity-concentration',
    'vendor-spend-concentration',
    'receivables-concentration',
  ] as const;

  const sample = (nameKey: string) =>
    [
      { id: 'a', cells: { [nameKey]: 'Igatpuri Cables', rank: '1', value: '1096683', revenue: '1096683', sharePct: '12.4', cumulativePct: '12.4', band: 'Top 50%' } },
      { id: 'b', cells: { [nameKey]: 'Ambad MIDC', rank: '2', value: '870158', revenue: '870158', sharePct: '9.9', cumulativePct: '22.3', band: 'Top 50%' } },
      { id: 'c', cells: { [nameKey]: 'Godavari', rank: '3', value: '841452', revenue: '841452', sharePct: '9.5', cumulativePct: '31.8', band: 'Top 50%' } },
      { id: 'd', cells: { [nameKey]: 'Malegaon', rank: '4', value: '840750', revenue: '840750', sharePct: '9.5', cumulativePct: '41.4', band: 'Top 50%' } },
      { id: 'e', cells: { [nameKey]: 'Sinnar', rank: '5', value: '757307', revenue: '757307', sharePct: '8.6', cumulativePct: '50.0', band: 'Top 50%' } },
    ];

  for (const key of KEYS) {
    it(`${key} offers a chart, and it is the Pareto form`, () => {
      const definition = REPORT_DEFINITIONS[key];
      const nameKey = key === 'customer-concentration' ? 'partyName' : 'name';
      const rows = sample(nameKey);
      // Not 'none' — otherwise the Table/Chart/Both toggle never appears.
      expect(chartKindOf(key, definition, rows)).not.toBe('none');
      const spec = resolveChartForm(key, definition, rows);
      expect(spec?.form).toBe('pareto');
      expect(spec?.category).toBe(nameKey);
      // And the sentence has both nouns it needs to read like English.
      expect(spec?.noun).toBeTruthy();
      expect(spec?.measure).toBeTruthy();
    });
  }

  it('names the customer who gives the most revenue first', () => {
    const points = paretoSeries(sample('partyName'), 'partyName');
    expect(points[0]?.category).toBe('Igatpuri Cables');
    expect(paretoInsight(points, 'customers', 'revenue')).toContain('of 5 customers make up half the revenue');
  });
});
