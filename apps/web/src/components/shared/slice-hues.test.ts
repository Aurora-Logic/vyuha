import { describe, expect, it } from 'vitest';

import { applyAppearance } from './appearance';
import { sliceColours, sliceHues, SLICE_COUNT } from './slice-hues';

/**
 * The rule the owner set: a pie or a radial chart uses several colours, and
 * none of them is green. An even spread from an indigo accent lands in green
 * every time, which is how green slices reached a crimson workspace.
 */
const GREEN_FROM = 100;
const GREEN_TO = 180;

/** The eighteen the appearance picker offers. */
const ACCENTS = [
  4, 17, 27.5, 38.4, 49, 66.4, 131.6, 150.1, 165.6, 186.4, 223.1, 242.7, 264.4, 277, 292.6, 301.9,
  323.9, 257.3,
];

describe('slice hues', () => {
  it('never produces a green slice, for any accent the picker offers', () => {
    for (const accent of ACCENTS) {
      const offending = sliceHues(accent).filter((h) => h > GREEN_FROM && h < GREEN_TO);
      expect(
        offending,
        `accent ${String(accent)} produced ${offending.map(Math.round).join(',')}`,
      ).toEqual([]);
    }
  });

  it('gives five distinct hues, not five shades of one', () => {
    const hues = sliceHues(277);
    expect(hues).toHaveLength(SLICE_COUNT);
    // Every pair at least 30 degrees apart: a pie separates by hue, because
    // five shades of indigo around a circle read as one wedge with seams.
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const raw = Math.abs((hues[i] ?? 0) - (hues[j] ?? 0));
        const apart = Math.min(raw, 360 - raw);
        expect(
          apart,
          `slots ${String(i)} and ${String(j)} are ${String(Math.round(apart))} apart`,
        ).toBeGreaterThan(30);
      }
    }
  });

  it('starts at the accent, so the chart still belongs to the workspace', () => {
    expect(sliceHues(277)[0]).toBe(277);
    expect(sliceHues(38.4)[0]).toBeCloseTo(38.4, 6);
  });

  it('moves the anchor off an accent that is itself the excluded hue', () => {
    // A workspace on green cannot have a green slice by the rule, so the set
    // starts beside it rather than on it.
    const hues = sliceHues(140);
    expect(hues[0]).toBeGreaterThan(GREEN_TO);
    expect(hues.filter((h) => h > GREEN_FROM && h < GREEN_TO)).toEqual([]);
  });

  it('floors the chroma so a near-grey accent cannot draw five greys', () => {
    // slate is 0.044; the data-viz floor is 0.10.
    for (const colour of sliceColours(257.3, 0.044, 'light')) {
      const chroma = Number(/oklch\([\d.]+ ([\d.]+)/u.exec(colour)?.[1] ?? 0);
      expect(chroma).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('chooses dark rather than reusing light', () => {
    expect(sliceColours(277, 0.24, 'light')).not.toEqual(sliceColours(277, 0.24, 'dark'));
  });

  it('writes a colour a browser can parse', () => {
    for (const colour of sliceColours(277, 0.24, 'light')) {
      expect(colour).toMatch(/^oklch\(0?\.\d+ 0?\.\d+ \d+(\.\d)?\)$/u);
    }
  });
});

describe('applied to the document', () => {
  it('hangs both modes of slice hue on the root, so CSS can pick', () => {
    const root = document.createElement('html');
    applyAppearance(root, {
      accentHue: 277,
      accentChroma: 0.24,
      base: 'stone',
      density: 'comfortable',
      font: 'sans',
    });

    for (let slot = 1; slot <= SLICE_COUNT; slot += 1) {
      expect(root.style.getPropertyValue(`--slice-light-${String(slot)}`)).toMatch(/^oklch\(/u);
      expect(root.style.getPropertyValue(`--slice-dark-${String(slot)}`)).toMatch(/^oklch\(/u);
    }
    // Slot one is the accent the picker set, so a pie still opens in the
    // workspace's own colour.
    expect(root.style.getPropertyValue('--slice-light-1')).toContain(' 277)');
  });

  it('carries no green through to the document, whatever the accent', () => {
    for (const accent of ACCENTS) {
      const root = document.createElement('html');
      applyAppearance(root, {
        accentHue: accent,
        accentChroma: 0.2,
        base: 'stone',
        density: 'comfortable',
        font: 'sans',
      });
      for (let slot = 1; slot <= SLICE_COUNT; slot += 1) {
        const hue = Number(
          /oklch\([\d.]+ [\d.]+ ([\d.]+)\)/u.exec(
            root.style.getPropertyValue(`--slice-light-${String(slot)}`),
          )?.[1] ?? 0,
        );
        expect(
          hue > GREEN_FROM && hue < GREEN_TO,
          `accent ${String(accent)} slot ${String(slot)} is ${String(hue)}`,
        ).toBe(false);
      }
    }
  });
});
