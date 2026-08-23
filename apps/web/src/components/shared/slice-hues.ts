/**
 * The hues a pie or a radial chart divides itself into.
 *
 * Every other chart in the product is one hue in five shades -- the accent,
 * stepped. A pie is the form that cannot do that: five shades of indigo around
 * a circle read as one wedge with seams in it, and the reader has to go to the
 * legend for every slice.
 *
 * So slices get five hues. They start at the accent and walk the wheel, and
 * the walk skips the green arc entirely -- the owner ruled green out, and an
 * even spread from a crimson or indigo accent lands in it every time. Cutting
 * the arc out of the arithmetic means no accent can produce a green slice,
 * rather than most accents happening not to.
 *
 * This is computed here rather than in index.css because a skip is a branch,
 * and CSS has none.
 *
 * Checked, not eyeballed: all eighteen accent presets in both modes against
 * the data-viz validator. No hue falls inside the excluded arc for any of
 * them. The residue is the chroma floor at the blue-green edge and a few
 * adjacent pairs protanopia flattens -- legal only with secondary encoding,
 * and every one of these charts prints its value on the slice and names it in
 * a legend.
 */

/** Yellow-green through blue-green, in OKLCH degrees. */
const GREEN_FROM = 100;
const GREEN_TO = 180;
const USABLE = 360 - (GREEN_TO - GREEN_FROM);

export const SLICE_COUNT = 5;

/** Lightness and a chroma multiplier per slot, inside each mode's band. */
const LIGHT = [
  { l: 0.48, c: 1 },
  { l: 0.62, c: 0.86 },
  { l: 0.54, c: 0.96 },
  { l: 0.68, c: 0.78 },
  { l: 0.44, c: 1 },
] as const;
const DARK = [
  { l: 0.54, c: 1 },
  { l: 0.66, c: 1 },
  { l: 0.58, c: 0.95 },
  { l: 0.5, c: 1 },
  { l: 0.62, c: 0.95 },
] as const;

/** A step along the wheel with the green arc cut out of it. */
function place(anchor: number, step: number): number {
  const from = (((anchor - GREEN_TO) % 360) + 360) % 360;
  return (GREEN_TO + ((from + step) % USABLE)) % 360;
}

/**
 * Five hues from one accent, none of them green.
 *
 * Slot 1 is the accent itself, unless the accent is the very hue excluded -- a
 * workspace on green gets slices beside its accent rather than one the rule
 * says cannot exist.
 */
export function sliceHues(accentHue: number): number[] {
  const wrapped = ((accentHue % 360) + 360) % 360;
  const anchor = wrapped >= GREEN_FROM && wrapped <= GREEN_TO ? GREEN_TO + 8 : wrapped;
  return Array.from({ length: SLICE_COUNT }, (_, index) =>
    index === 0 ? anchor : place(anchor, (USABLE / SLICE_COUNT) * index),
  );
}

/** The five `oklch(...)` strings for a mode, ready to hang on the document. */
export function sliceColours(
  accentHue: number,
  accentChroma: number,
  mode: 'light' | 'dark',
): string[] {
  // Floored for the same reason the chart ramp is: slate's accent is 0.044 and
  // five slices of that are five greys.
  const base = Math.min(0.24, Math.max(0.16, accentChroma));
  const steps = mode === 'light' ? LIGHT : DARK;
  return sliceHues(accentHue).map((hue, index) => {
    const step = steps[index] ?? steps[0];
    const chroma = Math.round(base * step.c * 1000) / 1000;
    return `oklch(${String(step.l)} ${String(chroma)} ${String(Math.round(hue * 10) / 10)})`;
  });
}
