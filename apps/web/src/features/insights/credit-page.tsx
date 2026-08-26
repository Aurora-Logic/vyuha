import { ArrowsClockwiseIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useSearchParams } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import type { Metric } from './api';
import { MetricChart } from './metric-card';
import { INSIGHT_PRESETS, rangeAsPickerValue, rangeFromParams, toApiDate } from './period';
import { useCfoReceivables, type CreditOverviewData } from './use-cfo';

/**
 * Credit control (brief C4, Phase 2): the receivable book as its measures --
 * DSO by countback, best possible, days late, CEI -- the ageing photographed
 * daily, and the parties whose delay costs the most, priced at the interest
 * module's rate (D17).
 */

const AGEING_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: '0-30', label: '0–30' },
  { key: '31-60', label: '31–60' },
  { key: '61-90', label: '61–90' },
  { key: '91-180', label: '91–180' },
  { key: '180+', label: '180+' },
];

/** The trend as a MetricChart metric, so the chart language stays one. */
function ageingMetric(data: CreditOverviewData): Metric {
  return {
    key: 'ageing-trend',
    label: 'Ageing, day by day',
    hint: 'Every day’s photograph of the open book, stacked by how overdue it is (by due date, not invoice date).',
    unit: 'money',
    headline: data.outstanding,
    series: AGEING_BUCKETS,
    points: data.ageingTrend,
  };
}

const days = (value: number | null): string => (value === null ? EMPTY_VALUE : `${String(Math.round(value * 10) / 10)}d`);

const OVERDUE_COLUMNS: RecordColumn<CreditOverviewData['topOverdue'][number]>[] = [
  { key: 'party', header: 'Party', cell: (row) => row.party },
  { key: 'outstanding', header: 'Outstanding', cell: (row) => formatMoney(row.outstanding), numeric: true },
  { key: 'overdue', header: 'Overdue', cell: (row) => formatMoney(row.overdue), numeric: true },
  { key: 'oldest', header: 'Oldest bill', cell: (row) => (row.oldestBill === null ? EMPTY_VALUE : formatDate(row.oldestBill)), secondary: true },
  { key: 'days', header: 'Days overdue', cell: (row) => formatCount(row.daysOverdue), numeric: true },
  { key: 'lastPayment', header: 'Last payment', cell: (row) => (row.lastPayment === null ? EMPTY_VALUE : formatDate(row.lastPayment)), secondary: true },
  // D17: the most persuasive number in a collection call.
  { key: 'cost', header: 'Delay costs / yr', cell: (row) => formatMoney(row.costPerYear), numeric: true },
];

export function CreditControlPage() {
  const canView = usePermission(PERMISSIONS.CFO_RECEIVABLES_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const query = useCfoReceivables(range, { enabled: canView });

  if (!canView) {
    return (
      <>
        <PageHeader description="The receivable book as its measures: DSO, days late, and the collection score." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view credit control</EmptyTitle>
            <EmptyDescription>This needs the cfo.receivables.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader description="The receivable book as its measures: DSO by countback, days late, the collection score, and the parties whose delay costs the most." />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Refresh"
            disabled={query.isFetching}
            onClick={() => {
              void query.refetch();
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
          {data?.asOf ? (
            <span className="text-muted-foreground text-xs tabular-nums">Book as of {formatDate(data.asOf)}</span>
          ) : null}
        </div>

        {query.isPending ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-72" />
          </div>
        ) : null}

        {query.isError ? (
          <QueryErrorAlert error={query.error} subject="credit overview" onRetry={() => void query.refetch()} />
        ) : null}

        {data ? (
          <>
            <KpiGrid
              columns={6}
              tiles={[
                { label: 'Outstanding', value: formatMoney(data.outstanding) },
                { label: 'Overdue', value: formatMoney(data.overdue) },
                { label: 'Days sales outstanding', value: days(data.dsoCountback) },
                { label: 'Best possible', value: days(data.bestPossibleDso) },
                { label: 'Days late (ADD)', value: days(data.addDays) },
                { label: 'Collection score (CEI)', value: data.cei === null ? EMPTY_VALUE : formatCount(Math.round(data.cei)) },
              ]}
            />

            {data.ageingTrend.length > 0 ? (
              <Card data-metric="ageing-trend">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Ageing, day by day</CardTitle>
                </CardHeader>
                <CardContent>
                  <MetricChart metric={ageingMetric(data)} kind="bar" options={{ legend: true, dataLabels: false }} className="h-56" />
                </CardContent>
              </Card>
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>No snapshots in this period</EmptyTitle>
                  <EmptyDescription>
                    The nightly photograph fills this chart from the day it starts running; pick a period that
                    covers photographed days.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {data.topOverdue.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Most overdue parties</p>
                <RecordTable
                  columns={OVERDUE_COLUMNS}
                  rows={[...data.topOverdue]}
                  rowKey={(row) => `${row.partyId ?? row.party}`}
                  mobilePrimary={(row) => row.party}
                  mobileSupporting={(row) => `${formatMoney(row.overdue)} overdue · ${String(row.daysOverdue)} days · costs ${formatMoney(row.costPerYear)}/yr`}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
