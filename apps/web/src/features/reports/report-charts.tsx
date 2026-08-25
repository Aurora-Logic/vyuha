import type { ReactNode } from 'react';

import { compactCount, compactIndian, stackTotal, valueCaps, valueTips } from '@/components/shared/chart-labels';
import { Bar, BarChart, CartesianGrid, ComposedChart, Label, Line, LineChart, Pie, PieChart, PolarGrid, PolarRadiusAxis, RadialBar, RadialBarChart, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, LabelList } from 'recharts';

import { CHART_INTRO_MS } from '@/components/shared/use-chart-motion';
import { Button } from '@/components/ui/button';
import { ChartCard } from '@/components/shared/chart-card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoneyShort, humaniseEnum } from '@/lib/format';
import { cn } from '@/lib/utils';

import { pieSliceLabel } from './pie-label';
import type { ReportDefinition, ReportKey } from '@vyuha/shared';

import {
  ageingSeries,
  formSeries,
  genericSeries,
  type GenericChartForm,
  heatmapGrid,
  heatmapStep,
  lapseSeries,
  movementSeries,
  paretoInsight,
  paretoSeries,
  resolveChartForm,
  salesAnalysisSeries,
  shareSeries,
  type ChartRow,
  velocitySeries,
} from './report-series';

/**
 * The chart above a report's table, for the five reports whose question a
 * picture answers faster than rows (report-series.ts names each question).
 * Presentational only: the series and its insight arrive computed. Colour
 * policy follows the dashboard's reasoning — semantic tokens only where a
 * colour carries meaning (lapsed red, at-risk amber, the fulfilment gauge's
 * good/fair/poor bands), and the theme's --chart ramp everywhere else,
 * whether the job is a sequential age scale or a series that needs no
 * identity at all.
 *
 * The ramp is five shades of the workspace's own accent, so these charts
 * belong to the appearance the way the rest of the product does. --primary is
 * the button hue and --info is a fixed blue; both were being drawn into
 * charts that meant neither.
 *
 * Bar geometry is square and narrow across every chart in the product. The
 * theme sets --radius to 0 and the shell is rounded-none throughout, so a
 * rounded bar cap was the one curve left on the page; and a bar wide enough to
 * read as a slab stops reading as a measurement, so each series carries a
 * width cap rather than letting recharts fill the band.
 */

const VALUE_CONFIG = { value: { label: 'Value', color: 'var(--chart-1)' } } satisfies ChartConfig;
const MOVEMENT_CONFIG = {
  inward: { label: 'Inward', color: 'var(--chart-1)' },
  outward: { label: 'Outward', color: 'var(--chart-2)' },
} satisfies ChartConfig;
const VELOCITY_CONFIG = {
  monthly12: { label: 'Per month, 12m', color: 'var(--chart-1)' },
  monthly3: { label: 'Per month, last 3m', color: 'var(--chart-2)' },
} satisfies ChartConfig;
/** One hue, light to dark: the ageing buckets are a magnitude of age, not identities. */
const AGEING_CONFIG = {
  bucket0: { label: '0–30 days', color: 'var(--chart-1)' },
  bucket31: { label: '31–60 days', color: 'var(--chart-2)' },
  bucket61: { label: '61–90 days', color: 'var(--chart-3)' },
  bucket90: { label: 'Over 90 days', color: 'var(--chart-4)' },
} satisfies ChartConfig;
const LAPSE_CONFIG = {
  lapsedRevenue: { label: 'Lapsed', color: 'var(--destructive)' },
  atRiskRevenue: { label: 'At risk', color: 'var(--warning)' },
} satisfies ChartConfig;

/** Room for the last label; ticks are centred under their category. */
/*
 * `top` leaves room for the value that sits on a bar's cap. At the old 4px the
 * tallest column's label was clipped by the plot edge -- the bars that most
 * need reading were the ones whose number was cut in half.
 *
 * `bottom` leaves room for angled category names; see ANGLED_CATEGORY.
 */
const AXIS_MARGIN = { left: 0, right: 16, top: 20, bottom: 4 } as const;
const AXIS_MARGIN_ANGLED = { left: 0, right: 16, top: 20, bottom: 28 } as const;

/**
 * Long category names, set at an angle instead of overlapping.
 *
 * Eight item names across half a page gives each about 55px, and
 * "MCCB 100A 3P 36kA" is nowhere near that -- horizontal they ran into each
 * other and became one smear. Angled, each name gets the full diagonal and
 * stays readable. `interval={0}` is kept deliberately: every bar keeps its
 * name, which is the point of the chart. Truncation is tighter than the
 * default because the diagonal is not unlimited either.
 */
const ANGLED_CATEGORY = {
  angle: -35,
  textAnchor: 'end',
  height: 56,
  interval: 0,
} as const;

function truncateTight(label: string): string {
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

/** A whole-number share, as it is written on a ring. */
function sharePercent(value: unknown): string {
  return typeof value === 'number' ? `${String(value)}%` : '';
}

/*
 * Heights and overflow, together on purpose.
 *
 * The angled category labels claim 56px of the box and the values on the caps
 * want 20 at the top, so an h-56 chart had about 148px left to actually plot
 * in -- the bars got shorter while the furniture around them did not. Raised
 * so the plot keeps the room it had before the labels arrived.
 *
 * `overflow-hidden` because a Recharts SVG does not clip itself: an angled
 * label longer than its slot spilled past the bottom of the chart and sat over
 * whatever came next. Clipping is the guard rather than the fix -- the height
 * above is the fix, and if a label is ever cut it means the height is wrong
 * again rather than that the clip is doing its job.
 */

/**
 * A slice's value, outside the ring on a leader line.
 *
 * Not inside the wedge: the slices are coloured fills across the whole ramp,
 * and one ink is illegible on some of them -- the same reason stacked segments
 * carry no inline label. Outside, on the surface, it wears text tokens and is
 * readable on every slice. Slices under 4% are left to the legend and the
 * tooltip, because their labels would collide with their neighbours' and a
 * collided label is worse than an absent one.
 */
/**
 * A slice's value, shortened, outside the ring.
 *
 * A render function rather than a props object with `formatter`. Recharts
 * honours `formatter` on `LabelList`; on a Pie's `label` it does not, and the
 * object is handed to the default renderer which prints the raw number. The
 * live dashboard showed 8943372.46 beside a bar chart correctly reading 10L,
 * which is what that difference looks like.
 *
 * Not inside the wedge: the slices run the whole ramp and one ink is illegible
 * on some of them, the same reason stacked segments carry no inline label.
 * Outside, on the surface, it wears text tokens and is readable on every
 * slice.
 *
 * Slices under a twentieth are skipped. Their labels collide with their
 * neighbours' and a collided label is worse than an absent one -- the legend
 * and the tooltip still carry them.
 */
function pieLabel(props: unknown): React.ReactNode {
  const { x, y, value, percent, textAnchor } = props as {
    x?: number;
    y?: number;
    value?: number;
    percent?: number;
    textAnchor?: 'start' | 'middle' | 'end';
  };
  const text = pieSliceLabel(value, percent);
  if (x === undefined || y === undefined || text === null) return null;
  return (
    <text
      x={x}
      y={y}
      textAnchor={textAnchor ?? 'middle'}
      dominantBaseline="central"
      className="hidden tabular-nums sm:block"
      fill="var(--muted-foreground)"
      fontSize={11}
    >
      {text}
    </text>
  );
}

export function ReportChart({ reportKey, rows, animate, compare }: { reportKey: ReportKey; rows: readonly ChartRow[]; animate: boolean; compare?: { rows: readonly ChartRow[]; label: string } }) {
  if (rows.length === 0) return null;
  const motion = { isAnimationActive: animate, animationDuration: CHART_INTRO_MS } as const;

  switch (reportKey) {
    case 'sales-analysis': {
      const { points, insight } = salesAnalysisSeries(rows);
      if (points.length === 0) return null;
      // Period-over-period wears the matrix's grouped form: current solid,
      // comparison muted. The share radial stays single-period — a share is
      // already a comparison within its own whole.
      const prevByLabel = new Map(
        compare === undefined ? [] : salesAnalysisSeries(compare.rows).points.map((point) => [point.label, point.value]),
      );
      const data = points.map((point) =>
        compare === undefined ? point : { ...point, compare: prevByLabel.get(point.label) ?? 0 },
      );
      const config =
        compare === undefined
          ? VALUE_CONFIG
          : ({ ...VALUE_CONFIG, compare: { label: compare.label, color: 'var(--muted-foreground)' } } satisfies ChartConfig);
      return (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartCard title="Where the value sits" insight={insight}>
            <ChartContainer config={config} className="h-72 w-full overflow-hidden">
              {/* Angled, like the item charts below: a party name is as long as
                  an item name, and `interval={0}` with eight of them straight
                  across a 360px axis renders one smear. */}
              <BarChart data={data} margin={AXIS_MARGIN_ANGLED}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickFormatter={truncateTight} {...ANGLED_CATEGORY} />
                <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={formatMoneyShort} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {compare !== undefined ? <ChartLegend content={<ChartLegendContent />} /> : null}
                <Bar dataKey="value" fill="var(--color-value)" maxBarSize={16} {...motion} >
                  <LabelList {...valueCaps('value', formatMoneyShort)} />
                </Bar>
                {compare !== undefined ? (
                  <Bar dataKey="compare" fill="var(--color-compare)" fillOpacity={0.55} maxBarSize={16} {...motion}>
                    <LabelList {...valueCaps('compare', formatMoneyShort)} />
                  </Bar>
                ) : null}
              </BarChart>
            </ChartContainer>
          </ChartCard>
          <ShareRadialChart rows={rows} labelKey="label" valueKey="value" title="Share of the total" animate={animate} />
        </div>
      );
    }
    case 'movement-analysis': {
      const { points, insight } = movementSeries(rows);
      if (points.length === 0) return null;
      return (
        <ChartCard title="Inward against outward" insight={insight}>
          <ChartContainer config={MOVEMENT_CONFIG} className="h-72 w-full overflow-hidden">
            <BarChart data={[...points]} margin={AXIS_MARGIN}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} width={56} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="inward" fill="var(--color-inward)" maxBarSize={16} {...motion} >
                <LabelList {...valueCaps('inward', compactCount)} />
              </Bar>
              <Bar dataKey="outward" fill="var(--color-outward)" maxBarSize={16} {...motion} >
                <LabelList {...valueCaps('outward', compactCount)} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>
      );
    }
    case 'item-velocity': {
      const { points, insight } = velocitySeries(rows);
      if (points.length === 0) return null;
      return (
        <ChartCard title="The pace, year against quarter" insight={insight}>
          <ChartContainer config={VELOCITY_CONFIG} className="h-72 w-full overflow-hidden">
            <BarChart data={[...points]} margin={AXIS_MARGIN_ANGLED}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="item" tickLine={false} axisLine={false} tickFormatter={truncateTight} {...ANGLED_CATEGORY} />
              <YAxis tickLine={false} axisLine={false} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="monthly12" fill="var(--color-monthly12)" maxBarSize={16} {...motion} >
                <LabelList {...valueCaps('monthly12', compactCount)} />
              </Bar>
              <Bar dataKey="monthly3" fill="var(--color-monthly3)" maxBarSize={16} {...motion} >
                <LabelList {...valueCaps('monthly3', compactCount)} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>
      );
    }
    case 'stock-ageing': {
      const { points, insight } = ageingSeries(rows);
      if (points.length === 0) return null;
      return (
        <ChartCard title="How long the shelf has held it" insight={insight}>
          <ChartContainer config={AGEING_CONFIG} className="h-72 w-full overflow-hidden">
            <BarChart data={[...points]} margin={AXIS_MARGIN_ANGLED}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="item" tickLine={false} axisLine={false} tickFormatter={truncateTight} {...ANGLED_CATEGORY} />
              <YAxis tickLine={false} axisLine={false} width={48} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="bucket0" stackId="age" fill="var(--color-bucket0)" maxBarSize={16} {...motion} />
              <Bar dataKey="bucket31" stackId="age" fill="var(--color-bucket31)" maxBarSize={16} {...motion} />
              <Bar dataKey="bucket61" stackId="age" fill="var(--color-bucket61)" maxBarSize={16} {...motion} />
              <Bar dataKey="bucket90" stackId="age" fill="var(--color-bucket90)" maxBarSize={16} {...motion} >
                <LabelList {...stackTotal([...points], ['bucket0', 'bucket31', 'bucket61', 'bucket90'])} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>
      );
    }
    case 'customer-lapse': {
      const { points, insight } = lapseSeries(rows);
      if (points.length === 0) return null;
      // One bar per customer; the state decides which series carries it, so
      // the legend and the colours say lapsed against at-risk without a
      // second axis.
      const data = points.map((p) => ({
        customer: p.customer,
        lapsedRevenue: p.state === 'LAPSED' ? p.revenue : 0,
        atRiskRevenue: p.state === 'AT_RISK' ? p.revenue : 0,
      }));
      return (
        <ChartCard title="Revenue going quiet" insight={insight}>
          <ChartContainer config={LAPSE_CONFIG} className="h-72 w-full overflow-hidden">
            <BarChart data={data} margin={AXIS_MARGIN_ANGLED}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="customer" tickLine={false} axisLine={false} tickFormatter={truncateTight} {...ANGLED_CATEGORY} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={formatMoneyShort} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="lapsedRevenue" stackId="risk" fill="var(--color-lapsedRevenue)" maxBarSize={16} {...motion} />
              <Bar dataKey="atRiskRevenue" stackId="risk" fill="var(--color-atRiskRevenue)" maxBarSize={16} {...motion} >
                <LabelList {...stackTotal(data, ['lapsedRevenue', 'atRiskRevenue'], formatMoneyShort)} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>
      );
    }
    case 'stock-summary':
      return (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ShareRadialChart rows={rows} labelKey="item" valueKey="value" title="Share of stock value" animate={animate} />
          <GenericReportChart reportKey="stock-summary" definition={{ columns: [{ key: 'item', header: 'Item', type: 'text' }, { key: 'value', header: 'Value at cost', type: 'text' }], defaultSort: '-value' }} rows={rows} animate={animate} />
        </div>
      );
    default:
      return null;
  }
}

/** The dashboard's calendar chart: value per month in month order, one hue. */
export function MonthlyValueChart({ points, animate }: { points: readonly { label: string; value: number }[]; animate: boolean }) {
  if (points.length === 0) return null;
  return (
    <ChartContainer config={VALUE_CONFIG} className="h-72 w-full overflow-hidden">
      <BarChart data={[...points]} margin={AXIS_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} />
        <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={formatMoneyShort} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="value" fill="var(--color-value)" maxBarSize={16} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} >
          <LabelList {...valueCaps('value', formatMoneyShort)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** The five identity slots of the theme's ramp, in fixed order (dataviz: never cycled). */
/* Slices, not ramp shades: five wedges of one hue read as one wedge with
   seams in it, and the reader goes to the legend for every slice. */
const SHARE_FILLS = ['var(--slice-1)', 'var(--slice-2)', 'var(--slice-3)', 'var(--slice-4)', 'var(--slice-5)'] as const;

/**
 * The top five as rings of one whole (the shadcn radial pattern, via the
 * MCP examples): each ring's length is its share of everything the page
 * shows. Five rings at most, so the fixed ramp is never cycled.
 */
export function ShareRadialChart({ rows, labelKey, valueKey, title, animate }: { rows: readonly ChartRow[]; labelKey: string; valueKey: string; title: string; animate: boolean }) {
  const { points, total } = shareSeries(rows, labelKey, valueKey);
  if (points.length < 2 || total <= 0) return null;
  const config = Object.fromEntries([
    ['value', { label: 'Share' }],
    ...points.map((p, index) => [`s${String(index)}`, { label: p.label, color: SHARE_FILLS[index % SHARE_FILLS.length] }]),
  ]) as ChartConfig;
  /* `slice` is the config's own key. ChartLegendContent looks the label up by
     nameKey and renders `itemConfig?.label` with no fallback, so pointing it
     at `name` -- a party name that is not a config key -- printed a swatch
     with nothing beside it. The tooltip keeps `name`, which does fall back. */
  const data = points.map((p, index) => ({ name: p.label, slice: `s${String(index)}`, value: p.share, fill: `var(--color-s${String(index)})` }));
  return (
    <ChartCard title={title} insight={`${points[0]?.label ?? ''} holds ${String(points[0]?.share ?? 0)}% of what this page shows.`}>
      <ChartContainer config={config} className="mx-auto h-72 w-full overflow-hidden">
        <RadialBarChart data={data} innerRadius={28} outerRadius={104}>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="name" />} />
          <RadialBar dataKey="value" background isAnimationActive={animate} animationDuration={CHART_INTRO_MS}>
            {/* The legend names the rings; the share itself was readable only
                by hovering. */}
            <LabelList dataKey="value" position="insideStart" className="fill-background" fontSize={10} formatter={sharePercent} />
          </RadialBar>
          <ChartLegend content={<ChartLegendContent nameKey="slice" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
        </RadialBarChart>
      </ChartContainer>
    </ChartCard>
  );
}

const GENERIC_FILLS = ['var(--chart-1)', 'var(--chart-2)'] as const;
/** The heatmap's six shades: nothing, then the theme's sequential ramp light to dark. */
const HEAT_STEPS = ['bg-muted', 'bg-[var(--chart-1)]', 'bg-[var(--chart-2)]', 'bg-[var(--chart-3)]', 'bg-[var(--chart-4)]', 'bg-[var(--chart-5)]'] as const;

/**
 * Any report, drawn: the first text column names the bars, the report's own
 * sort sizes them, in the table's order. The honest fallback behind the
 * Table | Chart | Both toggle — a report genericSeries refuses stays a table.
 */
/** What a clicked segment hands back for the drill (data-analyst skill §5). */
export interface ChartDrill {
  readonly categoryKey: string;
  readonly category: string;
  readonly rowId: string | null;
}

export function GenericReportChart({ reportKey, definition, rows, animate, compare, onDrill, form, title, action, wide, footnote }: { reportKey: ReportKey; definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>; rows: readonly ChartRow[]; animate: boolean; compare?: { rows: readonly ChartRow[]; label: string }; onDrill?: (drill: ChartDrill) => void; form?: GenericChartForm; title?: string; action?: ReactNode; wide?: boolean; footnote?: ReactNode }) {
  // A dashboard tile may pin a form. The resolved spec keeps the category and
  // series keys the resolver worked out; only the shape of the drawing moves.
  const resolved = resolveChartForm(reportKey, definition, rows);
  const spec = resolved === null || form === undefined ? resolved : { ...resolved, form };
  if (spec === null) {
    // Tile mode: the card stands and points at the table. The shell passes no
    // title and keeps its bare null -- its table is already on the screen.
    if (title === undefined) return null;
    return (
      <ChartCard title={title} action={action} wide={wide} footnote={footnote}>
        <p className="text-muted-foreground py-8 text-sm">
          This report reads as a table. Open it to see the rows.
        </p>
      </ChartCard>
    );
  }
  if (spec.form !== 'hbar') return <FormChart spec={spec} definition={definition} rows={rows} animate={animate} compare={compare} onDrill={onDrill} title={title} action={action} wide={wide} footnote={footnote} footnote={footnote} />;
  const series = genericSeries(definition, rows);
  if (series === null) return cannotWear('bar', title, action, wide, footnote);
  const first = series.series[0];
  // The comparison series joins by category and renders muted beside the
  // current one — current solid, past quiet (data-analyst skill §3).
  const prevByCategory = new Map<string, number>();
  if (compare !== undefined && first !== undefined) {
    const prev = genericSeries(definition, compare.rows);
    for (const point of prev?.points ?? []) prevByCategory.set(String(point.category), Number(point[first.key] ?? 0));
  }
  const withPrev = compare !== undefined && first !== undefined;
  const data = series.points.map((point) => (withPrev ? { ...point, compare: prevByCategory.get(String(point.category)) ?? 0 } : point));
  const config = Object.fromEntries([
    ...series.series.map((s, index) => [s.key, { label: s.label, color: GENERIC_FILLS[index % GENERIC_FILLS.length] }]),
    ...(withPrev ? [['compare', { label: compare.label, color: 'var(--muted-foreground)' }]] : []),
  ]) as ChartConfig;
  return (
    <ChartCard title={title ?? `Top rows by ${humaniseEnum(series.series[0]?.label ?? 'value').toLowerCase()}`} action={action} wide={wide} footnote={footnote} insight={null}>
      <ChartContainer config={config} className="h-80 w-full overflow-hidden">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 56, top: 4 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={compactIndian} />
          {/* Tighter than the 14-char default and a wider gutter: at 120px a
              fourteen-character name wrapped onto a second line, so every long
              customer read as two stacked fragments. One line, or it is not a
              tick label. */}
          <YAxis type="category" dataKey="category" tickLine={false} axisLine={false} width={140} tickFormatter={truncateTight} interval={0} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.series.length > 1 || withPrev ? <ChartLegend content={<ChartLegendContent />} /> : null}
          {withPrev ? (
            <Bar dataKey="compare" fill="var(--color-compare)" maxBarSize={12} fillOpacity={0.55} isAnimationActive={animate} animationDuration={CHART_INTRO_MS}>
              <LabelList {...valueTips('compare')} />
            </Bar>
          ) : null}
          {series.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={`var(--color-${s.key})`}
              maxBarSize={12}
              isAnimationActive={animate}
              animationDuration={CHART_INTRO_MS}
              className={onDrill === undefined ? undefined : 'cursor-pointer'}
              onClick={(entry: { payload?: Record<string, unknown> }) => {
                const payload = entry.payload ?? {};
                if (typeof payload.category !== 'string' || payload.category === '') return;
                onDrill?.({
                  categoryKey: series.categoryKey,
                  category: payload.category,
                  rowId: typeof payload.__rowId === 'string' && payload.__rowId !== '' ? payload.__rowId : null,
                });
              }}
            >
              <LabelList {...valueTips(s.key)} />
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/**
 * A tile that cannot draw must still stand: the board is a grid of the
 * person's choices, and a choice that silently vanishes reads as a blank
 * board with no way back -- which is exactly how it shipped, once, with a
 * pinned form the rows could not wear. Bare null is reserved for the report
 * shell, which draws its table beside the chart and loses nothing.
 */
function cannotWear(form: string, title: string | undefined, action: ReactNode, wide: boolean | undefined, footnote?: ReactNode): ReactNode {
  if (title === undefined) return null;
  return (
    <ChartCard title={title} action={action} wide={wide} footnote={footnote}>
      <p className="text-muted-foreground py-8 text-sm">
        These rows cannot wear the {form} chart. Open the report to see them, or set the tile back to Automatic.
      </p>
    </ChartCard>
  );
}

/** The non-bar generic forms: a line through time, or a donut of composition. */
function FormChart({ spec, definition, rows, animate, compare, onDrill, title, action, wide, footnote }: { spec: NonNullable<ReturnType<typeof resolveChartForm>>; definition: Pick<ReportDefinition, 'columns' | 'defaultSort'>; rows: readonly ChartRow[]; animate: boolean; compare?: { rows: readonly ChartRow[]; label: string }; onDrill?: (drill: ChartDrill) => void; title?: string; action?: ReactNode; wide?: boolean; footnote?: ReactNode }) {
  const points = formSeries(spec, rows);
  if (points.length === 0) return cannotWear(spec.form, title, action, wide, footnote);
  const headers = new Map(definition.columns.map((c) => [c.key, c.header]));

  if (spec.form === 'pareto') {
    const points = paretoSeries(rows, spec.category);
    if (points.length === 0) return cannotWear('pareto', title, action, wide, footnote);
    const noun = spec.noun ?? 'rows';
    const measure = spec.measure ?? 'total';
    const config = {
      sharePct: { label: 'Share', color: 'var(--chart-1)' },
      cumulativePct: { label: 'Running total', color: 'var(--chart-2)' },
    } satisfies ChartConfig;
    return (
      <ChartCard title={title ?? 'Concentration'} action={action} wide={wide} footnote={footnote} insight={paretoInsight(points, noun, measure)}>
        <ChartContainer config={config} className="h-80 w-full overflow-hidden">
          {/* One axis, in per cent, for both series. A Pareto is classically
              drawn with value on the left and per cent on the right; two
              scales on one chart is the mistake this product does not make,
              and the money is in the table beside it. */}
          <ComposedChart data={[...points]} margin={{ left: 0, right: 16, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="category" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 13)}…` : value)} />
            <YAxis tickLine={false} axisLine={false} width={40} domain={[0, 100]} tickFormatter={(value: number) => `${String(value)}%`} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {/* The two lines a reader actually looks for. */}
            <ReferenceLine y={50} stroke="var(--muted-foreground)" strokeDasharray="3 3" strokeOpacity={0.6} />
            <ReferenceLine y={80} stroke="var(--muted-foreground)" strokeDasharray="3 3" strokeOpacity={0.6} />
            <Bar dataKey="sharePct" fill="var(--color-sharePct)" maxBarSize={16} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
            <Line dataKey="cumulativePct" stroke="var(--color-cumulativePct)" strokeWidth={2} dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
          </ComposedChart>
        </ChartContainer>
      </ChartCard>
    );
  }

  if (spec.form === 'line') {
    const config = Object.fromEntries([
      ...spec.series.map((key, index) => [key, { label: headers.get(key) ?? key, color: GENERIC_FILLS[index % GENERIC_FILLS.length] }]),
      ...(compare ? [['compare', { label: compare.label, color: 'var(--muted-foreground)' }]] : []),
    ]) as ChartConfig;
    const prev = compare ? formSeries(spec, compare.rows) : [];
    const firstKey = spec.series[0] ?? '';
    // The comparison walks the same span shifted, so it joins by position, not by date.
    const data = points.map((point, index) => (compare ? { ...point, compare: Number(prev[index]?.[firstKey] ?? 0) } : point));
    return (
      <ChartCard title={title ?? `${headers.get(firstKey) ?? 'Value'} over time`} action={action} wide={wide} footnote={footnote} insight={null}>
        <ChartContainer config={config} className="h-72 w-full overflow-hidden">
          <LineChart data={data} margin={{ left: 0, right: 24, top: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="category" tickLine={false} axisLine={false} minTickGap={24} />
            <YAxis tickLine={false} axisLine={false} width={64} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {spec.series.length > 1 || compare ? <ChartLegend content={<ChartLegendContent />} /> : null}
            {compare ? <Line dataKey="compare" stroke="var(--color-compare)" strokeDasharray="4 4" strokeWidth={2} dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} /> : null}
            {spec.series.map((key) => (
              <Line key={key} dataKey={key} stroke={`var(--color-${key})`} strokeWidth={2} dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
            ))}
          </LineChart>
        </ChartContainer>
      </ChartCard>
    );
  }

  if (spec.form === 'scatter') {
    const [xKey = 'x', yKey = 'y'] = spec.series;
    const config = { [yKey]: { label: headers.get(yKey) ?? yKey, color: 'var(--chart-1)' } } as ChartConfig;
    return (
      <ChartCard title={title ?? `${headers.get(xKey) ?? xKey} against ${(headers.get(yKey) ?? yKey).toLowerCase()}`} action={action} wide={wide} footnote={footnote} insight={null}>
        <ChartContainer config={config} className="h-80 w-full overflow-hidden">
          <ScatterChart margin={{ left: 0, right: 24, top: 8 }}>
            <CartesianGrid />
            <XAxis type="number" dataKey={xKey} name={headers.get(xKey) ?? xKey} tickLine={false} axisLine={false} />
            <YAxis type="number" dataKey={yKey} name={headers.get(yKey) ?? yKey} tickLine={false} axisLine={false} width={64} />
            <ChartTooltip cursor={{ strokeDasharray: '4 4' }} content={<ChartTooltipContent labelKey="category" nameKey="category" />} />
            <Scatter
              data={points}
              fill="var(--chart-1)"
              fillOpacity={0.7}
              isAnimationActive={animate}
              animationDuration={CHART_INTRO_MS}
              className={onDrill === undefined ? undefined : 'cursor-pointer'}
              onClick={(entry: { payload?: Record<string, unknown> }) => {
                const item = entry.payload?.__item;
                if (typeof item !== 'string' || item === '') return;
                onDrill?.({ categoryKey: 'item', category: item, rowId: null });
              }}
            />
          </ScatterChart>
        </ChartContainer>
      </ChartCard>
    );
  }

  if (spec.form === 'radials') {
    const [rateKey = 'rate'] = spec.series;
    return (
      <ChartCard title={title ?? `${headers.get(rateKey) ?? 'Rate'} by ${humaniseEnum(headers.get(spec.category) ?? spec.category).toLowerCase()}`} action={action} wide={wide} footnote={footnote} insight={null}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {points.map((point) => (
            <Button
              key={String(point.category)}
              variant="ghost"
              className={cn('h-auto min-w-0 flex-col items-stretch p-0 text-left', onDrill === undefined ? 'cursor-default' : 'cursor-pointer')}
              aria-label={`${String(point.category)}: ${String(point[rateKey] ?? 0)}%`}
              onClick={() => {
                onDrill?.({ categoryKey: spec.category, category: String(point.category), rowId: typeof point.__rowId === 'string' && point.__rowId !== '' ? point.__rowId : null });
              }}
            >
              <RateRadial pct={Number(point[rateKey] ?? 0)} label={String(point.category)} animate={animate} />
            </Button>
          ))}
        </div>
      </ChartCard>
    );
  }

  if (spec.form === 'heatmap') {
    const [valueKey = 'value'] = spec.series;
    const grid = heatmapGrid(points, valueKey);
    if (grid.months.length === 0 || grid.rows.length === 0) return cannotWear('heatmap', title, action, wide, footnote);
    return (
      <ChartCard title={title ?? `${headers.get(valueKey) ?? 'Value'} by ${humaniseEnum(headers.get(spec.category) ?? spec.category).toLowerCase()} and month`} action={action} wide={wide} footnote={footnote} insight={null}>
        <div className="overflow-x-auto">
          <Table className="w-auto min-w-full border-separate border-spacing-0.5 text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground sticky left-0 bg-background h-7 pr-2 text-left font-normal">
                  {humaniseEnum(headers.get(spec.category) ?? spec.category)}
                </TableHead>
                {grid.months.map((month) => (
                  <TableHead key={month} className="text-muted-foreground h-7 min-w-12 text-center font-normal tabular-nums">
                    {month.slice(5)}/{month.slice(2, 4)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {grid.rows.map((row) => (
                <TableRow key={row.category} className="hover:bg-transparent">
                  <TableHead scope="row" className="sticky left-0 bg-background h-7 max-w-40 truncate pr-2 text-left font-normal">
                    {row.category}
                  </TableHead>
                  {row.cells.map((value, index) => (
                    <TableCell key={grid.months[index]} className="h-7 p-0">
                      <Button
                        variant="ghost"
                        aria-label={`${row.category}, ${grid.months[index] ?? ''}: ${value === null ? 'nothing' : value.toLocaleString('en-IN')}`}
                        title={value === null ? '' : value.toLocaleString('en-IN')}
                        className={cn('block h-7 w-full min-w-12 rounded-none p-0', HEAT_STEPS[heatmapStep(value, grid.max)], onDrill === undefined ? 'cursor-default' : 'cursor-pointer')}
                        onClick={() => {
                          onDrill?.({ categoryKey: spec.category, category: row.category, rowId: row.rowId === '' ? null : row.rowId.split(':')[0] ?? null });
                        }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </ChartCard>
    );
  }

  // donut: five slices plus Other, the fixed ramp in order, labels in the legend
  const config = Object.fromEntries([
    ['value', { label: headers.get(spec.series[0] ?? '') ?? 'Value' }],
    ...points.map((p, index) => [`slice${String(index)}`, { label: String(p.category), color: index < 5 ? SHARE_FILLS[index] : 'var(--muted-foreground)' }]),
  ]) as ChartConfig;
  const data = points.map((p, index) => ({ name: String(p.category), slice: `slice${String(index)}`, value: Number(p.value ?? 0), fill: `var(--color-slice${String(index)})` }));
  return (
    <ChartCard title={title ?? 'Composition'} action={action} wide={wide} footnote={footnote} insight={null}>
      <ChartContainer config={config} className="mx-auto h-72 w-full overflow-hidden">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="name" />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={56}
            strokeWidth={2}
            label={pieLabel}
            labelLine={{ stroke: 'var(--border)' }}
            isAnimationActive={animate}
            animationDuration={CHART_INTRO_MS}
            className={onDrill === undefined ? undefined : 'cursor-pointer'}
            onClick={(entry: { name?: unknown }) => {
              // 'Other' is a fold, not a value the filter can hold.
              if (typeof entry.name !== 'string' || entry.name === '' || entry.name === 'Other') return;
              onDrill?.({ categoryKey: spec.category, category: entry.name, rowId: null });
            }}
          />
          <ChartLegend content={<ChartLegendContent nameKey="slice" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
        </PieChart>
      </ChartContainer>
    </ChartCard>
  );
}

/** A composition donut for any labelled value set: five slices plus Other, the ramp in fixed order. */
export function CompositionDonut({ rows, labelKey, valueKey, animate }: { rows: readonly ChartRow[]; labelKey: string; valueKey: string; animate: boolean }) {
  const points = formSeries({ form: 'donut', category: labelKey, series: [valueKey] }, rows);
  if (points.length < 2) return null;
  const config = Object.fromEntries([
    ['value', { label: 'Value' }],
    ...points.map((p, index) => [`slice${String(index)}`, { label: String(p.category), color: index < 5 ? SHARE_FILLS[index] : 'var(--muted-foreground)' }]),
  ]) as ChartConfig;
  const data = points.map((p, index) => ({ name: String(p.category), slice: `slice${String(index)}`, value: Number(p.value ?? 0), fill: `var(--color-slice${String(index)})` }));
  return (
    <ChartContainer config={config} className="mx-auto h-72 w-full overflow-hidden">
      <PieChart>
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="name" />} />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={56} strokeWidth={2} label={pieLabel} labelLine={{ stroke: 'var(--border)' }} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
        <ChartLegend content={<ChartLegendContent nameKey="slice" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
      </PieChart>
    </ChartContainer>
  );
}

/**
 * One rate as one ring (the shadcn radial-text pattern): the arc is the
 * percentage, the number sits in the middle. For fulfilment, collection
 * against target — anything that reads "how much of the whole happened".
 */
export function RateRadial({ pct, label, animate }: { pct: number; label: string; animate: boolean }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const config = { value: { label, color: clamped >= 90 ? 'var(--success)' : clamped >= 60 ? 'var(--info)' : 'var(--warning)' } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="mx-auto aspect-square max-h-52 w-full">
      <RadialBarChart data={[{ name: label, value: clamped, fill: 'var(--color-value)' }]} startAngle={90} endAngle={90 - (clamped / 100) * 360} innerRadius={70} outerRadius={88}>
        <PolarGrid gridType="circle" radialLines={false} stroke="none" className="first:fill-muted last:fill-background" polarRadius={[74, 66]} />
        <RadialBar dataKey="value" background isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
        <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
          <Label
            content={({ viewBox }) => {
              if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                return (
                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-bold">
                      {String(clamped)}%
                    </tspan>
                    <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 22} className="fill-muted-foreground text-xs">
                      {label}
                    </tspan>
                  </text>
                );
              }
              return null;
            }}
          />
        </PolarRadiusAxis>
      </RadialBarChart>
    </ChartContainer>
  );
}
