import { useId, useMemo, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts';
import type { WidgetKind } from '@vyuha/shared';

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
import { InfoIcon } from '@phosphor-icons/react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChartIntro } from '@/components/shared/use-chart-motion';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { Metric } from './api';
import { formatCell, formatHeadline, formatTick } from './units';

/**
 * The metric card (owner, 26 Aug 2026, from the Supabase reference): title
 * with its hint, the headline figure, the day-bucketed chart, the period's
 * edges under it, and sometimes a breakdown table. Presentational only --
 * everything it prints arrived computed from the API.
 *
 * Colour holds the house line: bars and areas wear the accent ramp
 * (--chart-N), a donut wears the slice palette, and the two states that mean
 * trouble -- FAILED, ABSENT -- wear --destructive whatever series position
 * they land in, because red means the same thing everywhere or it means
 * nothing (CLAUDE.md §3 rule 4).
 */

const TROUBLE_KEYS = new Set(['FAILED', 'ABSENT', 'REJECTED']);
const SHARP = 0;
const BAR_MAX = 18;

function seriesColour(key: string, index: number): string {
  if (TROUBLE_KEYS.has(key)) return 'var(--destructive)';
  // Never cycled: a sixth identity folds into the muted ink rather than
  // repainting the first shade (dataviz non-negotiable).
  return index < 5 ? `var(--chart-${String(index + 1)})` : 'var(--muted-foreground)';
}

function chartConfigOf(metric: Metric): ChartConfig {
  const config: ChartConfig = {};
  metric.series.forEach((s, index) => {
    config[s.key] = { label: s.label, color: seriesColour(s.key, index) };
  });
  return config;
}

/** Recharts wants numbers; money points arrive as exact text for printing. */
function numericPoints(metric: Metric): Record<string, string | number>[] {
  return metric.points.map((point) => {
    const out: Record<string, string | number> = { t: point.t };
    for (const s of metric.series) out[s.key] = Number(point[s.key] ?? 0);
    return out;
  });
}

function isEmpty(metric: Metric): boolean {
  return metric.points.every((point) => metric.series.every((s) => Number(point[s.key] ?? 0) === 0));
}

export function MetricChart({
  metric,
  kind,
  legend = true,
  className,
}: {
  metric: Metric;
  kind: Exclude<WidgetKind, 'number'>;
  legend?: boolean;
  className?: string;
}) {
  const gradientId = useId();
  const config = useMemo(() => chartConfigOf(metric), [metric]);
  const points = useMemo(() => numericPoints(metric), [metric]);
  const animate = useChartIntro(points.length > 0);
  const showLegend = legend && metric.series.length > 1;

  if (kind === 'donut') {
    // A donut answers "of what is this made" for the whole period, so the
    // slices are the series' range totals, on the slice palette.
    const slices = metric.series.map((s, index) => ({
      key: s.key,
      label: s.label,
      value: points.reduce((sum, p) => sum + Number(p[s.key] ?? 0), 0),
      fill: TROUBLE_KEYS.has(s.key) ? 'var(--destructive)' : `var(--slice-${String((index % 5) + 1)})`,
    }));
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-44 w-full min-w-0', className)}>
        <PieChart accessibilityLayer>
          <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="62%"
            outerRadius="88%"
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
    const first = metric.series[0];
    return (
      <ChartContainer config={config} className={cn('aspect-auto h-44 w-full min-w-0', className)}>
        <AreaChart accessibilityLayer data={points} margin={{ left: 4, right: 4, top: 4 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--color-${first?.key ?? ''})`} stopOpacity={0.24} />
              <stop offset="100%" stopColor={`var(--color-${first?.key ?? ''})`} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" hide />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            tickCount={4}
            tickFormatter={(value: number) => formatTick(metric.unit, value)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => (typeof value === 'string' ? formatDate(value) : '')}
              />
            }
          />
          {metric.series.map((s, index) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="linear"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              fill={index === 0 ? `url(#${gradientId})` : 'transparent'}
              isAnimationActive={animate}
            />
          ))}
          {showLegend ? <ChartLegend content={<ChartLegendContent />} /> : null}
        </AreaChart>
      </ChartContainer>
    );
  }

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-44 w-full min-w-0', className)}>
      <BarChart accessibilityLayer data={points} margin={{ left: 4, right: 4, top: 4 }} barCategoryGap="20%">
        <XAxis dataKey="t" hide />
        <YAxis
          width={44}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11 }}
          tickCount={4}
          allowDecimals={false}
          tickFormatter={(value: number) => formatTick(metric.unit, value)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) => (typeof value === 'string' ? formatDate(value) : '')}
            />
          }
        />
        {metric.series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            stackId="m"
            fill={`var(--color-${s.key})`}
            maxBarSize={BAR_MAX}
            radius={SHARP}
            isAnimationActive={animate}
          />
        ))}
        {showLegend ? <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} /> : null}
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

export function MetricCard({
  metric,
  kind = 'bar',
  from,
  to,
  action,
}: {
  metric: Metric;
  kind?: Exclude<WidgetKind, 'number'>;
  from: string;
  to: string;
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
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatHeadline(metric.unit, metric.headline)}
        </p>
        {isEmpty(metric) ? (
          <div className="text-muted-foreground flex h-44 items-center justify-center border border-dashed text-sm">
            Nothing to show in this period
          </div>
        ) : (
          <MetricChart metric={metric} kind={kind} />
        )}
        {/* The period's edges under the plot, the way the reference anchors
            its charts -- the x axis itself stays unlabelled and quiet. */}
        <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
          <span>{formatDate(from)}</span>
          <span>{formatDate(to)}</span>
        </div>
        <MetricBreakdownTable metric={metric} />
      </CardContent>
    </Card>
  );
}
