import { useState, type ReactNode } from 'react';
import { ArrowRightIcon, LockKeyIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import { DASHBOARD_KEYS, isDashboardKey, isReportKey, PERMISSIONS } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';
import { useNavigate, useSearchParams } from 'react-router';
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

import { ChartCard } from '@/components/shared/chart-card';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { TabsToolbar, TabsToolbarAction } from '@/components/shared/tabs-toolbar';
import { CHART_INTRO_MS, useChartIntro } from '@/components/shared/use-chart-motion';
import { Button } from '@/components/ui/button';
import { CardAction } from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DateRangeField } from '@/features/attendance/pickers';
import { formatCount, formatMoney, formatMoneyShort } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { periodParams } from './period';
import { useReportRows } from './api';
import { monthLabel } from './dashboard-v2.format';
import { asApiDate, DASHBOARD_PRESETS, defaultRange } from './dashboard-v2.presets';
import * as series from './dashboard-v2.series';
import { boardFromParam, boardToParam, FINANCE_PRESET, OVERVIEW_SEED, SALES_PRESET } from './dashboard-boards';
import { DashboardCustomiseSheet } from './dashboard-customise';
import { TileGrid } from './dashboard-tiles';
import { useDashboardLayouts } from './use-dashboard-layouts';

/**
 * Every chart shape shadcn ships, over the receivables data, on one page.
 *
 * The point is to choose: each card is a real question answered with real
 * figures in a different form, so the ones worth keeping can be picked by
 * looking at them rather than argued about in the abstract.
 *
 * House rules this page follows, and the reasons:
 *
 * - **The shared surfaces.** Every card is the shared ChartCard, the figures
 *   are KpiGrid, and motion is the shared intro hook — one draw when a
 *   query's first data lands, nothing on re-render, nothing under reduced
 *   motion. This page once carried its own copies of all three, which is how
 *   it drifted from the rest of the product.
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
  return value.length <= NAME_MAX ? value : `${value.slice(0, NAME_MAX - 1).trimEnd()}…`;
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

/** The house chart heights: standard for a half-width card, tall for a wide one. */
const CHART_H = 'aspect-auto h-48 w-full min-w-0 sm:h-56';
const CHART_H_TALL = 'aspect-auto h-56 w-full min-w-0 sm:h-64';

/** Draw once when the query's first data lands (the shared motion policy). */
const motion = (intro: boolean): { isAnimationActive: boolean; animationDuration: number } => ({
  isAnimationActive: intro,
  animationDuration: CHART_INTRO_MS,
});

/** The card's in-place error line: quiet, because the report itself has the full story. */
const FAILED_NOTE = 'This report did not come back. Open it to see why.';

const cardState = (
  query: { isPending: boolean; isError: boolean },
  points: readonly unknown[],
): { pending: boolean; empty: boolean; emptyNote: string } => ({
  pending: query.isPending,
  empty: query.isError || points.length === 0,
  emptyNote: query.isError ? FAILED_NOTE : 'Nothing in this period.',
});

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

const BOARD_LABELS: Record<(typeof DASHBOARD_KEYS)[number], string> = {
  overview: 'Overview',
  sales: 'Sales',
  finance: 'Finance',
};

const BOARD_DESCRIPTIONS: Record<(typeof DASHBOARD_KEYS)[number], string> = {
  overview:
    'Every chart shape shadcn ships, over the receivables data. One card per question, the figure on the mark, the sentence underneath.',
  sales: 'The sales story over one period: what was invoiced, to whom, and how the order book moved.',
  finance: 'The money story: what is owed, how old it is, who pays late, and where the risk sits.',
};

/** The permission refusal, standing where the board would: the same Empty every screen refuses with. */
function RefusedEmpty({ description }: { description: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LockKeyIcon />
        </EmptyMedia>
        <EmptyTitle>Not yours to see</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Six figures wide, so the label set is stable while the strip loads. */
const SKELETON_TILES = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

/** The shapes the board resolves into: the headline strip, then the chart grid. */
function BoardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading the dashboard"
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {SKELETON_TILES.map((key) => (
          <Skeleton key={key} className="h-22 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 w-full sm:h-64" />
        <Skeleton className="h-56 w-full sm:h-64" />
      </div>
    </div>
  );
}

export function ReportsDashboardV2() {
  const [searchParams, setSearchParams] = useSearchParams();
  const board = boardFromParam(searchParams.get('board'));
  // The overview keeps its receivables gate; the sales and finance boards are
  // built from report tiles, and the catalogue and rows endpoints already
  // answer per permission -- so `report.view` is their whole ticket.
  const canOverview = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const canBoards = usePermission(PERMISSIONS.REPORT_VIEW);
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [customising, setCustomising] = useState(false);
  const layouts = useDashboardLayouts(canBoards);

  const stored = layouts.data?.find((view) => view.dashboard === board)?.config ?? null;
  const preset = board === 'sales' ? SALES_PRESET : board === 'finance' ? FINANCE_PRESET : null;
  const layout = stored ?? preset;
  const refused = board === 'overview' ? !canOverview : !canBoards;

  const switchBoard = (next: string): void => {
    if (!isDashboardKey(next)) return;
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const value = boardToParam(next);
      if (value === null) params.delete('board');
      else params.set('board', value);
      return params;
    });
  };

  return (
    <>
      <PageHeader description={BOARD_DESCRIPTIONS[board]} />

      <Tabs
        value={board}
        onValueChange={(value) => {
          switchBoard(String(value));
        }}
        className="gap-4"
      >
        <TabsToolbar
          list={
            <TabsList>
              {DASHBOARD_KEYS.map((key) => (
                <TabsTrigger key={key} value={key} className="px-3">
                  {BOARD_LABELS[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        >
          <TabsToolbarAction>
            <DateRangeField
              value={range}
              onValueChange={setRange}
              label="Period"
              presets={DASHBOARD_PRESETS}
              className="w-full sm:w-auto"
            />
            {canBoards ? (
              <Button
                variant="outline"
                onClick={() => {
                  setCustomising(true);
                }}
              >
                <SlidersHorizontalIcon data-icon="inline-start" />
                Customise
              </Button>
            ) : null}
          </TabsToolbarAction>

          {refused ? (
            <RefusedEmpty
              description={
                board === 'overview'
                  ? 'This dashboard needs permission to see receivables. Ask an administrator to widen your reports.'
                  : 'This board needs permission to view reports. Ask an administrator to widen your reports.'
              }
            />
          ) : canBoards && layouts.isLoading ? (
            <BoardSkeleton />
          ) : layout !== null ? (
            <TileGrid layout={layout} range={range} />
          ) : board === 'overview' ? (
            <OverviewCharts range={range} />
          ) : null}
        </TabsToolbar>
      </Tabs>

      {canBoards && !refused ? (
        <DashboardCustomiseSheet
          board={board}
          open={customising}
          onOpenChange={setCustomising}
          // Only the overview's layout can be null (its default render is the
          // bespoke page); its sheet drafts from the seed of all six headline
          // figures, so customising never silently drops them.
          current={layout ?? OVERVIEW_SEED}
          hasStored={stored !== null}
          range={range}
        />
      ) : null}
    </>
  );
}

function OverviewCharts({ range }: { range: DateRange }) {
  const navigate = useNavigate();
  const canView = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
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

  // One intro per query: a chart draws itself once when its own data first
  // lands, and two charts on one query share the one moment of arrival.
  const monthIntro = useChartIntro(byMonth.isSuccess);
  const partyIntro = useChartIntro(byParty.isSuccess);
  const ageingIntro = useChartIntro(ageing.isSuccess);
  const mixIntro = useChartIntro(mix.isSuccess);
  const aovIntro = useChartIntro(aov.isSuccess);
  const spreadIntro = useChartIntro(spread.isSuccess);
  const payingIntro = useChartIntro(paying.isSuccess);
  const fillingIntro = useChartIntro(filling.isSuccess);
  const waitingIntro = useChartIntro(waiting.isSuccess);
  const shelfIntro = useChartIntro(shelf.isSuccess);
  const quietIntro = useChartIntro(quiet.isSuccess);
  const creditIntro = useChartIntro(credit.isSuccess);

  if (!canView) {
    return (
      <RefusedEmpty description="This dashboard needs permission to see receivables. Ask an administrator to widen your reports." />
    );
  }

  const open = (query: string): void => {
    // The period travels with the drill-through. Every one of these used to
    // drop it, so a reader who clicked a figure for one quarter landed on a
    // report showing its own default range -- the number they had just been
    // looking at was not on the screen they arrived at, and nothing said the
    // dates had changed. Bent into what the target can answer for, because a
    // month-only report handed a quarter shows an error instead of a report.
    const params = new URLSearchParams(query);
    const report = params.get('report');
    if (report !== null && isReportKey(report)) {
      for (const [key, value] of Object.entries(periodParams(report, range))) params.set(key, value);
    }
    void navigate(`/reports?${params.toString()}`);
  };

  // Through the shared card's action slot, so the drill rides the same period
  // bending as every other figure on the page.
  const openAction = (query: string): ReactNode => (
    <CardAction>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          open(query);
        }}
      >
        Open report
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
    </CardAction>
  );

  const thisMonth = asApiDate(new Date()).slice(0, 7);
  const monthRows = byMonth.data?.data ?? [];
  const invoiced = series.monthlyInvoiced(monthRows, thisMonth);
  const season = series.seasonality(monthRows, thisMonth);
  const partyRows = byParty.data?.data ?? [];
  const customers = series.topCustomers(partyRows, 5, (byParty.data?.meta.total ?? 0) > partyRows.length);
  const scatter = series.invoiceMix(partyRows);
  const owed = series.ageingByBucket(ageing.data?.data ?? []);
  const firstTime = series.newVsRepeat(mix.data?.data ?? []);
  const basket = series.revenueAndBasket(aov.data?.data ?? [], thisMonth);
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
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeading
          title="Headline figures"
          note="Sums of the same rows the charts draw, so a figure and its chart can never disagree."
        />
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
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading
          title="The period, charted"
          note="One question per card, the figure on the mark, the sentence underneath."
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Interactive line, full width: two measures over the same months,
              one at a time, with the period's totals as the switch. */}
          <ChartCard
            title="Revenue against the average invoice"
            description="Line. One measure at a time, over the period's months"
            wide
            action={openAction('report=aov-trend')}
            insight={basket.insight}
            footnote="They move apart when the customer count changes, which is the thing worth catching."
            {...cardState(aov, basket.points)}
          >
            <div className="grid gap-4">
              {/* A figure strip, not a second card pattern: the two period
                  totals are also the switch, so each cell is a Button wearing
                  the strip's cell geometry. */}
              <div className="grid grid-cols-2 divide-x border">
                {(['revenue', 'aov'] as const).map((key) => (
                  <Button
                    key={key}
                    variant="ghost"
                    data-active={basketMeasure === key}
                    aria-pressed={basketMeasure === key}
                    className="data-[active=true]:bg-muted/50 h-auto flex-col items-start gap-1 rounded-none px-3 py-2 text-left"
                    onClick={() => {
                      setBasketMeasure(key);
                    }}
                  >
                    <span className="text-muted-foreground text-xs">{BASKET_CONFIG[key].label}</span>
                    <span className="text-lg leading-tight font-semibold tabular-nums sm:text-xl">
                      {formatMoneyShort(basket.totals[key])}
                    </span>
                  </Button>
                ))}
              </div>
              <ChartContainer config={BASKET_CONFIG} className={CHART_H_TALL}>
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
                    {...motion(aovIntro)}
                  />
                </LineChart>
              </ChartContainer>
            </div>
          </ChartCard>

          <ChartCard
            title="Invoiced by month"
            description="Bar. Where the value landed, month by month"
            action={openAction('report=sales-analysis&groupBy=month')}
            insight={invoiced.insight}
            footnote={`${formatMoney(invoiced.total)} across ${String(invoiced.points.length)} month${invoiced.points.length === 1 ? '' : 's'}`}
            {...cardState(byMonth, invoiced.points)}
          >
            <ChartContainer config={VALUE_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={[...invoiced.points]} margin={{ top: 20 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={monthLabel} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="value" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR} {...motion(monthIntro)}>
                  <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={MONEY} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Where the revenue comes from"
            description="Horizontal bar with labels. Top five customers"
            action={openAction('report=sales-analysis&groupBy=party')}
            insight={customers.insight}
            footnote={
              customers.tailCount > 0
                ? `${formatMoney(customers.tailValue)} more came from ${String(customers.tailCount)} other customers`
                : `${String(customers.points.length)} customers invoiced`
            }
            {...cardState(byParty, customers.points)}
          >
            <ChartContainer config={VALUE_CONFIG} className={CHART_H}>
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
                <Bar dataKey="value" radius={SHARP} maxBarSize={BAR} {...motion(partyIntro)}>
                  <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={MONEY} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="What is owed, by age"
            description="Pie with labels. Open bills, from the bill date"
            action={openAction('report=ageing')}
            insight={owed.insight}
            footnote={`${formatMoney(owed.total)} outstanding in total`}
            {...cardState(ageing, agePie)}
          >
            {/* Round charts size by height and centre themselves; the width
                follows the square. */}
            <ChartContainer
              config={AGEING_CONFIG}
              className="[&_.recharts-pie-label-text]:fill-foreground mx-auto aspect-square h-56 max-w-full sm:h-64"
            >
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={agePie} dataKey="value" nameKey="bucket" label={({ value }) => MONEY(value)} {...motion(ageingIntro)} />
                <ChartLegend content={<ChartLegendContent nameKey="bucket" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
              </PieChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Revenue that has gone quiet"
            description="Donut with a centre figure. Last year's value from customers who stopped or slowed"
            action={openAction('report=customer-lapse')}
            insight={risk.insight}
            footnote={`${formatMoney(riskTotal)} of last year's revenue sits behind these customers`}
            {...cardState(quiet, riskPie)}
          >
            <ChartContainer config={RISK_CONFIG} className="mx-auto aspect-square h-56 max-w-full sm:h-64">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                <Pie data={riskPie} dataKey="value" nameKey="state" innerRadius={62} strokeWidth={4} {...motion(quietIntro)}>
                  <LabelList dataKey="value" className="fill-background" stroke="none" fontSize={11} formatter={MONEY} />
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="state" className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
              </PieChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="New money against returning money"
            description="Stacked bar. Split by whether the customer had been billed before"
            action={openAction('report=new-vs-repeat')}
            insight={firstTime.insight}
            {...cardState(mix, firstTime.points)}
          >
            <ChartContainer config={SPLIT_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={[...firstTime.points]} margin={{ top: 20 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} tickFormatter={monthLabel} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent className="w-full flex-wrap justify-center gap-x-4 gap-y-1" />} />
                <Bar dataKey="repeatRevenue" stackId="m" fill="var(--color-repeatRevenue)" radius={SHARP} maxBarSize={BAR} {...motion(mixIntro)} />
                <Bar dataKey="newRevenue" stackId="m" fill="var(--color-newRevenue)" radius={SHARP} maxBarSize={BAR} {...motion(mixIntro)} />
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="How few customers carry the book"
            description="Area. Running share of revenue, largest customer first"
            action={openAction('report=customer-concentration')}
            insight={fewness.insight}
            {...cardState(spread, fewness.points)}
          >
            <ChartContainer config={SHARE_CONFIG} className={CHART_H}>
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
                  {...motion(spreadIntro)}
                />
              </AreaChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="The trading year, folded"
            description="Bar. Every January together, every February together"
            action={openAction('report=sales-analysis&groupBy=month')}
            insight={season.insight}
            {...cardState(byMonth, season.points)}
          >
            {/* Twelve columns rather than a radar. A radar makes the eye compare
                the areas of twelve wedges, which nobody can do; twelve bars on a
                common baseline is the comparison the question actually asks. */}
            <ChartContainer config={SEASON_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={withShades(season.points)} margin={{ top: 20 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} interval={0} fontSize={10} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="value" radius={SHARP} maxBarSize={BAR} {...motion(monthIntro)}>
                  <LabelList position="top" offset={8} className="fill-foreground" fontSize={9} formatter={MONEY} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="How much of the order book went out"
            description="Stacked bar. What was filled against what is still owed"
            action={openAction('report=order-fill-rate')}
            insight={served.insight}
            {...cardState(filling, served.points)}
          >
            {/* Both halves on one bar. A ring, or a bar that simply stops at
                40%, leaves the reader to work out that the other 60% is the
                story. */}
            <ChartContainer config={FILL_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={[...served.points]} layout="vertical" margin={{ right: 56 }}>
                <CartesianGrid horizontal={false} />
                <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
                <XAxis type="number" domain={[0, 100]} hide />
                <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent className="w-full flex-wrap justify-center gap-x-4" />} />
                <Bar dataKey="value" stackId="fill" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR} {...motion(fillingIntro)}>
                  <LabelList dataKey="value" position="insideLeft" offset={8} className="fill-background" fontSize={10} formatter={PERCENT} />
                </Bar>
                <Bar dataKey="shortfall" stackId="fill" fill="var(--color-shortfall)" radius={SHARP} maxBarSize={BAR} {...motion(fillingIntro)} />
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="How often against how much"
            description="Scatter with a trend line. Every customer against what they would be worth at the average bill"
            action={openAction('report=sales-analysis&groupBy=party')}
            insight={scatter.insight}
            {...cardState(byParty, scatter.points)}
          >
            <ChartContainer config={MIX_CONFIG} className={CHART_H}>
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
                  {...motion(partyIntro)}
                />
                <Scatter dataKey="value" fill="var(--color-value)" {...motion(partyIntro)} />
              </ComposedChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Who pays late"
            description="Horizontal bar. Days beyond agreed terms, worst first"
            action={openAction('report=payment-analysis')}
            insight={slippage.insight}
            {...cardState(paying, slippage.points)}
          >
            <ChartContainer config={SLIPPAGE_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={withShades(slippage.points)} layout="vertical" margin={{ right: 64 }}>
                <CartesianGrid horizontal={false} />
                <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
                <XAxis dataKey="value" type="number" hide />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                <Bar dataKey="value" radius={SHARP} maxBarSize={BAR} {...motion(payingIntro)}>
                  <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={DAYS} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="What is waiting to go out"
            description="Step area. Open order lines, by how long they have waited"
            action={openAction('report=pending-dispatch')}
            insight={backlog.insight}
            {...cardState(waiting, backlog.points)}
          >
            <ChartContainer config={LINES_CONFIG} className={CHART_H}>
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
                  {...motion(waitingIntro)}
                >
                  <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={COUNT} />
                </Area>
              </AreaChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="How long the shelf has held it"
            description="Bar. Quantity on hand, by age"
            action={openAction('report=stock-ageing')}
            insight={stock.insight}
            {...cardState(shelf, stock.points)}
          >
            <ChartContainer config={QTY_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={[...stock.points]} margin={{ top: 20 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} tickMargin={10} axisLine={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                <Bar dataKey="value" fill="var(--color-value)" radius={SHARP} maxBarSize={BAR} {...motion(shelfIntro)}>
                  <LabelList position="top" offset={10} className="fill-foreground" fontSize={11} formatter={COUNT} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="How much of the credit line is used"
            description="Horizontal bar. Exposure against limit, heaviest first"
            action={openAction('report=credit-cycle')}
            insight={exposure.insight}
            {...cardState(credit, exposure.points)}
          >
            <ChartContainer config={HEADROOM_CONFIG} className={CHART_H}>
              <BarChart accessibilityLayer data={withShades(exposure.points)} layout="vertical" margin={{ right: 64 }}>
                <CartesianGrid horizontal={false} />
                <YAxis dataKey="label" type="category" tickLine={false} axisLine={false} width={NAME_GUTTER} tickFormatter={CLIP} className="fill-muted-foreground" />
                <XAxis dataKey="value" type="number" hide />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                <Bar dataKey="value" radius={SHARP} maxBarSize={BAR} {...motion(creditIntro)}>
                  <LabelList dataKey="value" position="right" offset={8} className="fill-foreground" fontSize={11} formatter={PERCENT} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>
        </div>
      </section>
    </div>
  );
}
