import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_KEYS,
  DASHBOARD_KPI_METRICS,
  REPORT_DEFINITIONS,
  dashboardTileSchema,
  type DashboardLayout,
  type DashboardTile,
} from '@vyuha/shared';

import { FINANCE_PRESET, OVERVIEW_SEED, SALES_PRESET, boardFromParam, boardToParam } from './dashboard-boards';
import { DASHBOARD_KPIS } from './dashboard-kpis';
import type { GenericChartForm } from './report-series';

const BOARDS: readonly [string, DashboardLayout][] = [
  ['sales', SALES_PRESET],
  ['finance', FINANCE_PRESET],
  ['overview seed', OVERVIEW_SEED],
];

/** The thirteen drawable forms; `auto` is the absence of a choice, not a form. */
const GENERIC_FORMS = [
  'hbar',
  'bar',
  'stacked-bar',
  'line',
  'area',
  'stacked-area',
  'donut',
  'pie',
  'scatter',
  'heatmap',
  'radials',
  'radar',
  'pareto',
] as const satisfies readonly GenericChartForm[];

type NonAutoForm = Exclude<DashboardTile['form'], 'auto'>;

describe('shipped board presets', () => {
  it('keeps the tile form union aligned with the drawable forms', () => {
    // A tile's pinned form must be a form the chart engine can draw. The
    // unions already agree; these two assignments stop compiling the day one
    // moves without the other.
    const tileFormsAreDrawable: readonly GenericChartForm[] = [] as NonAutoForm[];
    const drawableFormsAreTileForms: readonly NonAutoForm[] = [] as GenericChartForm[];
    expect(tileFormsAreDrawable).toEqual(drawableFormsAreTileForms);
  });

  it('names only reports that exist', () => {
    for (const [board, preset] of BOARDS) {
      for (const tile of preset.tiles) {
        expect(REPORT_DEFINITIONS[tile.reportKey], `${board}: ${tile.reportKey}`).toBeDefined();
      }
    }
  });

  it('parses every tile with the wire schema', () => {
    for (const [board, preset] of BOARDS) {
      for (const tile of preset.tiles) {
        const result = dashboardTileSchema.safeParse(tile);
        expect(result.success, `${board}: ${tile.reportKey}`).toBe(true);
      }
    }
  });

  it('pins only forms the chart engine draws', () => {
    for (const [board, preset] of BOARDS) {
      for (const tile of preset.tiles) {
        if (tile.form === 'auto') continue;
        expect(GENERIC_FORMS, `${board}: ${tile.reportKey}`).toContain(tile.form);
      }
    }
  });

  it('sends groupBy only to reports that understand it', () => {
    for (const [board, preset] of BOARDS) {
      for (const tile of preset.tiles) {
        if (tile.filters.groupBy === undefined) continue;
        expect(
          REPORT_DEFINITIONS[tile.reportKey].filters,
          `${board}: ${tile.reportKey} carries groupBy`,
        ).toContain('groupBy');
      }
    }
  });

  it('stays within the schema tile budget', () => {
    for (const [board, preset] of BOARDS) {
      expect(preset.tiles.length, board).toBeGreaterThanOrEqual(1);
      expect(preset.tiles.length, board).toBeLessThanOrEqual(24);
    }
  });
});

describe('the KPI tiles', () => {
  it('names a registered metric on every kpi tile, and none on a chart tile', () => {
    for (const [board, preset] of BOARDS) {
      for (const tile of preset.tiles) {
        if (tile.kind === 'kpi') {
          expect(tile.metric, `${board}: ${tile.reportKey}`).toBeDefined();
          if (tile.metric === undefined) continue;
          // The stored reportKey must be the registry's, or the visibility
          // gate and the fetch would answer for two different reports.
          expect(DASHBOARD_KPIS[tile.metric].reportKey, `${board}: ${tile.metric}`).toBe(tile.reportKey);
        } else {
          expect(tile.metric, `${board}: ${tile.reportKey}`).toBeUndefined();
        }
      }
    }
  });

  it('leads sales with the invoiced figure and finance with the interest leak (owner: essential)', () => {
    expect(SALES_PRESET.tiles[0]?.metric).toBe('invoiced-period');
    expect(FINANCE_PRESET.tiles[0]?.metric).toBe('interest-lost');
    expect(FINANCE_PRESET.tiles[1]?.metric).toBe('receivables-exposure');
    expect(FINANCE_PRESET.tiles[2]?.metric).toBe('credit-breaches');
  });

  it('seeds the overview customise draft with all six figures', () => {
    expect(OVERVIEW_SEED.tiles.map((tile) => tile.metric)).toEqual([...DASHBOARD_KPI_METRICS]);
    expect(OVERVIEW_SEED.tiles.every((tile) => tile.kind === 'kpi')).toBe(true);
  });

  it('parses a layout stored before KPI tiles existed, as a chart tile', () => {
    const legacy = dashboardTileSchema.parse({ reportKey: 'ageing', form: 'hbar' });
    expect(legacy.kind).toBe('chart');
    expect(legacy.metric).toBeUndefined();
  });

  it('refuses a kpi tile that names no metric', () => {
    const result = dashboardTileSchema.safeParse({ reportKey: 'ageing', kind: 'kpi' });
    expect(result.success).toBe(false);
  });
});

describe('the board URL parameter', () => {
  it('round-trips every board', () => {
    for (const key of DASHBOARD_KEYS) {
      expect(boardFromParam(boardToParam(key))).toBe(key);
    }
  });

  it('defaults to the overview and keeps it out of the URL', () => {
    expect(boardToParam('overview')).toBeNull();
    expect(boardFromParam(null)).toBe('overview');
    expect(boardFromParam('nonsense')).toBe('overview');
  });
});
