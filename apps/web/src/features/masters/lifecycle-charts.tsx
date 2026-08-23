import type { CSSProperties, ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Label, LabelList, Line, LineChart, PolarGrid, PolarRadiusAxis, RadialBar, RadialBarChart, XAxis, YAxis } from 'recharts';

import { compactCount, endpointLabel } from '@/components/shared/chart-labels';
import { CHART_INTRO_MS, useChartIntro } from '@/components/shared/use-chart-motion';
import { ChartCard } from '@/components/shared/chart-card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

import type { RankPoint, TrendPoint } from './lifecycle-series';

/**
 * The lifecycle's charts, drawn from series the builders made: no data
 * massaging here (vyuha-charts skill §2). Colours are the theme's chart
 * ramp in fixed order; the comparison series is the muted ink, dashed,
 * so current reads solid and past reads quiet (data-analyst skill §3).
 * Each chart animates once, on first paint after its data arrives.
 */

const AXIS = { top: 8, right: 12, bottom: 0, left: 0 } as const;

export function TrendChart({
  title,
  note,
  points,
  labels,
  compareLabel,
  format,
  axisFormat,
  ready,
}: {
  title: string;
  note?: string;
  points: readonly TrendPoint[];
  labels: { a: string; b: string };
  compareLabel: string | null;
  format: (value: number) => string;
  /**
   * The axis tick, when it is not a plain count.
   *
   * `format` writes the exact figure into the tooltip and is too long for a
   * tick; the axis had its own compact formatter and no way to be told the
   * series was money, so a rupee axis read "12.5L" with no symbol on it.
   */
  axisFormat?: (value: number) => string;
  ready: boolean;
}) {
  const animate = useChartIntro(ready);
  const config = {
    a: { label: labels.a, color: 'var(--chart-1)' },
    b: { label: labels.b, color: 'var(--chart-2)' },
    aPrev: { label: `${labels.a}, ${compareLabel ?? 'comparison'}`, color: 'var(--muted-foreground)' },
    bPrev: { label: `${labels.b}, ${compareLabel ?? 'comparison'}`, color: 'var(--muted-foreground)' },
  } satisfies ChartConfig;
  return (
    <ChartCard title={title} description={note}>
      <ChartContainer config={config} className="h-56 w-full">
        <LineChart accessibilityLayer data={[...points]} margin={AXIS}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(value: number) => (axisFormat ?? compactCount)(value)} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={(value) => format(Number(value))} />} />
          {/* The endpoint only. A figure beside every dot on four lines is
              chaos and goes unread; where the series got to is the number the
              reader is after, and it was reachable only by hovering. */}
          <Line dataKey="a" type="monotone" stroke="var(--color-a)" strokeWidth={2} dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS}>
            <LabelList {...endpointLabel('a', points, axisFormat ?? compactCount)} />
          </Line>
          <Line dataKey="b" type="monotone" stroke="var(--color-b)" strokeWidth={2} dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS}>
            <LabelList {...endpointLabel('b', points, axisFormat ?? compactCount)} />
          </Line>
          {compareLabel !== null ? (
            <>
              <Line dataKey="aPrev" type="monotone" stroke="var(--color-aPrev)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
              <Line dataKey="bPrev" type="monotone" stroke="var(--color-bPrev)" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
            </>
          ) : null}
          <ChartLegend content={<ChartLegendContent />} />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

export function RankingChart({ title, note, points, valueLabel, format, ready }: { title: string; note?: string; points: readonly RankPoint[]; valueLabel: string; format: (value: number) => string; ready: boolean }) {
  const animate = useChartIntro(ready);
  const config = { value: { label: valueLabel, color: 'var(--chart-1)' } } satisfies ChartConfig;
  // One row per bar: the chart is as tall as its list, no taller. The measured value reaches CSS as a custom property.
  const height = Math.max(120, points.length * 30 + 16);
  return (
    <ChartCard title={title} description={note}>
      <ChartContainer config={config} className="h-[var(--rank-h)] w-full" style={{ '--rank-h': `${String(height)}px` } as CSSProperties}>
        <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={120} tick={{ fontSize: 11 }} tickFormatter={(value: string) => (value.length > 18 ? `${value.slice(0, 17)}…` : value)} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel formatter={(value) => format(Number(value))} />} />
          <Bar dataKey="value" fill="var(--color-value)" maxBarSize={12} isAnimationActive={animate} animationDuration={CHART_INTRO_MS}>
            <LabelList dataKey="value" position="right" className="fill-muted-foreground tabular-nums" fontSize={11} formatter={(label: ReactNode) => format(Number(label))} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/** One rate as a ring (dataviz: progress toward a whole), the number in the middle, the previous period under it. */
export function RateRadial({ title, note, pct, previousPct, label, ready }: { title: string; note?: string; pct: number; previousPct: number | null; label: string; ready: boolean }) {
  const animate = useChartIntro(ready);
  const clamped = Math.max(0, Math.min(100, pct));
  const config = { rate: { label, color: 'var(--chart-2)' } } satisfies ChartConfig;
  const data = [{ name: label, rate: clamped, fill: 'var(--color-rate)' }];
  return (
    <ChartCard title={title} description={note}>
      <ChartContainer config={config} className="mx-auto aspect-square max-h-48 w-full">
        <RadialBarChart data={data} startAngle={90} endAngle={90 - 360 * (clamped / 100)} innerRadius={56} outerRadius={72}>
          <PolarGrid gridType="circle" radialLines={false} stroke="none" className="first:fill-muted last:fill-background" polarRadius={[62, 50]} />
          <RadialBar dataKey="rate" background isAnimationActive={animate} animationDuration={CHART_INTRO_MS} />
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <Label
              content={({ viewBox }) => {
                if (!viewBox || !('cx' in viewBox) || !('cy' in viewBox)) return null;
                const cx = Number(viewBox.cx ?? 0);
                const cy = Number(viewBox.cy ?? 0);
                return (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan x={cx} y={cy - 4} className="fill-foreground text-2xl font-semibold tabular-nums">
                      {`${String(Math.round(pct))}%`}
                    </tspan>
                    <tspan x={cx} y={cy + 16} className="fill-muted-foreground text-[11px]">
                      {previousPct === null ? label : `was ${String(Math.round(previousPct))}%`}
                    </tspan>
                  </text>
                );
              }}
            />
          </PolarRadiusAxis>
        </RadialBarChart>
      </ChartContainer>
    </ChartCard>
  );
}
