import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';

import { compactCount } from '@/components/shared/chart-labels';
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

import type { FunnelPoint, OutcomePoint, OwnerPoint } from './analytics-series';

/**
 * The three charts the CRM dashboard draws (REQ-U-11). Presentational only:
 * every number arrives shaped by `analytics-series.ts`.
 *
 * **Won is blue and lost is red, and green was measured and rejected.** The
 * obvious pairing is the theme's `--success` and `--destructive`, and it is
 * unreadable: run through the colour-blindness checks those two separate by
 * ΔE 1.1 under deuteranopia on the dark surface (OKLab x100, floor 6, target
 * 8) -- two bars the same colour to a reader with the commonest form of
 * colour blindness. `--info` against `--destructive` separates by 21.8 dark
 * and 29.3 light, and keeps red meaning what it already means everywhere
 * else in the product. Both charts also carry a legend and direct labels, so
 * identity never rests on colour alone.
 *
 * The funnel and the owner load are one series each, so they take one step
 * of the theme's chart ramp and no legend -- the heading already names what
 * the bars are.
 *
 * `animate` is threaded in rather than decided here, so the page keeps the
 * "once, on first paint" rule and a filter change is not a wait.
 */

const FUNNEL_CONFIG = {
  count: { label: 'Open deals', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const OUTCOME_CONFIG = {
  won: { label: 'Won', color: 'var(--info)' },
  lost: { label: 'Lost', color: 'var(--destructive)' },
} satisfies ChartConfig;

const OWNER_CONFIG = {
  count: { label: 'Open deals', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** See dashboard/charts.tsx: recharts 3.8 puts the tick label a level deeper than chart.tsx's selector reaches. */
const TICK = { className: 'fill-muted-foreground' } as const;

/** Room on the right for a value label sitting outside the end of a bar. */
const ROW_MARGIN = { left: 0, right: 34, top: 4, bottom: 4 } as const;
const COLUMN_MARGIN = { left: 0, right: 8, top: 20 } as const;

/** Enough for "Negotiation" and "Priya Kulkarni" without truncating to initials. */
const CATEGORY_WIDTH = 96;

interface ChartProps<T> {
  readonly points: readonly T[];
  readonly animate: boolean;
}

function countLabel(value: unknown): string {
  return compactCount(Number(value));
}

/**
 * Where open deals are piling up.
 *
 * Horizontal, because stage names are words: vertical columns would either
 * rotate "Negotiation" onto its side or drop it, and a funnel whose stages
 * cannot be read is a decorative shape.
 */
export function StageFunnelChart({ points, animate }: ChartProps<FunnelPoint>) {
  return (
    <ChartContainer config={FUNNEL_CONFIG} className="aspect-auto h-52 w-full min-w-0 sm:h-56">
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="stage"
          width={CATEGORY_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={TICK}
        />
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
          {/* Every bar labelled, not a sample: there are at most a handful of
              stages, and a funnel is read as a set of numbers. */}
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

/** Won and lost per month, both as counts on one axis -- never money against count on two. */
export function OutcomesChart({ points, animate }: ChartProps<OutcomePoint>) {
  return (
    <ChartContainer config={OUTCOME_CONFIG} className="aspect-auto h-52 w-full min-w-0 sm:h-56">
      <BarChart accessibilityLayer data={[...points]} margin={COLUMN_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={TICK} tickMargin={8} interval={0} />
        <YAxis width={28} tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} tickCount={4} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="won"
          fill="var(--color-won)"
          radius={4}
          maxBarSize={18}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="lost"
          fill="var(--color-lost)"
          radius={4}
          maxBarSize={18}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}

/** Who is carrying the open pipeline. Horizontal for the same reason as the funnel: names are words. */
export function OwnerLoadChart({ points, animate }: ChartProps<OwnerPoint>) {
  return (
    <ChartContainer config={OWNER_CONFIG} className="aspect-auto h-52 w-full min-w-0 sm:h-56">
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="owner"
          width={CATEGORY_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={TICK}
        />
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
 * The loading state, sized like the chart it replaces.
 *
 * A spinner in a chart's place lets the page reflow when the data lands,
 * which moves whatever the reader was about to click.
 */
export function ChartSkeleton({ className }: { readonly className?: string }) {
  return <Skeleton className={className ?? 'h-52 w-full sm:h-56'} />;
}
