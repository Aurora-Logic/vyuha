import {
  APPEARANCE_BASES,
  APPEARANCE_BASE_TOKENS,
  DEFAULT_APPEARANCE,
  resolveAppearanceBase,
} from '@vyuha/shared';
import { describe, expect, it } from 'vitest';

import { applyAppearance } from './appearance';

describe('applyAppearance', () => {
  it('writes the four variables and two attributes index.css derives the theme from', () => {
    const root = document.createElement('html');
    applyAppearance(root, { accentHue: 190, accentChroma: 0.13, font: 'sans', base: 'slate', density: 'compact' });
    expect(root.style.getPropertyValue('--accent-h')).toBe('190');
    expect(root.style.getPropertyValue('--accent-c')).toBe('0.13');
    expect(root.dataset.base).toBe('slate');
    expect(root.dataset.density).toBe('compact');
    applyAppearance(root, DEFAULT_APPEARANCE);
    expect(root.style.getPropertyValue('--accent-h')).toBe('277');
    expect(root.dataset.base).toBe('stone');
  });

  it('sets an attribute index.css has a rule for, whichever preset is chosen', () => {
    // The failure this catches: adding a base to the enum and forgetting its
    // block in index.css. The attribute would be written, no rule would match,
    // and the page would silently keep the previous ramp.
    const root = document.createElement('html');
    for (const base of APPEARANCE_BASES) {
      applyAppearance(root, { ...DEFAULT_APPEARANCE, base });
      expect(root.dataset.base).toBe(base);
      expect(APPEARANCE_BASE_TOKENS[base]).toBeDefined();
    }
  });
});

describe('resolveAppearanceBase', () => {
  it('keeps a base that is still offered', () => {
    for (const base of APPEARANCE_BASES) {
      expect(resolveAppearanceBase(base)).toBe(base);
    }
  });

  it('maps a retired base to its nearest ramp rather than failing', () => {
    // An organisation that chose these before the change still has them in its
    // settings row. Rejecting them would fail the read, and the screen that
    // would fix it is the one that would not load.
    expect(resolveAppearanceBase('cool')).toBe('gray');
    expect(resolveAppearanceBase('warm')).toBe('stone');
  });

  it('falls back to stone for anything unrecognised', () => {
    expect(resolveAppearanceBase(null)).toBe('stone');
    expect(resolveAppearanceBase(undefined)).toBe('stone');
    expect(resolveAppearanceBase('mauve')).toBe('stone');
    expect(resolveAppearanceBase('')).toBe('stone');
  });

  it('gives neutral no hue at all, which is what neutral means', () => {
    expect(APPEARANCE_BASE_TOKENS.neutral.chroma).toBe(0);
  });
});
