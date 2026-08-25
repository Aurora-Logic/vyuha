import { z } from 'zod';

import { REPORT_KEYS, reportFilterSchema } from './reports.js';

/**
 * Customisable dashboards (owner, 25 Aug 2026).
 *
 * Layouts are data, presets are code: the server never renders a tile, it
 * only keeps the person's choice -- which report tiles a board shows, which
 * chart form each takes, and what filters each carries. No stored layout
 * means the shipped preset renders, so there is no "default layout" row
 * anywhere; absence is the default, and a reset is a delete.
 */

export const DASHBOARD_KEYS = ['overview', 'sales', 'finance'] as const;
export type DashboardKey = (typeof DASHBOARD_KEYS)[number];

export function isDashboardKey(value: string): value is DashboardKey {
  return (DASHBOARD_KEYS as readonly string[]).includes(value);
}

/**
 * How a tile draws its report. `auto` defers to the report's own default
 * form, so a tile saved before a report learned a better chart follows it.
 */
export const DASHBOARD_TILE_FORMS = ['auto', 'hbar', 'line', 'donut', 'scatter', 'heatmap', 'radials', 'pareto'] as const;
export type DashboardTileForm = (typeof DASHBOARD_TILE_FORMS)[number];

export const dashboardTileSchema = z.object({
  reportKey: z.enum(REPORT_KEYS),
  /** Overrides the report's own label on this board only. */
  label: z.string().trim().min(1).max(60).optional(),
  form: z.enum(DASHBOARD_TILE_FORMS).default('auto'),
  /** A wide tile spans the full row; what that means per breakpoint is the grid's business. */
  wide: z.boolean().default(false),
  filters: reportFilterSchema.default({}),
});

export type DashboardTile = z.infer<typeof dashboardTileSchema>;

export const dashboardLayoutSchema = z.object({
  tiles: z.array(dashboardTileSchema).min(1).max(24),
});

export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** A stored layout on the wire: whose board it is and when it last changed. */
export interface DashboardLayoutView {
  readonly dashboard: DashboardKey;
  readonly config: DashboardLayout;
  readonly updatedAt: string;
}
