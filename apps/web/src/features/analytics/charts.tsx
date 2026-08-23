import { compactCount, compactIndian, endpointLabel, stackTotal, valueCaps, valueTips } from '@/components/shared/chart-labels';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis, LabelList } from 'recharts';

import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { axisTicks, hourTicks, shortDate } from '@/features/attendance/chart-series';
import { OrderedChartLegend } from '@/features/attendance/charts';
import { formatDuration } from '@/features/attendance/format';
import { flagColourVar, flagLabel } from '@/features/attendance/status';
import { CHART_INTRO_MS } from '@/features/attendance/use-chart-motion';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import type {
  DepartmentPoint,
  FlagPoint,
  LateBucket,
  PersonPoint,
  RatePoint,
  SourcePoint,
  WeekdayPoint,
} from './series';

/**
 * The eight charts on the Analytics screen.
 *
 * Every one is a shadcn `ChartContainer` from `@/components/ui/chart`. There
 * is no bare `ResponsiveContainer`, no raw `svg`, and no second charting
 * library anywhere in this app.
 *
 * Colour rules, in order of how often they get broken:
 *
 * 1. Never `--chart-1..5`. That ramp is five steps of one pink hue in this
 *    theme; using it would say a present day and an absent day are the same
 *    kind of thing in two shades. Colour comes from the semantic status
 *    tokens, which the product has already given meanings to (`status.ts`).
 * 2. Colour is only used where it carries information. A ranked list of eight
 *    people already separates its bars by position and label, so it gets one
 *    colour; the punch mix and the headcount split genuinely encode a category
 *    per segment, so those get several.
 * 3. Where several are used, the pair is measured rather than eyeballed. OKLab
 *    ΔE x100 after a colour-vision simulation, floor 6, target 8:
 *
 *      info / warning / muted-foreground   worst 13.1 protanopia, 21.5 deuteranopia
 *      info / warning (headcount split)    worst 30.1 protanopia, 42.0 deuteranopia
 *      destructive / muted-foreground      worst 15.0 protanopia, 27.7 deuteranopia
 *
 *    The two pairings this file must never contain: destructive beside warning
 *    measures 5.5 under deuteranopia and success beside warning measures 4.7
 *    under protanopia. Both fail, and neither appears here.
 * 4. Colour is never the only encoding. Every multi-series chart carries a
 *    legend and a tooltip naming the series in words.
 *
 * `animate` is threaded in rather than decided per chart: the screen owns the
 * "draw once, on first paint" policy, and a chart deciding for itself would
 * re-animate on every filter change — which is the difference between a screen
 * that feels considered and one that feels slow.
 */

/**
 * The axis label colour, set here rather than inherited.
 *
 * chart.tsx paints ticks with `[&_.recharts-cartesian-axis-tick_text]`, and in
 * recharts 3.8 the label sits one level deeper. The selector misses, so every
 * tick keeps recharts' own `fill="#666"`: 5.7:1 on the light ground and 3.4:1
 * on the dark one, which fails the 4.5:1 NFR-07 asks for.
 */
const TICK = { className: 'fill-muted-foreground' } as const;

/**
 * The category tick on a horizontal bar chart, with wrapping switched off.
 *
 * Recharts hands its axis `width` to each tick, and its `Text` treats that as
 * a wrap boundary — measured, not guessed: "Offline sync" came back as two
 * tspans 27px tall inside a 28px row, so the label for one bar sat across its
 * neighbour's. Passing a width larger than any label can be stops the wrap.
 * It is safe because the labels are truncated first: the widest measured 79px
 * against a 96px gutter, so nothing overflows to the left.
 */
const NAME_TICK = { className: 'fill-muted-foreground', width: 400 } as const;

/**
 * Margins, spelled out because the registry's default is a bug here.
 *
 * Several registry chart examples carry `margin={{ left: -20 }}`, which pulls
 * the plot over the y axis and clips the widest tick label. That has already
 * been fixed once in this codebase; nothing below uses a negative margin, and
 * the right margin exists so a centred last tick has room for its own label
 * instead of hanging outside the panel at 360px.
 */
/* `top` is room for the value on a bar cap or a line end. At 4px the
   tallest mark had its label sliced off by the plot edge -- the marks
   that most need reading were the ones cut in half. */
const AXIS_MARGIN = { left: 0, right: 16, top: 20 } as const;
const LINE_MARGIN = { left: 0, right: 24, top: 20 } as const;
/** A horizontal bar's value label sits to the right of the bar; leave it room. */
const ROW_MARGIN = { left: 0, right: 36, top: 4, bottom: 4 } as const;

/** Five dates is what fits at 360px without the labels touching. */
const MAX_DATE_TICKS = 5;

/**
 * The category gutter on a horizontal bar chart.
 *
 * 96px, and a name longer than that is truncated by the tick formatter rather
 * than allowed to widen the gutter: at 360px the whole panel is 302px, so
 * every pixel the names take is a pixel the bars do not have, and a chart
 * whose bars are shorter than its labels has stopped being a chart. The
 * tooltip carries the full name.
 *
 * Both numbers are measured at 360px rather than chosen. At twelve characters
 * and an 88px gutter, "Human Resou…" rendered 89px wide and clipped its own
 * first letter; at eleven and 88 it still overhung by 2px, because the text is
 * right-aligned inside the gutter and recharts leaves a tick margin. Eleven
 * characters in 96px leaves the widest label ("Low GPS ac…", 79px) 17px clear.
 */
const NAME_AXIS_WIDTH = 96;
const NAME_MAX_CHARS = 11;

/**
 * The gutter a percentage axis needs.
 *
 * 36px was not enough and it was not obvious: "100%" renders 32px wide and is
 * right-aligned inside the gutter, so at 360px its left edge sat 4px outside
 * the panel and the first digit was cut off. Measured at 360, not assumed.
 */
const PERCENT_AXIS_WIDTH = 44;

/**
 * How tall a ranked list of N rows is.
 *
 * A literal class per row count rather than a computed height, for two
 * reasons: CLAUDE.md §3 rule 1 allows Tailwind and the theme tokens and
 * nothing else, so there is no inline style object; and Tailwind v4 generates
 * utilities by scanning source text, so a class assembled at runtime would
 * simply not exist in the stylesheet.
 *
 * 28px a row. Squeezing eight bars into a fixed box gives each one 4px, which
 * is a colour rather than a measurement.
 */
const ROW_CHART_HEIGHT: Record<number, string> = {
  1: 'h-[44px]',
  2: 'h-[72px]',
  3: 'h-[100px]',
  4: 'h-[128px]',
  5: 'h-[156px]',
  6: 'h-[184px]',
  7: 'h-[212px]',
  8: 'h-[240px]',
};

/** The same, plus room for a legend underneath. */
const ROW_CHART_HEIGHT_WITH_LEGEND: Record<number, string> = {
  1: 'h-[76px]',
  2: 'h-[104px]',
  3: 'h-[132px]',
  4: 'h-[160px]',
  5: 'h-[188px]',
  6: 'h-[216px]',
  7: 'h-[244px]',
  8: 'h-[272px]',
};

function rowHeight(count: number, withLegend = false): string {
  const table = withLegend ? ROW_CHART_HEIGHT_WITH_LEGEND : ROW_CHART_HEIGHT;
  const clamped = Math.min(Math.max(1, count), 8);
  return table[clamped] ?? (withLegend ? 'h-[272px]' : 'h-[240px]');
}

function truncateName(value: unknown): string {
  const name = String(value);
  return name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS - 1)}…` : name;
}

function dateTick(value: unknown): string {
  return shortDate(String(value));
}

function fullDate(value: unknown): string {
  return formatDate(String(value));
}

function percentTick(value: unknown): string {
  return `${String(value)}%`;
}

function percentValue(value: unknown): string {
  return `${String(value)}%`;
}

function daysValue(value: unknown): string {
  const days = Number(value);
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}

function punchesValue(value: unknown): string {
  const punches = Number(value);
  return `${String(punches)} punch${punches === 1 ? '' : 'es'}`;
}

function peopleValue(value: unknown): string {
  const people = Number(value);
  return `${String(people)} ${people === 1 ? 'person' : 'people'}`;
}

function minutesValue(value: unknown): string {
  return formatDuration(Number(value));
}

interface ChartProps<T> {
  points: readonly T[];
  animate: boolean;
}

// ------------------------------------------------------- attendance over time

const RATE_CONFIG = {
  rate: { label: 'At work', color: 'var(--success)' },
} satisfies ChartConfig;

/**
 * Is attendance drifting?
 *
 * A rate rather than a count, so the line does not step down every time
 * somebody leaves. `connectNulls` is off: a day nobody was expected has no
 * rate, and bridging it would draw a measurement across a public holiday.
 */
export function AttendanceRateChart({ points, animate }: ChartProps<RatePoint>) {
  return (
    <ChartContainer config={RATE_CONFIG} className="aspect-auto h-44 w-full min-w-0 sm:h-52">
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
          width={PERCENT_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          // Fixed at 0-100 rather than fitted to the data. An axis running
          // 94-97% turns ordinary noise into a cliff, which is the most common
          // way a rate chart lies.
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tickFormatter={percentTick}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent labelFormatter={fullDate} formatter={percentValue} indicator="line" />
          }
        />
        {/* `linear` rather than a curve: a curve through daily rates draws
            values on days nobody measured. */}
        <Line
          dataKey="rate"
          type="linear"
          stroke="var(--color-rate)"
          strokeWidth={2}
          connectNulls={false}
          dot={points.length <= 31 ? { r: 2, fill: 'var(--color-rate)' } : false}
          activeDot={{ r: 4 }}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...endpointLabel('rate', points)} />
        </Line>
      </LineChart>
    </ChartContainer>
  );
}

const WEEKDAY_CONFIG = {
  rate: { label: 'Absent', color: 'var(--destructive)' },
} satisfies ChartConfig;

/** Which weekday do people miss? A rate, so five Mondays do not beat four Fridays. */
export function WeekdayAbsenceChart({ points, animate }: ChartProps<WeekdayPoint>) {
  return (
    <ChartContainer config={WEEKDAY_CONFIG} className="aspect-auto h-40 w-full min-w-0 sm:h-44">
      <BarChart accessibilityLayer data={[...points]} margin={AXIS_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="weekday" tickLine={false} axisLine={false} tick={TICK} tickMargin={8} />
        <YAxis
          width={PERCENT_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={TICK}
          allowDecimals={false}
          tickFormatter={percentTick}
        />
        <ChartTooltip content={<ChartTooltipContent formatter={percentValue} />} />
        <Bar
          dataKey="rate"
          fill="var(--color-rate)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueCaps('rate', compactCount)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------- punctuality

const LATE_CONFIG = {
  days: { label: 'Late days', color: 'var(--warning)' },
} satisfies ChartConfig;

/** A handful of big delays, or a habit of small ones? Different problems. */
export function LateSpreadChart({ points, animate }: ChartProps<LateBucket>) {
  return (
    <ChartContainer config={LATE_CONFIG} className="aspect-auto h-40 w-full min-w-0 sm:h-44">
      <BarChart accessibilityLayer data={[...points]} margin={AXIS_MARGIN}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          tickMargin={8}
          interval={0}
          // Five buckets at 360px is roughly 60px each, which "16-30 min" does
          // not fit. The unit is stated once in the caption instead.
          tickFormatter={(value: unknown) => String(value).replace(' min', '').replace('Over 1 hr', '60+')}
        />
        <YAxis width={28} tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent formatter={daysValue} />} />
        <Bar
          dataKey="days"
          fill="var(--color-days)"
          maxBarSize={16}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueCaps('days', compactCount)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const REPEAT_CONFIG = {
  value: { label: 'Late days', color: 'var(--warning)' },
} satisfies ChartConfig;

/**
 * Who is repeatedly late.
 *
 * Horizontal, because the category is a person's name and a name written
 * sideways under a vertical bar is unreadable at any width.
 */
export function RepeatLateChart({ points, animate }: ChartProps<PersonPoint>) {
  return (
    <ChartContainer
      config={REPEAT_CONFIG}
      className={cn('aspect-auto w-full min-w-0', rowHeight(points.length))}
    >
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" dataKey="value" tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={NAME_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={NAME_TICK}
          tickFormatter={truncateName}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={daysValue} />} />
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          maxBarSize={12}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueTips('value', compactIndian)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const OVERTIME_CONFIG = {
  value: { label: 'Overtime', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** Who carries the overtime. Minutes only — REQ-E-05, no rate and no money. */
export function OvertimeChart({ points, animate }: ChartProps<PersonPoint>) {
  // Recharts picks its own ticks from the data, which for a top of 362 minutes
  // produced an axis reading 0h, 2h, 3h, 5h, 6h — four uneven steps that look
  // like a rounding bug because they are one. Fixing the domain to a multiple
  // of the step puts every gridline on an hour a reader recognises.
  const { domainMax, ticks } = hourTicks(
    points.reduce((most, point) => Math.max(most, point.value), 0),
  );

  return (
    <ChartContainer
      config={OVERTIME_CONFIG}
      className={cn('aspect-auto w-full min-w-0', rowHeight(points.length))}
    >
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          dataKey="value"
          tickLine={false}
          axisLine={false}
          tick={TICK}
          domain={[0, domainMax]}
          ticks={ticks}
          tickFormatter={(value: unknown) => `${String(Math.round(Number(value) / 60))}h`}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={NAME_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={NAME_TICK}
          tickFormatter={truncateName}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={minutesValue} />} />
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          maxBarSize={12}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueTips('value', compactIndian)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// --------------------------------------------------------------- punch quality

/* Where a punch came from is a category, not a verdict -- an offline sync is
   not a warning and a web punch is not a lesser one. It was drawn in status
   tokens, and two of the four were the same muted grey, so "Web" and
   "Recorded by admin" shared a legend swatch and could not be told apart in
   the bar at all. Four shades of the accent, in the order they stack. */
const SOURCE_CONFIG = {
  MOBILE: { label: 'Mobile', color: 'var(--chart-1)' },
  WEB: { label: 'Web', color: 'var(--chart-2)' },
  OFFLINE_SYNC: { label: 'Offline sync', color: 'var(--chart-3)' },
  ADMIN_ENTRY: { label: 'Recorded by admin', color: 'var(--chart-4)' },
} satisfies ChartConfig;

/** The order the mix is stacked in, so the legend agrees with the bar. */
const SOURCE_ORDER = ['MOBILE', 'WEB', 'OFFLINE_SYNC', 'ADMIN_ENTRY'];

interface SourceRow {
  row: string;
  MOBILE: number;
  WEB: number;
  OFFLINE_SYNC: number;
  ADMIN_ENTRY: number;
}

/**
 * How punches reached the server, as one bar rather than three.
 *
 * The question is a mix, not three separate magnitudes: web punch is policed
 * by the IP allowlist and mobile punch by the geofence (REQ-D-08, REQ-D-09),
 * so what matters is which control is carrying the premises rule. One stacked
 * row reads as a proportion; three bars would read as three unrelated counts.
 *
 * The colours are the measured triple. Offline sync is the warning tone
 * because it is the one that arrives late and carries a disputed timestamp
 * (REQ-D-10), not because there is anything wrong with it.
 */
export function PunchSourceChart({ points, animate }: ChartProps<SourcePoint>) {
  const row: SourceRow = { row: 'Punches', MOBILE: 0, WEB: 0, OFFLINE_SYNC: 0, ADMIN_ENTRY: 0 };
  for (const point of points) row[point.source] = point.punches;

  return (
    <ChartContainer config={SOURCE_CONFIG} className="aspect-auto h-24 w-full min-w-0">
      <BarChart
        accessibilityLayer
        data={[row]}
        layout="vertical"
        margin={{ left: 0, right: 0, top: 0, bottom: 0 }}
      >
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="row" hide />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={punchesValue} />} />
        <ChartLegend content={<OrderedChartLegend seriesOrder={SOURCE_ORDER} className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar
          dataKey="MOBILE"
          stackId="source"
          fill="var(--color-MOBILE)"
          maxBarSize={24}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="WEB"
          stackId="source"
          fill="var(--color-WEB)"
          maxBarSize={24}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="OFFLINE_SYNC"
          stackId="source"
          fill="var(--color-OFFLINE_SYNC)"
          maxBarSize={24}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="ADMIN_ENTRY"
          stackId="source"
          fill="var(--color-ADMIN_ENTRY)"
          maxBarSize={24}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...stackTotal([row], ['MOBILE', 'WEB', 'OFFLINE_SYNC', 'ADMIN_ENTRY'])} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const FLAG_CONFIG = {
  punches: { label: 'Punches', color: 'var(--destructive)' },
} satisfies ChartConfig;

interface FlagRow {
  flag: string;
  label: string;
  punches: number;
  fill: string;
}

/**
 * What actually went wrong at the punch.
 *
 * Colour here is information rather than decoration: a flag somebody has to
 * act on (`NEEDS_REVIEW` in status.ts — outside the geofence, a mock location,
 * a clock skew) reads in the destructive tone, and a flag that merely
 * describes the punch stays quiet. Same rule the flag badges on the muster
 * already use, so the two surfaces agree.
 *
 * The pair measures ΔE 15.0 under protanopia and 27.7 under deuteranopia, and
 * the label beside each bar says which is which regardless.
 */
export function FlagVolumeChart({ points, animate }: ChartProps<FlagPoint>) {
  const rows: FlagRow[] = points.map((point) => ({
    flag: point.flag,
    label: flagLabel(point.flag),
    punches: point.punches,
    // Owner, 22 Aug 2026: each flag paints in its own hue; the label beside
    // every bar carries the identity, the colour only agrees with the chips.
    fill: flagColourVar(point.flag),
  }));

  return (
    <ChartContainer
      config={FLAG_CONFIG}
      className={cn('aspect-auto w-full min-w-0', rowHeight(rows.length))}
    >
      <BarChart accessibilityLayer data={rows} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" dataKey="punches" tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="label"
          width={NAME_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={NAME_TICK}
          tickFormatter={truncateName}
        />
        {/* `nameKey` points the tooltip at the humanised label rather than at
            the raw `outside_geofence` the series is keyed on. */}
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent nameKey="label" formatter={punchesValue} />}
        />
        <Bar
          dataKey="punches"
          maxBarSize={12}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...valueTips('punches', compactCount)} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ------------------------------------------------------------------ headcount

/* Employment type is a category, not a status: fixed-term is a contract, not
   a warning. Two shades apart in the ramp rather than adjacent, so the stack
   still separates. */
const HEADCOUNT_CONFIG = {
  permanent: { label: 'Permanent', color: 'var(--chart-1)' },
  fixedTerm: { label: 'Fixed-term', color: 'var(--chart-3)' },
} satisfies ChartConfig;

const HEADCOUNT_ORDER = ['permanent', 'fixedTerm'];

/**
 * Where people sit, and which departments carry fixed-term staff.
 *
 * Two series rather than four employment types, because four cannot be given
 * four distinguishable colours from this theme (green beside amber fails at
 * ΔE 4.7 under protanopia) and because the management question is binary:
 * which teams depend on people whose engagement ends on a date.
 */
export function HeadcountChart({ points, animate }: ChartProps<DepartmentPoint>) {
  return (
    <ChartContainer
      config={HEADCOUNT_CONFIG}
      className={cn('aspect-auto w-full min-w-0', rowHeight(points.length, true))}
    >
      <BarChart accessibilityLayer data={[...points]} layout="vertical" margin={ROW_MARGIN}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="department"
          width={NAME_AXIS_WIDTH}
          tickLine={false}
          axisLine={false}
          tick={NAME_TICK}
          tickFormatter={truncateName}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={peopleValue} />} />
        <ChartLegend content={<OrderedChartLegend seriesOrder={HEADCOUNT_ORDER} className="flex-wrap gap-x-4 gap-y-1" />} />
        <Bar
          dataKey="permanent"
          stackId="head"
          fill="var(--color-permanent)"
          maxBarSize={12}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        />
        <Bar
          dataKey="fixedTerm"
          stackId="head"
          fill="var(--color-fixedTerm)"
          maxBarSize={12}
          isAnimationActive={animate}
          animationDuration={CHART_INTRO_MS}
          animationEasing="ease-out"
        >
          <LabelList {...stackTotal([...points], ['permanent', 'fixedTerm'])} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
