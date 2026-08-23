import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The chart ramp must follow the appearance.
 *
 * It shipped as five frozen pinks in both `:root` and `.dark` -- identical
 * values, no relation to `--accent-h`, so a workspace set to teal drew pink
 * bars and dark mode was a copy of light rather than a choice. Nothing caught
 * it because a colour that is merely wrong still renders.
 */
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

function chartTokens(): { line: string; slot: number }[] {
  return [...css.matchAll(/^\s*--chart-([1-5]):\s*(.+);$/gmu)].map((m) => ({
    slot: Number(m[1]),
    line: m[2] ?? '',
  }));
}

describe('chart colour tokens', () => {
  it('defines all five slots twice — once for light, once for dark', () => {
    const tokens = chartTokens();
    expect(tokens).toHaveLength(10);
    for (const slot of [1, 2, 3, 4, 5]) {
      expect(tokens.filter((t) => t.slot === slot)).toHaveLength(2);
    }
  });

  it('derives every slot from the accent rather than freezing a hue', () => {
    for (const token of chartTokens()) {
      expect(token.line, `--chart-${String(token.slot)} ignores the accent hue`).toContain(
        'var(--accent-h)',
      );
      expect(token.line, `--chart-${String(token.slot)} ignores the accent chroma`).toContain(
        'var(--chart-c)',
      );
    }
  });

  it('clamps the chroma so a low-chroma accent cannot draw a gray chart', () => {
    // slate's accent chroma is 0.044; the data-viz floor is 0.10.
    const clamp = /--chart-c:\s*clamp\(([\d.]+),\s*var\(--accent-c\),\s*([\d.]+)\)/u.exec(css);
    expect(clamp).not.toBeNull();
    expect(Number(clamp?.[1])).toBeGreaterThanOrEqual(0.1);
  });

  it('is one hue -- shades of the accent, never a rotation away from it', () => {
    // A crimson workspace drew green and teal slices when the ramp turned the
    // hue to make five distinguishable colours. A shade of the chosen colour
    // is the chosen colour; a hue ninety-five degrees from it is not.
    for (const token of chartTokens()) {
      expect(token.line, `--chart-${String(token.slot)} turns the hue away from the accent`).not.toMatch(
        /calc\(var\(--accent-h\)\s*[+-]/u,
      );
    }
  });

  it('steps monotonically, so the shades read as a scale', () => {
    const lightness = (block: 0 | 1): number[] =>
      [1, 2, 3, 4, 5].map((slot) => {
        const line = chartTokens().filter((t) => t.slot === slot)[block]?.line ?? '';
        return Number(/oklch\(([\d.]+)/u.exec(line)?.[1] ?? Number.NaN);
      });

    for (const block of [0, 1] as const) {
      const steps = lightness(block);
      const ordered = [...steps].sort((a, b) => a - b);
      expect(steps, `block ${String(block)} is not a monotone ramp`).toEqual(ordered);
      // A step nobody can see is not a step.
      for (let i = 1; i < steps.length; i += 1) {
        expect(Math.abs((steps[i] ?? 0) - (steps[i - 1] ?? 0))).toBeGreaterThanOrEqual(0.05);
      }
    }
  });

  it('starts at full strength so a single-series chart is not drawn in a tint', () => {
    const [lightFirst, darkFirst] = chartTokens()
      .filter((t) => t.slot === 1)
      .map((t) => Number(/oklch\(([\d.]+)/u.exec(t.line)?.[1] ?? Number.NaN));
    const [lightLast, darkLast] = chartTokens()
      .filter((t) => t.slot === 5)
      .map((t) => Number(/oklch\(([\d.]+)/u.exec(t.line)?.[1] ?? Number.NaN));
    expect(lightFirst ?? 1).toBeLessThan(lightLast ?? 0);
    expect(darkFirst ?? 1).toBeLessThan(darkLast ?? 0);
  });

  it('chooses dark rather than inverting light', () => {
    const lightness = (slot: number): number[] =>
      chartTokens()
        .filter((t) => t.slot === slot)
        .map((t) => Number(/oklch\(([\d.]+)/u.exec(t.line)?.[1] ?? Number.NaN));

    // Identical values in both blocks was the bug: the ramp shipped as a copy.
    const same = [1, 2, 3, 4, 5].filter((slot) => {
      const [light, dark] = lightness(slot);
      return light === dark;
    });
    expect(same).toEqual([]);
  });
});
