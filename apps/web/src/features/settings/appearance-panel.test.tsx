import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';
import { DEFAULT_APPEARANCE } from '@vyuha/shared';

import { AppearancePanel } from './appearance-panel';
import { SWATCH } from './appearance-swatches';

/**
 * The accent swatch went invisible under the pointer.
 *
 * The colour was a `bg-[oklch(...)]` utility on the button itself, and the
 * button also carried `hover:bg-transparent` to kill the ghost variant's hover
 * tint. A `hover:` utility beats a plain one, so hovering wiped the swatch and
 * left a hole in the row -- reported from a screenshot, not from a test,
 * because nothing here asserted where the colour lived.
 *
 * jsdom does not apply `:hover`, so this pins the structural fact that made the
 * bug possible instead: the colour must sit on a layer of its own, never on an
 * element that also has a hover background.
 */
describe('accent swatches', () => {
  function renderPanel() {
    return renderWithProviders(
      <AppearancePanel
        value={DEFAULT_APPEARANCE}
        saved={DEFAULT_APPEARANCE}
        enforcedBy={null}
        onChange={() => undefined}
      />,
    );
  }

  it('paints every swatch on a layer inside the control', () => {
    renderPanel();
    const swatches = screen.getAllByRole('radio');
    expect(swatches.length).toBeGreaterThan(10);

    for (const swatch of swatches) {
      const painted = swatch.querySelector('[class*="bg-[oklch"]');
      expect(painted, `${swatch.getAttribute('aria-label') ?? '?'} has no colour layer`).not.toBeNull();
      expect(painted).not.toBe(swatch);
    }
  });

  it('never puts the colour on an element that also has a hover background', () => {
    renderPanel();
    const colours = new Set(Object.values(SWATCH));

    // `className` is an SVGAnimatedString on an svg node, so read the attribute.
    for (const element of Array.from(document.querySelectorAll('[class]'))) {
      const attribute = element.getAttribute('class') ?? '';
      const classes: string[] = attribute.split(/\s+/u);
      const carriesColour = classes.some((c: string) => colours.has(c));
      if (!carriesColour) continue;
      const hoverBackground = classes.filter((c: string) => c.startsWith('hover:bg-'));
      expect(hoverBackground, `"${attribute}" would lose its colour on hover`).toEqual([]);
    }
  });
});
