import { CubeIcon, LightbulbIcon } from '@phosphor-icons/react';
import { Link, useNavigate, useParams } from 'react-router';

import { ChartCard } from '@/components/shared/chart-card';
import { HeatmapTable } from '@/components/shared/heatmap-table';
import { KpiGrid, type KpiTileProps } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatDate, formatMoney } from '@/lib/format';
import type { ItemAnalytics, ItemCustomerRow, ItemVendorRow } from '@vyuha/shared';

import { RankingChart, RateRadial, TrendChart } from './lifecycle-charts';
import { LifecycleFilter } from './lifecycle-filter';
import { COMPARE_LABELS } from './lifecycle-period';
import { heatGridFromCells, itemInsights, itemTrend, rankingSeries, trendReadable } from './lifecycle-series';
import { LifecycleTimeline } from './lifecycle-timeline';
import { useLifecyclePeriod } from './use-lifecycle-period';
import { useItemAnalytics } from './use-lifecycle-analytics';
import { useItemLifecycle } from './use-lifecycle';

/**
 * One stock item's life (owner, 22 Aug 2026): the decision this page
 * changes is whether to stock more or less of it, whom to call, and which
 * vendor to buy it from. The period and its comparison sit in the URL;
 * the figures carry their change; the charts answer one question each;
 * the tables have what the charts leave out; the timeline keeps the
 * dated trail. A figure the tables cannot support is named as absent.
 */
function qty(value: number, unit: string | null = null): string {
  const text = value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return unit ? `${text} ${unit}` : text;
}

function rate(value: number | null): string {
  return value === null ? EMPTY_VALUE : formatMoney(value);
}

const CUSTOMER_COLUMNS: RecordColumn<ItemCustomerRow>[] = [
  { key: 'name', header: 'Customer', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'quantity', header: 'Quantity', cell: (row) => qty(row.quantity), numeric: true },
  { key: 'value', header: 'Value', cell: (row) => formatMoney(row.value), numeric: true },
  { key: 'orders', header: 'Orders', cell: (row) => String(row.orders), numeric: true },
  { key: 'lastRate', header: 'Last rate', cell: (row) => rate(row.lastRate), numeric: true },
  { key: 'lastAt', header: 'Last order', cell: (row) => formatDate(row.lastAt), className: 'tabular-nums', secondary: true },
];

const VENDOR_COLUMNS: RecordColumn<ItemVendorRow>[] = [
  { key: 'name', header: 'Vendor', cell: (row) => <span className="font-medium">{row.name}</span> },
  { key: 'quantity', header: 'Quantity', cell: (row) => qty(row.quantity), numeric: true },
  { key: 'lastRate', header: 'Last rate', cell: (row) => rate(row.lastRate), numeric: true },
  {
    key: 'variance',
    header: 'Vs best',
    cell: (row) => (row.variancePct === null ? EMPTY_VALUE : row.variancePct <= 0 ? <Badge variant="outline">Best</Badge> : <span className="text-destructive">+{String(row.variancePct)}%</span>),
    numeric: true,
  },
  {
    key: 'lead',
    header: 'Lead time',
    cell: (row) => (row.leadTimeDays === null ? EMPTY_VALUE : `${String(row.leadTimeDays)} d${row.promisedDays === null ? '' : ` of ${String(row.promisedDays)}`}`),
    numeric: true,
  },
  { key: 'rejected', header: 'Rejected', cell: (row) => (row.rejectedPct === null ? EMPTY_VALUE : `${String(row.rejectedPct)}%`), numeric: true, secondary: true },
  { key: 'lastAt', header: 'Last PO', cell: (row) => formatDate(row.lastAt), className: 'tabular-nums', secondary: true },
];

export function StockItemPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const period = useLifecyclePeriod();
  const lifecycle = useItemLifecycle(id ?? null);
  const analytics = useItemAnalytics(id ?? null, period.query);

  if (lifecycle.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading the item" className="flex flex-col gap-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    );
  }
  if (lifecycle.isError) {
    return (
      <QueryErrorAlert
        error={lifecycle.error}
        subject="this item"
        onRetry={() => {
          void lifecycle.refetch();
        }}
      />
    );
  }

  const { item, events } = lifecycle.data;
  const unit = item.unit;
  const facts = [item.alias, item.parentGroup, `Unit ${item.unit}`, item.gstRate ? `GST ${Number(item.gstRate).toLocaleString('en-IN')}%` : null].filter((f): f is string => f !== null && f !== '');
  const compareLabel = period.compare === 'off' ? null : COMPARE_LABELS[period.compare];
  const a = analytics.data;

  return (
    <>
      <PageHeader
        eyebrow="Stock item"
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{item.name}</span>
            {item.absentInTally ? <Badge variant="destructive">Gone from Tally</Badge> : null}
          </span>
        }
        description={facts.join(' · ')}
        action={
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/masters/items" />}>
            <CubeIcon data-icon="inline-start" />
            All items
          </Button>
        }
      />

      <LifecycleFilter period={period} />

      {analytics.isError ? (
        <QueryErrorAlert
          error={analytics.error}
          subject="the period's figures"
          onRetry={() => {
            void analytics.refetch();
          }}
        />
      ) : null}
      {a === undefined ? (
        <div role="status" aria-busy="true" aria-label="Loading the period" className="flex flex-col gap-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <ItemAnalyticsBody a={a} unit={unit} compareLabel={compareLabel} ready={!analytics.isPlaceholderData} onParty={(partyId) => void navigate(`/masters/parties/${partyId}`)} />
      )}

      <LifecycleTimeline events={events} title="Every document that carried it" />
    </>
  );
}

function ItemAnalyticsBody({ a, unit, compareLabel, ready, onParty }: { a: ItemAnalytics; unit: string; compareLabel: string | null; ready: boolean; onParty: (id: string) => void }) {
  const { kpis } = a;
  const q = (value: number) => qty(value, unit);
  const withDelta = (tile: Omit<KpiTileProps, 'current' | 'previous'>, figure: { value: number; previous: number | null }): KpiTileProps => ({ ...tile, current: figure.value, previous: figure.previous });

  const demand: KpiTileProps[] = [
    withDelta({ label: 'Ordered', value: q(kpis.ordered.value), format: q }, kpis.ordered),
    withDelta({ label: 'Dispatched', value: q(kpis.dispatched.value), format: q }, kpis.dispatched),
    withDelta({ label: 'Fulfilment', value: `${String(kpis.fulfilmentPct.value)}%`, format: (v) => `${String(v)} pts` }, kpis.fulfilmentPct),
    withDelta({ label: 'Orders', value: String(kpis.orders.value), format: String }, kpis.orders),
    withDelta({ label: 'Customers', value: String(kpis.customers.value), format: String }, kpis.customers),
    withDelta({ label: 'Repeat buyers', value: String(kpis.repeatBuyers.value), format: String }, kpis.repeatBuyers),
    withDelta({ label: 'Top customer share', value: `${String(kpis.topCustomerSharePct.value)}%`, format: (v) => `${String(v)} pts` }, kpis.topCustomerSharePct),
    withDelta({ label: 'Shortages raised', value: String(kpis.shortages.value), format: String, lowerIsBetter: true }, kpis.shortages),
  ];
  const moneyTiles: KpiTileProps[] = [
    withDelta({ label: 'Revenue (Tally)', value: formatMoney(kpis.revenue.value), format: formatMoney }, kpis.revenue),
    withDelta({ label: 'Billed', value: q(kpis.billedQty.value), format: q }, kpis.billedQty),
    withDelta({ label: 'Realised rate', value: formatMoney(kpis.realisedRate.value), format: formatMoney }, kpis.realisedRate),
    ...(kpis.marginProxyPct === null ? [] : [{ label: 'Margin proxy', value: `${String(kpis.marginProxyPct)}%`, note: 'realised rate vs cost price' }]),
  ];
  const supply: KpiTileProps[] = [
    withDelta({ label: 'Purchased', value: q(kpis.purchased.value), format: q }, kpis.purchased),
    withDelta({ label: 'Received', value: q(kpis.received.value), format: q }, kpis.received),
    withDelta({ label: 'Purchase rate', value: formatMoney(kpis.purchaseRate.value), format: formatMoney, lowerIsBetter: true }, kpis.purchaseRate),
    { label: 'Last purchase rate', value: rate(kpis.lastPurchaseRate), note: kpis.lastPurchasedAt ? formatDate(kpis.lastPurchasedAt) : 'never' },
  ];
  const now: KpiTileProps[] = [
    { label: 'On the shelf', value: kpis.closingQty === null ? EMPTY_VALUE : q(kpis.closingQty), note: 'Tally closing' },
    { label: 'Months of cover', value: kpis.monthsOfCover === null ? EMPTY_VALUE : String(kpis.monthsOfCover), note: "at the period's pace" },
    { label: 'Open orders', value: String(kpis.openOrders), note: 'now' },
    { label: 'Last sold', value: kpis.lastSoldAt ? formatDate(kpis.lastSoldAt) : 'never', note: kpis.lastSoldRate === null ? undefined : `at ${formatMoney(kpis.lastSoldRate)}` },
  ];

  const trend = itemTrend(a);
  const customers = rankingSeries(a.customers, (r) => r.quantity);
  const grid = heatGridFromCells(a.heat);
  const insights = itemInsights(a);

  return (
    <>
      <section className="flex flex-col gap-3">
        <SectionHeading title="Demand" note={compareLabel === null ? 'In the period.' : `In the period, against the ${compareLabel.toLowerCase()}.`} />
        <KpiGrid tiles={demand} />
      </section>
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <SectionHeading title="Money" note="From Tally's Sales vouchers; credit notes subtract." />
          <KpiGrid tiles={moneyTiles} columns={moneyTiles.length === 4 ? 4 : 3} />
        </section>
        <section className="flex flex-col gap-3">
          <SectionHeading title="Supply" note="Purchase orders and receipts in the period." />
          <KpiGrid tiles={supply} />
        </section>
      </div>
      <section className="flex flex-col gap-3">
        <SectionHeading title="Now" note="Not the period: the shelf and the order book as they stand." />
        <KpiGrid tiles={now} />
      </section>

      {insights.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionHeading title="What the period says" icon={<LightbulbIcon />} />
          <ul className="flex flex-col gap-1 text-sm">
            {insights.map((line) => (
              <li key={line} className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {trendReadable(trend) ? (
          <TrendChart title="Ordered and dispatched, by month" note={compareLabel === null ? undefined : `Dashed: ${compareLabel.toLowerCase()}.`} points={trend} labels={{ a: 'Ordered', b: 'Dispatched' }} compareLabel={compareLabel} format={q} ready={ready} />
        ) : (
          // The same card the chart would have been, saying why it is not
          // there. A bare heading beside a bordered card left the row half
          // furnished: the card looked stranded next to four hundred pixels
          // of nothing, which is what made it look broken.
          <ChartCard
            title="Ordered and dispatched, by month"
            empty
            emptyNote="Not enough months with movement in this period to read a trend."
          >
            <span />
          </ChartCard>
        )}
        <RateRadial title="Fulfilment" note="Dispatched as a share of ordered, in the period." pct={kpis.fulfilmentPct.value} previousPct={kpis.fulfilmentPct.previous} label="fulfilled" ready={ready} />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {customers.length > 0 ? <RankingChart title="Who buys it" note="By quantity ordered in the period; eight at most." points={customers} valueLabel="Quantity" format={q} ready={ready} /> : null}
        {grid.rows.length > 0 ? (
          <ChartCard title="When each customer buys" description="Quantity ordered, by customer and month.">
            <HeatmapTable grid={grid} rowLabel="Customer" format={(v) => qty(v)} onRow={onParty} />
          </ChartCard>
        ) : null}
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-3">
          <SectionHeading title="Customers" note="Top eight in the period." />
          {a.customers.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CubeIcon />
                </EmptyMedia>
                <EmptyTitle>No order carried this item in the period</EmptyTitle>
                <EmptyDescription>Widen the period, or wait for sales to confirm one.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RecordTable
              columns={CUSTOMER_COLUMNS}
              rows={[...a.customers]}
              rowKey={(row) => row.id ?? row.name}
              mobilePrimary={(row) => row.name}
              mobileSupporting={(row) => `${qty(row.quantity, unit)} · ${formatMoney(row.value)} · ${String(row.orders)} order${row.orders === 1 ? '' : 's'}`}
              onRowActivate={(row) => {
                if (row.id !== null) onParty(row.id);
              }}
            />
          )}
        </section>
        <section className="flex min-w-0 flex-col gap-3">
          <SectionHeading title="Vendors" note="Rate against the best another vendor gave; lead time against the promise." />
          {a.vendors.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CubeIcon />
                </EmptyMedia>
                <EmptyTitle>No purchase order carried this item in the period</EmptyTitle>
                <EmptyDescription>Widen the period, or raise one from a requirement.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RecordTable
              columns={VENDOR_COLUMNS}
              rows={[...a.vendors]}
              rowKey={(row) => row.id ?? row.name}
              mobilePrimary={(row) => row.name}
              mobileSupporting={(row) => `${qty(row.quantity, unit)} · last ${rate(row.lastRate)}${row.variancePct !== null && row.variancePct > 0 ? ` · +${String(row.variancePct)}% vs best` : ''}`}
              onRowActivate={(row) => {
                if (row.id !== null) onParty(row.id);
              }}
            />
          )}
        </section>
      </div>

      {a.absent.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Not shown: {a.absent.map((k) => `${k.label} (needs ${k.needs})`).join('; ')}.
        </p>
      ) : null}
    </>
  );
}
