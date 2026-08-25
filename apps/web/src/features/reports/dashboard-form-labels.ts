import type { DashboardTileForm } from '@vyuha/shared';

/**
 * The one place a chart form gets its name. The customise sheet's collapsed
 * "Chart:" button and the gallery's tile captions both read from here, so the
 * word a person picked a form by is the word the sheet keeps calling it.
 *
 * `hbar` reads "Horizontal bars" because plain "Bars" names the vertical
 * family: two entries wearing the same word would be an unanswerable choice.
 */
export const FORM_LABELS: Record<DashboardTileForm, string> = {
  auto: 'Automatic',
  hbar: 'Horizontal bars',
  bar: 'Bars',
  'stacked-bar': 'Stacked bars',
  line: 'Line',
  area: 'Area',
  'stacked-area': 'Stacked area',
  donut: 'Donut',
  pie: 'Pie',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  radials: 'Radials',
  radar: 'Radar',
  pareto: 'Pareto',
};
