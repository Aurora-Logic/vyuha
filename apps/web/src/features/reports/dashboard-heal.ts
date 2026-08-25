import type { DashboardTile, ReportDefinition } from '@vyuha/shared';

import { formDraws, resolveChartForm, type ChartRow, type GenericChartForm } from './report-series';

/**
 * The pinned form, unless these rows cannot wear it -- then the automatic
 * one, with a footnote saying so. A person's choice is honoured where it can
 * be drawn and named where it cannot, and it is never silently dropped: the
 * blank board this replaces was every pinned-wrong tile vanishing at once.
 */
export function healTileForm(
  tile: DashboardTile,
  definition: ReportDefinition,
  rows: readonly ChartRow[],
): { form: GenericChartForm | undefined; footnote: string | undefined } {
  const pinned = tile.form === 'auto' ? undefined : tile.form;
  if (pinned === undefined) return { form: undefined, footnote: undefined };
  const resolved = resolveChartForm(tile.reportKey, definition, rows);
  if (resolved === null || formDraws({ ...resolved, form: pinned }, definition, rows)) {
    return { form: pinned, footnote: undefined };
  }
  return { form: undefined, footnote: `Shown in its automatic form - these rows cannot wear the ${pinned} chart.` };
}

