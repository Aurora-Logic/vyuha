import { describe, expect, it } from 'vitest';

import { TASK_DASHBOARD_BLOCKS, mergedOrder, moved, type TaskDashboardBlock } from './dashboard-blocks';

/**
 * The dashboard's layout is a stored preference, which means two things can
 * go wrong quietly: a move that loses or duplicates a block, and a preference
 * saved before a block existed deciding that the new block is hidden.
 */

const ORDER = TASK_DASHBOARD_BLOCKS.map((block) => block.key);

describe('moved', () => {
  it('swaps a block with its neighbour and keeps every block exactly once', () => {
    const next = moved(ORDER, 'attention', -1);
    expect(next.indexOf('attention')).toBe(ORDER.indexOf('attention') - 1);
    expect([...next].sort()).toEqual([...ORDER].sort());
    expect(new Set(next).size).toBe(ORDER.length);
  });

  it('does nothing at either end rather than wrapping around', () => {
    // Wrapping would send a block the whole length of the list on one click,
    // which is never what the click meant.
    expect(moved(ORDER, ORDER[0], -1)).toEqual(ORDER);
    expect(moved(ORDER, ORDER[ORDER.length - 1], 1)).toEqual(ORDER);
  });

  it('leaves the order alone for a block it does not hold', () => {
    expect(moved(ORDER, 'nothing-like-this' as TaskDashboardBlock, 1)).toEqual(ORDER);
  });

  it('moves down as well as up, and the two undo each other', () => {
    const down = moved(ORDER, 'open', 1);
    expect(down).not.toEqual(ORDER);
    expect(moved(down, 'open', -1)).toEqual(ORDER);
  });
});

describe('what a stored layout does with a block it has never seen', () => {
  it('appends it rather than dropping it', () => {
    // A layout saved when only the first three blocks existed.
    expect(mergedOrder(ORDER.slice(0, 3))).toEqual(ORDER);
  });

  it('keeps the saved order for the blocks it does know', () => {
    const reorderedThree = [ORDER[2], ORDER[0], ORDER[1]] as string[];
    expect(mergedOrder(reorderedThree).slice(0, 3)).toEqual(reorderedThree);
  });

  it('discards a block that no longer exists instead of keeping it forever', () => {
    expect(mergedOrder(['a-block-we-removed', ...ORDER])).toEqual(ORDER);
  });

  it('starts from the default when nothing was ever saved', () => {
    expect(mergedOrder(undefined)).toEqual(ORDER);
  });
});
