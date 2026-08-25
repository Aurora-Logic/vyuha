import type { Appearance } from '@vyuha/shared';

import { sliceColours } from './slice-hues';

/**
 * System stacks for the workspace typeface, so a choice never fetches a font.
 * `sans` keeps the app's own Geist ahead of the system fallback; the others
 * are the same stacks the printed documents use, for one voice across both.
 */
const FONT_STACKS: Record<Appearance['font'], string> = {
  sans: "'Geist Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  humanist: "'Trebuchet MS', 'Gill Sans', Verdana, 'DejaVu Sans', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
};

/**
 * The workspace's appearance, applied to the document: four custom
 * properties and two data attributes on <html> that index.css derives
 * every accent and neutral from. This is the one place the product sets a
 * style from JavaScript, and it sets variables, not styles -- every colour
 * still lives in index.css, in both modes.
 *
 * The slice hues are the exception, and only because CSS cannot do the
 * arithmetic: they are five hues walked around the wheel skipping the green
 * arc, and a skip is a branch. Both modes are written and index.css picks
 * between them the way it picks every other pair.
 */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
  root.style.setProperty('--accent-h', String(appearance.accentHue));
  root.style.setProperty('--accent-c', String(appearance.accentChroma));
  for (const mode of ['light', 'dark'] as const) {
    for (const [index, colour] of sliceColours(appearance.accentHue, appearance.accentChroma, mode).entries()) {
      root.style.setProperty(`--slice-${mode}-${String(index + 1)}`, colour);
    }
  }
  root.style.setProperty('--font-sans', FONT_STACKS[appearance.font]);
  root.dataset.base = appearance.base;
  root.dataset.density = appearance.density;
}
