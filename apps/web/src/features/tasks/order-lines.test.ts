import { describe, expect, it } from 'vitest';

import { incompleteOrderLines } from './order-lines';
import type { TaskItemLine } from './types';

/**
 * The guard between the order form and the API.
 *
 * The typing regexes are deliberately loose -- "12." and an emptied box are
 * normal mid-edit states -- so something has to decide when the line is
 * actually sendable. Before this existed, clearing the Qty box sent
 * `quantity: ''` and the API answered 400 with a generic toast, after the
 * person had already chosen the party, the items and written the notes.
 */

const line = (over: Partial<TaskItemLine> = {}): TaskItemLine => ({
  itemId: 'i-1',
  itemName: 'MCB 16A',
  quantity: '1',
  rate: null,
  discountPct: '0',
  amount: null,
  ...over,
});

describe('incompleteOrderLines', () => {
  it('passes a plain line, priced or not', () => {
    expect(incompleteOrderLines([line()])).toEqual([]);
    expect(incompleteOrderLines([line({ rate: '250.50', discountPct: '10' })])).toEqual([]);
  });

  it('catches the half-typed states the field allows', () => {
    for (const bad of [{ quantity: '' }, { quantity: '.' }, { discountPct: '' }, { rate: '.' }]) {
      expect(incompleteOrderLines([line(bad)]), JSON.stringify(bad)).toEqual(['i-1']);
    }
  });

  it('accepts an unpriced line, because an enquiry is a real state', () => {
    expect(incompleteOrderLines([line({ rate: null })])).toEqual([]);
  });

  it('refuses a discount over a hundred per cent', () => {
    expect(incompleteOrderLines([line({ discountPct: '120' })])).toEqual(['i-1']);
  });

  it('names only the lines at fault, so the form can point at them', () => {
    const rows = [line({ itemId: 'ok' }), line({ itemId: 'bad', quantity: '' })];
    expect(incompleteOrderLines(rows)).toEqual(['bad']);
  });
});
