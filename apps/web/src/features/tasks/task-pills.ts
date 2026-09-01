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

/** High is red, medium amber, low blue -- Notion's own ordering of urgency. */
export const PRIORITY_HUES = {
  HIGH: 'bg-destructive/10 text-destructive',
  MEDIUM: 'bg-warning/10 text-warning',
  LOW: 'bg-info/10 text-info',
} as const;
