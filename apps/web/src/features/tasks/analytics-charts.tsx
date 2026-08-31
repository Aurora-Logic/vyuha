import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from 'recharts';

import { compactCount, stackTotal } from '@/components/shared/chart-labels';
import { CHART_INTRO_MS } from '@/components/shared/use-chart-motion';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';

import type { ColumnPoint, FlowPoint, LoadPoint } from './analytics-series';

/**
 * The three charts the task dashboard draws (REQ-V-11). Presentational only:
 * every number arrives shaped by `analytics-series.ts`.
 *
 * **Raised is blue and closed is green, and the pair was measured.** Run
 * through the colour-blindness checks they separate by ΔE 24.9 in light and
 * 24.2 in dark under deuteranopia (OKLab x100, floor 6, target 8) — the
 * theme's own `--info` and `--success`, so closed keeps the green that means
 * "done" everywhere else in the product. Both series also carry a legend and
 * a tooltip, so identity never rests on colour alone.
 *
 * Overdue sits *inside* the open bar rather than beside it, because it is
 * part of that number and not another one: eight open of which three are
 * late is one bar with a darker head, not two bars a reader has to add up.
 *
 * `animate` is threaded in rather than decided here, so the page keeps the
 * "once, on first paint" rule and a filter change is not a wait.
 */

const COLUMN_CONFIG = {
  count: { label: 'Open tasks', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const FLOW_CONFIG = {
  raised: { label: 'Raised', color: 'var(--info)' },
  closed: { label: 'Closed', color: 'var(--success)' },
} satisfies ChartConfig;

const LOAD_CONFIG = {
  onTime: { label: 'On time', color: 'var(--chart-1)' },
  overdue: { label: 'Overdue', color: 'var(--warning)' },
} satisfies ChartConfig;

/** See dashboard/charts.tsx: recharts 3.8 puts the tick label a level deeper than chart.tsx's selector reaches. */
const TICK = { className: 'fill-muted-foreground' } as const;

const ROW_MARGIN = { left: 0, right: 34, top: 4, bottom: 4 } as const;
const COLUMN_MARGIN = { left: 0, right: 8, top: 20 } as const;

/** Enough for "In progress" and "Priya Kulkarni" without truncating to initials. */
const CATEGORY_WIDTH = 96;

interface ChartProps<T> {
  readonly points: readonly T[];
  readonly animate: boolean;
}

function countLabel(value: unknown): string {
  return compactCount(Number(value));
}

/** Where open work is sitting. Horizontal, because column names are words. */
export function ColumnLoadChart({ points, animate }: ChartProps<ColumnPoint>) {
  return (
    <ChartContainer config={COLUMN_CONFIG} className="aspect-auto h-48 w-full min-w-0 sm:h-52">
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="column" width={CATEGORY_WIDTH} tickLine={false} axisLine={false} tick={TICK} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar
          dataKey="count"
          fill="var(--color-count)"
          radius={4}
          maxBarSize={18}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList
            dataKey="count"
            position="right"
            offset={8}
            className="fill-foreground text-xs tabular-nums"
            formatter={countLabel}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/**
 * Raised against closed, per week. Both counts on one axis — a second axis
 * would make any two lines look related, and whether the two match is the
 * only question this chart is drawn to answer.
 */
export function FlowChart({ points, animate }: ChartProps<FlowPoint>) {
  return (
    <ChartContainer config={FLOW_CONFIG} className="aspect-auto h-48 w-full min-w-0 sm:h-56">
      <LineChart accessibilityLayer data={[...points]} margin={COLUMN_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={TICK} tickMargin={8} interval="preserveStartEnd" />
        <YAxis width={28} tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} tickCount={4} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="raised"
          stroke="var(--color-raised)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Line
          dataKey="closed"
          stroke="var(--color-closed)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
      </LineChart>
    </ChartContainer>
  );
}

/** Who is carrying open work, with the late part of it shown inside the bar. */
export function AssigneeLoadChart({ points, animate }: ChartProps<LoadPoint>) {
  return (
    <ChartContainer config={LOAD_CONFIG} className="aspect-auto h-52 w-full min-w-0 sm:h-56">
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="person" width={CATEGORY_WIDTH} tickLine={false} axisLine={false} tick={TICK} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {/* Stacked, so the bar's whole length is that person's open work and
            the amber head is the late part of it. Drawn as two separate bars
            they read as two different numbers -- 17 beside 6 looks like 23. */}
        <Bar
          dataKey="onTime"
          stackId="load"
          fill="var(--color-onTime)"
          maxBarSize={18}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="overdue"
          stackId="load"
          fill="var(--color-overdue)"
          radius={[0, 4, 4, 0]}
          maxBarSize={18}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          {/* The total on the end of the stack, which is the open count. */}
          <LabelList {...stackTotal([...points], ['onTime', 'overdue'])} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

/** The loading state, sized like the chart it replaces so the page does not reflow when data lands. */
export function ChartSkeleton({ className }: { readonly className?: string }) {
  return <Skeleton className={className ?? 'h-48 w-full sm:h-52'} />;
}
