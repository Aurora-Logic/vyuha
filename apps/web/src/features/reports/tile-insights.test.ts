import { describe, expect, it } from 'vitest';

import type { PageMeta } from '@vyuha/shared';

import { tileInsight } from './tile-insights';
import type { ReportRowView } from './types';

function row(cells: Record<string, string | number | boolean | null>): ReportRowView {
  return { id: JSON.stringify(cells), primary: '', status: null, cells, punch: null };
}

const meta = (total: number): PageMeta => ({ page: 1, pageSize: 200, total });

describe('tileInsight', () => {
  it('dispatches sales-analysis by its grouping: months read a trend, parties read a leader', () => {
    const months = [
      row({ label: '2026-05', value: '100' }),
      row({ label: '2026-06', value: '200' }),
      row({ label: '2026-07', value: '300' }),
    ];
    expect(tileInsight('sales-analysis', { groupBy: 'month' }, months, meta(3), '2026-08')).toContain(
      'on the month before',
    );
    const parties = Array.from({ length: 10 }, (_, i) => row({ label: `P${String(i)}`, value: '100' }));
    expect(tileInsight('sales-analysis', { groupBy: 'party' }, parties, meta(10), '2026-08')).toBe(
      'P0 leads at 10% of the period.',
    );
  });

  it('softens the party sentence when the page cap clipped the list', () => {
    const parties = [row({ label: 'Big', value: '500' }), row({ label: 'Small', value: '100' })];
    expect(tileInsight('sales-analysis', { groupBy: 'party' }, parties, meta(300), '2026-08')).toContain(
      'customers shown',
    );
  });

  it('says nothing for a report with no registered sentence', () => {
    expect(tileInsight('day-book', {}, [row({ amount: '1' })], meta(1), '2026-08')).toBeNull();
  });
});
