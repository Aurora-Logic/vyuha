import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The layout facts that made four charts invisible.
 *
 * The pie, the donut, the radar and the radial bars all rendered as empty
 * cards -- correct header, correct insight, correct total, nothing in
 * between. `CardContent` carried `flex justify-center`, and ChartContainer
 * measures itself through a Recharts ResponsiveContainer: a flex child with
 * no basis resolves to zero width.
 *
 * jsdom has no layout, so it cannot catch this by rendering. The source can.
 */
const source = readFileSync(resolve(__dirname, 'dashboard-v2.tsx'), 'utf8');
// The card composition moved into the shared ChartCard, so the CardContent
// this page's charts actually sit in lives there now; the rule follows it.
const cardSource = readFileSync(
  resolve(__dirname, '../../components/shared/chart-card.tsx'),
  'utf8',
);

describe('dashboard chart layout', () => {
  it('never puts a flex container around a chart', () => {
    for (const text of [source, cardSource]) {
      const cardContents = [...text.matchAll(/<CardContent([^>]*)>/gu)].map((m) => m[1] ?? '');
      const flexed = cardContents.filter((attributes) => /\bflex\b/u.test(attributes));
      expect(flexed, 'a flex CardContent collapses ChartContainer to zero width').toEqual([]);
    }
  });

  it('centres a square chart with mx-auto instead', () => {
    // Every aspect-square container is one of the round charts, and each one
    // needs the margin rule that replaced the flex.
    const squares = [...source.matchAll(/className="([^"]*aspect-square[^"]*)"/gu)].map((m) => m[1] ?? '');
    expect(squares.length).toBeGreaterThan(0);
    for (const className of squares) {
      expect(className, `"${className}" is not centred`).toContain('mx-auto');
    }
  });

  it('writes a row name on the axis, never inside the mark', () => {
    // Recharts wraps an over-long label onto further lines and the bar then
    // clips them: "Nashik Switchgear Traders" arrived as three half-visible
    // rows inside its own bar. Every horizontal chart gets a category axis
    // wide enough to hold the name instead.
    const horizontal = source.match(/layout="vertical"/gu) ?? [];
    const gutters = source.match(/width=\{NAME_GUTTER\}/gu) ?? [];
    expect(horizontal.length).toBeGreaterThan(0);
    expect(gutters.length, 'a horizontal chart is missing its name gutter').toBe(horizontal.length);
    expect(source, 'a name is being written inside a bar again').not.toContain(
      'dataKey="label"\n                  position="insideLeft"',
    );
  });

  it('keeps every bar square', () => {
    const radii = [...source.matchAll(/radius=\{([^}]*)\}/gu)].map((m) => m[1] ?? '');
    for (const radius of radii) {
      expect(radius, 'the theme is square; a rounded bar is the only curve on the page').toBe(
        'SHARP',
      );
    }
    expect(/const SHARP = 0;/u.test(source)).toBe(true);
  });
});
