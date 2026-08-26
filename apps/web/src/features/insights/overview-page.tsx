import { ArrowRightIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router';
import { PERMISSIONS, type InsightArea } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ChartBarIcon } from '@phosphor-icons/react';
import { KpiGrid, type KpiTileProps } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { DateRangeField } from '@/features/attendance/pickers';
import { formatDate } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useAreaInsights, type AreaInsightsData, type Metric } from './api';
import { AREA_LABELS } from './catalogue';
import { MetricChart } from './metric-card';
import { formatHeadline } from './units';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';

/**
 * The reports overview (owner, 26 Aug 2026, the Supabase Overview shape): a
 * strip of headline figures across every area this viewer may see, then one
 * health card per area with its marquee chart and the way in.
 *
 * Each area is fetched only when its permission is held -- the server would
 * refuse anyway, but asking a question whose answer is already known to be
 * 403 just fills the error lane of the page with noise.
 */

function tilesOf(area: InsightArea, data: AreaInsightsData | undefined): KpiTileProps[] {
  if (data === undefined) return [];
  const metric = (key: string) => data.metrics.find((m) => m.key === key);
  switch (area) {
    case 'attendance': {
      const mix = metric('attendance-mix');
      const late = metric('late-arrivals');
      return [
        ...(mix ? [{ label: 'Present today', value: formatHeadline(mix.unit, mix.headline) }] : []),
        ...(late ? [{ label: 'Late arrivals', value: formatHeadline(late.unit, late.headline) }] : []),
      ];
    }
    case 'receivables': {
      const invoiced = metric('invoiced');
      const received = metric('received');
      return [
        ...(invoiced ? [{ label: 'Invoiced', value: formatHeadline(invoiced.unit, invoiced.headline) }] : []),
        ...(received ? [{ label: 'Received', value: formatHeadline(received.unit, received.headline) }] : []),
      ];
    }
    case 'sales': {
      const orders = metric('orders-value');
      return orders ? [{ label: 'Sales orders', value: formatHeadline(orders.unit, orders.headline) }] : [];
    }
    case 'sync': {
      const exceptions = metric('exceptions');
      return exceptions
        ? [{ label: 'Open sync exceptions', value: formatHeadline(exceptions.unit, exceptions.headline) }]
        : [];
    }
  }
}

function OverviewMetricCard({ metric, index }: { metric: Metric; index: number }) {
  return (
    <Card className="min-w-0" data-metric={metric.key}>
      <CardHeader>
        <CardTitle className="truncate text-sm font-medium">{metric.label}</CardTitle>
        <CardAction>
          <span className="text-sm font-semibold tabular-nums">{formatHeadline(metric.unit, metric.headline)}</span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <MetricChart
          metric={metric}
          kind={metric.xKind === 'category' ? 'bar' : metric.series.length > 1 ? 'bar' : 'area'}
          options={{ legend: true, dataLabels: false, colourIndex: index }}
          className="h-36"
        />
      </CardContent>
    </Card>
  );
}

function AreaSection({ area, data, pending }: { area: InsightArea; data: AreaInsightsData | undefined; pending: boolean }) {
  const metrics = data?.metrics ?? [];
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading title={AREA_LABELS[area]} />
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link to={`/reports/${area}`} />}>
          Open
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </div>
      {pending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : null}
      {metrics.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {metrics.map((metric, index) => (
            <OverviewMetricCard key={metric.key} metric={metric} index={index} />
          ))}
        </div>
      ) : null}
      {!pending && metrics.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing yet for this period.</p>
      ) : null}
    </section>
  );
}

export function InsightsOverviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);

  const canAttendance = usePermission(PERMISSIONS.ATTENDANCE_VIEW_ALL);
  const canReceivables = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const canSales = usePermission(PERMISSIONS.SALES_DOCUMENT_VIEW_ALL);
  const canSync = usePermission(PERMISSIONS.INTEGRATION_MANAGE);

  const attendance = useAreaInsights('attendance', range, { enabled: canAttendance });
  const receivables = useAreaInsights('receivables', range, { enabled: canReceivables });
  const sales = useAreaInsights('sales', range, { enabled: canSales });
  const sync = useAreaInsights('sync', range, { enabled: canSync });

  const all: { area: InsightArea; allowed: boolean; data: AreaInsightsData | undefined; pending: boolean }[] = [
    { area: 'attendance', allowed: canAttendance, data: attendance.data, pending: attendance.isPending && canAttendance },
    { area: 'receivables', allowed: canReceivables, data: receivables.data, pending: receivables.isPending && canReceivables },
    { area: 'sales', allowed: canSales, data: sales.data, pending: sales.isPending && canSales },
    { area: 'sync', allowed: canSync, data: sync.data, pending: sync.isPending && canSync },
  ];
  const areas = all.filter((entry) => entry.allowed);

  const tiles = areas.flatMap((entry) => tilesOf(entry.area, entry.data));

  if (areas.length === 0) {
    return (
      <>
        <PageHeader description="Headline figures across the areas you may see, one chart to a card." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ChartBarIcon />
            </EmptyMedia>
            <EmptyTitle>No report areas for this account</EmptyTitle>
            <EmptyDescription>
              Reports show what your other permissions already let you see. None of the four areas —
              attendance, receivables, sales, sync — is open to this account.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader description="Headline figures across the areas you may see, one chart to a card." />
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            onClick={() => {
              void attendance.refetch();
              void receivables.refetch();
              void sales.refetch();
              void sync.refetch();
            }}
          >
            <ArrowsClockwiseIcon />
          </Button>
          <DateRangeField
            label="Period"
            value={rangeAsPickerValue(range)}
            presets={INSIGHT_PRESETS}
            onValueChange={(next) => {
              if (!next.from || !next.to) return;
              const from = toApiDate(next.from);
              const to = toApiDate(next.to);
              setSearchParams(
                (current) => {
                  const params = new URLSearchParams(current);
                  params.set('from', from);
                  params.set('to', to);
                  return params;
                },
                { replace: true },
              );
            }}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDate(range.from)} → {formatDate(range.to)}
          </span>
        </div>
        {tiles.length > 0 ? <KpiGrid tiles={tiles} columns={6} /> : null}
        {areas.map((entry) => (
          <AreaSection key={entry.area} area={entry.area} data={entry.data} pending={entry.pending} />
        ))}
      </div>
    </>
  );
}
