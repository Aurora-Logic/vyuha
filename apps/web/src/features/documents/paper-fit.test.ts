import { describe, expect, it } from 'vitest';

import { A4_WIDTH_PX, ZOOMS, fitZoomIndex } from './paper-fit';

// The fit picks the largest zoom step that clears the stage in BOTH
// dimensions. The bug this guards: a short packing slip on a narrow screen
// was height-fit, took a near-full scale, and spilled its 210mm width off
// both edges. Width must bind whenever it is the tighter side.

const value = (dims: Parameters<typeof fitZoomIndex>[0]) => ZOOMS[fitZoomIndex(dims)]?.value;

describe('fitZoomIndex', () => {
  it('a short slip on a phone is bound by width, not height', () => {
    // A5-ish slip: short (560px) inside the 210mm-wide stage, on a 360px phone.
    const dims = { naturalHeight: 560, naturalWidth: A4_WIDTH_PX, availableHeight: 650, availableWidth: 336 };
    const scale = value(dims);
    // Height alone would allow 100% (560 fits 650); width forbids it.
    expect(scale).toBeLessThan(1);
    // The scaled sheet actually fits the width — it does not overflow.
    expect((scale ?? 1) * A4_WIDTH_PX).toBeLessThanOrEqual(336);
    // And it is the largest step that fits: one step up would overflow.
    const bigger = ZOOMS[fitZoomIndex(dims) + 1];
    if (bigger !== undefined) expect(bigger.value * A4_WIDTH_PX).toBeGreaterThan(336);
  });

  it('a tall A4 on a desk is bound by height, with width to spare', () => {
    const dims = { naturalHeight: 1123, naturalWidth: A4_WIDTH_PX, availableHeight: 700, availableWidth: 1100 };
    const scale = value(dims);
    expect((scale ?? 1) * 1123).toBeLessThanOrEqual(700);
    expect((scale ?? 1) * A4_WIDTH_PX).toBeLessThanOrEqual(1100);
    // Height is the binding side here, so a step up would exceed the height.
    const bigger = ZOOMS[fitZoomIndex(dims) + 1];
    if (bigger !== undefined) expect(bigger.value * 1123).toBeGreaterThan(700);
  });

  it('falls back to the smallest step when nothing fits, rather than overflowing more', () => {
    const scale = value({ naturalHeight: 560, naturalWidth: A4_WIDTH_PX, availableHeight: 650, availableWidth: 100 });
    expect(scale).toBe(ZOOMS[0]?.value);
  });

  it('returns full size for degenerate (unmeasured) dimensions', () => {
    expect(value({ naturalHeight: 0, naturalWidth: A4_WIDTH_PX, availableHeight: 0, availableWidth: 0 })).toBe(1);
  });
});
