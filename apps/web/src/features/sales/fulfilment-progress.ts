import { lineBalances, type Dispatch, type Estimate, type PackRecord } from './types';

/**
 * The owner's four steps (22 Aug 2026), decided from the order's own
 * quantities: Picked, Packed, Shipped, Delivered. Pure, so the bar that
 * draws it is tested here without rendering.
 */

export type FulfilmentStep = 'picked' | 'packed' | 'shipped' | 'delivered';

/**
 * A colour per step, so the bar says where the order is without being read.
 *
 * All four steps were the same accent at three opacities, which told the eye
 * only "some of this is done" -- the difference between packed and shipped is
 * the thing anyone is actually looking for, and it was carried by position
 * alone.
 *
 * Composed from tokens that already have a light and a dark value rather than
 * four new hues: picked and shipped borrow the meaning they already have in
 * this product (something has started, something needs watching), delivered is
 * the green every screen here uses for done, and packed takes the identity
 * violet so it is not mistaken for either neighbour.
 *
 * Written as whole class strings because Tailwind cannot see a class name
 * assembled at runtime -- the same reason `appearance-swatches.ts` spells its
 * swatches out.
 */
export const STEP_BAR: Record<FulfilmentStep, { done: string; current: string }> = {
  picked: { done: 'bg-[var(--info)]', current: 'bg-[var(--info)]/45' },
  packed: { done: 'bg-[var(--tint-6)]', current: 'bg-[var(--tint-6)]/45' },
  shipped: { done: 'bg-[var(--warning)]', current: 'bg-[var(--warning)]/45' },
  delivered: { done: 'bg-[var(--success)]', current: 'bg-[var(--success)]/45' },
};

/** The tick beside a finished step, in that step's own colour. */
export const STEP_TICK: Record<FulfilmentStep, string> = {
  picked: 'text-[var(--info)]',
  packed: 'text-[var(--tint-6)]',
  shipped: 'text-[var(--warning)]',
  delivered: 'text-[var(--success)]',
};

export const STEPS: readonly { key: FulfilmentStep; label: string }[] = [
  { key: 'picked', label: 'Picked' },
  { key: 'packed', label: 'Packed' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

export interface FulfilmentProgress {
  /** The step the order is on: the first not yet complete. Null before confirmation. */
  readonly current: FulfilmentStep | null;
  readonly done: ReadonlySet<FulfilmentStep>;
  readonly toPick: number;
  readonly toPack: number;
  readonly toInvoice: number;
  readonly toDispatch: number;
  readonly undelivered: number;
}

/** Pure, so the bar can be tested without rendering. Quantities are per line; a step is done when nothing is left for it. */
export function fulfilmentProgress(order: Estimate, packs: readonly PackRecord[], dispatches: readonly Dispatch[]): FulfilmentProgress {
  const done = new Set<FulfilmentStep>();
  if (order.status !== 'CONFIRMED') return { current: null, done, toPick: 0, toPack: 0, toInvoice: 0, toDispatch: 0, undelivered: 0 };
  let toPick = 0;
  let toPack = 0;
  let toInvoice = 0;
  let toDispatch = 0;
  for (const line of order.lines) {
    const ordered = Number(line.quantity);
    const picked = Number(line.pickedQty);
    const packed = Number(line.packedQty);
    const invoiced = Number(line.invoicedQty);
    const dispatched = Number(line.dispatchedQty);
    toPick += Math.max(0, ordered - picked);
    toPack += Math.max(0, picked - packed);
    toInvoice += Math.max(0, packed - invoiced);
    toDispatch += Math.max(0, invoiced - dispatched);
  }
  const shortClosed = order.shortClosedAt !== null;
  const anythingPicked = order.lines.some((line) => Number(line.pickedQty) > 0);
  const anythingPacked = packs.length > 0 || order.lines.some((line) => Number(line.packedQty) > 0);
  // D-48: Picked is done when nothing is left on the shelf; Packed when nothing picked waits for a box.
  if (anythingPicked && (toPick <= 1e-9 || shortClosed)) done.add('picked');
  if (anythingPacked && toPick <= 1e-9 + (shortClosed ? Infinity : 0) && (toPack <= 1e-9 || shortClosed)) done.add('packed');
  const allOut = dispatches.length > 0 && toDispatch <= 1e-9 && toInvoice <= 1e-9 && (toPick + toPack <= 1e-9 || shortClosed);
  if (allOut) done.add('shipped');
  const undelivered = dispatches.filter((d) => d.status !== 'delivered').length;
  if (allOut && undelivered === 0) done.add('delivered');
  const current = STEPS.find((step) => !done.has(step.key))?.key ?? null;
  return { current, done, toPick, toPack, toInvoice, toDispatch, undelivered };
}

export type PickPackStep = 'pick' | 'pack';

/** The warehouse step an order is on: pack what is picked first (a box waits), else pick what is on the shelf. */
export function stepOf(order: Estimate): PickPackStep {
  const balances = order.lines.map(lineBalances);
  if (balances.some((b) => b.toPack > 0)) return 'pack';
  return balances.some((b) => b.toPick > 0) ? 'pick' : 'pack';
}
