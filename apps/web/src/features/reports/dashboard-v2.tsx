import { useState, type ReactNode } from 'react';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { PERMISSIONS, type ReportKey } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';
import { useNavigate } from 'react-router';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ComposedChart,
  Scatter,
  XAxis,
  YAxis,
} from 'recharts';

import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { DateRangeField } from '@/features/attendance/pickers';
import { formatCount, formatMoney, formatMoneyShort } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useReportRows } from './api';
import { monthLabel } from './dashboard-v2.format';
import { asApiDate, DASHBOARD_PRESETS, defaultRange } from './dashboard-v2.presets';
import * as series from './dashboard-v2.series';

/**
 * Every chart shape shadcn ships, over the receivables data, on one page.
 *
 * The point is to choose: each card is a real question answered with real
 * figures in a different form, so the ones worth keeping can be picked by
 * looking at them rather than argued about in the abstract.
 *
 * House rules this page follows, and the reasons:
 *
 * - **Plain shadcn.** ChartContainer, Recharts, `var(--chart-N)`. No project
 *   chart layer, no shared label helpers, no motion hook.
 * - **Square.** `--radius` is 0 and base-lyra uses `rounded-none` throughout;
 *   a rounded bar was the one soft edge in the whole product.
 * - **Slim.** Bars are capped well below Recharts' default, which fills the
 *   band and reads as a block of colour rather than a measurement.
 * - **Read without hovering.** Every mark carries its value, and every set of
 *   two or more series carries a legend, so identity is never colour alone.
 *
 * The series and every threshold their sentences turn on live in
 * `dashboard-v2.series.ts` and are tested there. Nothing here computes a
 * figure: a chart cannot be rendered in jsdom, and its arithmetic must not be
 * the part that cannot be checked.
 */

const MONEY = (value: unknown): string => (typeof value === 'number' ? formatMoneyShort(value) : '');
const COUNT = (value: unknown): string => (typeof value === 'number' ? formatCount(value) : '');
const PERCENT = (value: unknown): string => (typeof value === 'number' ? `${String(value)}%` : '');
const DAYS = (value: unknown): string => (typeof value === 'number' ? `${formatCount(value)}d` : '');
/** Recharts hands a tooltip label in as ReactNode, so the month key has to be
 *  narrowed before `monthLabel` will take it. */
const MONTH_TIP = (label: unknown): string => (typeof label === 'string' ? monthLabel(label) : '');

/**
 * A row's name, cut to what the axis gutter holds.
 *
 * Names used to be written inside the bar, and Recharts wraps an over-long
 * label onto further lines which the bar then clips -- "Nashik Switchgear
 * Traders" arrived as three half-visible rows inside a 26px bar. A category
 * axis has a width the name can be measured against and cannot be cropped by
 * the mark, so the name sits outside and the bar carries only its figure.
 */
const NAME_MAX = 18;
const NAME_GUTTER = 132;
const CLIP = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.length <= NAME_MAX ? value : `${value.slice(0, NAME_MAX - 1).trimEnd()}\u2026`;
};

/**
 * A shade per row.
 *
 * A ranked chart in one flat colour throws away the ramp; stepping through it
 * gives the eye an order to follow down the rows.
 */
const shade = (index: number): string => `var(--chart-${String((index % 5) + 1)})`;
const withShades = <T,>(points: readonly T[]): (T & { fill: string })[] =>
  points.map((point, index) => ({ ...point, fill: shade(index) }));

/** Square, because the theme is. */
const SHARP = 0;
/** A bar is a measurement, not a block of colour. */
const BAR = 16;

function ChartSkeleton() {
  return <Skeleton className="aspect-video w-full" />;
}

function ChartCard({
  title,
  description,
  report,
  query,
  state,
  insight,
  footnote,
  wide,
  children,
}: {
  title: string;
  description: string;
  report: ReportKey;
  query?: string;
  state: { isPending: boolean; isError: boolean; hasPoints: boolean };
  insight: string | null;
  footnote?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Card className={wide === true ? 'lg:col-span-2' : undefined}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigate(`/reports?report=${report}${query ?? ''}`);
            }}
          >
            Open report
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </CardAction>
      </CardHeader>
      {/* Never `flex` here. ChartContainer measures itself with a Recharts
          ResponsiveContainer, and a flex child with no basis resolves to zero
          width -- the pie and the donut rendered as empty cards with a correct
          header and footer around nothing. `mx-auto` on the container is what
          centres it. */}
      <CardContent>
        {state.isPending ? <ChartSkeleton /> : null}
        {state.isError ? (
          <p className="text-muted-foreground py-8 text-sm">
            This report did not come back. Open it to see why.
          </p>
        ) : null}
        {!state.isPending && !state.isError && !state.hasPoints ? (
          <p className="text-muted-foreground py-8 text-sm">Nothing in this period.</p>
        ) : null}
        {!state.isPending && !state.isError && state.hasPoints ? children : null}
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 text-sm">
        {insight === null ? null : <p className="leading-snug font-medium text-pretty">{insight}</p>}
        {footnote === undefined ? null : (
          <div className="text-muted-foreground leading-snug text-pretty">{footnote}</div>
        )}
      </CardFooter>
    </Card>
  );
}

const VALUE_CONFIG = { value: { label: 'Value', color: 'var(--chart-1)' } } satisfies ChartConfig;
const LINES_CONFIG = { value: { label: 'Lines', color: 'var(--chart-3)' } } satisfies ChartConfig;
const QTY_CONFIG = { value: { label: 'Quantity', color: 'var(--chart-4)' } } satisfies ChartConfig;
const SPLIT_CONFIG = {
  repeatRevenue: { label: 'Returning', color: 'var(--chart-1)' },
  newRevenue: { label: 'First time', color: 'var(--chart-2)' },
} satisfies ChartConfig;
const SHARE_CONFIG = {
  cumulative: { label: 'Running share', color: 'var(--chart-2)' },
} satisfies ChartConfig;
const SLIPPAGE_CONFIG = {
  value: { label: 'Days past terms', color: 'var(--chart-3)' },
} satisfies ChartConfig;
const HEADROOM_CONFIG = {
  value: { label: 'Limit used', color: 'var(--chart-5)' },
} satisfies ChartConfig;
const FILL_CONFIG = {
  value: { label: 'Filled', color: 'var(--chart-1)' },
  shortfall: { label: 'Still owed', color: 'var(--chart-5)' },
} satisfies ChartConfig;
const SEASON_CONFIG = {
  value: { label: 'Invoiced', color: 'var(--chart-2)' },
} satisfies ChartConfig;
const MIX_CONFIG = {
  value: { label: 'Invoiced', color: 'var(--chart-1)' },
  trend: { label: 'At the average bill', color: 'var(--chart-4)' },
} satisfies ChartConfig;
const BASKET_CONFIG = {
  revenue: { label: 'Revenue', color: 'var(--chart-1)' },
  aov: { label: 'Average invoice', color: 'var(--chart-2)' },
} satisfies ChartConfig;

/** Ageing and lapse both need a slot per slice; keys are slugs so
 *  `--color-<key>` is a legal custom property. */
const AGE_SLUGS = ['age0', 'age31', 'age61', 'age90'] as const;
const AGEING_CONFIG = {
  value: { label: 'Outstanding' },
  age0: { label: '0-30 days', color: 'var(--slice-1)' },
  age31: { label: '31-60 days', color: 'var(--slice-2)' },
  age61: { label: '61-90 days', color: 'var(--slice-3)' },
  age90: { label: 'Over 90 days', color: 'var(--slice-4)' },
} satisfies ChartConfig;
const RISK_CONFIG = {
  value: { label: 'Revenue' },
  lapsed: { label: 'Lapsed', color: 'var(--slice-1)' },
  atRisk: { label: 'At risk', color: 'var(--slice-3)' },
} satisfies ChartConfig;

export function ReportsDashboardV2() {
  const navigate = useNavigate();
  const canView = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [basketMeasure, setBasketMeasure] = useState<'revenue' | 'aov'>('revenue');

  const from = range.from === undefined ? undefined : asApiDate(range.from);
  const to = range.to === undefined ? undefined : asApiDate(range.to);
  const period = from !== undefined && to !== undefined ? { from, to } : {};
  const page = { page: 1, pageSize: 200 } as const;
  const on = { enabled: canView };

  const byMonth = useReportRows('sales-analysis', { ...page, ...period, groupBy: 'month' }, on);
  const byParty = useReportRows('sales-analysis', { ...page, ...period, groupBy: 'party' }, on);
  const ageing = useReportRows('ageing', page, on);
  const mix = useReportRows('new-vs-repeat', { ...page, ...period }, on);
  const aov = useReportRows('aov-trend', { ...page, ...period }, on);
  const spread = useReportRows('customer-concentration', { ...page, ...period }, on);
  const paying = useReportRows('payment-analysis', page, on);
  const filling = useReportRows('order-fill-rate', { ...page, ...period }, on);
  const waiting = useReportRows('pending-dispatch', page, on);
  const shelf = useReportRows('stock-ageing', page, on);
  const quiet = useReportRows('customer-lapse', page, on);
  const credit = useReportRows('credit-cycle', page, on);
  const breaches = useReportRows('credit-breaches', page, on);
  const dead = useReportRows('dead-stock', page, on);
  const lowStock = useReportRows('low-stock', page, on);

  if (!canView) {
    return <PageHeader description="This dashboard needs permission to see receivables." />;
  }

  const open = (query: string): void => {
    void navigate(`/reports?${query}`);
  };

  const thisMonth = asApiDate(new Date()).slice(0, 7);
  const monthRows = byMonth.data?.data ?? [];
  const invoiced = series.monthlyInvoiced(monthRows, thisMonth);
  const season = series.seasonality(monthRows);
  const partyRows = byParty.data?.data ?? [];
  const customers = series.topCustomers(partyRows);
  const scatter = series.invoiceMix(partyRows);
  const owed = series.ageingByBucket(ageing.data?.data ?? []);
  const firstTime = series.newVsRepeat(mix.data?.data ?? []);
  const basket = series.revenueAndBasket(aov.data?.data ?? []);
  const fewness = series.concentration(spread.data?.data ?? []);
  const slippage = series.paymentSlippage(paying.data?.data ?? []);
  const served = series.fillRate(filling.data?.data ?? []);
  const backlog = series.pendingByAge(waiting.data?.data ?? []);
  const stock = series.stockAgeing(shelf.data?.data ?? []);
  const risk = series.revenueAtRisk(quiet.data?.data ?? []);
  const exposure = series.creditHeadroom(credit.data?.data ?? []);

  // The six headline figures. Sums of the same rows the charts below draw, so
  // a tile and the chart under it can never disagree.
  // A tile states a figure for the whole report, so it reads the total the
  // server sums over every row -- adding up the two hundred rows a page
  // carries, beneath a caption naming every debtor there is, stated a number
  // belonging to nobody. The page sum remains the fallback for a response
  // that predates the total.
  const wholeReport = (meta: { totals?: Readonly<Record<string, string>> } | undefined, key: string, fallback: number): number => {
    const stated = meta?.totals?.[key];
    return stated === undefined ? fallback : Number(stated);
  };
  const totalExposure = wholeReport(credit.data?.meta, 'exposure', series.sumColumn(credit.data?.data ?? [], 'exposure'));
  const quietRevenue = wholeReport(quiet.data?.meta, 'revenue12m', series.quietRevenue(quiet.data?.data ?? []));
  const deadValue = wholeReport(dead.data?.meta, 'valueLocked', series.sumColumn(dead.data?.data ?? [], 'valueLocked'));

  const stateOf = (
    query: { isPending: boolean; isError: boolean },
    points: readonly unknown[],
  ): { isPending: boolean; isError: boolean; hasPoints: boolean } => ({
    isPending: query.isPending,
    isError: query.isError,
    hasPoints: points.length > 0,
  });

  // Slice data carries its own fill, which is how the shadcn pie examples do
  // it and the only way a Pie can colour per slice rather than per series.
  const agePie = owed.points.map((slice, index) => ({
    bucket: AGE_SLUGS[index] ?? 'age0',
    value: slice.value,
    fill: `var(--color-${AGE_SLUGS[index] ?? 'age0'})`,
  }));
  const riskPie = risk.points.map((slice) => {
    const key = slice.label === 'Lapsed' ? 'lapsed' : 'atRisk';
    return { state: key, value: slice.value, fill: `var(--color-${key})` };
  });
  const riskTotal = risk.points.reduce((sum, p) => sum + p.value, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader description="Every chart shape shadcn ships, over the receivables data. One card per question, the figure on the mark, the sentence underneath." />

      <div className="flex flex-wrap items-center gap-2">
        <DateRangeField
          value={range}
          onValueChange={setRange}
          label="Period"
          presets={DASHBOARD_PRESETS}
          className="w-full sm:w-auto"
        />
      </div>

      {/* Three across, not six. Six in a row made a wall of figures nobody
          reads left to right, and each tile was too narrow for a rupee amount
          without wrapping. */}
      <KpiGrid
        tiles={[
          { label: 'Invoiced this period', value: formatMoney(invoiced.total), note: `Across ${String(invoiced.points.length)} month${invoiced.points.length === 1 ? '' : 's'}`, onOpen: () => { open('report=sales-analysis&groupBy=month'); } },
          { label: 'Receivables exposure', value: formatMoney(totalExposure), note: `${formatCount(credit.data?.meta.total ?? 0)} debtors, from the credit cycle`, onOpen: () => { open('report=credit-cycle'); } },
          { label: 'Over the credit limit', value: formatCount(breaches.data?.meta.total ?? 0), note: 'Parties past their limit right now', onOpen: () => { open('report=credit-breaches'); } },
          { label: 'Revenue going quiet', value: formatMoney(quietRevenue), note: 'Last twelve months from lapsed and at-risk customers', onOpen: () => { open('report=customer-lapse'); } },
          { label: 'Dead stock value', value: formatMoney(deadValue), note: `${formatCount(dead.data?.meta.total ?? 0)} items with no sale in ninety days`, onOpen: () => { open('report=dead-stock'); } },
          { label: 'Below reorder level', value: formatCount(lowStock.data?.meta.total ?? 0), note: 'Items at or under reorder, net of open purchase orders', onOpen: () => { open('report=low-stock'); } },
        ]}
      />

      {/* Interactive line, full width: two measures over the same months, one
          at a time, with the period's totals as the switch. */}
      <Card className="py-4 sm:py-0">
        <CardHeader className="flex flex-col items-stretch border-b p-0! sm:flex-row">
          <div className="flex flex-1 flex-col justify-center gap-1 px-6 pb-3 sm:pb-0">
            <CardTitle>Revenue against the average invoice</CardTitle>
            <CardDescription>
              They move apart when the customer count changes, which is the thing worth catching.
            </CardDescription>
          </div>
          <div className="flex">
            {/* shadcn's own example uses a raw <button> for these; CLAUDE.md
                section 3 does not allow one in feature code, and the Button
                primitive takes the same classes. */}
            {(['revenue', 'aov'] as const).map((key) => (
              <Button
                key={key}
                variant="ghost"
                data-active={basketMeasure === key}
                aria-pressed={basketMeasure === key}
                className="data-[active=true]:bg-muted/50 h-auto flex-1 flex-col items-start justify-center gap-1 rounded-none border-t px-6 py-4 text-left even:border-l sm:border-t-0 sm:border-l sm:px-8 sm:py-6"
                onClick={() => {
                  setBasketMeasure(key);
                }}
              >
                <span className="text-muted-foreground text-xs">{BASKET_CONFIG[key].label}</span>
                <span className="text-lg leading-none font-bold sm:text-3xl">
                  {formatMoneyShort(basket.totals[key])}
                </span>
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="px-2 sm:p-6">
          {aov.isPending ? <ChartSkeleton /> : null}
          {aov.isSuccess && basket.points.length > 0 ? (
            <ChartContainer config={BASKET_CONFIG} className="aspect-auto h-[250px] w-full">
              <LineChart accessibilityLayer data={[...basket.points]} margin={{ left: 12, right: 12 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={monthLabel}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent className="w-[190px]" labelFormatter={MONTH_TIP} formatter={MONEY} />
                  }
                />
                <Line
                  dataKey={basketMeasure}
                  type="monotone"
                  stroke={`var(--color-${basketMeasure})`}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ChartContainer>
          ) : null}
        </CardContent>
        <CardFooter className="text-sm">
          {basket.insight === null ? null : (
            <p className="leading-snug font-medium text-pretty">{basket.insight}</p>
          )}
        </CardFooter>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Invoiced by month"
          description="Bar. Where the value landed, month by month"
          report="sales-analysis"
          query="&groupBy=month"
          state={stateOf(byMonth, invoiced.points)}
          insight={invoiced.insight}
          footnote={`${formatMoney(invoiced.total)} across ${String(invoiced.points.length)} month${invoiced.points.length === 1 ? '' : 's'}`}
        >
          <ChartContainer config={VALUE_CONFIG}>
            <BarChart accessibilityLayer data={[...invoiced.points]} margin={{ top: 20 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={monthLabel} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="value" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR}>
                <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={MONEY} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Where the revenue comes from"
          description="Horizontal bar with labels. Top five customers"
          report="sales-analysis"
          query="&groupBy=party"
          state={stateOf(byParty, customers.points)}
          insight={customers.insight}
          footnote={
            customers.tailCount > 0
              ? `${formatMoney(customers.tailValue)} more came from ${String(customers.tailCount)} other customers`
              : `${String(customers.points.length)} customers invoiced`
          }
        >
          <ChartContainer config={VALUE_CONFIG}>
            <BarChart accessibilityLayer data={withShades(customers.points)} layout="vertical" margin={{ right: 72 }}>
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="label"
                type="category"
                tickLine={false}
                axisLine={false}
                width={NAME_GUTTER}
                tickFormatter={CLIP}
                className="fill-muted-foreground"
              />
              <XAxis dataKey="value" type="number" hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <Bar dataKey="value" radius={SHARP} maxBarSize={BAR}>
                <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={MONEY} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="What is owed, by age"
          description="Pie with labels. Open bills, from the bill date"
          report="ageing"
          state={stateOf(ageing, agePie)}
          insight={owed.insight}
          footnote={`${formatMoney(owed.total)} outstanding in total`}
        >
          <ChartContainer
            config={AGEING_CONFIG}
            className="[&_.recharts-pie-label-text]:fill-foreground mx-auto aspect-square max-h-[260px]"
          >
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie data={agePie} dataKey="value" nameKey="bucket" label={({ value }) => MONEY(value)} />
              <ChartLegend content={<ChartLegendContent nameKey="bucket" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
            </PieChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Revenue that has gone quiet"
          description="Donut with a centre figure. Last year's value from customers who stopped or slowed"
          report="customer-lapse"
          state={stateOf(quiet, riskPie)}
          insight={risk.insight}
          footnote={`${formatMoney(riskTotal)} of last year's revenue sits behind these customers`}
        >
          <ChartContainer config={RISK_CONFIG} className="mx-auto aspect-square max-h-[260px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie data={riskPie} dataKey="value" nameKey="state" innerRadius={62} strokeWidth={4}>
                <LabelList dataKey="value" className="fill-background" stroke="none" fontSize={11} formatter={MONEY} />
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="state" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
            </PieChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="New money against returning money"
          description="Stacked bar. Split by whether the customer had been billed before"
          report="new-vs-repeat"
          state={stateOf(mix, firstTime.points)}
          insight={firstTime.insight}
        >
          <ChartContainer config={SPLIT_CONFIG}>
            <BarChart accessibilityLayer data={[...firstTime.points]} margin={{ top: 20 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={monthLabel} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
              <Bar dataKey="repeatRevenue" stackId="m" fill="var(--color-repeatRevenue)" radius={SHARP} maxBarSize={BAR} />
              <Bar dataKey="newRevenue" stackId="m" fill="var(--color-newRevenue)" radius={SHARP} maxBarSize={BAR} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="How few customers carry the book"
          description="Area. Running share of revenue, largest customer first"
          report="customer-concentration"
          state={stateOf(spread, fewness.points)}
          insight={fewness.insight}
        >
          <ChartContainer config={SHARE_CONFIG}>
            <AreaChart accessibilityLayer data={[...fewness.points]} margin={{ top: 20, left: 4, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} hide />
              <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={40} tickFormatter={PERCENT} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Area
                dataKey="cumulative"
                type="monotone"
                stroke="var(--color-cumulative)"
                fill="var(--color-cumulative)"
                fillOpacity={0.2}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="The trading year, folded"
          description="Bar. Every January together, every February together"
          report="sales-analysis"
          query="&groupBy=month"
          state={stateOf(byMonth, season.points)}
          insight={season.insight}
        >
          {/* Twelve columns rather than a radar. A radar makes the eye compare
              the areas of twelve wedges, which nobody can do; twelve bars on a
              common baseline is the comparison the question actually asks. */}
          <ChartContainer config={SEASON_CONFIG}>
            <BarChart accessibilityLayer data={withShades(season.points)} margin={{ top: 20 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} interval={0} fontSize={10} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="value" radius={SHARP} maxBarSize={BAR}>
                <LabelList position="top" offset={8} className="fill-foreground" fontSize={9} formatter={MONEY} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="How much of the order book went out"
          description="Stacked bar. What was filled against what is still owed"
          report="order-fill-rate"
          state={stateOf(filling, served.points)}
          insight={served.insight}
        >
          {/* Both halves on one bar. A ring, or a bar that simply stops at
              40%, leaves the reader to work out that the other 60% is the
              story. */}
          <ChartContainer config={FILL_CONFIG}>
            <BarChart accessibilityLayer data={[...served.points]} layout="vertical" margin={{ right: 56 }}>
              <CartesianGrid horizontal={false} />
              <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
              <XAxis type="number" domain={[0, 100]} hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent className="w-full flex-wrap justify-center gap-x-4" />} />
              <Bar dataKey="value" stackId="fill" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR}>
                <LabelList dataKey="value" position="insideLeft" offset={8} className="fill-background" fontSize={10} formatter={PERCENT} />
              </Bar>
              <Bar dataKey="shortfall" stackId="fill" fill="var(--color-shortfall)" radius={SHARP} maxBarSize={BAR} />
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="How often against how much"
          description="Scatter with a trend line. Every customer against what they would be worth at the average bill"
          report="sales-analysis"
          query="&groupBy=party"
          state={stateOf(byParty, scatter.points)}
          insight={scatter.insight}
        >
          <ChartContainer config={MIX_CONFIG}>
            <ComposedChart
              accessibilityLayer
              data={[...scatter.points]}
              margin={{ top: 20, left: 4, right: 16, bottom: 12 }}
            >
              <CartesianGrid />
              <XAxis
                type="number"
                dataKey="invoices"
                name="Invoices"
                tickLine={false}
                axisLine={false}
                tickFormatter={COUNT}
              />
              <YAxis
                type="number"
                dataKey="value"
                name="Value"
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={MONEY}
              />
              <ChartTooltip cursor={{ strokeDasharray: '3 3' }} content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
              {/* The line is what makes the dots mean something: it is what a
                  customer would be worth at the book's average bill, so above
                  it is bigger bills and below it is more of them. */}
              <Line
                dataKey="trend"
                type="linear"
                stroke="var(--color-trend)"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                activeDot={false}
              />
              <Scatter dataKey="value" fill="var(--color-value)" />
            </ComposedChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="Who pays late"
          description="Horizontal bar. Days beyond agreed terms, worst first"
          report="payment-analysis"
          state={stateOf(paying, slippage.points)}
          insight={slippage.insight}
        >
          <ChartContainer config={SLIPPAGE_CONFIG}>
            <BarChart accessibilityLayer data={withShades(slippage.points)} layout="vertical" margin={{ right: 64 }}>
              <CartesianGrid horizontal={false} />
              <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
              <XAxis dataKey="value" type="number" hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <Bar dataKey="value" radius={SHARP} maxBarSize={BAR}>
                <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={DAYS} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="What is waiting to go out"
          description="Step area. Open order lines, by how long they have waited"
          report="pending-dispatch"
          state={stateOf(waiting, backlog.points)}
          insight={backlog.insight}
        >
          <ChartContainer config={LINES_CONFIG}>
            <AreaChart accessibilityLayer data={[...backlog.points]} margin={{ top: 20, left: 4, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Area
                dataKey="value"
                type="step"
                stroke="var(--color-value)"
                fill="var(--color-value)"
                fillOpacity={0.2}
                strokeWidth={2}
              >
                <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={COUNT} />
              </Area>
            </AreaChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="How long the shelf has held it"
          description="Bar. Quantity on hand, by age"
          report="stock-ageing"
          state={stateOf(shelf, stock.points)}
          insight={stock.insight}
        >
          <ChartContainer config={QTY_CONFIG}>
            <BarChart accessibilityLayer data={[...stock.points]} margin={{ top: 20 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="value" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR}>
                <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={COUNT} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>

        <ChartCard
          title="How much of the credit line is used"
          description="Horizontal bar. Exposure against limit, heaviest first"
          report="credit-cycle"
          state={stateOf(credit, exposure.points)}
          insight={exposure.insight}
        >
          <ChartContainer config={HEADROOM_CONFIG}>
            <BarChart accessibilityLayer data={withShades(exposure.points)} layout="vertical" margin={{ right: 64 }}>
              <CartesianGrid horizontal={false} />
              <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
              <XAxis dataKey="value" type="number" hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <Bar dataKey="value" radius={SHARP} maxBarSize={BAR}>
                <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={PERCENT} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </ChartCard>
      </div>
    </div>
  );
}
