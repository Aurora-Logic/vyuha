import { compactIndian } from '@/components/shared/chart-labels';

/**
 * What a pie slice's label should say, or nothing at all.
 *
 * Separated from the renderer because a Recharts chart cannot be rendered in
 * jsdom -- it measures its container, and jsdom reports zero -- so anything
 * left inside the SVG is untestable. That is not a theoretical gap: the label
 * previously printed 8943372.46 in production because `formatter` is honoured
 * on a LabelList and not on a Pie's `label`, and no test could have caught it.
 * The formatting and the skip rule live here, where they can be.
 */
export function pieSliceLabel(value: unknown, percent: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  /*
   * Slices under a twentieth are left to the legend. Their labels collide with
   * their neighbours' at this radius, and a collided label is worse than an
   * absent one -- the number is still in the tooltip and the table.
   */
  if (typeof percent === 'number' && percent < 0.05) return null;
  return compactIndian(value);
}
