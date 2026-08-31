import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Popover, PopoverContent } from '@/components/ui/popover';

import { AnchoredPopover } from './anchored-popover';

/**
 * `AnchoredPopover` copies its popup styling from `ui/popover.tsx` because it
 * cannot compose `PopoverContent` (no `anchor` forward) and may not edit a
 * file `shadcn add` overwrites. The copy's contract is "keep the two in
 * step", and a comment cannot enforce that -- this does: every visual token
 * the anchored popup carries must still exist on the shadcn popup, so a
 * restyle of `ui/popover.tsx` fails here instead of drifting silently. The
 * shadcn popup keeping extra tokens (its entry animation) is fine.
 */

function tokens(el: Element | null): Set<string> {
  return new Set((el?.className ?? '').split(/\s+/).filter((t) => t !== ''));
}

describe('AnchoredPopover stays in step with ui/popover', () => {
  it('carries no visual token the shadcn popup has dropped', () => {
    // Controlled open with no trigger, the same shape AnchoredPopover runs in.
    render(
      <Popover open>
        <PopoverContent>reference</PopoverContent>
      </Popover>,
    );
    const anchor = {
      getBoundingClientRect: () =>
        ({ x: 0, y: 0, top: 0, left: 0, right: 40, bottom: 20, width: 40, height: 20, toJSON: () => ({}) }) as DOMRect,
    };
    render(
      <AnchoredPopover open onOpenChange={() => undefined} anchor={anchor}>
        anchored
      </AnchoredPopover>,
    );

    const reference = tokens(document.querySelector('[data-slot="popover-content"]'));
    const anchored = tokens(document.querySelector('[data-slot="anchored-popover-content"]'));
    expect(anchored.size).toBeGreaterThan(0);
    expect([...anchored].filter((t) => !reference.has(t))).toEqual([]);
  });
});
