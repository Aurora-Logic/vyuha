import { useId, useMemo, type ReactNode } from 'react';
import { InfoIcon } from '@phosphor-icons/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import type { WidgetKind, WidgetPalette } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { Metric } from './api';
import { formatCell, formatHeadline, formatTick } from './units';

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
}

const TROUBLE_KEYS = new Set(['FAILED', 'ABSENT', 'REJECTED']);
const SHARP = 0;
const BAR_MAX = 20;
/** Value labels stop above this many points: forty labelled bars is noise. */
export const LABEL_LIMIT = 16;

/** A single-hue family, its steps far enough apart to stay five colours. */
const family = (hue: number): string[] =>
  [0.5, 0.58, 0.66, 0.74, 0.82].map((l) => `oklch(${String(l)} 0.17 ${String(hue)})`);

const PALETTES: Record<WidgetPalette, readonly string[]> = {
  default: ['var(--slice-1)', 'var(--slice-2)', 'var(--slice-3)', 'var(--slice-4)', 'var(--slice-5)'],
  accent: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'],
  blue: family(250),
  violet: family(295),
  amber: family(75),
  rose: family(15),
  teal: family(200),
};

function seriesColour(key: string, index: number, palette: WidgetPalette): string {
  if (TROUBLE_KEYS.has(key)) return 'var(--destructive)';
  const colours = PALETTES[palette];
  // Never cycled: a sixth identity folds into the muted ink rather than
  // repainting the first colour (dataviz non-negotiable).
  return colours[index] ?? 'var(--muted-foreground)';
}

function chartConfigOf(metric: Metric, palette: WidgetPalette): ChartConfig {
  const config: ChartConfig = {};
  metric.series.forEach((s, index) => {
    config[s.key] = { label: s.label, color: seriesColour(s.key, index, palette) };
  });
  return config;
}

/** Recharts wants numbers; money points arrive as exact text for printing. */
function numericPoints(metric: Metric, omitZero: boolean): Record<string, string | number>[] {
  const points = metric.points.map((point) => {
    const out: Record<string, string | number> = { t: point.t };
    for (const s of metric.series) out[s.key] = Number(point[s.key] ?? 0);
    return out;
  });
  if (!omitZero) return points;
  return points.filter((point) => metric.series.some((s) => Number(point[s.key]) !== 0));
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
  metric,
  kind,
  options = {},
  className,
}: {
  metric: Metric;
  kind: Exclude<WidgetKind, 'number' | 'table'>;
  options?: ChartOptions;
  className?: string;
}) {
  const gradientId = useId();
  const palette = options.palette ?? 'default';
  const config = useMemo(() => chartConfigOf(metric, palette), [metric, palette]);
  const points = useMemo(() => numericPoints(metric, options.omitZero ?? false), [metric, options.omitZero]);
  const animate = useChartIntro(points.length > 0);
  const showLegend = (options.legend ?? true) && metric.series.length > 1;
  const showLabels = (options.dataLabels ?? false) && points.length <= LABEL_LIMIT;
  const category = metric.xKind === 'category';
  const domain: [number | 'auto', number | 'auto'] = [options.yMin ?? 0, options.yMax ?? 'auto'];
  const lastSeries = metric.series[metric.series.length - 1]?.key;

  // The number a bar wears when labels are on: the stack's total, printed
  // once at its end rather than once per segment.
  const totalOf = (point: Record<string, string | number>): string =>
    formatTick(metric.unit, metric.series.reduce((sum, s) => sum + Number(point[s.key] ?? 0), 0));

  const totalLabel = (position: 'top' | 'right') => (
    <LabelList
      position={position}
      offset={6}
      className="fill-foreground"
      fontSize={10}
      valueAccessor={(entry: { payload?: Record<string, string | number> }) =>
        entry.payload ? totalOf(entry.payload) : ''
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
    const slices = metric.series.map((s, index) => ({
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

  if (kind === 'line') {
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-48 w-full min-w-0', className)}>
        <LineChart accessibilityLayer data={points} margin={{ left: 4, right: 12, top: showLabels ? 18 : 8 }}>
          {xAxis}
          {yAxis}
          {tooltip}
          {metric.series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="linear"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              dot={{ r: 2.5 }}
              isAnimationActive={animate}
            >
              {showLabels && metric.series.length === 1 ? (
                <LabelList
                  dataKey={s.key}
                  position="top"
                  offset={8}
                  className="fill-foreground"
                  fontSize={10}
                  formatter={(value: unknown) => (typeof value === 'number' ? formatTick(metric.unit, value) : '')}
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
          <defs>
            {metric.series.map((s, index) => (
              <linearGradient key={s.key} id={`${gradientId}-${String(index)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={`var(--color-${s.key})`} stopOpacity={0.35} />
                <stop offset="100%" stopColor={`var(--color-${s.key})`} stopOpacity={0.04} />
              </linearGradient>
            ))}
          </defs>
          {xAxis}
          {yAxis}
          {tooltip}
          {metric.series.map((s, index) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="linear"
              stackId={metric.series.length > 1 ? 'a' : undefined}
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
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
          {metric.series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="m"
              fill={`var(--color-${s.key})`}
              fillOpacity={0.88}
              maxBarSize={BAR_MAX}
              radius={SHARP}
              isAnimationActive={animate}
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
        {xAxis}
        {yAxis}
        {tooltip}
        {metric.series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="m"
            fill={`var(--color-${s.key})`}
            fillOpacity={0.88}
            maxBarSize={BAR_MAX}
            radius={SHARP}
            isAnimationActive={animate}
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
  action,
}: {
  metric: Metric;
  kind?: Exclude<WidgetKind, 'number' | 'table'>;
  action?: ReactNode;
}) {
  return (
    <Card data-metric={metric.key}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
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
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">
          {formatHeadline(metric.unit, metric.headline)}
        </p>
        {isEmpty(metric) ? (
          <div className="text-muted-foreground flex h-48 items-center justify-center border border-dashed text-sm">
            Nothing to show in this period
          </div>
        ) : (
          <MetricChart metric={metric} kind={kind} options={{ legend: true, dataLabels: true }} />
        )}
        <MetricBreakdownTable metric={metric} />
      </CardContent>
    </Card>
  );
}
