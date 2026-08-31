import { heatGridOf, heatmapStep, type HeatGrid } from '@/components/shared/heat-grid';
import { formatCount, formatMoney } from '@/lib/format';
import type { ReportCellValue, ReportColumnSpec, ReportDefinition, ReportKey } from '@vyuha/shared';

/**
 * Series builders for the report charts: pure functions from a page of
 * report rows (the shell's parsed cells) to plottable points and one
 * insight sentence the series proves (vyuha-charts §3). No React, no
 * fetching; every threshold an insight depends on is named here and
 * tested.
 *
 * A chart reads the rows the table shows — same filters, same period — so
 * the picture and the figures beneath it can never disagree. Each builder
 * states the question it answers; a report whose question a table answers
 * better has no builder.
 */

export interface ChartRow {
  /** Present on rows from the report shell; a drill uses it as the row's own id. */
  readonly id?: string;
  readonly cells: Readonly<Record<string, ReportCellValue>>;
}

/** How many bars fit at 360px with readable labels; beyond it, the table has the rest. */
export const MAX_BARS = 8;

function num(value: ReportCellValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function text(value: ReportCellValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- sales analysis

export interface ValueBarPoint {
  readonly label: string;
  readonly value: number;
}

/** Which group carries the value? Top groups of the current page, one hue. */
export function salesAnalysisSeries(rows: readonly ChartRow[]): { points: ValueBarPoint[]; insight: string | null } {
  const points = rows
    .map((row) => ({ label: text(row.cells.label), value: Math.abs(num(row.cells.value)) }))
    .filter((p) => p.label !== '' && p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_BARS);
  if (points.length < 2) return { points, insight: null };
  const total = rows.reduce((sum, row) => sum + Math.abs(num(row.cells.value)), 0);
  const top = points[0];
  if (top === undefined || total <= 0) return { points, insight: null };
  const share = Math.round((top.value / total) * 100);
  // Below a fifth, "leads" would dress an even spread up as a headline.
  const insight = share >= 20 ? `${top.label} carries ${String(share)}% of the value shown.` : null;
  return { points, insight };
}

// ---------------------------------------------------------------- movement

export interface MovementPoint {
  readonly month: string;
  readonly inward: number;
  readonly outward: number;
}

/** Is stock building up or draining, month by month? */
export function movementSeries(rows: readonly ChartRow[]): { points: MovementPoint[]; insight: string | null } {
  const byMonth = new Map<string, { inward: number; outward: number }>();
  for (const row of rows) {
    const month = text(row.cells.month);
    if (month === '') continue;
    const entry = byMonth.get(month) ?? { inward: 0, outward: 0 };
    entry.inward += num(row.cells.inwardQty);
    entry.outward += num(row.cells.outwardQty);
    byMonth.set(month, entry);
  }
  const points = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, entry]) => ({ month, ...entry }));
  const last = points.at(-1);
  if (points.length < 2 || last === undefined) return { points, insight: points.length === 0 ? null : 'Not enough months on this page to read a direction.' };
  const net = last.inward - last.outward;
  const insight =
    net > 0
      ? `${last.month}: stock built up by ${formatCount(net)} units — more came in than went out.`
      : net < 0
        ? `${last.month}: stock drained by ${formatCount(-net)} units — sales outran purchases.`
        : `${last.month}: inward and outward balanced exactly.`;
  return { points, insight };
}

// ---------------------------------------------------------------- velocity

export interface VelocityPoint {
  readonly item: string;
  readonly monthly12: number;
  readonly monthly3: number;
}

/** Which items move fastest, and is the pace changing? */
export function velocitySeries(rows: readonly ChartRow[]): { points: VelocityPoint[]; insight: string | null } {
  const points = rows
    .map((row) => ({ item: text(row.cells.item), monthly12: num(row.cells.monthly12), monthly3: num(row.cells.monthly3) }))
    .filter((p) => p.item !== '' && p.monthly12 > 0)
    .sort((a, b) => b.monthly12 - a.monthly12)
    .slice(0, MAX_BARS);
  if (points.length === 0) return { points, insight: null };
  // A quickening item runs a quarter past its year pace; a slowing one a quarter under.
  const rising = points.filter((p) => p.monthly3 > p.monthly12 * 1.25).length;
  const falling = points.filter((p) => p.monthly3 < p.monthly12 * 0.75).length;
  const insight =
    rising === 0 && falling === 0
      ? null
      : `Of the top ${String(points.length)}: ${String(rising)} quickening, ${String(falling)} slowing against their own year.`;
  return { points, insight };
}

// ---------------------------------------------------------------- stock ageing

export interface AgeingPoint {
  readonly item: string;
  readonly bucket0: number;
  readonly bucket31: number;
  readonly bucket61: number;
  readonly bucket90: number;
  readonly valueLocked: number;
}

/** Where is stock sitting old — and how much of the money is in the oldest bucket? */
export function ageingSeries(rows: readonly ChartRow[]): { points: AgeingPoint[]; insight: string | null } {
  const points = rows
    .map((row) => ({
      item: text(row.cells.item),
      bucket0: num(row.cells.bucket0),
      bucket31: num(row.cells.bucket31),
      bucket61: num(row.cells.bucket61),
      bucket90: num(row.cells.bucket90),
      valueLocked: num(row.cells.valueLocked),
    }))
    .filter((p) => p.item !== '' && p.bucket0 + p.bucket31 + p.bucket61 + p.bucket90 > 0)
    .sort((a, b) => b.valueLocked - a.valueLocked)
    .slice(0, MAX_BARS);
  if (points.length === 0) return { points, insight: null };
  const totalQty = points.reduce((sum, p) => sum + p.bucket0 + p.bucket31 + p.bucket61 + p.bucket90, 0);
  const oldQty = points.reduce((sum, p) => sum + p.bucket90, 0);
  const share = totalQty > 0 ? Math.round((oldQty / totalQty) * 100) : 0;
  // A quarter of the shelf over ninety days old is a purchasing question, not noise.
  const insight = share >= 25 ? `${String(share)}% of the stock shown has sat over ninety days.` : null;
  return { points, insight };
}

// ---------------------------------------------------------------- customer lapse

export interface LapsePoint {
  readonly customer: string;
  readonly revenue: number;
  readonly state: 'LAPSED' | 'AT_RISK' | 'ON_RHYTHM';
}

/** How much revenue is going quiet, and whose? */
export function lapseSeries(rows: readonly ChartRow[]): { points: LapsePoint[]; insight: string | null } {
  const points: LapsePoint[] = rows
    .map((row): LapsePoint => {
      const state = text(row.cells.state);
      return {
        customer: text(row.cells.partyName),
        revenue: num(row.cells.revenue12m),
        state: state === 'LAPSED' || state === 'AT_RISK' ? state : 'ON_RHYTHM',
      };
    })
    .filter((p) => p.customer !== '' && p.state !== 'ON_RHYTHM' && p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, MAX_BARS);
  if (points.length === 0) return { points, insight: null };
  const atRisk = points.reduce((sum, p) => sum + p.revenue, 0);
  const lapsed = points.filter((p) => p.state === 'LAPSED').length;
  return {
    points,
    insight: `${formatMoney(atRisk)} of last year's revenue is going quiet — ${String(lapsed)} of these ${String(points.length)} customers have fully lapsed.`,
  };
}

/** The keys that draw a chart; everything else is answered by its table. */
export const CHARTED_REPORTS: readonly ReportKey[] = ['sales-analysis', 'movement-analysis', 'item-velocity', 'stock-ageing', 'customer-lapse'];

// ---------------------------------------------------------------- generic

export interface GenericSeries {
  readonly categoryLabel: string;
  /** The column the categories came from — what a drill can filter by. */
  readonly categoryKey: string;
  readonly series: readonly { key: string; label: string }[];
  readonly points: readonly Record<string, string | number>[];
}

function isNumericColumn(column: ReportColumnSpec, rows: readonly ChartRow[]): boolean {
  if (column.key === 'asOf') return false;
  const sample = rows.slice(0, 5).map((row) => row.cells[column.key]).filter((v) => v !== null && v !== undefined && v !== '');
  if (sample.length === 0) return false;
  return sample.every((v) => typeof v === 'number' || (typeof v === 'string' && Number.isFinite(Number(v))));
}

/**
 * Any report as a chart: the first text column names the bars, the sort
 * column (or the first numeric ones) sizes them, and the rows come in the
 * order the report itself sorted — the chart never re-ranks what the table
 * ranked. Returns null where no honest chart exists, and the view toggle
 * follows that answer rather than drawing nonsense.
 */
export function genericSeries(definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>, rows: readonly ChartRow[]): GenericSeries | null {
  if (rows.length === 0) return null;
  const category = definition.columns.find((c) => (c.type === 'text' || c.type === 'code') && !isNumericColumn(c, rows) && c.key !== 'asOf');
  if (category === undefined) return null;
  const sortKey = definition.defaultSort.startsWith('-') ? definition.defaultSort.slice(1) : definition.defaultSort;
  const numeric = definition.columns.filter((c) => c.key !== category.key && isNumericColumn(c, rows));
  const ordered = [...numeric].sort((a, b) => (a.key === sortKey ? -1 : b.key === sortKey ? 1 : 0)).slice(0, 2);
  if (ordered.length === 0) return null;
  const points = rows.slice(0, MAX_BARS).map((row) => {
    // __rowId rides along unplotted so a drill on a party-grain bar can carry
    // the id its filter needs, not just the display name.
    const point: Record<string, string | number> = { category: text(row.cells[category.key]) || '—', __rowId: row.id ?? '' };
    for (const column of ordered) point[column.key] = num(row.cells[column.key]);
    return point;
  });
  if (points.every((p) => ordered.every((c) => p[c.key] === 0))) return null;
  return { categoryLabel: category.header, categoryKey: category.key, series: ordered.map((c) => ({ key: c.key, label: c.header })), points };
}

// ---------------------------------------------------------------- share radial

export interface SharePoint {
  readonly label: string;
  readonly value: number;
  readonly share: number;
}

/** Top five as a share of everything shown — the whole is this page's rows, and the chart says so. */
export function shareSeries(rows: readonly ChartRow[], labelKey: string, valueKey: string): { points: SharePoint[]; total: number } {
  const all = rows.map((row) => ({ label: text(row.cells[labelKey]), value: num(row.cells[valueKey]) })).filter((p) => p.label !== '' && p.value > 0);
  const total = all.reduce((sum, p) => sum + p.value, 0);
  const points = [...all]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((p) => ({ ...p, share: total > 0 ? Math.round((p.value / total) * 100) : 0 }));
  return { points, total };
}

/** Whether a report can draw anything, so the view toggle can tell the truth. */
export function chartKindOf(reportKey: ReportKey, definition: Pick<ReportDefinition, 'columns' | 'defaultSort'> | undefined, rows: readonly ChartRow[]): 'bespoke' | 'generic' | 'none' {
  if (BESPOKE_CHART_KEYS.has(reportKey)) return 'bespoke';
  if (definition !== undefined && genericSeries(definition, rows) !== null) return 'generic';
  return 'none';
}

const BESPOKE_CHART_KEYS = new Set<ReportKey>(['sales-analysis', 'movement-analysis', 'item-velocity', 'stock-ageing', 'customer-lapse', 'stock-summary']);

/** The column a comparison deltas: the sort column when numeric, else the first numeric one. */
export function primaryNumericColumn(definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>, rows: readonly ChartRow[]): { key: string; header: string } | null {
  const sortKey = definition.defaultSort.startsWith('-') ? definition.defaultSort.slice(1) : definition.defaultSort;
  const numeric = definition.columns.filter((c) => isNumericColumn(c, rows));
  const chosen = numeric.find((c) => c.key === sortKey) ?? numeric[0];
  return chosen === undefined ? null : { key: chosen.key, header: chosen.header };
}

// ---------------------------------------------------------------- chart forms

export type GenericChartForm = 'hbar' | 'bar' | 'stacked-bar' | 'line' | 'area' | 'stacked-area' | 'donut' | 'pie' | 'scatter' | 'heatmap' | 'radials' | 'radar' | 'pareto';

export interface ChartFormSpec {
  readonly form: GenericChartForm;
  readonly category: string;
  readonly series: readonly string[];
  /**
   * What a Pareto's rows are, plural and lower case, and what is being
   * concentrated — "customers" and "revenue". They live on the spec because
   * the sentence belongs beside the form that needs it, and a chart cannot
   * write "9 of 214 rows make up half the total" and be worth reading.
   */
  readonly noun?: string;
  readonly measure?: string;
}

/**
 * Which form a report's generic chart takes (data-analyst skill §2): a
 * time-shaped category draws a line, a ranking draws horizontal bars, and
 * the named overrides draw the form their question demands — a day book is
 * a composition of voucher types, a statement is a balance walking through
 * time. Anything unlisted resolves by shape.
 */
export const REPORT_FORM_OVERRIDES: Partial<Record<ReportKey, ChartFormSpec>> = {
  'day-book': { form: 'donut', category: 'voucherType', series: ['amount'] },
  'ledger-extract': { form: 'line', category: 'date', series: ['balance'] },
  'customer-statement': { form: 'line', category: 'date', series: ['balance'] },
  'voucher-reconciliation': { form: 'line', category: 'month', series: ['total'] },
  'headcount': { form: 'line', category: 'month', series: ['closing'] },
  // Owner, 22 Aug 2026. A Pareto is bars plus a running curve, which is
  // classically drawn on two y-axes — value on the left, per cent on the
  // right. This product does not draw two axes (dataviz: it is the single
  // most common chart mistake), so both series are put in per cent and share
  // one 0–100 axis. Nothing is lost: the money is in the table and the
  // tooltip, and the question a Pareto answers is a question about shares.
  'customer-concentration': { form: 'pareto', category: 'partyName', series: ['sharePct', 'cumulativePct'], noun: 'customers', measure: 'revenue' },
  'item-revenue-concentration': { form: 'pareto', category: 'name', series: ['sharePct', 'cumulativePct'], noun: 'items', measure: 'revenue' },
  'item-quantity-concentration': { form: 'pareto', category: 'name', series: ['sharePct', 'cumulativePct'], noun: 'items', measure: 'volume' },
  'vendor-spend-concentration': { form: 'pareto', category: 'name', series: ['sharePct', 'cumulativePct'], noun: 'vendors', measure: 'spend' },
  'receivables-concentration': { form: 'pareto', category: 'name', series: ['sharePct', 'cumulativePct'], noun: 'customers', measure: 'money owed' },
  'order-pipeline': { form: 'hbar', category: 'number', series: ['ageDays'] },
  'dispatch-performance': { form: 'hbar', category: 'number', series: ['leadDays'] },
  'order-fill-rate': { form: 'hbar', category: 'partyName', series: ['fillPct'] },
  'new-vs-repeat': { form: 'line', category: 'month', series: ['newRevenue', 'repeatRevenue'] },
  // The matrix's two-variable form (data-analyst §2): how often a customer
  // buys an item against how much that lane is worth — the outliers are the
  // consolidation candidates and the quiet big-ticket lanes.
  'customer-item-matrix': { form: 'scatter', category: 'partyName', series: ['invoices', 'value'] },
  // Owner, 22 Aug 2026: the second analytics set, forms from the matrix.
  'approvals-turnaround': { form: 'hbar', category: 'type', series: ['medianHours', 'p90Hours'] },
  'early-arrival-leaderboard': { form: 'hbar', category: 'employeeName', series: ['currentStreak'] },
  // Several rates side by side: a grid of radials, five at most, the table has the rest.
  'on-time-rate': { form: 'radials', category: 'department', series: ['onTimePct'] },
  'aov-trend': { form: 'line', category: 'month', series: ['aov'] },
  'partial-shipments': { form: 'hbar', category: 'partyName', series: ['partialPct'] },
  'vendor-lead-time': { form: 'hbar', category: 'partyName', series: ['medianDays', 'promisedDays'] },
  'stock-out-frequency': { form: 'hbar', category: 'item', series: ['shortages'] },
  'margin-proxy': { form: 'hbar', category: 'item', series: ['margin'] },
  // The dense grid: customer down the side, month across, value in the cell.
  'sales-heatmap': { form: 'heatmap', category: 'partyName', series: ['value'] },
  // D-22: the interest module. The two cost reports rank where the money
  // sits; the cash cycle is its three day-components walking month by month,
  // on one axis because all three are days of the same cycle.
  'party-interest-cost': { form: 'hbar', category: 'partyName', series: ['interestLoss'] },
  'stock-interest-cost': { form: 'hbar', category: 'item', series: ['interest'] },
  'cash-cycle': { form: 'line', category: 'month', series: ['inventoryDays', 'receivableDays', 'payableDays'] },
};

const TIME_CATEGORY = /^\d{4}-\d{2}(?:-\d{2})?$/u;

/** The generic chart's resolved shape for a report: what to draw and from which keys. */
export function resolveChartForm(reportKey: ReportKey, definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>, rows: readonly ChartRow[]): ChartFormSpec | null {
  const override = REPORT_FORM_OVERRIDES[reportKey];
  if (override !== undefined) return override;
  const auto = genericSeries(definition, rows);
  if (auto === null) return null;
  const categoryColumn = definition.columns.find((c) => c.header === auto.categoryLabel);
  if (categoryColumn === undefined) return null;
  const sample = rows.slice(0, 5).map((row) => text(row.cells[categoryColumn.key]));
  const timeShaped = sample.length > 0 && sample.every((v) => TIME_CATEGORY.test(v));
  return { form: timeShaped ? 'line' : 'hbar', category: categoryColumn.key, series: auto.series.map((entry) => entry.key) };
}

export interface FormPoint extends Record<string, string | number> {
  readonly category: string;
}

/**
 * Rows shaped for the resolved form. A line or an area aggregates duplicate
 * categories and walks chronologically; a donut or a pie aggregates into the
 * top five slices plus Other; bars, columns and the radar keep the report's
 * own order, top rows only.
 */
export function formSeries(spec: ChartFormSpec, rows: readonly ChartRow[]): FormPoint[] {
  if (spec.form === 'heatmap') {
    // One point per row: the category, the month, and the value; the chart
    // lays them out as a grid. Rows carry their id for the drill.
    const [valueKey = 'value'] = spec.series;
    return rows.map((row) => {
      const point: Record<string, string | number> = {
        category: text(row.cells[spec.category]) || '—',
        month: text(row.cells.month),
        __rowId: row.id ?? '',
        [valueKey]: num(row.cells[valueKey]),
      };
      return point as FormPoint;
    });
  }
  if (spec.form === 'radials') {
    // Five rates at most, in the table's own order; the table has the rest.
    const [rateKey = 'rate'] = spec.series;
    return rows.slice(0, 5).map((row) => {
      const point: Record<string, string | number> = {
        category: text(row.cells[spec.category]) || '—',
        __rowId: row.id ?? '',
        [rateKey]: num(row.cells[rateKey]),
      };
      return point as FormPoint;
    });
  }
  if (spec.form === 'scatter') {
    // One dot per row; the first series is x, the second y. The item rides
    // along so the tooltip and the drill can name what the dot is.
    const [xKey = 'x', yKey = 'y'] = spec.series;
    return rows.map((row) => {
      const item = text(row.cells.item);
      const point: Record<string, string | number> = {
        category: item === '' ? text(row.cells[spec.category]) || '—' : `${text(row.cells[spec.category]) || '—'} · ${item}`,
        __item: item,
        [xKey]: num(row.cells[xKey]),
        [yKey]: num(row.cells[yKey]),
      };
      return point as FormPoint;
    });
  }
  if (spec.form === 'hbar' || spec.form === 'bar' || spec.form === 'stacked-bar' || spec.form === 'radar') {
    // One point per row in the report's own order, top rows only -- MAX_BARS
    // is also the most categories a radar stays readable at, so the radar
    // slices here the way the radials slice to five, silently and honestly:
    // the table has the rest.
    return rows.slice(0, MAX_BARS).map((row) => {
      const point: Record<string, string | number> = { category: text(row.cells[spec.category]) || '—', __rowId: row.id ?? '' };
      for (const key of spec.series) point[key] = num(row.cells[key]);
      return point as FormPoint;
    });
  }
  const byCategory = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const category = text(row.cells[spec.category]);
    if (category === '') continue;
    const entry = byCategory.get(category) ?? {};
    for (const key of spec.series) entry[key] = (entry[key] ?? 0) + num(row.cells[key]);
    byCategory.set(category, entry);
  }
  if (spec.form === 'line' || spec.form === 'area' || spec.form === 'stacked-area') {
    // A running balance is a last-value series, not a sum; the last row of a
    // date already carries the day's closing figure.
    const isBalance = spec.series.length === 1 && spec.series[0] === 'balance';
    if (isBalance) {
      const lastPerDay = new Map<string, number>();
      for (const row of rows) {
        const category = text(row.cells[spec.category]);
        if (category !== '') lastPerDay.set(category, num(row.cells.balance));
      }
      return [...lastPerDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, balance]) => ({ category, balance }));
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, entry]) => ({ category, ...entry }));
  }
  // donut and pie: top five slices of the first series, everything else as Other
  const key = spec.series[0] ?? '';
  const slices = [...byCategory.entries()].map(([category, entry]) => ({ category, value: entry[key] ?? 0 })).filter((p) => p.value > 0);
  slices.sort((a, b) => b.value - a.value);
  const top = slices.slice(0, 5);
  const rest = slices.slice(5).reduce((sum, p) => sum + p.value, 0);
  const points: FormPoint[] = top.map((p) => ({ category: p.category, value: p.value }));
  if (rest > 0) points.push({ category: 'Other', value: rest });
  return points;
}

/**
 * The heatmap's grid: categories down, months across, each cell the value or
 * null where the pair never met. Months come out sorted so August follows
 * July whatever order the rows arrived in; categories keep the report's
 * order (its sort is the ranking the reader asked for).
 */
/**
 * Whether a form, once drawn, would put any mark on the page for these rows.
 * The tile renderer heals a pinned form that cannot draw back to the
 * automatic one, and the customise sheet never offers a form the report's
 * columns cannot wear -- both ask here, so the two answers cannot drift.
 */
export function formDraws(spec: ChartFormSpec, definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>, rows: readonly ChartRow[]): boolean {
  if (rows.length === 0) return false;
  if (spec.form === 'hbar') return genericSeries(definition, rows) !== null;
  if (spec.form === 'bar' || spec.form === 'stacked-bar' || spec.form === 'radar') {
    // The hbar rule for the other per-row forms: bars of nothing but zeros
    // draw an empty plot that reads as a rendering failure, not a chart.
    return formSeries(spec, rows).some((point) => spec.series.some((key) => Number(point[key] ?? 0) !== 0));
  }
  if (spec.form === 'pareto') return paretoSeries(rows, spec.category).length > 0;
  if (spec.form === 'heatmap') {
    const grid = heatmapGrid(formSeries(spec, rows), spec.series[0] ?? 'value');
    return grid.months.length > 0 && grid.rows.length > 0;
  }
  return formSeries(spec, rows).length > 0;
}

/** The forms this report's columns can wear at all, before any rows arrive. */
export function wearableForms(definition: Pick<ReportDefinition, 'columns'>): GenericChartForm[] {
  const numeric = definition.columns.filter((c) => c.type === 'number' || c.type === 'money');
  const texty = definition.columns.filter((c) => (c.type === 'text' || c.type === 'code') && c.key !== 'asOf');
  const keys = new Set(definition.columns.map((c) => c.key));
  // resolveChartForm decides "time-shaped" from the rows; before any rows
  // arrive the columns-level mirror of that test is a `month` or `date` key,
  // the same key the heatmap rule below already leans on. An area over
  // ranked categories is a line wearing a fill, so it is never offered.
  const timeShaped = keys.has('month') || keys.has('date');
  const forms: GenericChartForm[] = ['hbar', 'bar', 'line', 'donut', 'pie'];
  if (timeShaped && numeric.length > 0) forms.push('area');
  if (numeric.length >= 2) forms.push('stacked-bar');
  if (timeShaped && numeric.length >= 2) forms.push('stacked-area');
  if (texty.length > 0 && numeric.length > 0) forms.push('radar');
  if (keys.has('month') && texty.some((c) => c.key !== 'month') && numeric.length > 0) forms.push('heatmap');
  if (numeric.length >= 2) forms.push('scatter');
  if (definition.columns.some((c) => /pct$/iu.test(c.key))) forms.push('radials');
  if (keys.has('sharePct') && keys.has('cumulativePct')) forms.push('pareto');
  return forms;
}

export function heatmapGrid(points: readonly FormPoint[], valueKey: string): HeatGrid {
  return heatGridOf(points.map((point) => ({ category: String(point.category), month: String(point.month), value: Number(point[valueKey] ?? 0), rowId: String(point.__rowId ?? '') })));
}

export { heatmapStep };


// ------------------------------------------------------------------ Pareto

export interface ParetoPoint {
  readonly category: string;
  readonly sharePct: number;
  readonly cumulativePct: number;
}

/**
 * The curve, in the order the report already ranked it.
 *
 * The rows arrive sorted and carrying their own running total, so this does
 * not re-derive either: a chart that recomputed the cumulative from a page of
 * rows would disagree with the table the moment the reader paged, and the
 * table is the one that is right.
 */
export function paretoSeries(rows: readonly ChartRow[], categoryKey: string): ParetoPoint[] {
  return rows
    .map((row) => ({
      category: text(row.cells[categoryKey]),
      sharePct: num(row.cells.sharePct),
      cumulativePct: num(row.cells.cumulativePct),
    }))
    .filter((point) => point.category !== '');
}

/** How many rows it takes to reach a share of the whole, or null if the page never gets there. */
export function countToReach(points: readonly ParetoPoint[], target: number): number | null {
  const index = points.findIndex((point) => point.cumulativePct >= target);
  return index === -1 ? null : index + 1;
}

/**
 * The sentence the curve proves: how few of them make up half, and then most.
 *
 * `noun` is plural and lower case — "customers", "items", "vendors". Null
 * when the page cannot support the claim: with three rows the answer is
 * arithmetically true and practically meaningless, and a Pareto over a
 * handful of rows is a bar chart wearing a curve.
 */
export function paretoInsight(points: readonly ParetoPoint[], noun: string, measure: string): string | null {
  if (points.length < 4) return null;
  const half = countToReach(points, 50);
  const most = countToReach(points, 80);
  if (half === null) return null;
  const total = points.length;
  const head = `${String(half)} of ${String(total)} ${noun} make up half the ${measure}`;
  if (most === null || most === half) return `${head}.`;
  return `${head}; ${String(most)} make up 80%.`;
}
