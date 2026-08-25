import { describe, expect, it } from 'vitest';

import { comparisonJoinable, deltaTone, isToDate, previousRowLookup, rowShapeOf } from './comparison';
import type { ReportRowView } from './types';

function row(id: string, value: number): ReportRowView {
  return { id, primary: '', status: null, cells: { value }, punch: null };
}

describe('rowShapeOf', () => {
  it('reads month keys, date keys, and everything else as entities', () => {
    expect(rowShapeOf([row('2026-08', 1), row('2026-07', 1)])).toBe('month');
    expect(rowShapeOf([row('2026-08-21', 1)])).toBe('date');
    expect(rowShapeOf([row('0192-party-uuid', 1)])).toBe('entity');
    // One stray id means the ids are not a calendar, whatever the rest say.
    expect(rowShapeOf([row('2026-08', 1), row('unknown', 1)])).toBe('entity');
  });
});

describe('previousRowLookup', () => {
  it('joins month rows to last FY by the calendar, not the raw id', () => {
    // The defect this closes: '2025-08' never equals '2026-08', so a real
    // prior year rendered as a column of "new" with green arrows.
    const lookup = previousRowLookup('lastYear', [row('2026-08', 300)], [row('2025-08', 200)]);
    expect(lookup).not.toBeNull();
    expect(lookup?.(row('2026-08', 300))?.cells.value).toBe(200);
  });

  it('refuses to join month rows against an arbitrary previous period', () => {
    // "Previous period" of 1-21 Aug is 11-31 Jul: there is no honest month
    // alignment, so no comparison is shown rather than a wrong one.
    expect(previousRowLookup('previous', [row('2026-08', 1)], [row('2026-07', 1)])).toBeNull();
    expect(comparisonJoinable('previous', 'month')).toBe(false);
    expect(comparisonJoinable('lastYear', 'month')).toBe(true);
  });

  it('joins entity rows by identity under either mode', () => {
    const lookup = previousRowLookup('previous', [row('party-1', 300)], [row('party-1', 120)]);
    expect(lookup?.(row('party-1', 300))?.cells.value).toBe(120);
  });

  it('clamps a shifted leap day instead of inventing 1 March', () => {
    const lookup = previousRowLookup('lastYear', [row('2025-02-28', 1)], [row('2024-02-29', 7)]);
    expect(lookup?.(row('2025-02-28', 1))?.cells.value).toBe(7);
  });

  it('carries a December across the year boundary', () => {
    const lookup = previousRowLookup('lastYear', [row('2026-01', 1)], [row('2025-01', 5)]);
    expect(lookup?.(row('2026-01', 1))?.cells.value).toBe(5);
  });
});

describe('deltaTone', () => {
  it('keeps up green for revenue and turns it red for a cost', () => {
    expect(deltaTone('sales-analysis', 'up')).toBe('good');
    expect(deltaTone('sales-analysis', 'down')).toBe('bad');
    // Interest lost rising is bad news, whatever colour the arrow wants.
    expect(deltaTone('party-interest-cost', 'up')).toBe('bad');
    expect(deltaTone('party-interest-cost', 'down')).toBe('good');
    expect(deltaTone('payment-analysis', 'up')).toBe('bad');
    expect(deltaTone('ageing', 'down')).toBe('good');
  });

  it('is neutral when nothing moved', () => {
    expect(deltaTone('sales-analysis', 'flat')).toBe('neutral');
    expect(deltaTone('ageing', 'flat')).toBe('neutral');
  });
});

describe('isToDate', () => {
  it('marks only a period still running as to date', () => {
    expect(isToDate('2026-08-31', '2026-08-25')).toBe(true);
    expect(isToDate('2026-07-31', '2026-08-25')).toBe(false);
    expect(isToDate('2026-08-25', '2026-08-25')).toBe(true);
  });
});
