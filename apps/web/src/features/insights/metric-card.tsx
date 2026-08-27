import { useId, useMemo, type ReactNode } from 'react';
import { InfoIcon } from '@phosphor-icons/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarRadiusAxis,
  RadialBar,
  RadialBarChart,
  XAxis,
  YAxis,
} from 'recharts';
import type { WidgetKind, WidgetPalette } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HeatmapTable } from '@/components/shared/heatmap-table';
import { heatGridOf } from '@/components/shared/heat-grid';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { Metric } from './api';
import { CHART_PALETTES } from './catalogue';
import { formatCell, formatHeadline, formatTick } from './units';

/** The series the options keep, in the metric's own order. */
function keptSeries(metric: Metric, options: ChartOptions): Metric['series'] {
  const chosen = options.series;
  if (chosen === undefined || chosen.length === 0) return metric.series;
  const kept = metric.series.filter((s) => chosen.includes(s.key));
  return kept.length > 0 ? kept : metric.series;
}

/**
 * The metric card and its charts (owner, 26 Aug 2026, revised on review):
 * distinct fresh colours rather than one hue in shades -- the gradation made
 * stacked series read as one smear -- real ticks on both axes, the value on
 * the mark where the marks are few enough to carry one, and translucent
 * fills, the way the Supabase dashboards draw load.
 *
 * The default palette is the slice set: five fresh hues walked from the
 * workspace accent, green skipped (standing owner rule). A widget may choose
 * a named family instead; the states that mean trouble -- FAILED, ABSENT,
 * REJECTED -- wear destructive whatever palette is on, because red means one
 * thing everywhere or it means nothing.
 */

export interface ChartOptions {
  readonly legend?: boolean;
  readonly dataLabels?: boolean;
  readonly palette?: WidgetPalette;
  readonly omitZero?: boolean;
  readonly yMin?: number;
  readonly yMax?: number;
  /** How a line or area bends between points. */
  readonly curve?: 'linear' | 'smooth' | 'step';
  /** Dots on line and area points. */
  readonly points?: boolean;
  /** Stack multi-series bars; off draws them grouped side by side. */
  readonly stacked?: boolean;
  /** Horizontal grid lines behind the plot. */
  readonly grid?: boolean;
  readonly xTitle?: string;
  readonly yTitle?: string;
  /** Only these series drawn; absent means all. */
  readonly series?: readonly string[];
  /** Bar order along x: as the data comes, or ranked by total value. */
  readonly xOrder?: 'natural' | 'asc' | 'desc';
  /**
   * Rotates a single-series chart's colour through the palette, so a page of
   * one-series cards is not a page of one colour -- one chart, one shade
   * (owner, 26 Aug 2026). Multi-series charts ignore it: their colours are
   * identities and must not move.
   */
  readonly colourIndex?: number;
}

const CURVES = { linear: 'linear', smooth: 'monotone', step: 'stepAfter' } as const;

const TROUBLE_KEYS = new Set(['FAILED', 'ABSENT', 'REJECTED']);
const SHARP = 0;
const BAR_MAX = 20;
/**
 * Labels are on everywhere (owner, 26 Aug: every chart carries its numbers,
 * the way the reference blocks do) -- but past this many points only a
 * thinned subset prints, or a month of bars becomes soup.
 */
export const LABEL_EVERY_LIMIT = 12;
const LABEL_TARGET = 8;

function seriesColour(key: string, index: number, palette: WidgetPalette): string {
  if (TROUBLE_KEYS.has(key)) return 'var(--destructive)';
  const colours = CHART_PALETTES[palette];
  // Never cycled: a sixth identity folds into the muted ink rather than
  // repainting the first colour (dataviz non-negotiable).
  return colours[index] ?? 'var(--muted-foreground)';
}


const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const safeKeyOf = (key: string): string => (SAFE_KEY.test(key) ? key : `k_${key.replace(/[^A-Za-z0-9_-]/gu, '_')}`);

/** The same metric with series keys that are legal CSS custom-property names. */
function safeKeyed(metric: Metric): Metric {
  if (metric.series.every((s) => SAFE_KEY.test(s.key))) return metric;
  const rename = new Map(metric.series.map((s) => [s.key, safeKeyOf(s.key)]));
  return {
    ...metric,
    series: metric.series.map((s) => ({ ...s, key: rename.get(s.key) ?? s.key })),
    points: metric.points.map((point) => {
      const next: Record<string, string | number> = { t: point.t };
      for (const [key, value] of Object.entries(point)) if (key !== 't') next[rename.get(key) ?? key] = value;
      return next as Metric['points'][number];
    }),
  };
}

function chartConfigOf(metric: Metric, palette: WidgetPalette, shift = 0): ChartConfig {
  const config: ChartConfig = {};
  const colours = CHART_PALETTES[palette];
  metric.series.forEach((s, index) => {
    config[s.key] = { label: s.label, color: seriesColour(s.key, (index + shift) % colours.length, palette) };
  });
  return config;
}

/** Recharts wants numbers; money points arrive as exact text for printing. */
function numericPoints(metric: Metric, options: ChartOptions, series: Metric['series']): Record<string, string | number>[] {
  let points = metric.points.map((point) => {
    const out: Record<string, string | number> = { t: point.t };
    for (const s of series) out[s.key] = Number(point[s.key] ?? 0);
    return out;
  });
  if (options.omitZero ?? false) {
    points = points.filter((point) => series.some((s) => Number(point[s.key]) !== 0));
  }
  const order = options.xOrder ?? 'natural';
  if (order !== 'natural') {
    const totalOf = (point: Record<string, string | number>): number =>
      series.reduce((sum, s) => sum + Number(point[s.key] ?? 0), 0);
    points = [...points].sort((a, b) => (order === 'asc' ? totalOf(a) - totalOf(b) : totalOf(b) - totalOf(a)));
  }
  return points;
}

function isEmpty(metric: Metric): boolean {
  return metric.points.every((point) => metric.series.every((s) => Number(point[s.key] ?? 0) === 0));
}

/** "12 Aug" for a day axis; an ageing bucket prints itself. */
function xTick(metric: Metric, value: string): string {
  if (metric.xKind === 'category') return value;
  return formatDate(value).replace(/\s\d{4}$/u, '');
}

/** At most five x labels on a day axis, always keeping both ends. */
function xTicks(points: readonly Record<string, string | number>[], category: boolean): string[] | undefined {
  if (category) return undefined;
  const days = points.map((p) => String(p.t));
  if (days.length <= 5) return days;
  const step = (days.length - 1) / 4;
  return [0, 1, 2, 3, 4].map((i) => days[Math.round(i * step)] ?? '');
}

export function MetricChart({
  metric: rawMetric,
  kind,
  options = {},
  className,
  onActivate,
}: {
  metric: Metric;
  kind: Exclude<WidgetKind, 'number' | 'table'>;
  options?: ChartOptions;
  className?: string;
  /** R2: a bar is an entry point. Called with the point's x value. */
  onActivate?: (t: string) => void;
}) {
  const activate = onActivate === undefined
    ? undefined
    : (entry: { payload?: { t?: string | number }; t?: string | number }) => {
        const t = entry.payload?.t ?? entry.t;
        if (t !== undefined) onActivate(String(t));
      };
  const gradientId = useId();
  const palette = options.palette ?? 'default';
  // Series keys become CSS custom-property names (--color-<key>) inside
  // ChartContainer; "180+" or "0-30" would be an invalid name and the
  // series loses its colour silently. Keys are made safe here, once, for
  // the chart alone -- tables keep the originals.
  const metric = useMemo(() => safeKeyed(rawMetric), [rawMetric]);
  const series = keptSeries(metric, { ...options, ...(options.series ? { series: options.series.map(safeKeyOf) } : {}) });
  const shift = series.length === 1 ? (options.colourIndex ?? 0) : 0;
  const config = useMemo(() => chartConfigOf(metric, palette, shift), [metric, palette, shift]);
  const points = useMemo(() => numericPoints(metric, options, series), [metric, options, series]);
  const animate = useChartIntro(points.length > 0);
  const showLegend = (options.legend ?? true) && series.length > 1;
  const showLabels = options.dataLabels ?? true;
  // Which points wear a printed value: all of them up to the limit, then an
  // evenly-thinned subset that always keeps the last point.
  const labelStep = points.length <= LABEL_EVERY_LIMIT ? 1 : Math.ceil(points.length / LABEL_TARGET);
  const labelled = (index: number): boolean => index % labelStep === 0 || index === points.length - 1;
  const category = metric.xKind === 'category';
  const domain: [number | 'auto', number | 'auto'] = [options.yMin ?? 0, options.yMax ?? 'auto'];
  const lastSeries = series[series.length - 1]?.key;
  const curve = CURVES[options.curve ?? 'linear'];
  const dots = options.points ?? true;
  const stacked = options.stacked ?? true;
  const grid = options.grid ? <CartesianGrid vertical={false} strokeOpacity={0.4} /> : null;

  // The number a bar wears when labels are on: the stack's total, printed
  // once at its end rather than once per segment.
  // A zero wears no label: thirty "0"s along a baseline say nothing the
  // baseline does not.
  const totalOf = (point: Record<string, string | number>): string => {
    const total = series.reduce((sum, s) => sum + Number(point[s.key] ?? 0), 0);
    return total === 0 ? '' : formatTick(metric.unit, total);
  };
  // Grouped bars have no shared total; each series would need its own label,
  // which is clutter -- labels there mark only the last series.


  const totalLabel = (position: 'top' | 'right') => (
    <LabelList
      position={position}
      offset={6}
      className="fill-foreground"
      fontSize={10}
      valueAccessor={(entry: { payload?: Record<string, string | number> }, index: number) =>
        entry.payload && labelled(index) ? totalOf(entry.payload) : ''
      }
    />
  );

  const xAxis = (
    <XAxis
      dataKey="t"
      tickLine={false}
      axisLine={false}
      tick={{ fontSize: 11 }}
      tickMargin={6}
      interval={category ? 0 : undefined}
      ticks={xTicks(points, category)}
      tickFormatter={(value: string) => xTick(metric, value)}
      label={options.xTitle ? { value: options.xTitle, position: 'insideBottom', offset: -4, fontSize: 11 } : undefined}
    />
  );
  const yAxis = (
    <YAxis
      width={48}
      tickLine={false}
      axisLine={false}
      tick={{ fontSize: 11 }}
      tickCount={4}
      allowDecimals={false}
      domain={domain}
      tickFormatter={(value: number) => formatTick(metric.unit, value)}
      label={options.yTitle ? { value: options.yTitle, angle: -90, position: 'insideLeft', fontSize: 11 } : undefined}
    />
  );
  const tooltip = (
    <ChartTooltip
      content={
        <ChartTooltipContent
          labelFormatter={(value) => (typeof value === 'string' ? (category ? value : formatDate(value)) : '')}
        />
      }
    />
  );
  const legend = showLegend ? (
    <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
  ) : null;

  if (kind === 'donut') {
    const slices = series.map((s, index) => ({
      key: s.key,
      label: s.label,
      value: points.reduce((sum, p) => sum + Number(p[s.key] ?? 0), 0),
      fill: seriesColour(s.key, index, palette),
    }));
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="60%"
            outerRadius="86%"
            strokeWidth={2}
            stroke="var(--card)"
            isAnimationActive={animate}
          >
            {slices.map((slice) => (
              <Cell key={slice.key} fill={slice.fill} />
            ))}
          </Pie>
          {showLegend ? <ChartLegend content={<ChartLegendContent nameKey="key" />} /> : null}
        </PieChart>
      </ChartContainer>
    );
  }

  if (kind === 'heatmap') {
    // The dense-grid form (dataviz): rows are the series, columns the days
    // or buckets, colour carrying magnitude only -- Q2.15's seasonality
    // shape, on any metric. It reuses the product's own HeatmapTable.
    const grid = heatGridOf(
      points.flatMap((point) =>
        series.map((s) => ({
          month: String(point.t),
          category: s.label,
          rowId: '',
          value: Number(point[s.key] ?? 0),
        })),
      ),
    );
    return (
      <div className={className}>
        <HeatmapTable
          grid={grid}
          rowLabel=""
          format={(value) => formatTick(metric.unit, value)}
          columnLabel={(key) => xTick(metric, key)}
        />
      </div>
    );
  }

  if (kind === 'pie') {
    // shadcn "Pie Chart - Label": full pie, slice names on the slices.
    const slices = series.map((s, index) => ({
      key: s.key,
      label: s.label,
      value: points.reduce((sum, p) => sum + Number(p[s.key] ?? 0), 0),
      fill: seriesColour(s.key, index, palette),
    }));
    return (
      <ChartContainer
        config={config}
        className={cn('mx-auto aspect-square h-48 w-full min-w-0 [&_.recharts-pie-label-text]:fill-foreground', className)}
      >
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            strokeWidth={2}
            stroke="var(--card)"
            isAnimationActive={animate}
            label={
              showLabels
                ? (props: { name?: string; value?: number }) =>
                    `${props.name ?? ''} ${formatTick(metric.unit, Number(props.value ?? 0))}`
                : true
            }
          />
          {showLegend ? <ChartLegend content={<ChartLegendContent nameKey="key" />} /> : null}
        </PieChart>
      </ChartContainer>
    );
  }

  if (kind === 'radial') {
    // shadcn "Radial Chart - Text": the ring with the figure in its centre.
    // The segments are the series' range totals, the ring is their sum, so
    // the arc is a share, never a decorative angle.
    const totals = series.map((s, index) => ({
      key: s.key,
      value: points.reduce((sum, p) => sum + Number(p[s.key] ?? 0), 0),
      fill: seriesColour(s.key, index, palette),
    }));
    const ringTotal = totals.reduce((sum, t) => sum + t.value, 0);
    const datum: Record<string, number> = {};
    for (const t of totals) datum[t.key] = t.value;
    return (
      <ChartContainer config={config} className={cn('mx-auto aspect-square h-48 w-full min-w-0', className)}>
        <RadialBarChart
          data={[datum]}
          startAngle={90}
          endAngle={-270}
          innerRadius="62%"
          outerRadius="88%"
        >
          <PolarAngleAxis type="number" domain={[0, ringTotal === 0 ? 1 : ringTotal]} tick={false} />
          {totals.map((t) => (
            <RadialBar key={t.key} dataKey={t.key} stackId="ring" fill={t.fill} background={totals.length === 1} isAnimationActive={animate} />
          ))}
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <Label
              content={({ viewBox }) => {
                if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold">
                        {formatTick(metric.unit, ringTotal)}
                      </tspan>
                      <tspan x={viewBox.cx} y={(Number(viewBox.cy) || 0) + 20} className="fill-muted-foreground text-xs">
                        {metric.label}
                      </tspan>
                    </text>
                  );
                }
                return null;
              }}
            />
          </PolarRadiusAxis>
          {showLegend ? <ChartLegend content={<ChartLegendContent nameKey="key" />} /> : null}
        </RadialBarChart>
      </ChartContainer>
    );
  }

  if (kind === 'line') {
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
        <LineChart accessibilityLayer data={points} margin={{ left: 4, right: 12, top: showLabels ? 18 : 8 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type={curve}
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={dots ? { r: 2.5 } : false}
              isAnimationActive={animate}
            >
              {showLabels && series.length === 1 ? (
                <LabelList
                  dataKey={s.key}
                  position="top"
                  offset={8}
                  className="fill-foreground"
                  fontSize={10}
                  valueAccessor={(entry: { value?: unknown }, index: number) =>
                    labelled(index) && typeof entry.value === 'number' && entry.value !== 0
                      ? formatTick(metric.unit, entry.value)
                      : ''
                  }
                />
              ) : null}
            </Line>
          ))}
          {legend}
        </LineChart>
      </ChartContainer>
    );
  }

  if (kind === 'area') {
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
        <AreaChart accessibilityLayer data={points} margin={{ left: 4, right: 12, top: showLabels ? 18 : 8 }}>
          {grid}
          <defs>
            {series.map((s, index) => (
              <linearGradient key={s.key} id={`${gradientId}-${String(index)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${s.key})`} stopOpacity={0.42} />
                <stop offset="100%" stopColor={`var(--color-${s.key})`} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          {xAxis}
          {yAxis}
          {tooltip}
          {series.map((s, index) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type={curve}
              stackId={stacked && series.length > 1 ? 'a' : undefined}
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={dots && series.length === 1 ? { r: 2.5 } : false}
              fill={`url(#${gradientId}-${String(index)})`}
              isAnimationActive={animate}
            >
              {showLabels && s.key === lastSeries ? totalLabel('top') : null}
            </Area>
          ))}
          {legend}
        </AreaChart>
      </ChartContainer>
    );
  }

  if (kind === 'barh') {
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
        <BarChart
          accessibilityLayer
          data={points}
          layout="vertical"
          margin={{ left: 4, right: showLabels ? 44 : 12, top: 4 }}
          barCategoryGap="24%"
        >
          {options.grid ? <CartesianGrid horizontal={false} strokeOpacity={0.4} /> : null}
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickCount={4}
            domain={domain}
            tickFormatter={(value: number) => formatTick(metric.unit, value)}
          />
          <YAxis
            dataKey="t"
            type="category"
            width={76}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            interval={0}
            tickFormatter={(value: string) => xTick(metric, value)}
          />
          {tooltip}
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId={stacked ? 'm' : undefined}
              fill={`var(--color-${s.key})`}
              fillOpacity={0.7}
              stroke={`var(--color-${s.key})`}
              strokeWidth={1}
              maxBarSize={BAR_MAX}
              radius={SHARP}
              isAnimationActive={animate}
              onClick={activate}
              className={activate ? 'cursor-pointer' : undefined}
            >
              {showLabels && s.key === lastSeries ? totalLabel('right') : null}
            </Bar>
          ))}
          {legend}
        </BarChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
      <BarChart
        accessibilityLayer
        data={points}
        margin={{ left: 4, right: 12, top: showLabels ? 18 : 8 }}
        barCategoryGap="20%"
      >
        {grid}
        {xAxis}
        {yAxis}
        {tooltip}
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId={stacked ? 'm' : undefined}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.7}
              stroke={`var(--color-${s.key})`}
              strokeWidth={1}
            maxBarSize={BAR_MAX}
            radius={SHARP}
            isAnimationActive={animate}
            onClick={activate}
            className={activate ? 'cursor-pointer' : undefined}
          >
            {showLabels && s.key === lastSeries ? totalLabel('top') : null}
          </Bar>
        ))}
        {legend}
      </BarChart>
    </ChartContainer>
  );
}

export function MetricBreakdownTable({ metric }: { metric: Metric }) {
  const breakdown = metric.breakdown;
  if (breakdown === undefined || breakdown.rows.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto border-t pt-1">
      <Table>
        <TableHeader>
          <TableRow>
            {breakdown.columns.map((column) => (
              <TableHead key={column.key} className={cn('h-8 text-xs', column.numeric && 'text-right')}>
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {breakdown.rows.map((row, index) => (
            <TableRow key={index}>
              {breakdown.columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn('py-1.5 text-xs', column.numeric && 'text-right tabular-nums')}
                >
                  {formatCell(column.unit, row[column.key] ?? '')}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The whole series as rows: the report that is honest as a table, not a chart. */
export function MetricPointsTable({ metric }: { metric: Metric }) {
  if (metric.breakdown !== undefined && metric.breakdown.rows.length > 0) {
    return <MetricBreakdownTable metric={metric} />;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 text-xs">{metric.xKind === 'category' ? 'Bucket' : 'Day'}</TableHead>
            {metric.series.map((s) => (
              <TableHead key={s.key} className="h-8 text-right text-xs">
                {s.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {metric.points.map((point) => (
            <TableRow key={point.t}>
              <TableCell className="py-1.5 text-xs">
                {metric.xKind === 'category' ? point.t : formatDate(point.t)}
              </TableCell>
              {metric.series.map((s) => (
                <TableCell key={s.key} className="py-1.5 text-right text-xs tabular-nums">
                  {formatCell(metric.unit, point[s.key] ?? 0)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function MetricCard({
  metric,
  kind = 'bar',
  colourIndex = 0,
  action,
}: {
  metric: Metric;
  kind?: Exclude<WidgetKind, 'number' | 'table'>;
  colourIndex?: number;
  action?: ReactNode;
}) {
  return (
    <Card data-metric={metric.key} className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
          {metric.label}
          <Tooltip>
            {/* A real button, so the hint opens from the keyboard and on touch,
                not only under a pointer that can hover. */}
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`About ${metric.label}`} className="text-muted-foreground">
                  <InfoIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipContent className="max-w-72 text-pretty">{metric.hint}</TooltipContent>
          </Tooltip>
        </CardTitle>
        {/* CardAction, not a flexed header: the header is a grid that only
            makes a second column for this slot, and anything else lands in a
            row of its own below the title -- which is exactly where the
            overview's Open button was found sitting. */}
        {action !== undefined ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
          {formatHeadline(metric.unit, metric.headline)}
        </p>
        {isEmpty(metric) ? (
          <div className="text-muted-foreground flex h-48 items-center justify-center border border-dashed text-sm">
            Nothing to show in this period
          </div>
        ) : (
          <MetricChart metric={metric} kind={kind} options={{ legend: true, dataLabels: true, colourIndex }} />
        )}
        <MetricBreakdownTable metric={metric} />
      </CardContent>
    </Card>
  );
}
