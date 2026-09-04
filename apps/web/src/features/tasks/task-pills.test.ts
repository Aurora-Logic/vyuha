import { describe, expect, it } from 'vitest';

import { taskSurface } from './task-pills';
import type { Task } from './types';

/**
 * The card state language, with its urgency precedence. Only three fields
 * decide it, so the rest are filled to satisfy the type; a wrong precedence
 * (an overdue order pulsing blue instead of red, a done task still pulsing)
 * is exactly what these pin.
 */
function task(over: Partial<Task>): Task {
  return { isClosed: false, items: [], dueDate: null, ...over } as unknown as Task;
}

const ITEMS = [
  { itemId: 'i1', itemName: 'Widget', quantity: '1', rate: null, discountPct: '0', amount: null },
];
const PAST = '2020-01-01';

describe('taskSurface', () => {
  it('a done task is green and calm — no pulse', () => {
    const s = taskSurface(task({ isClosed: true, items: ITEMS, dueDate: PAST })) ?? '';
    expect(s).toContain('bg-success/10');
    expect(s).not.toContain('pulse');
  });

  it('an open order is blue with a steady blue border, no pulse', () => {
    const s = taskSurface(task({ items: ITEMS })) ?? '';
    expect(s).toContain('bg-info/15');
    expect(s).toContain('border-info');
    expect(s).not.toContain('pulse');
  });

  it('an overdue task pulses red', () => {
    const s = taskSurface(task({ dueDate: PAST })) ?? '';
    expect(s).toContain('border-destructive');
    expect(s).toContain('animate-overdue-pulse');
  });

  it('an overdue order stays steady blue — an order never pulses', () => {
    const s = taskSurface(task({ items: ITEMS, dueDate: PAST })) ?? '';
    expect(s).toContain('bg-info/15');
    expect(s).toContain('border-info');
    expect(s).not.toContain('pulse');
  });

  it('a plain open task wears nothing', () => {
    expect(taskSurface(task({}))).toBeUndefined();
  });
});
