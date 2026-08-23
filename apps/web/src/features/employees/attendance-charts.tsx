import { compactCount, endpointLabel, stackTotal, valueCaps } from '@/components/shared/chart-labels';
import { useMemo, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  XAxis,
  YAxis,
} from 'recharts';

import { formatDuration } from '@/features/attendance/format';
import { statusLabel } from '@/features/attendance/status';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ATTENDANCE_STATUSES, type AttendanceStatus } from '@vyuha/shared';

import type { LatePoint, StatusSlice, WorkedPoint } from './attendance-analysis';
import { CHART_EASING, useChartMotion } from './use-chart-motion';

/**
 * The three charts on the employee detail screen (REQ-E-01, REQ-E-02).
 *
 * Colour splits two ways. Where a mark is a *state* — present, absent, on
 * leave, late, overtime — it wears the same token the badge and the calendar
 * cell for that state already use, because "red" cannot mean absence in a
 * table and step four of a scale in the graph beside it (CLAUDE.md §3 rule 4).
 * Where a mark is only a quantity, it wears the `--chart-1..5` ramp: those are
 * five shades of whatever accent the workspace picked, so ordinary worked time
 * follows the theme rather than borrowing the button's hue.
 *
 * Nothing here is wrapped in a Card. Each chart sits on the page surface under
 * its own SectionHeading, divided by space rather than by a box (rule 3).
 */

/**
 * The widest a single day is allowed to be drawn.
 *
 * A month with one recorded day would otherwise stretch that day across the
 * whole plot, and a chart whose bar width depends on how much data is missing
 * misreports the data it does have.
 */
const MAX_BAR_PX = 16;

/**
 * Minutes, as an axis tick a person reads.
 *
 * Rounding everything to hours looks right until the range is short: a month
 * holding nothing but holidays tops out near zero, and recharts then picks
 * quarter-hour ticks that all round to the same label — an axis reading
 * "0h 0h 0h 0h" beside a flat row of bars. Whole hours stay hours and anything
 * finer is stated in minutes, so no two ticks can print the same thing.
 */
function hoursTick(value: number): string {
  if (value === 0) return '0';
  if (value % 60 === 0) return `${String(value / 60)}h`;
  return `${String(Math.round(value))}m`;
}

/**
 * A day's worked time, short enough to sit on a bar cap.
 *
 * `formatDuration` writes "8h 30m", which is six characters over a bar that is
 * nineteen pixels wide in a full month. A tenth of an hour is the finest
 * reading a cap can usefully carry; the tooltip still gives the exact minutes.
 */
function capHours(minutes: number): string {
  return `${(Math.round(minutes / 6) / 10).toFixed(1).replace(/\.0$/u, '')}h`;
}

/** `2026-08-12` as `12`. The month is stated by the picker above the chart. */
function dayOfMonthTick(value: string): string {
  return value.slice(8, 10);
}

/**
 * Minutes from a tooltip payload, made safe.
 *
 * Recharts hands back the datum's value as a union that includes strings and
 * arrays, and a NaN reaching `formatDuration` prints "NaNh NaNm" into the
 * tooltip rather than failing loudly.
 */
function minutesOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function durationTooltipRow(config: ChartConfig) {
  return function row(value: unknown, name: unknown): ReactNode {
    const key = typeof name === 'string' ? name : '';
    return (
      <>
        <span className="text-muted-foreground">{config[key]?.label ?? key}</span>
        <span className="ml-auto font-mono font-medium tabular-nums">
          {formatDuration(minutesOf(value))}
        </span>
      </>
    );
  };
}

/** REQ-L-01: the tooltip heading is dd-MM-yyyy, never the raw ISO string. */
function dateTooltipLabel(label: ReactNode): ReactNode {
  return formatDate(typeof label === 'string' ? label : null);
}

// -------------------------------------------------------------- worked hours

const WORKED_CONFIG = {
  regular: { label: 'Worked', color: 'var(--chart-1)' },
  /* Overtime is more of the same measurement, not a warning about it, and a
     stack that mixes a ramp shade with a status token reads as two unrelated
     things. Two steps down the ramp keeps the segments apart. */
  overtime: { label: 'Overtime', color: 'var(--chart-3)' },
  scheduled: { label: 'Scheduled span', color: 'var(--muted-foreground)' },
} satisfies ChartConfig;

/**
 * Worked minutes per day, against what the roster asked for.
 *
 * The bar is one day's worked time, split at the overtime boundary rather than
 * stacked on top of it — `compute-day.ts` derives overtime from minutes that
 * are already inside `workedMinutes`, so the two added together would report a
 * nine-hour day as ten (see `toWorkedSeries`).
 *
 * The dashed line is the scheduled span, and it sits a little above a full
 * day's bar on purpose: the span is door to door and worked time has the break
 * taken out of it. That is said in the section note rather than left for the
 * reader to work out, because a chart whose reference line is never reached
 * reads as a workforce permanently behind.
 */
export function WorkedHoursChart({ points, delayMs = 0 }: { points: WorkedPoint[]; delayMs?: number }) {
  const { animate, durationMs, beginMs } = useChartMotion(delayMs);
  const formatter = useMemo(() => durationTooltipRow(WORKED_CONFIG), []);

  return (
    <ChartContainer config={WORKED_CONFIG} className="aspect-auto h-56 w-full">
      <ComposedChart accessibilityLayer data={points} margin={{ top: 20, right: 8, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          // A 31-day month at 360px cannot label every bar. Recharts drops the
          // ticks that would collide rather than overlapping them.
          minTickGap={14}
          tickFormatter={dayOfMonthTick}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickMargin={4}
          tickFormatter={hoursTick}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={dateTooltipLabel} formatter={formatter} />}
        />
        {/* Three series, so the legend is what names them: the split between
            regular and overtime is a colour difference inside one column, and
            the dashed reference is not self-explanatory either. */}
        <ChartLegend content={<ChartLegendContent className="flex-wrap gap-x-4 gap-y-1" />} />
        {/* Without a ceiling, a month holding one recorded day draws that day
            as a 900px slab across the whole plot, which reads as a filled
            background rather than as one measurement. */}
        <Bar
          dataKey="regular"
          stackId="worked"
          fill="var(--color-regular)"
          maxBarSize={MAX_BAR_PX}
          isAnimationActive={animate}
          animationBegin={beginMs}
          animationDuration={durationMs}
          animationEasing={CHART_EASING}
        />
        <Bar
          dataKey="overtime"
          stackId="worked"
          fill="var(--color-overtime)"
          maxBarSize={MAX_BAR_PX}
          isAnimationActive={animate}
          animationBegin={beginMs}
          animationDuration={durationMs}
          animationEasing={CHART_EASING}
        >
          {/* The total, not the two parts. Overtime is carved out of worked
              time rather than added to it, so the cap reads the day's length
              and the legend and the tooltip carry the split. */}
          <LabelList {...stackTotal(points, ['regular', 'overtime'], capHours)} />
        </Bar>
        <Line
          dataKey="scheduled"
          type="linear"
          stroke="var(--color-scheduled)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          // A line needs two points to be a line, and a month with one recorded
          // day is a real state in this product. Below that threshold the
          // reference is drawn as a marker instead of as nothing — and as a
          // filled one, because the default hollow ring at this stroke width
          // reads as a speck of dust rather than as a measurement.
          dot={points.length <= 3 ? { r: 3, strokeWidth: 0, fill: 'var(--color-scheduled)' } : false}
          activeDot={false}
          connectNulls={false}
          isAnimationActive={animate}
          animationBegin={beginMs}
          animationDuration={durationMs}
          // Not CHART_EASING: recharts types a Line's easing as the five named
          // curves and only Bar accepts a cubic-bezier. Over 420ms on a 1.5px
          // dashed reference the difference between the two ease-outs is not
          // visible, and weakening every bar to match a typing limitation
          // would be the wrong way round.
          animationEasing="ease-out"
        >
          <LabelList {...endpointLabel('scheduled', points)} />
        </Line>
      </ComposedChart>
    </ChartContainer>
  );
}

// --------------------------------------------------------------- status split

/**
 * The same two-dimensional system the badges use (`status.ts`): the family
 * says what kind of day it is, and the treatment — solid against faded —
 * separates a resolved day from its partial or derived variant. Present and
 * half day are both green because a half day is half a present day; the fade
 * is what keeps them apart in a chart that has no room for a second hue.
 */
const STATUS_FILL: Record<AttendanceStatus, string> = {
  PRESENT: 'var(--success)',
  HALF_DAY: 'color-mix(in oklch, var(--success), transparent 55%)',
  ON_DUTY: 'var(--info)',
  ON_LEAVE: 'color-mix(in oklch, var(--info), transparent 55%)',
  PENDING: 'var(--warning)',
  ABSENT: 'var(--destructive)',
  HOLIDAY: 'var(--muted-foreground)',
  WEEKLY_OFF: 'color-mix(in oklch, var(--muted-foreground), transparent 55%)',
};

const STATUS_CONFIG: ChartConfig = {
  count: { label: 'Days' },
  ...Object.fromEntries(
    ATTENDANCE_STATUSES.map((status) => [
      status,
      { label: statusLabel(status), color: STATUS_FILL[status] },
    ]),
  ),
};

/**
 * One row per status present, so the chart grows with the data instead of
 * reserving eight rows of empty axis for states this range does not contain.
 * Written as literals rather than computed, because Tailwind generates classes
 * by scanning the source and cannot see a string this file builds at runtime.
 */
const STATUS_CHART_HEIGHT = [
  'h-[54px]',
  'h-[88px]',
  'h-[122px]',
  'h-[156px]',
  'h-[190px]',
  'h-[224px]',
  'h-[258px]',
  'h-[292px]',
];

function statusTick(value: string): string {
  return (ATTENDANCE_STATUSES as readonly string[]).includes(value)
    ? statusLabel(value as AttendanceStatus)
    : value;
}

/**
 * How the range breaks down by status.
 *
 * Horizontal rather than a donut, and the reason is the palette above. Eight
 * statuses share four colour families, so two neighbouring arcs of a pie would
 * be the same green with nothing between them; labelled rows cannot collide
 * that way, and they stay readable at 360px where a donut plus its legend
 * costs half the screen.
 */
export function StatusSplitChart({ slices, delayMs = 0 }: { slices: StatusSlice[]; delayMs?: number }) {
  const { animate, durationMs, beginMs } = useChartMotion(delayMs);
  const data = useMemo(
    () => slices.map((slice) => ({ ...slice, fill: `var(--color-${slice.status})` })),
    [slices],
  );

  return (
    <ChartContainer
      config={STATUS_CONFIG}
      className={cn(
        'aspect-auto w-full',
        STATUS_CHART_HEIGHT[Math.min(data.length, STATUS_CHART_HEIGHT.length) - 1],
      )}
    >
      <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 0, right: 56 }}>
        <YAxis
          dataKey="status"
          type="category"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          width={86}
          tickFormatter={statusTick}
        />
        <XAxis dataKey="count" type="number" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="status" hideLabel />} />
        <Bar
          dataKey="count"
          barSize={12}
          isAnimationActive={animate}
          animationBegin={beginMs}
          animationDuration={durationMs}
          animationEasing={CHART_EASING}
        >
          {/* The bar length is relative to the largest status, so a month with
              one status draws a full-width bar whatever the count is. The
              number at the end is what makes it a reading rather than a mood. */}
          <LabelList
            dataKey="count"
            position="right"
            offset={8}
            fontSize={11}
            className="fill-foreground tabular-nums"
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// -------------------------------------------------------------- late arrivals

const LATE_CONFIG = {
  lateMinutes: { label: 'Late by', color: 'var(--warning)' },
} satisfies ChartConfig;

/**
 * Minutes late, day by day.
 *
 * Every day in the range is a column, including the ones with no lateness at
 * all, so four scattered late arrivals read as four incidents rather than as
 * four days running. The screen only renders this at all when the range
 * contains lateness; an axis of nothing is not a finding.
 */
export function LateMinutesChart({ points, delayMs = 0 }: { points: LatePoint[]; delayMs?: number }) {
  const { animate, durationMs, beginMs } = useChartMotion(delayMs);
  const formatter = useMemo(() => durationTooltipRow(LATE_CONFIG), []);

  return (
    <ChartContainer config={LATE_CONFIG} className="aspect-auto h-40 w-full">
      <BarChart accessibilityLayer data={points} margin={{ top: 20, right: 8, left: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={14}
          tickFormatter={dayOfMonthTick}
        />
        <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} allowDecimals={false} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={dateTooltipLabel} formatter={formatter} />}
        />
        <Bar
          dataKey="lateMinutes"
          fill="var(--color-lateMinutes)"
          maxBarSize={MAX_BAR_PX}
          isAnimationActive={animate}
          animationBegin={beginMs}
          animationDuration={durationMs}
          animationEasing={CHART_EASING}
        >
          <LabelList {...valueCaps('lateMinutes', compactCount)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
