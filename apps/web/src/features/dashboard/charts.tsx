import { compactCount, endpointLabel, stackTotal, valueCaps } from '@/components/shared/chart-labels';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis, LabelList } from 'recharts';

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDuration } from '@/features/attendance/format';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { CHART_INTRO_MS } from './use-chart-motion';
import {
  axisTicks,
  hourTicks,
  shortDate,
  type HoursPoint,
  type LatePoint,
  type TeamHoursPoint,
  type TrendPoint,
} from './series';

/**
 * The three charts REQ-K-01 can honestly draw from `/attendance/days`.
 *
 * Colour comes from the theme's semantic status tokens, not from --chart-1..5.
 * That ramp is five steps of one pink hue in this theme, which would say a
 * present day and an absent day are the same kind of thing in two shades. The
 * product already decided what green, blue, red and grey mean (see
 * attendance/status.ts) and a colour has to mean one thing everywhere
 * (CLAUDE.md §3 rule 4).
 *
 * The order of the stack is a measured decision rather than an aesthetic one.
 * Run against the colour-blindness checks, red beside amber separates by only
 * 5.6 (OKLab dE x100 under deuteranopia, floor 6, target 8), while
 * work-leave-absent-other separates by 12.3 at worst in light mode and 7.8 in
 * dark. The dark pair sits in the band that is allowed only with a second
 * encoding, which is why every chart here carries a legend and a tooltip that
 * name the series in words.
 *
 * `animate` is threaded in rather than decided here: the page owns the "once,
 * on first paint" policy, and a chart that decided for itself would re-animate
 * every time the period changed.
 */

const TREND_CONFIG = {
  work: { label: 'At work', color: 'var(--success)' },
  leave: { label: 'On leave', color: 'var(--info)' },
  absent: { label: 'Absent', color: 'var(--destructive)' },
  other: { label: 'Off or pending', color: 'var(--muted-foreground)' },
} satisfies ChartConfig;

const LATE_CONFIG = {
  late: { label: 'Arrived late', color: 'var(--warning)' },
} satisfies ChartConfig;

/* Hours worked is a quantity, not a state. It wore --success because it sits
   beside the status bands where green means "at work", but a measurement is
   not a verdict and a green bar in a crimson workspace belongs to neither. */
const HOURS_CONFIG = {
  workedMinutes: { label: 'Worked', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const TEAM_HOURS_CONFIG = {
  workedMinutes: { label: 'Worked, everyone', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** Five dates is what fits at 360px without the labels touching. */
const MAX_DATE_TICKS = 5;

/**
 * Room on the right for the last date label.
 *
 * Ticks are centred under their category, so at 360px the final "13 Aug" hung
 * half outside the plot and was clipped by the panel. The margin moves the
 * last column in far enough for its own label.
 */
/* `top` is room for the value on a bar cap or a line end. At 4px the
   tallest mark had its label sliced off by the plot edge -- the marks
   that most need reading were the ones cut in half. */
const AXIS_MARGIN = { left: 0, right: 16, top: 20 } as const;

/**
 * The line chart needs more of it. A band axis keeps half a column of padding
 * at each end; a line axis puts its last point on the edge itself, so the same
 * 16px left "13 Aug" hanging 3px outside the plot.
 */
const LINE_MARGIN = { left: 0, right: 24, top: 20 } as const;

/**
 * The axis label colour, set here rather than inherited.
 *
 * chart.tsx paints ticks with `[&_.recharts-cartesian-axis-tick_text]`, and in
 * recharts 3.8 the label sits one level deeper, inside
 * `.recharts-cartesian-axis-tick-label`. The selector misses, so every tick
 * keeps recharts' own `fill="#666"`: 5.7:1 on the light ground and 3.4:1 on
 * the dark one, which fails the 4.5:1 NFR-07 asks for. A class on the tick
 * beats the presentation attribute and follows the theme in both modes.
 */
const TICK = { className: 'fill-muted-foreground' } as const;

/**
 * The loading chart's bar heights, as classes rather than an inline style.
 * CLAUDE.md §3 rule 1 allows Tailwind and the theme tokens and nothing else,
 * and a percentage height is expressible in both.
 */
const SKELETON_BARS = [
  'h-[45%]',
  'h-[70%]',
  'h-[55%]',
  'h-[80%]',
  'h-[60%]',
  'h-[90%]',
  'h-[50%]',
  'h-[75%]',
  'h-[65%]',
  'h-[85%]',
  'h-[55%]',
  'h-[70%]',
];

interface ChartProps<T> {
  points: readonly T[];
  animate: boolean;
}

function dateTick(value: unknown): string {
  return shortDate(String(value));
}

/**
 * The trend legend, in the order the stack is drawn.
 *
 * Left alone, recharts orders legend entries by what the series happen to
 * contain, so one absent day puts Absent first and the row reshuffles every
 * time the period changes. Recharts 3 does not accept a `payload` prop on
 * Legend, so the order is imposed on the payload it clones in on its way to
 * the shadcn legend rather than by replacing it.
 */
const LEGEND_ORDER = ['work', 'leave', 'absent', 'other'];

function legendRank(key: unknown): number {
  const at = LEGEND_ORDER.indexOf(String(key));
  return at === -1 ? LEGEND_ORDER.length : at;
}

function TrendLegend(props: React.ComponentProps<typeof ChartLegendContent>) {
  const payload = [...(props.payload ?? [])].sort(
    (left, right) => legendRank(left.dataKey) - legendRank(right.dataKey),
  );
  return <ChartLegendContent {...props} payload={payload} />;
}

function fullDate(value: unknown): string {
  return formatDate(String(value));
}

export function AttendanceTrendChart({ points, animate }: ChartProps<TrendPoint>) {
  return (
    <ChartContainer config={TREND_CONFIG} className="aspect-auto h-56 w-full min-w-0 sm:h-64">
      <BarChart accessibilityLayer data={[...points]} margin={AXIS_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickMargin={8}
          interval={0}
          ticks={axisTicks(points.map((point) => point.date), MAX_DATE_TICKS)}
          tickFormatter={dateTick}
        />
        <YAxis
          width={28}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          allowDecimals={false}
          tickCount={4}
        />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={fullDate} />} />
        <ChartLegend content={<TrendLegend className="flex-wrap gap-x-4 gap-y-1" />} />
        {/* Stack order is bottom to top: the people who came, then the ones
            with a reason, then the ones without, then the days nobody was
            expected. Absent sits high in the stack on purpose - it is the row
            somebody has to act on. */}
        <Bar
          dataKey="work"
          stackId="day"
          fill="var(--color-work)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="leave"
          stackId="day"
          fill="var(--color-leave)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="absent"
          stackId="day"
          fill="var(--color-absent)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="other"
          stackId="day"
          fill="var(--color-other)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...stackTotal([...points], ['work', 'leave', 'absent', 'other'])} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function LateArrivalsChart({ points, animate }: ChartProps<LatePoint>) {
  return (
    <ChartContainer config={LATE_CONFIG} className="aspect-auto h-40 w-full min-w-0 sm:h-44">
      <LineChart accessibilityLayer data={[...points]} margin={LINE_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickMargin={8}
          interval={0}
          ticks={axisTicks(points.map((point) => point.date), MAX_DATE_TICKS)}
          tickFormatter={dateTick}
        />
        <YAxis
          width={28}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          allowDecimals={false}
          tickCount={3}
        />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={fullDate} indicator="line" />}
        />
        {/* `linear` rather than a curve: a curve through daily counts draws
            values between the days that nobody measured. The dots mark where
            the measurements actually are. */}
        <Line
          dataKey="late"
          type="linear"
          stroke="var(--color-late)"
          strokeWidth={2}
          dot={{ r: 2, fill: 'var(--color-late)' }}
          activeDot={{ r: 4 }}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...endpointLabel('late', points)} />
        </Line>
      </LineChart>
    </ChartContainer>
  );
}

function hoursTick(value: unknown): string {
  return `${String(Math.round(Number(value) / 60))}h`;
}

function hoursValue(value: unknown): string {
  return formatDuration(Number(value));
}

export function WorkedHoursChart({ points, animate }: ChartProps<HoursPoint>) {
  const { domainMax, ticks } = hourTicks(
    points.reduce((most, point) => Math.max(most, point.workedMinutes), 0),
  );

  return (
    <ChartContainer config={HOURS_CONFIG} className="aspect-auto h-44 w-full min-w-0 sm:h-48">
      <BarChart accessibilityLayer data={[...points]} margin={AXIS_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickMargin={8}
          interval={0}
          ticks={axisTicks(points.map((point) => point.date), MAX_DATE_TICKS)}
          tickFormatter={dateTick}
        />
        <YAxis
          width={32}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          domain={[0, domainMax]}
          ticks={ticks}
          tickFormatter={hoursTick}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent labelFormatter={fullDate} formatter={hoursValue} indicator="dot" />
          }
        />
        {/* Minutes, drawn as hours. Plotting the rounded hours instead would
            make the tooltip disagree with the bar it is describing. */}
        <Bar
          dataKey="workedMinutes"
          fill="var(--color-workedMinutes)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueCaps('workedMinutes', compactCount)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

function teamHoursValue(value: unknown, _name: unknown, item: unknown): string {
  const people = (item as { payload?: { people?: number } } | undefined)?.payload?.people ?? 0;
  return `${formatDuration(Number(value))} across ${String(people)} ${people === 1 ? 'person' : 'people'}`;
}

/**
 * The team's worked hours, day by day.
 *
 * The line is everyone's minutes added together and the tooltip names the
 * headcount behind it, because the total on its own cannot tell a quiet week
 * from a short-staffed one.
 */
export function TeamHoursChart({ points, animate }: ChartProps<TeamHoursPoint>) {
  const { domainMax, ticks } = hourTicks(
    points.reduce((most, point) => Math.max(most, point.workedMinutes), 0),
  );

  return (
    <ChartContainer config={TEAM_HOURS_CONFIG} className="aspect-auto h-44 w-full min-w-0 sm:h-48">
      <LineChart accessibilityLayer data={[...points]} margin={LINE_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickMargin={8}
          interval={0}
          ticks={axisTicks(points.map((point) => point.date), MAX_DATE_TICKS)}
          tickFormatter={dateTick}
        />
        <YAxis
          width={32}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          domain={[0, domainMax]}
          ticks={ticks}
          tickFormatter={hoursTick}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={fullDate}
              formatter={teamHoursValue}
              indicator="dot"
            />
          }
        />
        <Line
          dataKey="workedMinutes"
          type="monotone"
          stroke="var(--color-workedMinutes)"
          strokeWidth={2}
          dot={{ r: 2.5, fill: 'var(--color-workedMinutes)', strokeWidth: 0 }}
          activeDot={{ r: 4 }}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * The loading state, shaped like the chart it stands in for.
 *
 * A single grey block would be honest about "something is coming" and wrong
 * about what: the page would resize when the real chart arrived. These are the
 * same heights as the charts above.
 */
export function ChartSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      <div aria-hidden className="flex h-full items-end gap-1.5">
        {SKELETON_BARS.map((height, index) => (
          <Skeleton key={index} className={cn('min-w-0 flex-1', height)} />
        ))}
      </div>
    </div>
  );
}
