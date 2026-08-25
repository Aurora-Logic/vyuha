import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The layout facts that once made four charts invisible, retargeted at the
 * one place every surface now draws from. The bespoke overview page these
 * rules were written against is gone -- its charts collapsed into the
 * generic engine -- so the lint follows the drawing into report-charts.tsx
 * and the shared card.
 *
 * jsdom has no layout, so it cannot catch any of this by rendering. The
 * source can.
 */
const chartsSource = readFileSync(resolve(__dirname, 'report-charts.tsx'), 'utf8');
const cardSource = readFileSync(
  resolve(__dirname, '../../components/shared/chart-card.tsx'),
  'utf8',
);

describe('chart engine layout', () => {
  it('never puts a flex container around a chart', () => {
    // ChartContainer measures itself through a ResponsiveContainer; a flex
    // child with no basis resolves to zero width, and the chart renders as
    // an empty card with a correct header.
    for (const text of [chartsSource, cardSource]) {
      const cardContents = [...text.matchAll(/<CardContent([^>]*)>/gu)].map((m) => m[1] ?? '');
      const flexed = cardContents.filter((attributes) => /\bflex\b/u.test(attributes));
      expect(flexed, 'a flex CardContent collapses ChartContainer to zero width').toEqual([]);
    }
  });

  it('centres a square chart with mx-auto instead', () => {
    const squares = [...chartsSource.matchAll(/className="([^"]*aspect-square[^"]*)"/gu)].map(
      (m) => m[1] ?? '',
    );
    expect(squares.length).toBeGreaterThan(0);
    for (const className of squares) {
      expect(className, `"${className}" is not centred`).toContain('mx-auto');
    }
  });

  it('gives every horizontal chart a category axis wide enough to hold the name', () => {
    // Recharts wraps an over-long label onto further lines and the bar then
    // clips them: "Nashik Switchgear Traders" once arrived as three
    // half-visible rows inside its own bar. The name lives on the axis, in
    // an explicit gutter.
    const horizontal = chartsSource.match(/layout="vertical"/gu) ?? [];
    const categoryAxes = [...chartsSource.matchAll(/<YAxis[^>]*type="category"[^>]*>/gu)].map(
      (m) => m[0],
    );
    expect(horizontal.length).toBeGreaterThan(0);
    expect(
      categoryAxes.length,
      'a horizontal chart is missing its category axis',
    ).toBeGreaterThanOrEqual(horizontal.length);
    for (const axis of categoryAxes) {
      expect(axis, 'a category axis without an explicit width clips its names').toMatch(/width=\{\d+\}/u);
    }
  });

  it('keeps every bar square', () => {
    // The theme sets --radius to 0; a rounded bar would be the one curve on
    // the page. Recharts' default radius is already 0, so the only radius=
    // a bar may state is the explicit zero.
    const radii = [...chartsSource.matchAll(/(?<!inner|outer|Polar)radius=\{([^}]*)\}/gu)].map(
      (m) => m[1] ?? '',
    );
    for (const radius of radii) {
      expect(radius, 'the theme is square; a rounded bar is the only curve on the page').toBe('0');
    }
  });
});
