import { describe, expect, it } from 'vitest';

import { STEPS, STEP_BAR, STEP_TICK, fulfilmentProgress } from './fulfilment-progress';
import type { Dispatch, Estimate, PackRecord } from './types';

/** The owner's four steps, decided from the order's own quantities. */
function order(lines: { quantity: string; pickedQty?: string; packedQty: string; invoicedQty: string; dispatchedQty: string }[], status = 'CONFIRMED'): Estimate {
  // D-48: picked sits between ordered and packed; a fixture that does not say is picked as far as it is packed.
  return { status, shortClosedAt: null, lines: lines.map((line, index) => ({ id: `l${String(index)}`, pickedQty: line.pickedQty ?? line.packedQty, ...line })) } as unknown as Estimate;
}
const pack = { id: 'p1' } as unknown as PackRecord;
const shipped = { id: 'd1', status: 'shipped' } as unknown as Dispatch;
const delivered = { id: 'd1', status: 'delivered' } as unknown as Dispatch;

describe('fulfilmentProgress', () => {
  it('is nothing before confirmation', () => {
    expect(fulfilmentProgress(order([{ quantity: '10', packedQty: '0', invoicedQty: '0', dispatchedQty: '0' }], 'DRAFT'), [], []).current).toBeNull();
  });

  it('stays at Picked while the shelf owes, then moves to Packed', () => {
    expect(fulfilmentProgress(order([{ quantity: '10', packedQty: '0', invoicedQty: '0', dispatchedQty: '0' }]), [], []).current).toBe('picked');
    const halfPicked = fulfilmentProgress(order([{ quantity: '10', pickedQty: '4', packedQty: '4', invoicedQty: '0', dispatchedQty: '0' }]), [pack], []);
    expect(halfPicked.current).toBe('picked');
    expect(halfPicked.toPick).toBe(6);
    const partly = fulfilmentProgress(order([{ quantity: '10', pickedQty: '10', packedQty: '4', invoicedQty: '0', dispatchedQty: '0' }]), [pack], []);
    expect(partly.current).toBe('packed');
    expect(partly.done.has('picked')).toBe(true);
    expect(partly.toPack).toBe(6);
  });

  it('blocks Shipped on the invoice, and names how much waits', () => {
    const packed = fulfilmentProgress(order([{ quantity: '10', packedQty: '10', invoicedQty: '0', dispatchedQty: '0' }]), [pack], []);
    expect(packed.current).toBe('shipped');
    expect(packed.toInvoice).toBe(10);
    expect(packed.toDispatch).toBe(0);
  });

  it('is Delivered when every dispatch has been marked at the door', () => {
    const out = order([{ quantity: '10', packedQty: '10', invoicedQty: '10', dispatchedQty: '10' }]);
    expect(fulfilmentProgress(out, [pack], [shipped]).current).toBe('delivered');
    const home = fulfilmentProgress(out, [pack], [delivered]);
    expect(home.current).toBeNull();
    expect([...home.done]).toEqual(['picked', 'packed', 'shipped', 'delivered']);
  });
});

describe('a colour per step', () => {
  /**
   * All four bars were the same accent at three opacities, so the eye could
   * read "some of this is done" and nothing else. The difference between
   * packed and shipped is what anyone is actually looking for.
   */
  it('gives every step its own colour, none repeated', () => {
    const done = STEPS.map((step) => STEP_BAR[step.key].done);
    expect(new Set(done).size).toBe(STEPS.length);
  });

  it('dims the current step from its own colour rather than a shared one', () => {
    for (const step of STEPS) {
      const { done, current } = STEP_BAR[step.key];
      expect(current.startsWith(done), `${step.key} dims from a different colour`).toBe(true);
      expect(current).not.toBe(done);
    }
  });

  it('ticks a finished step in the colour its bar carries', () => {
    for (const step of STEPS) {
      const hue = /var\(--[a-z0-9-]+\)/u.exec(STEP_BAR[step.key].done)?.[0];
      expect(STEP_TICK[step.key], `${step.key} ticks in a different colour`).toContain(hue ?? '');
    }
  });

  it('spells the classes out, because Tailwind cannot see one built at runtime', () => {
    for (const step of STEPS) {
      expect(STEP_BAR[step.key].done).toMatch(/^bg-\[var\(--[a-z0-9-]+\)\]$/u);
    }
  });
});
