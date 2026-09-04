import { cn } from '@/lib/utils';

import { isOrderTask, isOverdue, type Task } from './types';

/**
 * The property pill, Notion's shape: a soft wash of one hue with its own
 * darker text, never a saturated block (owner, 1 Sep 2026 -- "take all the
 * colours from notion").
 *
 * The hues are this theme's own tokens rather than Notion's hex, so they
 * follow the palette into dark mode and stay the red, amber and blue that
 * already mean urgent, watch and informational everywhere else in the
 * product.
 *
 * Shared by the board card and the gallery card. They are two renderings of
 * one task and a priority that was red on one and amber on the other would be
 * a bug nobody could see in a single screenshot.
 */

export const PILL = 'rounded-none px-1.5 py-px text-[0.6875rem] font-medium';

/**
 * The wash and border a task card wears, by its state (owner, 4 Sep 2026):
 *
 *  - done    -> a calm green fill. It is finished; nothing to chase, no motion.
 *  - overdue -> a red border that pulses. The one card that has earned motion,
 *               because "late" is the thing to act on.
 *  - order   -> a blue fill, and a blue border that pulses while it is open.
 *
 * Precedence is urgency: an overdue order keeps its blue fill but takes the red
 * pulse. --info / --destructive / --success are the blue, red and green the
 * product already means note / warn / done with, so they follow the palette
 * into dark mode; the pulses collapse to a steady coloured border under reduced
 * motion (index.css). One class string, so board, list and gallery agree.
 */
export function taskSurface(task: Task): string | undefined {
  if (task.isClosed) return 'bg-success/10';
  const order = isOrderTask(task);
  return (
    cn(
      order && 'bg-info/15',
      isOverdue(task)
        ? 'border-destructive animate-overdue-pulse'
        : order && 'border-info animate-order-pulse',
    ) || undefined
  );
}

/** High is red, medium amber, low blue -- Notion's own ordering of urgency. */
export const PRIORITY_HUES = {
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/10 text-warning',
  LOW: 'bg-info/10 text-info',
} as const;

/**
 * A board column's colour, by its position, with done always green.
 *
 * Lives here rather than in the board because the sheet's status dropdown
 * shows the same colours: picking "In progress" from a menu where it is amber
 * and then seeing it land in a blue lane would be two answers to one
 * question. The board is the source of the order, so the index is the board's.
 */
const COLUMN_HUES = [
  'bg-tint-1/15 text-tint-1',
  'bg-tint-2/15 text-tint-2',
  'bg-tint-3/15 text-tint-3',
  'bg-tint-4/15 text-tint-4',
  'bg-tint-5/15 text-tint-5',
  'bg-tint-6/15 text-tint-6',
] as const;

export const DONE_HUE = 'bg-success/15 text-success';

export function columnHue(index: number, isDone: boolean): string {
  if (isDone) return DONE_HUE;
  return COLUMN_HUES[index % COLUMN_HUES.length] ?? COLUMN_HUES[0];
}
